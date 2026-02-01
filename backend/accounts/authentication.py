from django.conf import settings
from rest_framework_simplejwt.authentication import JWTAuthentication


class CookieJWTAuthentication(JWTAuthentication):
    """
    Intenta primero header Authorization: Bearer <token>.
    Si no existe, usa cookie HttpOnly "access".
    """
    def authenticate(self, request):
        header = self.get_header(request)
        if header is not None:
            raw = self.get_raw_token(header)
            if raw is None:
                return None
            validated = self.get_validated_token(raw)
            return self.get_user(validated), validated

        cookie_name = getattr(settings, "JWT_COOKIE_ACCESS", "access")
        raw_token = request.COOKIES.get(cookie_name)
        if not raw_token:
            return None

        validated = self.get_validated_token(raw_token)
        return self.get_user(validated), validated
