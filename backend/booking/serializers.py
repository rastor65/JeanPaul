from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import serializers

from booking.models import Appointment, AppointmentBlock, AppointmentServiceLine, Customer


class CustomerPublicSerializer(serializers.ModelSerializer):
    phone = serializers.SerializerMethodField()
    birth_date = serializers.SerializerMethodField()

    class Meta:
        model = Customer
        fields = ["id", "name", "phone", "birth_date"]

    def get_phone(self, obj: Customer) -> str | None:
        return getattr(obj, "phone", None)

    def get_birth_date(self, obj: Customer) -> Any:
        return getattr(obj, "birth_date", None)


class ServiceSummarySerializer(serializers.Serializer):
    id = serializers.IntegerField()
    name = serializers.CharField()
    duration_minutes = serializers.IntegerField()
    buffer_before = serializers.IntegerField()
    buffer_after = serializers.IntegerField()
    price = serializers.DecimalField(max_digits=12, decimal_places=2)

    @staticmethod
    def from_service(service) -> dict:
        """
        Construye un dict seguro sin asumir nombres exactos de campos.
        """
        duration = (
            getattr(service, "duration_minutes", None)
            or getattr(service, "duration", None)
            or getattr(service, "duracion", None)
            or 0
        )
        buffer_before = getattr(service, "buffer_before", None) or getattr(service, "tiempo_extra_antes", None) or 0
        buffer_after = getattr(service, "buffer_after", None) or getattr(service, "tiempo_extra_despues", None) or 0
        price = getattr(service, "price", None) or getattr(service, "precio", None) or Decimal("0")

        return {
            "id": service.id,
            "name": getattr(service, "name", str(service)),
            "duration_minutes": int(duration),
            "buffer_before": int(buffer_before),
            "buffer_after": int(buffer_after),
            "price": Decimal(str(price)),
        }


class AppointmentBlockPublicSerializer(serializers.ModelSerializer):
    worker_label = serializers.SerializerMethodField()
    services = serializers.SerializerMethodField()

    class Meta:
        model = AppointmentBlock
        fields = [
            "id",
            "sequence",
            "worker",
            "worker_label",
            "start_datetime",
            "end_datetime",
            "services",
        ]

    def get_worker_label(self, obj: AppointmentBlock) -> str:
        wk = getattr(obj, "worker", None)
        return str(wk) if wk is not None else "-"

    def get_services(self, obj: AppointmentBlock):
        lines = (
            AppointmentServiceLine.objects
            .filter(appointment_block=obj)
            .select_related("service")
        )
        payload = []
        for ln in lines:
            svc = getattr(ln, "service", None)
            if svc is None:
                continue
            payload.append(ServiceSummarySerializer.from_service(svc))
        return payload


class AppointmentBaseSerializer(serializers.ModelSerializer):
    customer = serializers.SerializerMethodField()
    blocks = serializers.SerializerMethodField()
    recommended_total = serializers.SerializerMethodField()

    class Meta:
        model = Appointment
        fields = [
            "id",
            "status",
            "start_datetime",
            "end_datetime",
            "customer",
            "blocks",
            "recommended_total",
        ]
 
    def get_customer(self, obj: Appointment):
        cust = getattr(obj, "customer", None)
        if cust is None:
            # fallback por si guardas el nombre directamente en appointment
            name = getattr(obj, "customer_name", None) or getattr(obj, "name", None)
            return {"id": None, "name": name or "Sin nombre", "phone": None, "birth_date": None}
        return CustomerPublicSerializer(cust).data

    def get_blocks(self, obj: Appointment):
        blocks = (
            AppointmentBlock.objects
            .filter(appointment=obj)
            .select_related("worker")
            .order_by("sequence", "start_datetime")
        )
        return AppointmentBlockPublicSerializer(blocks, many=True).data

    def get_recommended_total(self, obj: Appointment) -> str:
        """
        Cobro recomendado: suma de los precios de los servicios.
        """
        lines = (
            AppointmentServiceLine.objects
            .filter(appointment_block__appointment=obj)
            .select_related("service")
        )
        total = Decimal("0")
        for ln in lines:
            svc = getattr(ln, "service", None)
            if svc is None:
                continue
            price = getattr(svc, "price", None) or getattr(svc, "precio", None) or Decimal("0")
            total += Decimal(str(price))
        return str(total)


class AppointmentStaffSerializer(AppointmentBaseSerializer):
    """
    Para recepción: incluye además el pago real si existe.
    """
    paid_total = serializers.SerializerMethodField()
    payment_method = serializers.SerializerMethodField()
    paid_at = serializers.SerializerMethodField()
    paid_by = serializers.SerializerMethodField()

    class Meta(AppointmentBaseSerializer.Meta):
        fields = AppointmentBaseSerializer.Meta.fields + [
            "paid_total",
            "payment_method",
            "paid_at",
            "paid_by",
        ]

    def get_paid_total(self, obj: Appointment):
        return getattr(obj, "paid_total", None)

    def get_payment_method(self, obj: Appointment):
        return getattr(obj, "payment_method", None)

    def get_paid_at(self, obj: Appointment):
        return getattr(obj, "paid_at", None)

    def get_paid_by(self, obj: Appointment):
        pb = getattr(obj, "paid_by", None)
        return str(pb) if pb is not None else None


class AppointmentWorkerSerializer(AppointmentBaseSerializer):
    """
    Para trabajador: normalmente NO necesita ver pago real.
    """
    pass

class AppointmentInlineEditSerializer(serializers.Serializer):
    service_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1),
        required=False
    )
    note = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    # opcional si también quieres cambiar barber/worker en staff:
    worker_id = serializers.IntegerField(required=False, allow_null=True, min_value=1)
