from __future__ import annotations

from datetime import timedelta
from typing import Tuple

from django.db import transaction
from django.utils import timezone

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status

from booking.models import Appointment, AppointmentBlock

# Si tienes AppointmentAudit, lo intentamos usar sin romper el arranque
try:
    from booking.models import AppointmentAudit
except Exception:  # pragma: no cover
    AppointmentAudit = None


def _is_staff_or_admin(user) -> bool:
    role = (getattr(user, "role", "") or "").upper()
    return role in ("ADMIN", "STAFF")


def _block_datetime_field_names() -> Tuple[str, str]:
    field_names = {f.name for f in AppointmentBlock._meta.fields}
    if {"start_datetime", "end_datetime"} <= field_names:
        return "start_datetime", "end_datetime"
    if {"start", "end"} <= field_names:
        return "start", "end"
    raise AttributeError(
        "No encuentro campos de fecha en AppointmentBlock "
        "(start_datetime/end_datetime o start/end)."
    )


class AppointmentInlineEditAPIView(APIView):
    """
    Edición rápida SIN disponibilidad (solo STAFF/ADMIN).

    POST:
    {
      "duration_minutes": 60,
      "service_ids": [1,2,3],   # opcional (solo si tu modelo soporta appt.services)
      "note": "opcional"
    }
    """

    def post(self, request, appointment_id: int):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "No autenticado."}, status=401)

        duration = request.data.get("duration_minutes", None)
        note = (request.data.get("note") or "").strip()
        service_ids = request.data.get("service_ids", None)

        try:
            duration = int(duration)
        except Exception:
            duration = 0

        if duration <= 0:
            return Response(
                {"detail": "duration_minutes es requerido y debe ser > 0."},
                status=400
            )

        start_field, end_field = _block_datetime_field_names()

        with transaction.atomic():
            try:
                appt = Appointment.objects.select_for_update().get(id=appointment_id)
            except Appointment.DoesNotExist:
                return Response({"detail": "Cita no encontrada."}, status=404)

            # No validamos disponibilidad, ni ventana de 30 minutos, ni solapes.
            before_end = appt.end_datetime
            new_end = appt.start_datetime + timedelta(minutes=duration)

            appt.end_datetime = new_end

            update_fields = ["end_datetime"]

            # Si tienes campo note en Appointment
            if hasattr(appt, "note"):
                appt.note = note
                update_fields.append("note")

            appt.save(update_fields=list(set(update_fields)))

            # Actualiza bloques: por seguridad igualamos el final al nuevo end
            blocks = list(AppointmentBlock.objects.filter(appointment_id=appt.id))
            for b in blocks:
                setattr(b, end_field, new_end)
                b.save(update_fields=[end_field])

            # Si tu Appointment tiene M2M services, intentamos setear sin romper si no existe
            if service_ids is not None and hasattr(appt, "services"):
                try:
                    ids = [int(x) for x in (service_ids or [])]
                    ServiceModel = appt.services.model
                    services = list(ServiceModel.objects.filter(id__in=ids))
                    if len(services) == len(ids):
                        appt.services.set(services)
                except Exception:
                    pass

            # Audit (si existe y cuadra con tu modelo)
            if AppointmentAudit is not None:
                try:
                    AppointmentAudit.objects.create(
                        appointment=appt,
                        action="INLINE_EDIT",
                        performed_by=user,
                        performed_at=timezone.now(),
                        note=f"end: {before_end.isoformat()} -> {new_end.isoformat()} | note={note}" if note else
                             f"end: {before_end.isoformat()} -> {new_end.isoformat()}",
                    )
                except Exception:
                    pass

            return Response(
                {
                    "id": appt.id,
                    "status": appt.status,
                    "start_datetime": appt.start_datetime,
                    "end_datetime": appt.end_datetime,
                    "detail": "Edición aplicada (sin validar disponibilidad).",
                },
                status=status.HTTP_200_OK
            )
