from datetime import datetime, time
from django.utils.timezone import make_aware
from django.db.models import Q
from rest_framework.permissions import IsAuthenticated
from rest_framework.generics import ListAPIView

from booking.models import Appointment
from booking.serializers import AppointmentStaffSerializer


class AppointmentStaffList(ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = AppointmentStaffSerializer

    def get_queryset(self):
        qs = (
            Appointment.objects
            .select_related("customer", "created_by", "paid_by", "cancelled_by")
            .order_by("-start_datetime")
        )

        # Soporta múltiples nombres de params
        qp = self.request.query_params

        from_s = qp.get("from") or qp.get("start") or qp.get("start_date") or qp.get("date_from")
        to_s   = qp.get("to")   or qp.get("end")   or qp.get("end_date")   or qp.get("date_to")

        if from_s and to_s:
            f = make_aware(datetime.combine(datetime.fromisoformat(from_s).date(), time.min))
            t = make_aware(datetime.combine(datetime.fromisoformat(to_s).date(), time.max))
            qs = qs.filter(start_datetime__range=(f, t))

        # filtros opcionales (si quieres usarlos desde la vista)
        status = qp.get("status")
        if status and status != "ALL":
            qs = qs.filter(status=status)

        payment_method = qp.get("payment_method")
        if payment_method == "NONE":
            qs = qs.filter(Q(payment_method__isnull=True) | Q(payment_method=""))
        elif payment_method and payment_method != "ALL":
            qs = qs.filter(payment_method=payment_method)

        worker_id = qp.get("worker_id")
        if worker_id and str(worker_id).isdigit():
            qs = qs.filter(blocks__worker_id=int(worker_id)).distinct()

        q = qp.get("q")
        if q:
            qs = qs.filter(customer__name__icontains=q)

        return qs
