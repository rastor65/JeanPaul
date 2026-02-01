from rest_framework.permissions import BasePermission


class IsStaffOrAdmin(BasePermission):
    def has_permission(self, request, view):
        u = request.user
        if not u or not u.is_authenticated:
            return False

        # Compatible con:
        # - is_staff / is_superuser
        # - role en el usuario (ADMIN/STAFF)
        role = getattr(u, "role", None)
        return bool(getattr(u, "is_superuser", False) or getattr(u, "is_staff", False) or role in ("ADMIN", "STAFF"))


class IsWorker(BasePermission):
    def has_permission(self, request, view):
        u = request.user
        if not u or not u.is_authenticated:
            return False

        # Compatible con:
        # - role = WORKER
        # - relación OneToOne: user.worker_profile
        role = getattr(u, "role", None)
        has_profile = hasattr(u, "worker_profile") or hasattr(u, "worker_profile_id") or hasattr(u, "worker_profile")
        return bool(role == "WORKER" or has_profile)
