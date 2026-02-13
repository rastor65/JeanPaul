from __future__ import annotations

from django.conf import settings
from django.core import signing


# Tiempo de vida del option_id (segundos).
# Puedes sobreescribirlo en settings.py como BOOKING_OPTION_TTL_SECONDS = 300
DEFAULT_TTL_SECONDS = int(getattr(settings, "BOOKING_OPTION_TTL_SECONDS", 300))

# Salt fijo para que no se mezclen firmas con otros tokens del proyecto
OPTION_SALT = "booking.option.v1"


def encode_option_id(data: dict) -> str:
    """
    Firma un dict (serializable a JSON) y devuelve un string seguro.
    Normalmente data contiene:
      - appointment_start, appointment_end (ISO strings)
      - blocks: lista con worker_id, start, end, sequence, service_ids, etc.
    """
    return signing.dumps(data, salt=OPTION_SALT, compress=True)


def decode_option_id(token: str, *, max_age: int | None = None) -> dict:
    """
    Valida el token y devuelve el dict original.
    Si expira o es inválido, lanza signing.BadSignature / signing.SignatureExpired.
    """
    age = DEFAULT_TTL_SECONDS if max_age is None else int(max_age)
    return signing.loads(token, salt=OPTION_SALT, max_age=age)
