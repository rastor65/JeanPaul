from rest_framework.generics import (
    ListAPIView,
    ListCreateAPIView,
    RetrieveUpdateDestroyAPIView,
)
from rest_framework.permissions import AllowAny, IsAuthenticated

from accounts.permissions import IsStaffOrAdmin
from catalog.models import Service, ServiceCategory
from catalog.serializers import (
    ServicePublicSerializer,
    ServiceStaffSerializer,
    ServiceCategoryPublicSerializer,
    ServiceCategoryStaffSerializer,
)


# --------------------------
# PUBLIC
# --------------------------
class ServicePublicListAPIView(ListAPIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    serializer_class = ServicePublicSerializer

    def get_queryset(self):
        return (
            Service.objects.select_related("category")
            .filter(active=True, category__active=True)
            .order_by("category__name", "name")
        )


class ServiceCategoryPublicListAPIView(ListAPIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    serializer_class = ServiceCategoryPublicSerializer

    def get_queryset(self):
        return ServiceCategory.objects.filter(active=True).order_by("name")


# --------------------------
# STAFF / ADMIN  (CRUD)
# --------------------------
class ServiceStaffListCreateAPIView(ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = ServiceStaffSerializer

    def get_queryset(self):
        return (
            Service.objects.select_related("category", "fixed_worker")
            .all()
            .order_by("category__name", "name")
        )


class ServiceStaffDetailAPIView(RetrieveUpdateDestroyAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = ServiceStaffSerializer

    def get_queryset(self):
        return Service.objects.select_related("category", "fixed_worker").all()


class ServiceCategoryStaffListCreateAPIView(ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = ServiceCategoryStaffSerializer

    def get_queryset(self):
        return ServiceCategory.objects.select_related("default_fixed_worker").all().order_by("name")


class ServiceCategoryStaffDetailAPIView(RetrieveUpdateDestroyAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = ServiceCategoryStaffSerializer

    def get_queryset(self):
        return ServiceCategory.objects.select_related("default_fixed_worker").all()
