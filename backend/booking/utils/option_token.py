import json
from django.core import signing

OPTION_SALT = "booking.option.v1"

def make_option_token(payload: dict) -> str:
    # payload debe ser JSON-serializable
    return signing.dumps(payload, salt=OPTION_SALT, compress=True)

def read_option_token(token: str, max_age_seconds: int) -> dict:
    # Lanza signing.BadSignature o signing.SignatureExpired si falla
    return signing.loads(token, salt=OPTION_SALT, max_age=max_age_seconds)
