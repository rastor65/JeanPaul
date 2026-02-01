from rest_framework import serializers
from .models import Service, ServiceCategory


class ServiceCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = ServiceCategory
        fields = ["id", "name"]


class ServicePublicSerializer(serializers.ModelSerializer):
    category = ServiceCategorySerializer(read_only=True)

    class Meta:
        model = Service
        # SIN price
        fields = [
            "id", "name", "category",
            "duration_minutes", "buffer_before_minutes", "buffer_after_minutes",
            "description", "requirements", "active"
        ]


class ServiceStaffSerializer(serializers.ModelSerializer):
    category = ServiceCategorySerializer(read_only=True)

    class Meta:
        model = Service
        # CON price
        fields = [
            "id", "name", "category",
            "duration_minutes", "buffer_before_minutes", "buffer_after_minutes",
            "price",
            "description", "requirements", "active",
            "assignment_type", "fixed_worker"
        ]
