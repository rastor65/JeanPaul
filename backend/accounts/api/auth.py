from __future__ import annotations

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken


User = get_user_model()


def _set_auth_cookies(resp: Response, *, access: str, refresh: str) -> None:
    access_age = int(settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"].total_seconds())
    refresh_age = int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds())

    resp.set_cookie(
        key=settings.JWT_COOKIE_ACCESS,
        value=access,
        max_age=access_age,
        httponly=settings.JWT_COOKIE_HTTPONLY,
        secure=settings.JWT_COOKIE_SECURE,
        samesite=settings.JWT_COOKIE_SAMESITE,
        path=settings.JWT_COOKIE_PATH,
        domain=settings.JWT_COOKIE_DOMAIN,
    )
    resp.set_cookie(
        key=settings.JWT_COOKIE_REFRESH,
        value=refresh,
        max_age=refresh_age,
        httponly=settings.JWT_COOKIE_HTTPONLY,
        secure=settings.JWT_COOKIE_SECURE,
        samesite=settings.JWT_COOKIE_SAMESITE,
        path=settings.JWT_COOKIE_PATH,
        domain=settings.JWT_COOKIE_DOMAIN,
    )


def _clear_auth_cookies(resp: Response) -> None:
    resp.delete_cookie(settings.JWT_COOKIE_ACCESS, path=settings.JWT_COOKIE_PATH, domain=settings.JWT_COOKIE_DOMAIN)
    resp.delete_cookie(settings.JWT_COOKIE_REFRESH, path=settings.JWT_COOKIE_PATH, domain=settings.JWT_COOKIE_DOMAIN)


def _user_payload(user) -> dict:
    # Ajusta aquí si tu User tiene campos distintos
    return {
        "id": user.id,
        "username": getattr(user, "username", ""),
        "email": getattr(user, "email", ""),
        "role": getattr(user, "role", None),
    }


class RegisterAPIView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}

        username = str(data.get("username", "")).strip()
        password = str(data.get("password", "")).strip()
        email = str(data.get("email", "")).strip()

        if not username or not password:
            return Response({"detail": "username y password son requeridos."}, status=400)

        if User.objects.filter(username=username).exists():
            return Response({"detail": "El username ya existe."}, status=409)

        user = User.objects.create_user(username=username, email=email)
        user.set_password(password)

        # Si tu User tiene campo role, lo seteamos si viene
        if hasattr(user, "role") and data.get("role"):
            user.role = data["role"]

        user.save()

        refresh = RefreshToken.for_user(user)
        access = str(refresh.access_token)

        resp = Response(_user_payload(user), status=201)
        _set_auth_cookies(resp, access=access, refresh=str(refresh))
        return resp


class LoginAPIView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}

        username = str(data.get("username", "")).strip()
        password = str(data.get("password", "")).strip()

        if not username or not password:
            return Response({"detail": "username y password son requeridos."}, status=400)

        user = authenticate(request, username=username, password=password)
        if not user:
            return Response({"detail": "Credenciales inválidas."}, status=401)

        refresh = RefreshToken.for_user(user)
        access = str(refresh.access_token)

        resp = Response(_user_payload(user), status=200)
        _set_auth_cookies(resp, access=access, refresh=str(refresh))
        return resp


class RefreshAPIView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        refresh_cookie = request.COOKIES.get(settings.JWT_COOKIE_REFRESH)
        if not refresh_cookie:
            return Response({"detail": "No hay refresh token."}, status=401)

        try:
            refresh = RefreshToken(refresh_cookie)
            access = str(refresh.access_token)
        except TokenError:
            return Response({"detail": "Refresh inválido o expirado."}, status=401)

        resp = Response({"detail": "OK"}, status=200)
        # Re-emitimos cookies (access nuevo)
        _set_auth_cookies(resp, access=access, refresh=str(refresh))
        return resp


class LogoutAPIView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        resp = Response({"detail": "OK"}, status=200)
        _clear_auth_cookies(resp)
        return resp


class MeAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(_user_payload(request.user), status=200)
