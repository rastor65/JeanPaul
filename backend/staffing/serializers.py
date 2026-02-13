from rest_framework import serializers
from staffing.models import Worker


class WorkerPublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = Worker
        fields = ["id", "display_name", "role"]
