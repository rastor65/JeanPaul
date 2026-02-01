from django.urls import path
from accounts.api.auth import RegisterAPIView, LoginAPIView, LogoutAPIView, RefreshAPIView, MeAPIView

urlpatterns = [
    path("auth/register/", RegisterAPIView.as_view()),
    path("auth/login/", LoginAPIView.as_view()),
    path("auth/logout/", LogoutAPIView.as_view()),
    path("auth/refresh/", RefreshAPIView.as_view()),
    path("auth/me/", MeAPIView.as_view()),
]
