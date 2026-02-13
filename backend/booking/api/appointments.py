from __future__ import annotations

from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.models import Appointment, AppointmentBlock, AppointmentServiceLine, Customer
from booking.tokens import decode_option_id
from catalog.models import Service


class AppointmentCreateAPIView(APIView):
    """
    Crea una cita a partir de un option_id (devuelto por /availability/options/).

    Reglas:
    - Si hay conflicto (lógico o por BD), devolver 409.
    - Operación atómica (si falla, no deja basura).
    """
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def post(self, request):
        payload = request.data if isinstance(request.data, dict) else {}

        option_id = payload.get("option_id")
        if not option_id:
            return Response({"detail": "option_id es requerido."}, status=400)

        # decode_option_id debe devolverte un dict con:
        # {
        #   "appointment_start": "...",
        #   "appointment_end": "...",
        #   "blocks": [
        #       {"sequence":1,"worker_id":1,"start":"...","end":"...","service_ids":[1,3]},
        #       ...
        #   ],
        #   "customer": {...}  # según tu implementación
        # }
        try:
            option = decode_option_id(option_id)
        except Exception:
            return Response({"detail": "option_id inválido."}, status=400)

        # -------- Cliente (casual/frecuente) --------
        customer_data = payload.get("customer") or {}
        customer_name = (customer_data.get("name") or "").strip()
        if not customer_name:
            return Response({"detail": "customer.name es requerido."}, status=400)

        # Si tienes lógica de frecuente por phone, aquí la respetamos
        phone = (customer_data.get("phone") or "").strip() or None
        birth_date = customer_data.get("birth_date") or None

        customer = None
        if phone:
            customer = Customer.objects.filter(phone=phone).first()
        if customer is None:
            customer = Customer.objects.create(
                name=customer_name,
                phone=phone,
                birth_date=birth_date,
            )
        else:
            # Actualiza nombre/birth_date si vienen
            changed = False
            if customer.name != customer_name:
                customer.name = customer_name
                changed = True
            if birth_date and getattr(customer, "birth_date", None) != birth_date:
                customer.birth_date = birth_date
                changed = True
            if changed:
                customer.save()

        # -------- Crear Appointment --------
        start_dt = option["appointment_start"]
        end_dt = option["appointment_end"]

        appt = Appointment.objects.create(
            customer=customer,
            status="RESERVED",
            start_datetime=start_dt,
            end_datetime=end_dt,
        )

        # -------- Crear bloques + líneas --------
        # Importante: para evitar carreras, usamos la constraint en AppointmentBlock.
        try:
            for b in option["blocks"]:
                block = AppointmentBlock.objects.create(
                    appointment=appt,
                    sequence=b["sequence"],
                    worker_id=b["worker_id"],
                    start_datetime=b["start"],
                    end_datetime=b["end"],
                )

                # Services: pueden venir como lista de ids o lista de objetos
                service_ids = b.get("service_ids")
                if service_ids is None:
                    # fallback si viene lista de services con id
                    services_list = b.get("services", [])
                    service_ids = [s["id"] for s in services_list if "id" in s]

                services = Service.objects.filter(id__in=service_ids)
                for svc in services:
                    AppointmentServiceLine.objects.create(
                        appointment_block=block,
                        service=svc,
                    )

        except IntegrityError:
            # Conflicto por BD: rollback automático por @atomic
            # Forzamos el mismo mensaje de conflicto
            return Response(
                {"detail": "Conflicto de disponibilidad, elige otro turno."},
                status=409
            )

        # Si todo ok:
        return Response(
            {
                "id": appt.id,
                "status": appt.status,
                "start_datetime": appt.start_datetime,
                "end_datetime": appt.end_datetime,
            },
            status=201
        )
