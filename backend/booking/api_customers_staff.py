from django.db.models import Q
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateDestroyAPIView
from rest_framework.permissions import IsAuthenticated

from accounts.permissions import IsStaffOrAdmin
from booking.models import Customer
from booking.serializers_staff import CustomerStaffSerializer


class CustomerStaffListCreateAPIView(ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = CustomerStaffSerializer
    queryset = Customer.objects.all().order_by("-id")

    def get_queryset(self):
        qs = super().get_queryset()
        q = (self.request.query_params.get("q") or "").strip()
        ctype = (self.request.query_params.get("customer_type") or "").strip()

        if q:
            qs = qs.filter(
                Q(name__icontains=q) |
                Q(phone__icontains=q)
            )

        if ctype in ("CASUAL", "FREQUENT"):
            qs = qs.filter(customer_type=ctype)

        return qs


class CustomerStaffDetailAPIView(RetrieveUpdateDestroyAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = CustomerStaffSerializer
    queryset = Customer.objects.all()
