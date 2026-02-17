from __future__ import annotations

from decimal import Decimal
from typing import Optional

from rest_framework import serializers

from booking.models import Appointment, AppointmentBlock, AppointmentServiceLine


def _d(v) -> Decimal:
    try:
        return Decimal(str(v)) if v is not None else Decimal("0")
    except Exception:
        return Decimal("0")


def _worker_display(worker) -> dict:
    if not worker:
        return {"id": None, "name": "", "username": ""}

    # Intentar sacar un nombre bonito sin asumir estructura exacta
    name = getattr(worker, "name", None) or getattr(worker, "full_name", None)

    if not name and hasattr(worker, "user") and worker.user:
        try:
            name = worker.user.get_full_name()
        except Exception:
            name = None

    if not name:
        first = getattr(worker, "first_name", "") or ""
        last = getattr(worker, "last_name", "") or ""
        name = (f"{first} {last}").strip()

    username = getattr(worker, "username", None)
    if not username and hasattr(worker, "user") and worker.user:
        username = getattr(worker.user, "username", None)

    return {
        "id": getattr(worker, "id", None),
        "name": name or "",
        "username": username or "",
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
        return _worker_display(getattr(obj, "worker", None))


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
        # Si viene prefetched, DRF ya lo usa sin golpear DB.
        # Si no, Django consulta; pero en agenda.py ya lo prefetcheamos.
        blocks_qs = getattr(obj, "blocks", None)
        blocks = list(blocks_qs.all()) if blocks_qs is not None else []
        return AppointmentBlockPublicSerializer(blocks, many=True).data


class AppointmentStaffSerializer(AppointmentBaseSerializer):
    # Usa el campo ya calculado en Appointment (cero queries extra)
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
    # El trabajador puede ver el total recomendado (si lo necesitas)
    recommended_total = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)

    class Meta(AppointmentBaseSerializer.Meta):
        fields = AppointmentBaseSerializer.Meta.fields + [
            "recommended_total",
        ]
