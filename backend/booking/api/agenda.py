from datetime import datetime, time, timedelta
from django.utils import timezone
from django.db.models import Prefetch
from rest_framework.generics import ListAPIView
from rest_framework.permissions import IsAuthenticated

from accounts.permissions import IsStaffOrAdmin, IsWorker
from booking.models import Appointment, AppointmentBlock, AppointmentServiceLine
from booking.serializers import AppointmentStaffSerializer, AppointmentWorkerSerializer


def _parse_range(request):
    """
    from/to en formato YYYY-MM-DD.
    Rango inclusivo en fechas -> convertimos a [from 00:00, to+1 00:00)
    """
    from_str = request.query_params.get("from")
    to_str = request.query_params.get("to")
    if not from_str or not to_str:
        raise ValueError("Parámetros requeridos: from y to (YYYY-MM-DD).")

    from_date = datetime.fromisoformat(from_str).date()
    to_date = datetime.fromisoformat(to_str).date()

    start_dt = timezone.make_aware(datetime.combine(from_date, time.min))
    end_dt = timezone.make_aware(datetime.combine(to_date + timedelta(days=1), time.min))
    return start_dt, end_dt


class StaffAgendaAPIView(ListAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = AppointmentStaffSerializer

    def get_queryset(self):
        start_dt, end_dt = _parse_range(self.request)

        blocks_qs = (
            AppointmentBlock.objects
            .select_related("worker")
            .prefetch_related("service_lines")
        )

        return (
            Appointment.objects
            .filter(start_datetime__gte=start_dt, start_datetime__lt=end_dt)
            .select_related("customer", "created_by", "cancelled_by", "paid_by")
            .prefetch_related(Prefetch("blocks", queryset=blocks_qs))
            .order_by("start_datetime")
        )


class MyAgendaAPIView(ListAPIView):
    permission_classes = [IsAuthenticated, IsWorker]
    serializer_class = AppointmentWorkerSerializer

    def get_queryset(self):
        start_dt, end_dt = _parse_range(self.request)

        # worker asociado al usuario
        worker = getattr(self.request.user, "worker_profile", None)
        if worker is None:
            # fallback por si tu relación tiene otro nombre
            worker = getattr(self.request.user, "worker", None)

        blocks_qs = (
            AppointmentBlock.objects
            .filter(worker=worker)
            .select_related("worker")
            .prefetch_related("service_lines")
        )

        return (
            Appointment.objects
            .filter(start_datetime__gte=start_dt, start_datetime__lt=end_dt, blocks__worker=worker)
            .select_related("customer")
            .prefetch_related(Prefetch("blocks", queryset=blocks_qs))
            .distinct()
            .order_by("start_datetime")
        )

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        worker = getattr(self.request.user, "worker_profile", None)
        if worker is None:
            worker = getattr(self.request.user, "worker", None)
        ctx["worker"] = worker
        return ctx
