from rest_framework.generics import ListAPIView
from rest_framework.permissions import AllowAny

from staffing.models import Worker
from staffing.serializers import WorkerPublicSerializer


class PublicBarberListAPIView(ListAPIView):
    """
    Lista pública de barberos activos.
    """
    permission_classes = [AllowAny]
    authentication_classes = []
    serializer_class = WorkerPublicSerializer

    def get_queryset(self):
        return (
            Worker.objects
            .filter(active=True, role=Worker.ROLE_BARBER)
            .order_by("display_name")
        )
