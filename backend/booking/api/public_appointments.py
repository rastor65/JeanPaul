from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from django.db import transaction
from django.db.models import Q, Sum
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.models import (
    Appointment,
    AppointmentAudit,
    AppointmentBlock,
    AppointmentServiceLine,
    Customer,
)
from booking.tokens import decode_option_id
from catalog.models import Service


class PublicAppointmentCreateAPIView(APIView):
    """
    Crea una reserva pública usando option_id (NO requiere login).
    """
    permission_classes = [AllowAny]
    authentication_classes = []

    @transaction.atomic
    def post(self, request):
        payload = request.data if isinstance(request.data, dict) else {}

        option_id = payload.get("option_id")
        if not option_id:
            return Response({"detail": "option_id es requerido."}, status=400)

        # Aceptamos customer anidado o campos planos (compatibilidad)
        customer_data = payload.get("customer") or {}
        customer_type = (customer_data.get("customer_type") or payload.get("customer_type") or "CASUAL").upper()
        name = (customer_data.get("name") or payload.get("name") or "").strip()
        phone = (customer_data.get("phone") or payload.get("phone") or "").strip()
        birth_date_raw = (customer_data.get("birth_date") or payload.get("birth_date") or "").strip()

        if customer_type not in (Customer.TYPE_CASUAL, Customer.TYPE_FREQUENT):
            return Response({"detail": "customer_type inválido."}, status=400)

        if not name:
            return Response({"detail": "name es requerido."}, status=400)

        # Decodificar option_id
        try:
            option = decode_option_id(option_id)
        except Exception:
            return Response({"detail": "option_id inválido."}, status=400)

        blocks = option.get("blocks") or []
        appt_start_raw = option.get("appointment_start")
        appt_end_raw = option.get("appointment_end")

        if not blocks or not appt_start_raw or not appt_end_raw:
            return Response({"detail": "option_id no contiene información válida."}, status=400)

        appt_start = _parse_dt(appt_start_raw)
        appt_end = _parse_dt(appt_end_raw)
        if not appt_start or not appt_end:
            return Response({"detail": "Fechas inválidas en option_id."}, status=400)

        # -------- Cliente frecuente: debe existir y coincidir phone + birth_date --------
        customer: Customer | None = None

        if customer_type == Customer.TYPE_FREQUENT:
            if not phone or not birth_date_raw:
                return Response(
                    {"detail": "Para cliente frecuente se requiere phone y birth_date."},
                    status=400
                )

            birth_date = parse_date(birth_date_raw)
            if not birth_date:
                return Response({"detail": "birth_date inválida (YYYY-MM-DD)."}, status=400)

            customer = Customer.objects.filter(
                customer_type=Customer.TYPE_FREQUENT,
                phone=phone,
                birth_date=birth_date,
            ).first()

            if not customer:
                return Response(
                    {
                        "detail": (
                            "Los datos ingresados no están registrados para un cliente frecuente. "
                            "Si quieres ser cliente frecuente, acércate a recepción para que te registren."
                        )
                    },
                    status=400
                )

            # opcional: sincronizar nombre si cambió
            if name and customer.name != name:
                customer.name = name
                customer.save(update_fields=["name"])

        # -------- Cliente casual: crear (solo nombre). Evitar chocar por phone unique --------
        if customer_type == Customer.TYPE_CASUAL:
            # Recomendación: NO guardes phone en casual para evitar choques por unique.
            customer = Customer.objects.create(
                customer_type=Customer.TYPE_CASUAL,
                name=name,
                phone=None,
                birth_date=None,
            )

        # En este punto customer existe
        assert customer is not None

        # -------- Revalidar choques antes de crear (evita carreras) --------
        for b in blocks:
            worker_id = int(b.get("worker_id") or 0)
            b_start = _parse_dt(b.get("start"))
            b_end = _parse_dt(b.get("end"))
            if not worker_id or not b_start or not b_end:
                return Response({"detail": "Bloques inválidos en option_id."}, status=400)

            conflict = AppointmentBlock.objects.filter(worker_id=worker_id).filter(
                Q(start_datetime__lt=b_end) & Q(end_datetime__gt=b_start)
            ).exists()

            if conflict:
                # rollback automático por @atomic
                return Response(
                    {"detail": "Ese turno ya no está disponible. Vuelve a consultar disponibilidad."},
                    status=409
                )

        # -------- Crear Appointment --------
        appt = Appointment.objects.create(
            customer=customer,
            status=Appointment.STATUS_RESERVED,
            start_datetime=appt_start,
            end_datetime=appt_end,
            created_by=None,
            created_channel=Appointment.CHANNEL_CLIENT,
            recommended_subtotal=Decimal("0"),
            recommended_discount=Decimal("0"),
            recommended_total=Decimal("0"),
        )

        # -------- Crear bloques + service lines con snapshots --------
        for b in blocks:
            block = AppointmentBlock.objects.create(
                appointment=appt,
                sequence=int(b.get("sequence") or 1),
                worker_id=int(b["worker_id"]),
                start_datetime=_parse_dt(b["start"]),
                end_datetime=_parse_dt(b["end"]),
            )

            service_ids = b.get("service_ids") or []
            services = list(Service.objects.filter(id__in=service_ids, active=True).select_related("category"))
            if len(services) != len(service_ids):
                return Response({"detail": "Uno o más servicios no existen o están inactivos."}, status=400)

            for svc in services:
                AppointmentServiceLine.objects.create(
                    appointment_block=block,
                    service=svc,
                    service_name_snapshot=svc.name,
                    duration_minutes_snapshot=svc.duration_minutes,
                    buffer_before_snapshot=svc.buffer_before_minutes,
                    buffer_after_snapshot=svc.buffer_after_minutes,
                    price_snapshot=svc.price,
                )

        # Totales recomendados desde snapshots
        agg = (
            AppointmentServiceLine.objects
            .filter(appointment_block__appointment=appt)
            .aggregate(total=Sum("price_snapshot"))
        )
        subtotal = agg["total"] or Decimal("0")

        appt.recommended_subtotal = subtotal
        appt.recommended_total = subtotal
        appt.save(update_fields=["recommended_subtotal", "recommended_total"])

        # Auditoría
        AppointmentAudit.objects.create(
            appointment=appt,
            action=AppointmentAudit.ACTION_CREATE,
            performed_by=None,
            performed_at=timezone.now(),
            reason="Creación pública",
            detail_json={"option_id": option_id},
        )

        return Response(
            {
                "appointment_id": appt.id,
                "customer_id": customer.id,
                "start_datetime": appt.start_datetime.isoformat(),
                "end_datetime": appt.end_datetime.isoformat(),
            },
            status=201
        )


def _parse_dt(value) -> datetime | None:
    if not value:
        return None

    if isinstance(value, datetime):
        dt = value
    else:
        dt = parse_datetime(str(value))
        if dt is None:
            try:
                dt = datetime.fromisoformat(str(value))
            except Exception:
                return None

    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_current_timezone())
    return dt
