from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Dict

from django.db import transaction
from django.utils import timezone

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status as drf_status
from rest_framework.exceptions import PermissionDenied

from booking.models import (
    Appointment,
    AppointmentAudit,
    AppointmentServiceLine,
)


def _is_staff_or_admin(user) -> bool:
    role = (getattr(user, "role", "") or "").upper()
    return role in ("ADMIN", "STAFF")


def _to_decimal(value: Any) -> Decimal:
    if value is None:
        raise ValueError("paid_total es requerido.")
    try:
        d = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError("paid_total debe ser numérico.")
    if d < 0:
        raise ValueError("paid_total no puede ser negativo.")
    return d


def _recommended_total_for_appointment(appointment_id: int) -> Decimal:
    """
    Cobro recomendado = suma de precios de los servicios asociados a la cita.
    Nota: usamos Service.price (vía AppointmentServiceLine.service.price).
    """
    lines = (
        AppointmentServiceLine.objects
        .filter(appointment_block__appointment_id=appointment_id)
        .select_related("service")
    )

    total = Decimal("0")
    for line in lines:
        svc = getattr(line, "service", None)
        if svc is None:
            continue
        price = getattr(svc, "price", None)
        if price is None:
            continue
        total += Decimal(str(price))

    return total


class AppointmentChargeSummaryAPIView(APIView):
    """
    Solo recepción (STAFF/ADMIN) ve el cobro recomendado.

    GET /api/appointments/<id>/charge-summary/
    """

    def get(self, request, appointment_id: int):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "No autenticado."}, status=401)

        if not _is_staff_or_admin(user):
            raise PermissionDenied("No tienes permisos para ver el cobro recomendado.")

        try:
            appt = Appointment.objects.get(id=appointment_id)
        except Appointment.DoesNotExist:
            return Response({"detail": "Cita no encontrada."}, status=404)

        recommended = _recommended_total_for_appointment(appt.id)

        payload: Dict[str, Any] = {
            "appointment_id": appt.id,
            "status": appt.status,
            "start_datetime": appt.start_datetime,
            "end_datetime": appt.end_datetime,
            "recommended_total": recommended,
            "paid_total": getattr(appt, "paid_total", None),
            "payment_method": getattr(appt, "payment_method", None),
            "paid_at": getattr(appt, "paid_at", None),
            "paid_by": getattr(appt, "paid_by_id", None),
        }
        return Response(payload, status=200)


class AppointmentCloseAPIView(APIView):
    """
    Cierre operativo de cita (recepción):
    - COMPLETED (atendida): permite registrar cobro real
    - NO_SHOW: marca no asistencia

    POST /api/appointments/<id>/close/
    Body ejemplo:
    {
      "status": "COMPLETED",
      "paid_total": 45000,
      "payment_method": "CASH",
      "note": "Pago en efectivo"
    }

    Para NO_SHOW:
    {
      "status": "NO_SHOW",
      "note": "No asistió"
    }
    """

    ALLOWED_FINAL_STATUSES = {"COMPLETED", "NO_SHOW"}
    ALLOWED_PAYMENT_METHODS = {"CASH", "CARD", "TRANSFER", "OTHER"}

    def post(self, request, appointment_id: int):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "No autenticado."}, status=401)

        if not _is_staff_or_admin(user):
            raise PermissionDenied("No tienes permisos para cerrar/cobrar citas.")

        desired_status = (request.data.get("status") or "").strip().upper()
        note = (request.data.get("note") or "").strip()

        if desired_status not in self.ALLOWED_FINAL_STATUSES:
            return Response(
                {"detail": "status inválido. Use COMPLETED o NO_SHOW."},
                status=400
            )

        payment_method = (request.data.get("payment_method") or "").strip().upper()
        paid_total_raw = request.data.get("paid_total", None)

        with transaction.atomic():
            try:
                appt = Appointment.objects.select_for_update().get(id=appointment_id)
            except Appointment.DoesNotExist:
                return Response({"detail": "Cita no encontrada."}, status=404)

            if appt.status in ("CANCELLED", "COMPLETED", "NO_SHOW"):
                return Response(
                    {"detail": "La cita no se puede cerrar en su estado actual."},
                    status=drf_status.HTTP_409_CONFLICT
                )

            recommended = _recommended_total_for_appointment(appt.id)

            # Si COMPLETED, registrar cobro real
            if desired_status == "COMPLETED":
                try:
                    paid_total = _to_decimal(paid_total_raw)
                except ValueError as e:
                    return
