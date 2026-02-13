from __future__ import annotations

from datetime import timedelta, datetime
from typing import Any, Dict, List

from django.core import signing
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.exceptions import PermissionDenied

from booking.models import Appointment, AppointmentBlock, AppointmentAudit


# Ajusta si tu campo de rol se llama distinto.
def _is_staff_or_admin(user) -> bool:
    role = (getattr(user, "role", "") or "").upper()
    return role in ("ADMIN", "STAFF")


def _parse_dt(value: Any) -> datetime:
    """
    Soporta:
    - datetime (ya listo)
    - string ISO 8601 con zona (ej: '2026-02-01T09:00:00-05:00')
    """
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        dt = datetime.fromisoformat(value)
    else:
        raise ValueError("Formato de fecha inválido en option payload.")

    # Si por alguna razón llega naive, lo volvemos aware en timezone actual.
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


def _decode_option_id(option_id: str) -> Dict[str, Any]:
    """
    Decodifica el option_id generado por AvailabilityOptionsAPIView.
    En tu respuesta se ve como un string firmado tipo Django signing.
    """
    try:
        payload = signing.loads(option_id)
    except Exception:
        raise ValueError("option_id inválido o expirado.")

    if not isinstance(payload, dict):
        raise ValueError("Payload inválido en option_id.")

    # Esperamos estas claves (según tus responses):
    # - appointment_start
    # - appointment_end
    # - blocks: [{sequence, worker_id, start, end, services:[...]}]
    if "appointment_start" not in payload or "appointment_end" not in payload or "blocks" not in payload:
        raise ValueError("Payload incompleto en option_id.")

    return payload


def _active_appointment_statuses() -> List[str]:
    """
    Estados que BLOQUEAN disponibilidad.
    Ajusta si manejas otros (por ejemplo CONFIRMED, IN_PROGRESS).
    """
    return ["RESERVED", "CONFIRMED", "IN_PROGRESS"]


def _block_datetime_fields(block: AppointmentBlock) -> tuple[str, str]:
    """
    Para tolerar diferentes nombres de campos en AppointmentBlock.
    Preferimos start_datetime/end_datetime.
    """
    if hasattr(block, "start_datetime") and hasattr(block, "end_datetime"):
        return "start_datetime", "end_datetime"
    if hasattr(block, "start") and hasattr(block, "end"):
        return "start", "end"
    # Si tu modelo usa otros nombres, ajusta aquí.
    raise AttributeError("No encuentro campos de fecha en AppointmentBlock (start/end).")


class AppointmentRescheduleAPIView(APIView):
    """
    Recepción (STAFF/ADMIN) reprograma una cita existente usando option_id.

    Body:
    {
      "option_id": "<string>",
      "reason": "opcional"
    }
    """

    def post(self, request, appointment_id: int):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "No autenticado."}, status=401)

        if not _is_staff_or_admin(user):
            raise PermissionDenied("No tienes permisos para reprogramar citas.")

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

        # Ordena por sequence para aplicar coherente
        try:
            new_blocks_sorted = sorted(new_blocks, key=lambda b: int(b.get("sequence", 0)))
        except Exception:
            return Response({"detail": "sequence inválida en blocks."}, status=400)

        with transaction.atomic():
            # Bloquea la cita para evitar carreras
            try:
                appt = Appointment.objects.select_for_update().get(id=appointment_id)
            except Appointment.DoesNotExist:
                return Response({"detail": "Cita no encontrada."}, status=404)

            if appt.status in ("CANCELLED", "NO_SHOW", "COMPLETED"):
                return Response(
                    {"detail": "La cita no se puede reprogramar en su estado actual."},
                    status=status.HTTP_409_CONFLICT
                )

            # Regla de negocio: reprogramar solo hasta 30 min antes del turno ACTUAL
            now = timezone.now()
            limit = appt.start_datetime - timedelta(minutes=30)
            if now > limit:
                return Response(
                    {"detail": "Solo se puede reprogramar hasta 30 minutos antes del turno."},
                    status=status.HTTP_409_CONFLICT
                )

            # Cargar bloques existentes (del appointment actual)
            blocks_qs = AppointmentBlock.objects.filter(appointment_id=appt.id)
            existing_blocks = list(blocks_qs)

            if not existing_blocks:
                return Response(
                    {"detail": "La cita no tiene bloques asociados (AppointmentBlock)."},
                    status=409
                )

            # Validar que el set de workers coincide (reprogramación no cambia servicios/workers, solo horas/orden)
            existing_worker_ids = {b.worker_id for b in existing_blocks}
            new_worker_ids = {int(b.get("worker_id")) for b in new_blocks_sorted if b.get("worker_id") is not None}

            if existing_worker_ids != new_worker_ids:
                return Response(
                    {
                        "detail": "El option_id no corresponde a los mismos trabajadores de la cita.",
                        "existing_worker_ids": sorted(list(existing_worker_ids)),
                        "option_worker_ids": sorted(list(new_worker_ids)),
                    },
                    status=400
                )

            # Mapear bloques existentes por worker_id
            by_worker: Dict[int, AppointmentBlock] = {b.worker_id: b for b in existing_blocks}

            # Chequeo de solapamientos en el nuevo horario, por cada worker
            # Buscamos bloques de otros appointments que choquen con (start,end).
            # Excluimos el mismo appointment.
            active_statuses = _active_appointment_statuses()

            for nb in new_blocks_sorted:
                w_id = int(nb["worker_id"])
                b_start = _parse_dt(nb["start"])
                b_end = _parse_dt(nb["end"])

                conflict = AppointmentBlock.objects.filter(
                    worker_id=w_id,
                ).exclude(
                    appointment_id=appt.id
                ).filter(
                    Q(start_datetime__lt=b_end, end_datetime__gt=b_start)
                    if hasattr(AppointmentBlock, "start_datetime")
                    else Q(start__lt=b_end, end__gt=b_start)
                ).filter(
                    appointment__status__in=active_statuses
                ).exists()

                if conflict:
                    return Response(
                        {"detail": "Conflicto de disponibilidad, elige otro turno."},
                        status=status.HTTP_409_CONFLICT
                    )

            # Guardar "before" para auditoría
            before_start = appt.start_datetime
            before_end = appt.end_datetime

            # Aplicar cambios a Appointment
            appt.start_datetime = new_start
            appt.end_datetime = new_end
            appt.save(update_fields=["start_datetime", "end_datetime"])

            # Aplicar cambios a bloques existentes (sin tocar service_lines)
            for nb in new_blocks_sorted:
                w_id = int(nb["worker_id"])
                seq = int(nb.get("sequence", 0))
                b_start = _parse_dt(nb["start"])
                b_end = _parse_dt(nb["end"])

                block = by_worker[w_id]
                start_field, end_field = _block_datetime_fields(block)

                setattr(block, start_field, b_start)
                setattr(block, end_field, b_end)

                if hasattr(block, "sequence"):
                    block.sequence = seq

                update_fields = [start_field, end_field]
                if hasattr(block, "sequence"):
                    update_fields.append("sequence")

                block.save(update_fields=update_fields)

            # Auditoría
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
