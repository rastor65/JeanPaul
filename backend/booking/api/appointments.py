from decimal import Decimal
from django.db import transaction
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status

from booking.utils.option_token import read_option_token
from booking.models import Customer, Appointment, AppointmentBlock, AppointmentServiceLine, AppointmentAudit
from staffing.models import Worker

OPTION_MAX_AGE_SECONDS = 600  # 10 min

def _compute_recommended(payload: dict) -> tuple[Decimal, Decimal, Decimal]:
    subtotal = Decimal("0")
    for b in payload["blocks"]:
        for s in b["services"]:
            subtotal += Decimal(str(s["price"]))
    # descuentos automáticos se aplican después (cumpleaños/promos). Por ahora 0 aquí.
    discount = Decimal("0")
    total = subtotal - discount
    if total < 0:
        total = Decimal("0")
    return subtotal, discount, total

class AppointmentCreateAPIView(APIView):
    authentication_classes = []  # público permitido
    permission_classes = []

    def post(self, request):
        data = request.data
        token = data.get("option_id")
        if not token:
            return Response({"detail": "option_id requerido"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            payload = read_option_token(token, max_age_seconds=OPTION_MAX_AGE_SECONDS)
        except Exception:
            return Response({"detail": "option_id inválido o expirado"}, status=status.HTTP_400_BAD_REQUEST)

        # Cliente
        cust = data.get("customer", {})
        ctype = cust.get("type")
        name = cust.get("name", "").strip()
        if not name:
            return Response({"detail": "Nombre requerido"}, status=status.HTTP_400_BAD_REQUEST)

        phone = cust.get("phone")
        birth_date = cust.get("birth_date")

        # Crear/usar customer
        if ctype == "FREQUENT":
            if not phone:
                return Response({"detail": "Teléfono requerido para frecuente"}, status=status.HTTP_400_BAD_REQUEST)
        elif ctype == "CASUAL":
            phone = None
            birth_date = None
        else:
            return Response({"detail": "type debe ser CASUAL o FREQUENT"}, status=status.HTTP_400_BAD_REQUEST)

        start_dt = timezone.datetime.fromisoformat(payload["start"])
        end_dt = timezone.datetime.fromisoformat(payload["end"])
        if timezone.is_naive(start_dt):
            start_dt = timezone.make_aware(start_dt)
        if timezone.is_naive(end_dt):
            end_dt = timezone.make_aware(end_dt)

        worker_ids = list({b["worker_id"] for b in payload["blocks"]})

        with transaction.atomic():
            # Lock por worker (evita carrera incluso si no hay blocks existentes)
            list(Worker.objects.select_for_update().filter(id__in=worker_ids))

            # Revalidar solapes
            for b in payload["blocks"]:
                bs = timezone.datetime.fromisoformat(b["start"])
                be = timezone.datetime.fromisoformat(b["end"])
                if timezone.is_naive(bs):
                    bs = timezone.make_aware(bs)
                if timezone.is_naive(be):
                    be = timezone.make_aware(be)

                conflict = AppointmentBlock.objects.filter(
                    worker_id=b["worker_id"],
                    start_datetime__lt=be,
                    end_datetime__gt=bs,
                    appointment__status__in=["RESERVED"]
                ).exists()
                if conflict:
                    return Response({"detail": "Conflicto de disponibilidad, elige otro turno."}, status=status.HTTP_409_CONFLICT)

            # Customer upsert
            if ctype == "FREQUENT":
                customer, _ = Customer.objects.update_or_create(
                    phone=phone,
                    defaults={"customer_type": "FREQUENT", "name": name, "birth_date": birth_date}
                )
            else:
                customer = Customer.objects.create(customer_type="CASUAL", name=name)

            subtotal, discount, total = _compute_recommended(payload)

            appt = Appointment.objects.create(
                customer=customer,
                status="RESERVED",
                start_datetime=start_dt,
                end_datetime=end_dt,
                created_by=None,
                created_channel="CLIENT",
                recommended_subtotal=subtotal,
                recommended_discount=discount,
                recommended_total=total
            )

            # blocks + lines
            for b in payload["blocks"]:
                bs = timezone.datetime.fromisoformat(b["start"])
                be = timezone.datetime.fromisoformat(b["end"])
                if timezone.is_naive(bs):
                    bs = timezone.make_aware(bs)
                if timezone.is_naive(be):
                    be = timezone.make_aware(be)

                block = AppointmentBlock.objects.create(
                    appointment=appt,
                    sequence=b["sequence"],
                    worker_id=b["worker_id"],
                    start_datetime=bs,
                    end_datetime=be
                )

                for s in b["services"]:
                    AppointmentServiceLine.objects.create(
                        appointment_block=block,
                        service_id=s["id"],
                        service_name_snapshot=s["name"],
                        duration_minutes_snapshot=s["duration"],
                        buffer_before_snapshot=s["buffer_before"],
                        buffer_after_snapshot=s["buffer_after"],
                        price_snapshot=Decimal(str(s["price"]))
                    )

            AppointmentAudit.objects.create(
                appointment=appt,
                action="CREATE",
                performed_by=None,
                performed_at=timezone.now(),
                reason=None,
                detail_json={"channel": "CLIENT"}
            )

        # Respuesta al cliente: SIN montos
        return Response({
            "id": appt.id,
            "status": appt.status,
            "start_datetime": appt.start_datetime,
            "end_datetime": appt.end_datetime,
        }, status=status.HTTP_201_CREATED)
