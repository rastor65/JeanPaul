from __future__ import annotations

from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.models import Appointment, AppointmentAudit, AppointmentBlock


def _user_has_any_role(user, role_names: list[str]) -> bool:
    role_names = set(role_names)

    if getattr(user, "is_superuser", False):
        return True

    if "staff" in role_names and getattr(user, "is_staff", False):
        return True

    # Campo role (si existe)
    if hasattr(user, "role"):
        if getattr(user, "role", None) in role_names:
            return True

    # Groups (si se usa)
    try:
        if user.groups.filter(name__in=list(role_names)).exists():
            return True
    except Exception:
        pass

    return False


def _appointment_status_choices() -> set[str]:
    """
    Toma choices desde el modelo si existen.
    Si no hay choices definidos, igual permite cualquier string (pero se valida mínimamente).
    """
    try:
        field = Appointment._meta.get_field("status")
        choices = getattr(field, "choices", None) or []
        return {c[0] for c in choices if c and isinstance(c, (list, tuple))}
    except Exception:
        return set()


def _safe_audit_create(*, appointment: Appointment, action: str, user, note: str | None = None):
    """
    Crea auditoría sin asumir 100% los nombres de campos (evita reventar si algo cambia).
    """
    try:
        field_names = {f.name for f in AppointmentAudit._meta.get_fields()}
        kwargs = {}
        if "appointment" in field_names:
            kwargs["appointment"] = appointment
        if "action" in field_names:
            kwargs["action"] = action
        if "performed_by" in field_names:
            kwargs["performed_by"] = user
        if "note" in field_names and note is not None:
            kwargs["note"] = note

        # performed_at normalmente tiene default=timezone.now
        AppointmentAudit.objects.create(**kwargs)
    except Exception:
        # Nunca rompemos la operación por la auditoría
        return


def _service_summary_for_audit(appointment: Appointment) -> str:
    """
    Resumen de bloques/servicios para dejar trazabilidad en caso de cancelar (si se liberan bloques).
    """
    try:
        blocks = (
            AppointmentBlock.objects
            .filter(appointment=appointment)
            .select_related("worker")
            .order_by("sequence", "start_datetime")
        )
        parts = []
        for b in blocks:
            wk = getattr(b, "worker", None)
            wk_label = str(wk) if wk else "-"
            parts.append(
                f"[{getattr(b, 'sequence', '-')}] {wk_label} {b.start_datetime} -> {b.end_datetime}"
            )
        return " | ".join(parts) if parts else "Sin bloques"
    except Exception:
        return "Sin bloques"


class AppointmentCancelAPIView(APIView):
    """
    Cancelación de cita.

    Reglas:
    - Si es staff/admin: puede cancelar en cualquier momento.
    - Si NO es staff/admin: solo puede cancelar si faltan >= 30 minutos para el inicio.
    - Para liberar disponibilidad, se eliminan los bloques (AppointmentBlock) al cancelar.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk: int):
        appointment = get_object_or_404(Appointment, pk=pk)

        is_staff = _user_has_any_role(request.user, ["staff", "admin"])

        # Si ya está cancelada, idempotente
        if str(getattr(appointment, "status", "")).upper() == "CANCELLED":
            return Response({"detail": "La cita ya está cancelada."}, status=200)

        start_dt = getattr(appointment, "start_datetime", None)
        if start_dt is None:
            return Response({"detail": "La cita no tiene fecha/hora de inicio."}, status=400)

        now = timezone.now()

        # Si viene naive por alguna razón, la hacemos aware en tz actual
        if timezone.is_naive(start_dt):
            start_dt = timezone.make_aware(start_dt, timezone.get_current_timezone())

        # Regla de 30 minutos para no-staff
        if not is_staff:
            limit = start_dt - timedelta(minutes=30)
            if now > limit:
                return Response(
                    {"detail": "No se puede cancelar con menos de 30 minutos de anticipación."},
                    status=403
                )

        note = request.data.get("note") if isinstance(request.data, dict) else None

        with transaction.atomic():
            summary = _service_summary_for_audit(appointment)

            # Marcar cancelada
            appointment.status = "CANCELLED"
            appointment.save(update_fields=["status"])

            # Liberar agenda eliminando bloques (y líneas por cascade si aplica)
            AppointmentBlock.objects.filter(appointment=appointment).delete()

            _safe_audit_create(
                appointment=appointment,
                action="CANCELLED",
                user=request.user,
                note=(note or "") + (f" | {summary}" if summary else "")
            )

        return Response({"detail": "Cita cancelada correctamente."}, status=200)


class AppointmentStatusUpdateAPIView(APIView):
    """
    Actualizar estado de una cita (recepción/staff).

    Body:
      {"status": "ATTENDED"}  # Ejemplos: ATTENDED, NO_SHOW, RESERVED, CANCELLED
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk: int):
        if not _user_has_any_role(request.user, ["staff", "admin"]):
            return Response({"detail": "No autorizado."}, status=403)

        appointment = get_object_or_404(Appointment, pk=pk)
        payload = request.data if isinstance(request.data, dict) else {}

        new_status = str(payload.get("status", "")).strip().upper()
        if not new_status:
            return Response({"detail": "status es requerido."}, status=400)

        valid = _appointment_status_choices()
        if valid and new_status not in valid:
            return Response(
                {"detail": f"Estado inválido. Permitidos: {sorted(valid)}"},
                status=400
            )

        note = payload.get("note")

        with transaction.atomic():
            appointment.status = new_status
            appointment.save(update_fields=["status"])

            _safe_audit_create(
                appointment=appointment,
                action=f"STATUS_{new_status}",
                user=request.user,
                note=str(note) if note else None
            )

        return Response({"detail": "Estado actualizado.", "status": new_status}, status=200)


class AppointmentPaymentAPIView(APIView):
    """
    Registrar cobro real (solo recepción/staff).

    Body:
      {
        "paid_total": "50000.00",
        "payment_method": "CASH"  # opcional
      }
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk: int):
        if not _user_has_any_role(request.user, ["staff", "admin"]):
            return Response({"detail": "No autorizado."}, status=403)

        appointment = get_object_or_404(Appointment, pk=pk)
        payload = request.data if isinstance(request.data, dict) else {}

        if "paid_total" not in payload:
            return Response({"detail": "paid_total es requerido."}, status=400)

        try:
            paid_total = Decimal(str(payload.get("paid_total")))
            if paid_total < 0:
                return Response({"detail": "paid_total no puede ser negativo."}, status=400)
        except (InvalidOperation, TypeError, ValueError):
            return Response({"detail": "paid_total debe ser numérico."}, status=400)

        payment_method = payload.get("payment_method")
        note = payload.get("note")

        # Campos que agregaste en migración: paid_total, paid_at, paid_by, payment_method
        update_fields = []

        with transaction.atomic():
            if hasattr(appointment, "paid_total"):
                appointment.paid_total = paid_total
                update_fields.append("paid_total")

            if hasattr(appointment, "paid_at"):
                appointment.paid_at = timezone.now()
                update_fields.append("paid_at")

            if hasattr(appointment, "paid_by"):
                appointment.paid_by = request.user
                update_fields.append("paid_by")

            if hasattr(appointment, "payment_method") and payment_method is not None:
                appointment.payment_method = str(payment_method).strip().upper()
                update_fields.append("payment_method")

            if update_fields:
                appointment.save(update_fields=update_fields)
            else:
                appointment.save()

            _safe_audit_create(
                appointment=appointment,
                action="PAYMENT_REGISTERED",
                user=request.user,
                note=str(note) if note else None
            )

        return Response(
            {
                "detail": "Pago registrado.",
                "appointment_id": appointment.id,
                "paid_total": str(paid_total),
                "payment_method": (str(payment_method).strip().upper() if payment_method else None),
            },
            status=200
        )
