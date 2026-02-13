from __future__ import annotations
from django.conf import settings

from datetime import datetime, timedelta
from typing import Iterable, Optional

from django.db.models import Q
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.models import Appointment, AppointmentBlock
from booking.serializers import AppointmentStaffSerializer, AppointmentWorkerSerializer


# -----------------------------
# Roles (robusto / case-insensitive)
# -----------------------------
_ROLE_ALIASES = {
    # Español -> Inglés
    "BARBERO": "BARBER",
    "UNAS": "NAILS",
    "UÑAS": "NAILS",
    "FACIAL": "FACIAL",
    "TRABAJADOR": "WORKER",
    "RECEPCION": "STAFF",
    "RECEPCIÓN": "STAFF",

    # Variantes comunes
    "SUPERUSER": "ADMIN",
}


def _norm_role(value: str) -> str:
    r = (value or "").strip().upper()
    return _ROLE_ALIASES.get(r, r)


def _user_has_any_role(user, role_names: Iterable[str]) -> bool:
    """
    Compatible con:
    - user.role (string)
    - Django Groups
    - user.is_staff / user.is_superuser
    Comparación case-insensitive + alias.
    """
    wanted = {_norm_role(r) for r in role_names}

    if getattr(user, "is_superuser", False):
        return True

    # Si está pidiendo STAFF o ADMIN, contemplamos is_staff
    if getattr(user, "is_staff", False) and ("STAFF" in wanted or "ADMIN" in wanted):
        return True

    # Campo role (si existe)
    if hasattr(user, "role"):
        user_role = _norm_role(getattr(user, "role", "") or "")
        if user_role and user_role in wanted:
            return True

    # Groups (si se usa)
    try:
        user_groups = {_norm_role(g.name) for g in user.groups.all()}
        if user_groups.intersection(wanted):
            return True
    except Exception:
        pass

    return False


# -----------------------------
# Fechas
# -----------------------------
def _parse_date(date_str: Optional[str]):
    if not date_str:
        return timezone.localdate()
    try:
        return datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        return timezone.localdate()


def _day_range_aware(day):
    tz = timezone.get_current_timezone()
    start = datetime.combine(day, datetime.min.time())
    start = timezone.make_aware(start, tz)
    end = start + timedelta(days=1)
    return start, end


# -----------------------------
# Staff agenda
# -----------------------------
class StaffAgendaAPIView(APIView):
    """
    Agenda general para recepción/staff.

    GET params:
      - date=YYYY-MM-DD (opcional)
      - worker_id=ID (opcional)
      - status=RESERVED|CANCELLED|ATTENDED|NO_SHOW (opcional)
      - q=texto (opcional): busca por nombre/teléfono
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        if not _user_has_any_role(user, ["staff", "admin"]):
            return Response({"detail": "No autorizado."}, status=403)

        day = _parse_date(request.query_params.get("date"))
        start_dt, end_dt = _day_range_aware(day)

        qs = Appointment.objects.all().order_by("start_datetime")

        # Rango del día
        qs = qs.filter(start_datetime__gte=start_dt, start_datetime__lt=end_dt)

        # Filtros
        worker_id = request.query_params.get("worker_id")
        if worker_id:
            # En tu modelo AppointmentBlock tiene related_name="blocks"
            qs = qs.filter(blocks__worker_id=worker_id).distinct()

        status_param = request.query_params.get("status")
        if status_param:
            qs = qs.filter(status=status_param)

        q = request.query_params.get("q")
        if q:
            q = q.strip()
            combined = Q()

            # customer relacionado (existe en tus modelos)
            combined |= Q(customer__name__icontains=q)
            combined |= Q(customer__phone__icontains=q)

            qs = qs.filter(combined)

        # Optimizaciones
        qs = qs.select_related("customer", "paid_by")

        data = AppointmentStaffSerializer(qs, many=True).data
        return Response({"date": str(day), "count": len(data), "results": data}, status=200)


# -----------------------------
# My agenda (worker)
# -----------------------------

class MyAgendaAPIView(APIView):
    """
    Agenda del trabajador autenticado (solo sus turnos).

    GET params:
      - date=YYYY-MM-DD (opcional)
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user

        # 1) Autorizar por relación Worker (la fuente de verdad para "mi agenda")
        worker = None
        try:
            from staffing.models import Worker
            # si tu FK se llama diferente a "user", aquí es donde tocaría ajustar
            worker = Worker.objects.filter(user=user).first()
        except Exception:
            worker = None

        # DEBUG opcional (solo en desarrollo): te dice por qué está fallando
        if not worker:
            if getattr(settings, "DEBUG", False) and request.query_params.get("debug") == "1":
                role_val = getattr(user, "role", None)
                try:
                    groups = list(user.groups.values_list("name", flat=True))
                except Exception:
                    groups = []
                return Response(
                    {
                        "detail": "No autorizado (DEBUG). No existe Worker asociado a este usuario.",
                        "user_id": getattr(user, "id", None),
                        "username": getattr(user, "username", None),
                        "role_attr": role_val,
                        "groups": groups,
                        "is_staff": getattr(user, "is_staff", False),
                        "is_superuser": getattr(user, "is_superuser", False),
                    },
                    status=403,
                )

            # Si es staff/admin pero no tiene Worker, devolvemos 400 (no aplica a "my")
            # (si quieres permitir staff aquí, podrías redirigirlos a /agenda/staff/)
            return Response({"detail": "No autorizado."}, status=403)

        # 2) Ya autorizado: traer agenda del día para ese worker
        day = _parse_date(request.query_params.get("date"))
        start_dt, end_dt = _day_range_aware(day)

        blocks = (
            AppointmentBlock.objects
            .filter(worker_id=worker.id, start_datetime__gte=start_dt, start_datetime__lt=end_dt)
        )

        appointment_ids = blocks.values_list("appointment_id", flat=True).distinct()

        qs = (
            Appointment.objects
            .filter(id__in=appointment_ids)
            .select_related("customer")
            .order_by("start_datetime")
        )

        data = AppointmentWorkerSerializer(qs, many=True).data
        return Response(
            {"date": str(day), "worker_id": worker.id, "count": len(data), "results": data},
            status=200,
        )
