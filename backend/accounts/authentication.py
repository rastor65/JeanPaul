from django.conf import settings
from rest_framework_simplejwt.authentication import JWTAuthentication


class CookieJWTAuthentication(JWTAuthentication):
    """
    Autenticación por JWT en cookie HttpOnly (access).
    Lee el token desde request.COOKIES[settings.JWT_COOKIE_ACCESS]
    """

    def authenticate(self, request):
        raw_token = request.COOKIES.get(getattr(settings, "JWT_COOKIE_ACCESS", "jp_access"))
        if not raw_token:
            return None

        validated_token = self.get_validated_token(raw_token)
        user = self.get_user(validated_token)
        return (user, validated_token)
