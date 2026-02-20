from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Tuple, Any, Dict, List, Optional

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status

from booking.models import Appointment, AppointmentBlock

# Si tienes AppointmentAudit, lo intentamos usar sin romper el arranque
try:
    from booking.models import AppointmentAudit
except Exception:  # pragma: no cover
    AppointmentAudit = None


def _datetime_field_names_for_model(model) -> Tuple[str, str]:
    """
    Detecta campos start/end en un modelo.
    Soporta: start_datetime/end_datetime o start/end
    """
    field_names = {f.name for f in model._meta.fields}
    if {"start_datetime", "end_datetime"} <= field_names:
        return "start_datetime", "end_datetime"
    if {"start", "end"} <= field_names:
        return "start", "end"
    raise AttributeError(
        f"No encuentro campos start/end en {model.__name__}. "
        "Espero start_datetime/end_datetime o start/end."
    )


def _parse_dt(value: Any):
    """
    Acepta ISO string o datetime.
    Retorna datetime o None si no parsea.
    """
    if value is None:
        return None
    if hasattr(value, "tzinfo"):
        return value
    if isinstance(value, str):
        dt = parse_datetime(value)
        return dt
    return None


def _field_map(model) -> Dict[str, Any]:
    """Mapa name -> Field para campos concretos (no M2M)."""
    return {f.name: f for f in model._meta.fields}


def _coerce_value(field, value: Any):
    """
    Convierte value según tipo de Field, de forma defensiva.
    """
    if value is None:
        return None

    internal = field.get_internal_type()

    try:
        if internal in ("CharField", "TextField", "EmailField", "URLField"):
            return str(value)

        if internal in ("IntegerField", "BigIntegerField", "PositiveIntegerField", "SmallIntegerField", "PositiveSmallIntegerField"):
            return int(value)

        if internal in ("FloatField",):
            return float(value)

        if internal in ("BooleanField", "NullBooleanField"):
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                return value.strip().lower() in ("1", "true", "t", "yes", "y", "si", "sí", "on")
            return bool(value)

        if internal in ("DecimalField",):
            return Decimal(str(value))

        if internal in ("DateTimeField",):
            dt = _parse_dt(value)
            return dt

        if internal in ("DateField",):
            # Si llega como "YYYY-MM-DD"
            if isinstance(value, str):
                # Django puede castear string a DateField al guardar en muchos casos,
                # pero preferimos dejarlo como string válido.
                return value.strip()
            return value

        # ForeignKey y otros: por lo general aceptan pk (int/str) en *_id
        return value
    except Exception:
        # Si falla la coerción, devolvemos tal cual y que el save/DB valide
        return value


def _validate_choice(field, value: Any) -> bool:
    """Valida choices si existen."""
    if not getattr(field, "choices", None):
        return True
    allowed = {c[0] for c in field.choices}
    return value in allowed


# -------------------------
# API View
# -------------------------
class AppointmentInlineEditAPIView(APIView):
    """
    Edición rápida SIN validar disponibilidad (solo STAFF/ADMIN).

    Acepta edición parcial de muchos campos del Appointment de forma defensiva.

    POST/PATCH ejemplo:
    {
      "start_datetime": "2026-02-20T10:00:00-05:00",   # opcional (o "start")
      "duration_minutes": 60,                         # opcional
      "end_datetime": "2026-02-20T11:30:00-05:00",    # opcional (o "end")
      "status": "Reservado",                          # opcional si tu model lo tiene
      "note": "opcional",                             # opcional si tu model lo tiene
      "worker_id": 5,                                 # opcional si tu model lo tiene
      "service_ids": [1,2,3]                          # opcional si existe appt.services (M2M)
      ... cualquier otro campo concreto del modelo ...
    }

    Reglas de fechas:
    - Si llega end(_datetime), se respeta.
    - Si NO llega end pero llega duration_minutes, se calcula end = start + duration.
    - Si no llega start, se mantiene el start actual.
    """

    def post(self, request, appointment_id: int):
        return self._handle(request, appointment_id)

    # Por si quieres mapear también PATCH en urls.py a este mismo view
    def patch(self, request, appointment_id: int):
        return self._handle(request, appointment_id)

    def _handle(self, request, appointment_id: int):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "No autenticado."}, status=status.HTTP_401_UNAUTHORIZED)

        data = request.data or {}

        # Detecta nombres reales de start/end en Appointment y AppointmentBlock
        appt_start_field, appt_end_field = _datetime_field_names_for_model(Appointment)
        block_start_field, block_end_field = _datetime_field_names_for_model(AppointmentBlock)

        duration = data.get("duration_minutes", None)
        service_ids = data.get("service_ids", None)

        # Permite que te manden start/end con cualquiera de los dos nombres
        start_in = data.get(appt_start_field, data.get("start_datetime", data.get("start")))
        end_in = data.get(appt_end_field, data.get("end_datetime", data.get("end")))

        new_start_dt = _parse_dt(start_in)
        new_end_dt = _parse_dt(end_in)

        # duration (si viene)
        duration_int: Optional[int] = None
        if duration is not None and duration != "":
            try:
                duration_int = int(duration)
            except Exception:
                return Response({"detail": "duration_minutes debe ser numérico."}, status=status.HTTP_400_BAD_REQUEST)
            if duration_int <= 0:
                return Response({"detail": "duration_minutes debe ser > 0."}, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            try:
                appt = Appointment.objects.select_for_update().get(id=appointment_id)
            except Appointment.DoesNotExist:
                return Response({"detail": "Cita no encontrada."}, status=status.HTTP_404_NOT_FOUND)

            before_snapshot = {
                "start": getattr(appt, appt_start_field, None),
                "end": getattr(appt, appt_end_field, None),
                "status": getattr(appt, "status", None),
                "note": getattr(appt, "note", None) if hasattr(appt, "note") else None,
            }

            # Base times actuales
            current_start = getattr(appt, appt_start_field)
            current_end = getattr(appt, appt_end_field)

            # Si no mandan start, mantener el actual
            if new_start_dt is None:
                new_start_dt = current_start

            # Si mandan end explícito, se respeta; si no, se calcula por duration si viene
            if new_end_dt is None:
                if duration_int is not None:
                    new_end_dt = new_start_dt + timedelta(minutes=duration_int)
                else:
                    new_end_dt = current_end

            # Validación mínima de coherencia temporal
            if new_end_dt <= new_start_dt:
                return Response(
                    {"detail": "La fecha/hora final debe ser mayor que la inicial."},
                    status=status.HTTP_400_BAD_REQUEST
                )

            # ---------
            # Actualiza campos del Appointment
            # ---------
            fields = _field_map(Appointment)
            update_fields: List[str] = []

            # 1) Aplica start/end detectados
            setattr(appt, appt_start_field, new_start_dt)
            setattr(appt, appt_end_field, new_end_dt)
            update_fields.extend([appt_start_field, appt_end_field])

            # 2) Aplica otros campos enviados (edición parcial genérica)
            #    - Ignoramos duration_minutes y service_ids (se manejan aparte)
            #    - Permitimos setear campos concretos del modelo defensivamente
            special_keys = {"duration_minutes", "service_ids", "id", "pk"}
            for key, raw_value in data.items():
                if key in special_keys:
                    continue

                # Si intentan mandar start/end por alias, ya lo manejamos arriba
                if key in ("start_datetime", "start", "end_datetime", "end", appt_start_field, appt_end_field):
                    continue

                # FK: permitir worker_id (o cualquier *_id)
                if key.endswith("_id") and key[:-3] in fields:
                    fk_field_name = key[:-3]
                    fk_field = fields[fk_field_name]
                    # solo si es relación many-to-one
                    if getattr(fk_field, "many_to_one", False) or getattr(fk_field, "is_relation", False):
                        try:
                            setattr(appt, key, int(raw_value) if raw_value is not None else None)
                            update_fields.append(key)
                        except Exception:
                            return Response({"detail": f"Valor inválido para {key}."}, status=status.HTTP_400_BAD_REQUEST)
                    continue

                # Campo normal (si existe)
                if key in fields:
                    field = fields[key]

                    # Evita tocar PK / campos automáticos en caliente
                    if getattr(field, "primary_key", False):
                        continue
                    if getattr(field, "auto_now", False) or getattr(field, "auto_now_add", False):
                        continue

                    coerced = _coerce_value(field, raw_value)

                    # Si tiene choices, valida
                    if getattr(field, "choices", None) and coerced is not None:
                        if not _validate_choice(field, coerced):
                            return Response(
                                {"detail": f"Valor inválido para {key}. No está en choices."},
                                status=status.HTTP_400_BAD_REQUEST
                            )

                    # Si es DateTimeField, coerción puede devolver None si no parseó
                    if field.get_internal_type() == "DateTimeField" and raw_value is not None and coerced is None:
                        return Response(
                            {"detail": f"Formato inválido para {key}. Usa ISO 8601."},
                            status=status.HTTP_400_BAD_REQUEST
                        )

                    setattr(appt, key, coerced)
                    update_fields.append(key)

            # Guarda Appointment
            appt.save(update_fields=sorted(set(update_fields)))

            # ---------
            # Actualiza bloques asociados (start/end siempre se sincronizan)
            # ---------
            blocks = list(
                AppointmentBlock.objects.select_for_update().filter(appointment_id=appt.id)
            )
            for b in blocks:
                setattr(b, block_start_field, new_start_dt)
                setattr(b, block_end_field, new_end_dt)
                b.save(update_fields=[block_start_field, block_end_field])

            # ---------
            # M2M services (si existe)
            # ---------
            if service_ids is not None and hasattr(appt, "services"):
                try:
                    ids = [int(x) for x in (service_ids or [])]
                    ServiceModel = appt.services.model
                    services = list(ServiceModel.objects.filter(id__in=ids))
                    if len(services) != len(ids):
                        return Response(
                            {"detail": "Uno o más service_ids no existen."},
                            status=status.HTTP_400_BAD_REQUEST
                        )
                    appt.services.set(services)
                except ValueError:
                    return Response(
                        {"detail": "service_ids debe ser una lista de enteros."},
                        status=status.HTTP_400_BAD_REQUEST
                    )
                except Exception:
                    # Si tu M2M tiene restricciones raras, no tumbamos el endpoint
                    pass

            # ---------
            # Audit (si existe)
            # ---------
            after_snapshot = {
                "start": getattr(appt, appt_start_field, None),
                "end": getattr(appt, appt_end_field, None),
                "status": getattr(appt, "status", None),
                "note": getattr(appt, "note", None) if hasattr(appt, "note") else None,
            }

            if AppointmentAudit is not None:
                try:
                    AppointmentAudit.objects.create(
                        appointment=appt,
                        action="INLINE_EDIT",
                        performed_by=user,
                        performed_at=timezone.now(),
                        note=f"before={before_snapshot} | after={after_snapshot}",
                    )
                except Exception:
                    pass

            # Respuesta uniforme (siempre devuelve start/end en keys estándar)
            return Response(
                {
                    "id": appt.id,
                    "status": getattr(appt, "status", None),
                    "start_datetime": getattr(appt, appt_start_field),
                    "end_datetime": getattr(appt, appt_end_field),
                    "updated_fields": sorted(set(update_fields)),
                    "detail": "Edición aplicada (sin validar disponibilidad).",
                },
                status=status.HTTP_200_OK
            )