from __future__ import annotations

from rest_framework import serializers

from booking.models import Appointment, AppointmentBlock, AppointmentServiceLine


def _worker_payload(worker) -> dict:
    """
    Ajustado a tu modelo staffing.Worker:
      - display_name (obligatorio)
      - role
      - active
      - user (opcional)
    """
    if not worker:
        return {"id": None, "display_name": "", "role": None, "active": False, "username": ""}

    username = ""
    try:
        if getattr(worker, "user", None):
            username = getattr(worker.user, "username", "") or ""
    except Exception:
        username = ""

    return {
        "id": getattr(worker, "id", None),
        "display_name": getattr(worker, "display_name", "") or "",
        "role": getattr(worker, "role", None),
        "active": bool(getattr(worker, "active", False)),
        "username": username,
    }


class AppointmentServiceLineSerializer(serializers.ModelSerializer):
    service_id = serializers.IntegerField(source="service.id", read_only=True)

    class Meta:
        model = AppointmentServiceLine
        fields = [
            "id",
            "service_id",
            "service_name_snapshot",
            "duration_minutes_snapshot",
            "buffer_before_snapshot",
            "buffer_after_snapshot",
            "buffer_after_snapshot",
            "price_snapshot",
        ]


class AppointmentBlockPublicSerializer(serializers.ModelSerializer):
    worker = serializers.SerializerMethodField()
    service_lines = AppointmentServiceLineSerializer(many=True, read_only=True)

    class Meta:
        model = AppointmentBlock
        fields = [
            "id",
            "sequence",
            "start_datetime",
            "end_datetime",
            "worker",
            "service_lines",
        ]

    def get_worker(self, obj):
        return _worker_payload(getattr(obj, "worker", None))


class AppointmentBaseSerializer(serializers.ModelSerializer):
    customer = serializers.SerializerMethodField()
    blocks = serializers.SerializerMethodField()

    class Meta:
        model = Appointment
        fields = [
            "id",
            "start_datetime",
            "end_datetime",
            "status",
            "customer",
            "blocks",
        ]

    def get_customer(self, obj):
        c = getattr(obj, "customer", None)
        if not c:
            return None
        return {
            "id": getattr(c, "id", None),
            "name": getattr(c, "name", "") or "",
            "phone": getattr(c, "phone", None),
            "customer_type": getattr(c, "customer_type", None),
        }

    def get_blocks(self, obj):
        # En agenda.py ya lo prefetchamos, así que esto no debe disparar N+1.
        blocks_rel = getattr(obj, "blocks", None)
        blocks = list(blocks_rel.all()) if blocks_rel is not None else []
        return AppointmentBlockPublicSerializer(blocks, many=True).data


class AppointmentStaffSerializer(AppointmentBaseSerializer):
    recommended_subtotal = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)
    recommended_discount = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)
    recommended_total = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)

    paid_total = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)
    payment_method = serializers.CharField(read_only=True)
    paid_at = serializers.DateTimeField(read_only=True)

    class Meta(AppointmentBaseSerializer.Meta):
        fields = AppointmentBaseSerializer.Meta.fields + [
            "recommended_subtotal",
            "recommended_discount",
            "recommended_total",
            "paid_total",
            "payment_method",
            "paid_at",
        ]


class AppointmentWorkerSerializer(AppointmentBaseSerializer):
    recommended_total = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)

    class Meta(AppointmentBaseSerializer.Meta):
        fields = AppointmentBaseSerializer.Meta.fields + [
            "recommended_total",
        ]
