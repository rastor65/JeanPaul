from datetime import datetime, time
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status

from catalog.models import Service, ServiceCategory
from staffing.models import Worker
from booking.services.availability import (
    get_service_snaps, build_block_specs, generate_options, _dt
)
from booking.utils.option_token import make_option_token


def _is_staff(user) -> bool:
    return user and user.is_authenticated and getattr(user, "roles_cache", None) and ("STAFF" in user.roles_cache or "ADMIN" in user.roles_cache)

class AvailabilityOptionsAPIView(APIView):
    authentication_classes = []  # permite público; si ya tienes auth global, puedes dejarla
    permission_classes = []      # AllowAny

    def post(self, request):
        data = request.data
        try:
            date_str = data["date"]  # YYYY-MM-DD
            date_obj = datetime.strptime(date_str, "%Y-%m-%d").date()
            service_ids = data["services"]
            pref = data.get("barber_preference", {"type": "NEAREST_AVAILABLE"})
            tw = data.get("time_window")

            # ventana
            if tw:
                ws = _dt(date_obj, datetime.strptime(tw["start"], "%H:%M").time())
                we = _dt(date_obj, datetime.strptime(tw["end"], "%H:%M").time())
            else:
                ws = _dt(date_obj, time(0, 0))
                we = _dt(date_obj, time(23, 59))

            # snaps
            snaps = get_service_snaps(service_ids)

            # detectar workers fijos por categoría/servicio (simplificado):
            # aquí asumo que Service.assignment_type y Service.fixed_worker están definidos
            services = Service.objects.filter(id__in=service_ids).select_related("fixed_worker", "category")
            service_id_to_worker = {}
            nails_worker_id = None
            facial_worker_id = None

            for s in services:
                if s.assignment_type == "FIXED_WORKER" and s.fixed_worker_id:
                    service_id_to_worker[s.id] = s.fixed_worker_id
                    # inferir uñas/facial por rol del worker
                    w = Worker.objects.filter(id=s.fixed_worker_id).first()
                    if w:
                        if w.role == "NAILS":
                            nails_worker_id = w.id
                        elif w.role == "FACIAL":
                            facial_worker_id = w.id

            # candidatos barberos
            barber_ids = []
            if pref["type"] == "SPECIFIC":
                barber_ids = [int(pref["barber_id"])]
            else:
                barber_ids = list(Worker.objects.filter(active=True, role="BARBER").values_list("id", flat=True))

            # generar opciones por cada barbero candidato
            all_options_payload = []
            for bid in barber_ids:
                specs = build_block_specs(
                    service_snaps=snaps,
                    barber_worker_id=bid,
                    nails_worker_id=nails_worker_id,
                    facial_worker_id=facial_worker_id,
                    service_id_to_worker=service_id_to_worker
                )
                options = generate_options(date_obj, ws, we, specs, limit=20)

                for op in options:
                    payload = {
                        "date": date_str,
                        "start": op.start.isoformat(),
                        "end": op.end.isoformat(),
                        "blocks": [
                            {
                                "sequence": b.sequence,
                                "worker_id": b.worker_id,
                                "start": b.start.isoformat(),
                                "end": b.end.isoformat(),
                                "services": [
                                    {
                                        "id": s.id,
                                        "name": s.name,
                                        "duration": s.duration,
                                        "buffer_before": s.buffer_before,
                                        "buffer_after": s.buffer_after,
                                        "price": s.price,  # NO se mostrará al cliente; solo se firma
                                    } for s in b.services
                                ]
                            } for b in op.blocks
                        ],
                        "gap_total_minutes": op.gap_total_minutes,
                    }
                    token = make_option_token(payload)

                    # Respuesta pública: ocultar price y totales
                    resp_blocks = []
                    for b in payload["blocks"]:
                        resp_blocks.append({
                            "sequence": b["sequence"],
                            "worker_id": b["worker_id"],
                            "start": b["start"],
                            "end": b["end"],
                            "services": [
                                {
                                    "id": ss["id"],
                                    "name": ss["name"],
                                    "duration": ss["duration"],
                                    "buffer_before": ss["buffer_before"],
                                    "buffer_after": ss["buffer_after"],
                                } for ss in b["services"]
                            ]
                        })

                    all_options_payload.append({
                        "option_id": token,
                        "appointment_start": payload["start"],
                        "appointment_end": payload["end"],
                        "gap_total_minutes": payload["gap_total_minutes"],
                        "blocks": resp_blocks,
                    })

            # ordenar globalmente
            all_options_payload.sort(key=lambda x: (x["gap_total_minutes"], x["appointment_end"]))
            return Response(all_options_payload[:20], status=status.HTTP_200_OK)

        except Exception as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
