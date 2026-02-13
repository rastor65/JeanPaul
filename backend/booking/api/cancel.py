from datetime import timedelta
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status

from accounts.permissions import IsStaffOrAdmin
from booking.models import Appointment, AppointmentAudit


class AppointmentCancelAPIView(APIView):
    permission_classes = [IsStaffOrAdmin]

    def post(self, request, appointment_id: int):
        try:
            appt = Appointment.objects.get(id=appointment_id)
        except Appointment.DoesNotExist:
            return Response({"detail": "Cita no encontrada."}, status=404)

        if appt.status in ("CANCELLED", "NO_SHOW", "COMPLETED"):
            return Response({"detail": "La cita no se puede cancelar en su estado actual."}, status=409)

        now = timezone.now()
        limit = appt.start_datetime - timedelta(minutes=30)

        # Regla: solo se cancela si ahora <= (inicio - 30min)
        if now > limit:
            return Response(
                {"detail": "Solo se puede cancelar hasta 30 minutos antes del turno."},
                status=status.HTTP_409_CONFLICT
            )

        reason = (request.data.get("reason") or "").strip()

        appt.status = "CANCELLED"
        appt.cancelled_at = now if hasattr(appt, "cancelled_at") else appt.start_datetime  # opcional
        appt.save(update_fields=["status"] + (["cancelled_at"] if hasattr(appt, "cancelled_at") else []))

        AppointmentAudit.objects.create(
            appointment=appt,
            action="CANCELLED",
            performed_by=request.user,
            performed_at=now,
            note=reason,
        )

        return Response({"detail": "Cita cancelada.", "id": appt.id, "status": appt.status}, status=200)
