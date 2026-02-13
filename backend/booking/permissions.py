from __future__ import annotations

from rest_framework.permissions import BasePermission


def _get_role(user) -> str:
    """
    Soporta:
      - user.role (string)
      - user.rol (string)
      - fallback: ""
    """
    if not user or not getattr(user, "is_authenticated", False):
        return ""
    for attr in ("role", "rol"):
        if hasattr(user, attr):
            val = getattr(user, attr)
            if val:
                return str(val).upper()
    return ""


def is_admin_user(user) -> bool:
    return bool(user and user.is_authenticated and (getattr(user, "is_superuser", False) or _get_role(user) == "ADMIN"))


def is_staff_user(user) -> bool:
    # "recepción" normalmente entra aquí
    return bool(user and user.is_authenticated and (getattr(user, "is_staff", False) or _get_role(user) in {"STAFF", "RECEPCION"}))


def is_worker_user(user) -> bool:
    # barbero / uñas / facial
    role = _get_role(user)
    if role in {"WORKER", "BARBER", "BARBERO", "NAILS", "FACIAL"}:
        return True
    return False


class IsAdminOrStaff(BasePermission):
    def has_permission(self, request, view):
        return is_admin_user(request.user) or is_staff_user(request.user)


class IsWorkerOrStaff(BasePermission):
    def has_permission(self, request, view):
        return is_admin_user(request.user) or is_staff_user(request.user) or is_worker_user(request.user)
