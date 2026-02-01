from rest_framework import serializers
from .models import (
    Customer, Appointment, AppointmentBlock, AppointmentServiceLine
)

class CustomerPublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = Customer
        # El cliente NO debería ver teléfono/fecha nac de otros; para su propia cita sí, pero en MVP lo simplificamos:
        fields = ["id", "customer_type", "name"]


class AppointmentServiceLinePublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = AppointmentServiceLine
        # SIN price_snapshot
        fields = [
            "id",
            "service",
            "service_name_snapshot",
            "duration_minutes_snapshot",
            "buffer_before_snapshot",
            "buffer_after_snapshot",
        ]


class AppointmentBlockPublicSerializer(serializers.ModelSerializer):
    service_lines = AppointmentServiceLinePublicSerializer(many=True, read_only=True)

    class Meta:
        model = AppointmentBlock
        fields = ["id", "sequence", "worker", "start_datetime", "end_datetime", "service_lines"]


class AppointmentPublicSerializer(serializers.ModelSerializer):
    customer = CustomerPublicSerializer(read_only=True)
    blocks = AppointmentBlockPublicSerializer(many=True, read_only=True)

    class Meta:
        model = Appointment
        # SIN recommended_* ni paid_*
        fields = ["id", "status", "start_datetime", "end_datetime", "customer", "blocks", "created_at"]


# -------- STAFF --------

class CustomerStaffSerializer(serializers.ModelSerializer):
    class Meta:
        model = Customer
        fields = ["id", "customer_type", "name", "phone", "birth_date"]


class AppointmentServiceLineStaffSerializer(serializers.ModelSerializer):
    class Meta:
        model = AppointmentServiceLine
        fields = [
            "id",
            "service",
            "service_name_snapshot",
            "duration_minutes_snapshot",
            "buffer_before_snapshot",
            "buffer_after_snapshot",
            "price_snapshot",
        ]


class AppointmentBlockStaffSerializer(serializers.ModelSerializer):
    service_lines = AppointmentServiceLineStaffSerializer(many=True, read_only=True)

    class Meta:
        model = AppointmentBlock
        fields = ["id", "sequence", "worker", "start_datetime", "end_datetime", "service_lines"]


class AppointmentStaffSerializer(serializers.ModelSerializer):
    customer = CustomerStaffSerializer(read_only=True)
    blocks = AppointmentBlockStaffSerializer(many=True, read_only=True)

    class Meta:
        model = Appointment
        fields = [
            "id", "status", "start_datetime", "end_datetime",
            "customer", "blocks",
            "recommended_subtotal", "recommended_discount", "recommended_total",
            "paid_total", "payment_method", "paid_at", "paid_by",
            "created_at", "updated_at"
        ]

class AppointmentWorkerSerializer(serializers.ModelSerializer):
    customer = CustomerPublicSerializer(read_only=True)
    blocks = serializers.SerializerMethodField()

    class Meta:
        model = Appointment
        fields = ["id", "status", "start_datetime", "end_datetime", "customer", "blocks", "created_at"]

    def get_blocks(self, obj):
        worker = self.context.get("worker")
        if not worker:
            return []
        qs = obj.blocks.filter(worker=worker).prefetch_related("service_lines")
        return AppointmentBlockPublicSerializer(qs, many=True).data