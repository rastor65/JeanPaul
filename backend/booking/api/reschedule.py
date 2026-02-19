from __future__ import annotations

from datetime import timedelta, datetime
from typing import Any, Dict, List, Tuple

from django.core import signing
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.exceptions import PermissionDenied

from booking.models import Appointment, AppointmentBlock, AppointmentAudit


def _is_staff_or_admin(user) -> bool:
    role = (getattr(user, "role", "") or "").upper()
    return role in ("ADMIN", "STAFF")


def _parse_dt(value: Any) -> datetime:
    """
    Soporta:
    - datetime
    - string ISO 8601 con zona (ej: '2026-02-01T09:00:00-05:00')
    - string ISO con 'Z' (UTC) (ej: '2026-02-01T14:00:00Z')
    """
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        v = value.strip()
        if v.endswith("Z"):
            v = v[:-1] + "+00:00"
        dt = datetime.fromisoformat(v)
    else:
        raise ValueError("Formato de fecha inválido en option payload.")

    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


def _decode_option_id(option_id: str) -> Dict[str, Any]:
    try:
        payload = signing.loads(option_id)
    except Exception:
        raise ValueError("option_id inválido o expirado.")

    if not isinstance(payload, dict):
        raise ValueError("Payload inválido en option_id.")

    if "appointment_start" not in payload or "appointment_end" not in payload or "blocks" not in payload:
        raise ValueError("Payload incompleto en option_id.")

    return payload


def _active_appointment_statuses() -> List[str]:
    return ["RESERVED", "CONFIRMED", "IN_PROGRESS"]


def _block_datetime_field_names() -> Tuple[str, str]:
    """
    Detecta nombres reales de campos de fecha en AppointmentBlock:
    - start_datetime/end_datetime
    - start/end
    """
    field_names = {f.name for f in AppointmentBlock._meta.fields}

    if {"start_datetime", "end_datetime"} <= field_names:
        return "start_datetime", "end_datetime"
    if {"start", "end"} <= field_names:
        return "start", "end"

    raise AttributeError("No encuentro campos de fecha en AppointmentBlock (start_datetime/end_datetime o start/end).")


class AppointmentRescheduleAPIView(APIView):
    """
    Recepción (STAFF/ADMIN) reprograma una cita existente usando option_id.

    POST:
    {
      "option_id": "<string>",
      "reason": "opcional"
    }
    """

    def post(self, request, appointment_id: int):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "No autenticado."}, status=401)

        option_id = (request.data.get("option_id") or "").strip()
        reason = (request.data.get("reason") or "").strip()

        if not option_id:
            return Response({"detail": "option_id es requerido."}, status=400)

        try:
            payload = _decode_option_id(option_id)
        except ValueError as e:
            return Response({"detail": str(e)}, status=400)

        try:
            new_start = _parse_dt(payload["appointment_start"])
            new_end = _parse_dt(payload["appointment_end"])
        except Exception:
            return Response({"detail": "Fechas inválidas en option payload."}, status=400)

        new_blocks = payload.get("blocks") or []
        if not isinstance(new_blocks, list) or len(new_blocks) == 0:
            return Response({"detail": "blocks inválido en option payload."}, status=400)

        try:
            new_blocks_sorted = sorted(new_blocks, key=lambda b: int(b.get("sequence", 0)))
        except Exception:
            return Response({"detail": "sequence inválida en blocks."}, status=400)

        start_field, end_field = _block_datetime_field_names()
        active_statuses = _active_appointment_statuses()

        with transaction.atomic():
            try:
                appt = Appointment.objects.select_for_update().get(id=appointment_id)
            except Appointment.DoesNotExist:
                return Response({"detail": "Cita no encontrada."}, status=404)

            if appt.status in ("CANCELLED", "NO_SHOW", "COMPLETED"):
                return Response(
                    {"detail": "La cita no se puede reprogramar en su estado actual."},
                    status=status.HTTP_409_CONFLICT
                )

            now = timezone.now()
            limit = appt.start_datetime - timedelta(minutes=30)
            if now > limit:
                return Response(
                    {"detail": "Solo se puede reprogramar hasta 30 minutos antes del turno."},
                    status=status.HTTP_409_CONFLICT
                )

            existing_blocks = list(AppointmentBlock.objects.filter(appointment_id=appt.id))
            if not existing_blocks:
                return Response(
                    {"detail": "La cita no tiene bloques asociados (AppointmentBlock)."},
                    status=409
                )

            existing_worker_ids = {b.worker_id for b in existing_blocks}
            try:
                new_worker_ids = {int(b.get("worker_id")) for b in new_blocks_sorted if b.get("worker_id") is not None}
            except Exception:
                return Response({"detail": "worker_id inválido en blocks."}, status=400)

            if existing_worker_ids != new_worker_ids:
                return Response(
                    {
                        "detail": "El option_id no corresponde a los mismos trabajadores de la cita.",
                        "existing_worker_ids": sorted(list(existing_worker_ids)),
                        "option_worker_ids": sorted(list(new_worker_ids)),
                    },
                    status=400
                )

            by_worker: Dict[int, AppointmentBlock] = {b.worker_id: b for b in existing_blocks}

            # Chequeo solapamientos (otros appointments) usando nombres reales de campos
            for nb in new_blocks_sorted:
                w_id = int(nb["worker_id"])
                b_start = _parse_dt(nb["start"])
                b_end = _parse_dt(nb["end"])

                overlap_q = Q(**{f"{start_field}__lt": b_end, f"{end_field}__gt": b_start})

                conflict = (
                    AppointmentBlock.objects.filter(worker_id=w_id)
                    .exclude(appointment_id=appt.id)
                    .filter(overlap_q)
                    .filter(appointment__status__in=active_statuses)
                    .exists()
                )

                if conflict:
                    return Response(
                        {"detail": "Conflicto de disponibilidad, elige otro turno."},
                        status=status.HTTP_409_CONFLICT
                    )

            before_start = appt.start_datetime
            before_end = appt.end_datetime

            appt.start_datetime = new_start
            appt.end_datetime = new_end
            appt.save(update_fields=["start_datetime", "end_datetime"])

            for nb in new_blocks_sorted:
                w_id = int(nb["worker_id"])
                seq = int(nb.get("sequence", 0))
                b_start = _parse_dt(nb["start"])
                b_end = _parse_dt(nb["end"])

                block = by_worker[w_id]
                setattr(block, start_field, b_start)
                setattr(block, end_field, b_end)

                update_fields = [start_field, end_field]
                if hasattr(block, "sequence"):
                    block.sequence = seq
                    update_fields.append("sequence")

                block.save(update_fields=update_fields)

            note_parts = [
                f"from={before_start.isoformat()}..{before_end.isoformat()}",
                f"to={new_start.isoformat()}..{new_end.isoformat()}",
            ]
            if reason:
                note_parts.append(f"reason={reason}")

            AppointmentAudit.objects.create(
                appointment=appt,
                action="RESCHEDULED",
                performed_by=user,
                performed_at=timezone.now(),
                note=" | ".join(note_parts),
            )

            return Response(
                {
                    "id": appt.id,
                    "status": appt.status,
                    "start_datetime": appt.start_datetime,
                    "end_datetime": appt.end_datetime,
                    "detail": "Cita reprogramada.",
                },
                status=200
            )
