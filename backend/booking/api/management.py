from __future__ import annotations

from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.permissions import IsAdminOrStaff, is_admin_user, is_staff_user
from booking.models import Appointment


def _get_recommended_total(appointment: Appointment) -> int:
    """
    Recomendado = suma de precios de servicios de la cita.
    Intenta usar AppointmentServiceLine si existe.
    Fallback: 0 si no se puede calcular.
    """
    try:
        from booking.models import AppointmentServiceLine  # type: ignore
        lines = AppointmentServiceLine.objects.filter(appointment=appointment).select_related("service")
        total = 0
        for ln in lines:
            svc = getattr(ln, "service", None)
            if svc is None:
                continue
            # tolerante al nombre del campo precio
            price = 0
            for attr in ("price", "price_amount", "amount", "value"):
                if hasattr(svc, attr):
                    try:
                        price = int(getattr(svc, attr) or 0)
                        break
                    except Exception:
                        price = 0
            total += int(price or 0)
        return int(total)
    except Exception:
        return 0


def _audit(appointment: Appointment, *, action: str, performed_by, note: str = "") -> None:
    """
    Crea AppointmentAudit si el modelo existe.
    """
    try:
        from booking.models import AppointmentAudit  # type: ignore

        AppointmentAudit.objects.create(
            appointment=appointment,
            action=action,
            performed_by=performed_by,
            note=note,
            performed_at=timezone.now(),
        )
    except Exception:
        # Si no existe o no coincide el modelo, no bloqueamos la operación
        return


class CancelAppointmentAPIView(APIView):
    """
    POST /api/appointments/<id>/cancel/
    - Cliente: solo si faltan >= 30 minutos.
    - Staff/Admin: puede forzar con {"force": true}
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk: int):
        appt = Appointment.objects.filter(pk=pk).first()
        if not appt:
            return Response({"detail": "Cita no encontrada."}, status=404)

        force = bool((request.data or {}).get("force", False))
        user = request.user

        # Si no es staff/admin, aplicar regla 30 min
        if not (is_admin_user(user) or is_staff_user(user)) and not force:
            now = timezone.now()
            limit = appt.start_datetime - timedelta(minutes=30)
            if now > limit:
                return Response(
                    {"detail": "No se puede cancelar: faltan menos de 30 minutos para el turno."},
                    status=409,
                )

        # No permitir cancelar si ya está atendida/no-show/cancelada (staff puede forzar si quieres)
        current_status = str(getattr(appt, "status", "") or "").upper()
        if current_status in {"CANCELLED", "CANCELED", "ATTENDED", "NO_SHOW"} and not force:
            return Response({"detail": f"No se puede cancelar en estado {current_status}."}, status=409)

        with transaction.atomic():
            # Set status cancelado (tolerante a choices)
            new_status = "CANCELLED"
            setattr(appt, "status", new_status)
            appt.save(update_fields=["status"])

            _audit(appt, action="CANCEL", performed_by=user, note="Cancelación")

        return Response(
            {
                "id": appt.id,
                "status": appt.status,
                "start_datetime": appt.start_datetime,
                "end_datetime": appt.end_datetime,
            },
            status=200,
        )


class MarkAttendedAPIView(APIView):
    """
    POST /api/appointments/<id>/attend/
    Marca la cita como atendida. Solo staff/admin.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk: int):
        appt = Appointment.objects.filter(pk=pk).first()
        if not appt:
            return Response({"detail": "Cita no encontrada."}, status=404)

        with transaction.atomic():
            setattr(appt, "status", "ATTENDED")
            appt.save(update_fields=["status"])
            _audit(appt, action="ATTEND", performed_by=request.user, note="Atendida")

        return Response({"id": appt.id, "status": appt.status}, status=200)


class MarkNoShowAPIView(APIView):
    """
    POST /api/appointments/<id>/no-show/
    Marca la cita como NO_SHOW. Solo staff/admin.
    """
    permission_classes = [IsAuthenticated]

    def post(self, request, pk: int):
        appt = Appointment.objects.filter(pk=pk).first()
        if not appt:
            return Response({"detail": "Cita no encontrada."}, status=404)

        with transaction.atomic():
            setattr(appt, "status", "NO_SHOW")
            appt.save(update_fields=["status"])
            _audit(appt, action="NO_SHOW", performed_by=request.user, note="No show")

        return Response({"id": appt.id, "status": appt.status}, status=200)


class RegisterPaymentAPIView(APIView):
    """
    POST /api/appointments/<id>/payment/
    Body:
      {
        "paid_total": 50000,
        "payment_method": "CASH" | "CARD" | "TRANSFER" | ...
      }
    Solo staff/admin.

    Regla: el cliente NO ve el total como "obligatorio", pero el sistema guarda el recomendado
    y la recepción registra el monto real cobrado (paid_total).
    """
    permission_classes = [IsAuthenticated, IsAdminOrStaff]

    def post(self, request, pk: int):
        appt = Appointment.objects.filter(pk=pk).first()
        if not appt:
            return Response({"detail": "Cita no encontrada."}, status=404)

        data = request.data or {}
        if "paid_total" not in data:
            return Response({"detail": "paid_total es requerido."}, status=400)

        try:
            paid_total = int(data.get("paid_total") or 0)
        except Exception:
            return Response({"detail": "paid_total debe ser numérico."}, status=400)

        payment_method = (data.get("payment_method") or "").strip().upper() or None
        recommended_total = _get_recommended_total(appt)

        with transaction.atomic():
            # Campos creados en tu migration 0002:
            # paid_total, paid_at, paid_by, payment_method
            if hasattr(appt, "paid_total"):
                setattr(appt, "paid_total", paid_total)
            if hasattr(appt, "paid_at"):
                setattr(appt, "paid_at", timezone.now())
            if hasattr(appt, "paid_by"):
                setattr(appt, "paid_by", request.user)
            if hasattr(appt, "payment_method"):
                setattr(appt, "payment_method", payment_method)

            appt.save()

            _audit(
                appt,
                action="PAYMENT",
                performed_by=request.user,
                note=f"Pago registrado. paid_total={paid_total} method={payment_method}",
            )

        return Response(
            {
                "id": appt.id,
                "status": appt.status,
                "start_datetime": appt.start_datetime,
                "end_datetime": appt.end_datetime,
                "recommended_total": recommended_total,
                "paid_total": getattr(appt, "paid_total", None),
                "paid_at": getattr(appt, "paid_at", None),
                "payment_method": getattr(appt, "payment_method", None),
            },
            status=200,
        )
