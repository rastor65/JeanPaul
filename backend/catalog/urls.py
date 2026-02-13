from django.urls import path

from catalog.api import (
    ServicePublicListAPIView,
    ServiceStaffListCreateAPIView,
    ServiceStaffDetailAPIView,
    ServiceCategoryPublicListAPIView,
    ServiceCategoryStaffListCreateAPIView,
    ServiceCategoryStaffDetailAPIView,
)

urlpatterns = [
    # Público
    path("public/services/", ServicePublicListAPIView.as_view(), name="public-services"),
    path("public/service-categories/", ServiceCategoryPublicListAPIView.as_view(), name="public-service-categories"),

    # Staff/Admin (CRUD)
    path("staff/services/", ServiceStaffListCreateAPIView.as_view(), name="staff-services"),
    path("staff/services/<int:pk>/", ServiceStaffDetailAPIView.as_view(), name="staff-service-detail"),

    path("staff/service-categories/", ServiceCategoryStaffListCreateAPIView.as_view(), name="staff-service-categories"),
    path("staff/service-categories/<int:pk>/", ServiceCategoryStaffDetailAPIView.as_view(), name="staff-service-category-detail"),
]
