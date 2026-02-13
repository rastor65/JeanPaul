from django.db.models import Q
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateDestroyAPIView
from rest_framework.permissions import IsAuthenticated

from accounts.permissions import IsStaffOrAdmin
from staffing.models import Worker
from staffing.serializers_staff import WorkerStaffSerializer


class WorkerStaffManageListCreateAPIView(ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerStaffSerializer
    queryset = Worker.objects.select_related("user").all().order_by("id")

    def get_queryset(self):
        qs = super().get_queryset()

        q = (self.request.query_params.get("q") or "").strip()
        role = (self.request.query_params.get("role") or "").strip()
        active = self.request.query_params.get("active")

        if q:
            qs = qs.filter(
                Q(display_name__icontains=q) |
                Q(user__username__icontains=q) |
                Q(user__email__icontains=q) |
                Q(user__phone__icontains=q)
            )

        if role:
            qs = qs.filter(role=role)

        if active in ("true", "false"):
            qs = qs.filter(active=(active == "true"))

        return qs


class WorkerStaffManageDetailAPIView(RetrieveUpdateDestroyAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerStaffSerializer
    queryset = Worker.objects.select_related("user").all()

    def perform_destroy(self, instance):
        # Soft delete (desactivar)
        instance.active = False
        instance.save(update_fields=["active"])
