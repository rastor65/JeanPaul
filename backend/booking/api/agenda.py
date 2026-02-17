from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable, Optional

from django.conf import settings
from django.db.models import Q, Prefetch
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.models import Appointment, AppointmentBlock, AppointmentServiceLine
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
    wanted = {_norm_role(r) for r in role_names}

    if getattr(user, "is_superuser", False):
        return True

    if getattr(user, "is_staff", False) and ("STAFF" in wanted or "ADMIN" in wanted):
        return True

    if hasattr(user, "role"):
        user_role = _norm_role(getattr(user, "role", "") or "")
        if user_role and user_role in wanted:
            return True

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
    start = timezone.make_aware(datetime.combine(day, datetime.min.time()), tz)
    end = start + timedelta(days=1)
    return start, end


def _blocks_prefetch():
    """
    Prefetch de blocks + worker + service_lines.
    Esto evita N+1 cuando serializas agenda.
    """
    service_lines_qs = AppointmentServiceLine.objects.select_related("service")
    blocks_qs = (
        AppointmentBlock.objects
        .select_related("worker")
        .prefetch_related(Prefetch("service_lines", queryset=service_lines_qs))
        .order_by("start_datetime")
    )
    return Prefetch("blocks", queryset=blocks_qs)


# -----------------------------
# Staff agenda
# -----------------------------
class StaffAgendaAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        if not _user_has_any_role(user, ["staff", "admin"]):
            return Response({"detail": "No autorizado."}, status=403)

        day = _parse_date(request.query_params.get("date"))
        start_dt, end_dt = _day_range_aware(day)

        qs = (
            Appointment.objects
            .filter(start_datetime__gte=start_dt, start_datetime__lt=end_dt)
            .select_related("customer", "paid_by", "created_by", "cancelled_by")
            .prefetch_related(_blocks_prefetch())
            .order_by("start_datetime")
        )

        # Filtros
        worker_id = request.query_params.get("worker_id")
        if worker_id:
            appointment_ids = (
                AppointmentBlock.objects
                .filter(worker_id=worker_id, start_datetime__gte=start_dt, start_datetime__lt=end_dt)
                .values_list("appointment_id", flat=True)
                .distinct()
            )
            qs = qs.filter(id__in=appointment_ids)

        status_param = request.query_params.get("status")
        if status_param:
            qs = qs.filter(status=status_param)

        q = request.query_params.get("q")
        if q:
            q = q.strip()
            qs = qs.filter(Q(customer__name__icontains=q) | Q(customer__phone__icontains=q))

        count = qs.count()
        data = AppointmentStaffSerializer(qs, many=True).data
        return Response({"date": str(day), "count": count, "results": data}, status=200)


# -----------------------------
# My agenda (worker)
# -----------------------------
class MyAgendaAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user

        worker = None
        try:
            from staffing.models import Worker
            worker = Worker.objects.filter(user=user).first()
        except Exception:
            worker = None

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
            return Response({"detail": "No autorizado."}, status=403)

        day = _parse_date(request.query_params.get("date"))
        start_dt, end_dt = _day_range_aware(day)

        appointment_ids = (
            AppointmentBlock.objects
            .filter(worker_id=worker.id, start_datetime__gte=start_dt, start_datetime__lt=end_dt)
            .values_list("appointment_id", flat=True)
            .distinct()
        )

        qs = (
            Appointment.objects
            .filter(id__in=appointment_ids)
            .select_related("customer")
            .prefetch_related(_blocks_prefetch())
            .order_by("start_datetime")
        )

        data = AppointmentWorkerSerializer(qs, many=True).data
        return Response({"date": str(day), "worker_id": worker.id, "count": qs.count(), "results": data}, status=200)
