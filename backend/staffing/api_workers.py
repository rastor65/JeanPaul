from rest_framework.generics import ListAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework import serializers

from accounts.permissions import IsStaffOrAdmin
from staffing.models import Worker


class WorkerTinySerializer(serializers.ModelSerializer):
    label = serializers.SerializerMethodField()

    class Meta:
        model = Worker
        fields = ["id", "label"]

    def get_label(self, obj):
        # usa __str__ del modelo Worker
        return str(obj)


class WorkerStaffListAPIView(ListAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerTinySerializer

    def get_queryset(self):
        return Worker.objects.all().order_by("id")
