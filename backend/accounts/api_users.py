from django.contrib.auth import get_user_model
from django.db.models import Q
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateDestroyAPIView
from rest_framework.permissions import IsAuthenticated

from accounts.permissions import IsStaffOrAdmin
from accounts.serializers_staff import UserStaffSerializer

User = get_user_model()


class UserStaffListCreateAPIView(ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = UserStaffSerializer
    queryset = User.objects.all().order_by("id")

    def get_queryset(self):
        qs = super().get_queryset()
        q = (self.request.query_params.get("q") or "").strip()
        if q:
            qs = qs.filter(
                Q(username__icontains=q) |
                Q(email__icontains=q) |
                Q(phone__icontains=q)
            )
        return qs


class UserStaffDetailAPIView(RetrieveUpdateDestroyAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = UserStaffSerializer
    queryset = User.objects.all()

    def perform_destroy(self, instance):
        # Soft delete recomendado
        instance.is_active = False
        instance.save(update_fields=["is_active"])
