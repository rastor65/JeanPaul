from django.urls import path

from accounts.views import (
    RegisterAPIView,
    LoginAPIView,
    RefreshAPIView,
    LogoutAPIView,
    MeAPIView,
)

from accounts.api_staff import (
    UserStaffListCreateAPIView,
    UserStaffRetrieveUpdateAPIView,
    UserStaffResetPasswordAPIView,
    CustomerStaffListCreateAPIView,
    CustomerStaffRetrieveUpdateAPIView,
)

urlpatterns = [
    # Auth (cookies JWT)
    path("auth/register/", RegisterAPIView.as_view(), name="auth-register"),
    path("auth/login/", LoginAPIView.as_view(), name="auth-login"),
    path("auth/refresh/", RefreshAPIView.as_view(), name="auth-refresh"),
    path("auth/logout/", LogoutAPIView.as_view(), name="auth-logout"),
    path("auth/me/", MeAPIView.as_view(), name="auth-me"),

    # Staff/Admin: Users
    path("staff/users/", UserStaffListCreateAPIView.as_view(), name="staff-users"),
    path("staff/users/<int:pk>/", UserStaffRetrieveUpdateAPIView.as_view(), name="staff-user-detail"),
    path("staff/users/<int:pk>/reset-password/", UserStaffResetPasswordAPIView.as_view(), name="staff-user-reset-password"),

    # Staff/Admin: Customers (desde booking.Customer)
    path("staff/customers/", CustomerStaffListCreateAPIView.as_view(), name="staff-customers"),
    path("staff/customers/<int:pk>/", CustomerStaffRetrieveUpdateAPIView.as_view(), name="staff-customer-detail"),
]
