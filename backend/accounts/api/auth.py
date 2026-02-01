from django.conf import settings
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth import authenticate, get_user_model

from accounts.serializers import RegisterSerializer

User = get_user_model()


def _set_auth_cookies(response: Response, access: str, refresh: str):
    response.set_cookie(
        key=settings.JWT_COOKIE_ACCESS,
        value=access,
        httponly=True,
        secure=getattr(settings, "JWT_COOKIE_SECURE", False),
        samesite=getattr(settings, "JWT_COOKIE_SAMESITE", "Lax"),
        domain=getattr(settings, "JWT_COOKIE_DOMAIN", None),
        path="/",
    )
    response.set_cookie(
        key=settings.JWT_COOKIE_REFRESH,
        value=refresh,
        httponly=True,
        secure=getattr(settings, "JWT_COOKIE_SECURE", False),
        samesite=getattr(settings, "JWT_COOKIE_SAMESITE", "Lax"),
        domain=getattr(settings, "JWT_COOKIE_DOMAIN", None),
        path="/",
    )


def _clear_auth_cookies(response: Response):
    response.delete_cookie(settings.JWT_COOKIE_ACCESS, path="/")
    response.delete_cookie(settings.JWT_COOKIE_REFRESH, path="/")


class RegisterAPIView(APIView):
    permission_classes = [AllowAny]  # en producción: restringir a admin/staff

    def post(self, request):
        ser = RegisterSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = ser.save()
        return Response({"id": user.id, "username": user.username, "role": getattr(user, "role", None)}, status=201)


class LoginAPIView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        username = request.data.get("username")
        password = request.data.get("password")

        user = authenticate(request, username=username, password=password)
        if not user:
            return Response({"detail": "Credenciales inválidas."}, status=status.HTTP_401_UNAUTHORIZED)

        refresh = RefreshToken.for_user(user)
        access = str(refresh.access_token)

        resp = Response(
            {"id": user.id, "username": user.username, "role": getattr(user, "role", None)},
            status=200
        )
        _set_auth_cookies(resp, access=access, refresh=str(refresh))
        return resp


class RefreshAPIView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        refresh_cookie = request.COOKIES.get(settings.JWT_COOKIE_REFRESH)
        if not refresh_cookie:
            return Response({"detail": "No refresh token."}, status=401)

        try:
            refresh = RefreshToken(refresh_cookie)
            new_access = str(refresh.access_token)

            # Rotación: si ROTATE_REFRESH_TOKENS=True, se emite uno nuevo
            new_refresh = str(refresh)  # por defecto el mismo objeto ya queda rotado internamente
        except Exception:
            return Response({"detail": "Refresh inválido."}, status=401)

        resp = Response({"detail": "Token renovado."}, status=200)
        _set_auth_cookies(resp, access=new_access, refresh=new_refresh)
        return resp


class LogoutAPIView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        resp = Response({"detail": "Logout OK."}, status=200)
        _clear_auth_cookies(resp)
        return resp


class MeAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        u = request.user
        return Response({"id": u.id, "username": u.username, "role": getattr(u, "role", None)}, status=200)
