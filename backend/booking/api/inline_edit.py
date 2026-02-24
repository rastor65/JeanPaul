from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.models import Appointment, AppointmentBlock, AppointmentServiceLine

# Catálogo / Staff
from catalog.models import Service as CatalogService
from staffing.models import Worker

# Si tienes AppointmentAudit, lo intentamos usar sin romper el arranque
try:
    from booking.models import AppointmentAudit
except Exception:  # pragma: no cover
    AppointmentAudit = None


# ==========================================================
# Helpers genéricos
# ==========================================================
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
    """Acepta ISO string o datetime. Retorna datetime o None si no parsea."""
    if value is None:
        return None
    if hasattr(value, "tzinfo"):
        return value
    if isinstance(value, str):
        return parse_datetime(value)
    return None


def _field_map(model) -> Dict[str, Any]:
    """Mapa name -> Field para campos concretos (no M2M)."""
    return {f.name: f for f in model._meta.fields}


def _coerce_value(field, value: Any):
    """Convierte value según tipo de Field, de forma defensiva."""
    if value is None:
        return None

    internal = field.get_internal_type()

    try:
        if internal in ("CharField", "TextField", "EmailField", "URLField"):
            return str(value)

        if internal in (
            "IntegerField",
            "BigIntegerField",
            "PositiveIntegerField",
            "SmallIntegerField",
            "PositiveSmallIntegerField",
        ):
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
            if isinstance(value, str):
                return value.strip()
            return value

        # ForeignKey y otros: por lo general aceptan pk (int/str) en *_id
        return value
    except Exception:
        return value


def _validate_choice(field, value: Any) -> bool:
    """Valida choices si existen."""
    if not getattr(field, "choices", None):
        return True
    allowed = {c[0] for c in field.choices}
    return value in allowed


# ==========================================================
# Helpers específicos de tu modelo (service_lines snapshots)
# ==========================================================
def _infer_group_from_text(text: str) -> str:
    raw = (text or "").lower()
    nails_keys = ["uña", "unas", "uñas", "manicure", "pedicure", "nails"]
    facial_keys = ["facial", "limpieza facial", "rostro", "skin"]

    if any(k in raw for k in nails_keys):
        return "NAILS"
    if any(k in raw for k in facial_keys):
        return "FACIAL"
    return "BARBER"


def _group_for_service(svc: CatalogService) -> str:
    cat_name = ""
    try:
        cat = getattr(svc, "category", None)
        cat_name = getattr(cat, "name", "") or getattr(cat, "nombre", "") or ""
    except Exception:
        cat_name = ""
    text = f"{cat_name} {getattr(svc, 'name', '')}"
    return _infer_group_from_text(text)


def _pick_worker_for_role(role: str, barber_id: Optional[int] = None, current: Optional[Worker] = None) -> Optional[Worker]:
    """
    - BARBER: si mandan barber_id -> ese. Si no, conserva current. Si no, primero BARBER.
    - NAILS/FACIAL: worker fijo (primero por rol).
    """
    if role == "BARBER":
        if barber_id:
            return Worker.objects.filter(id=barber_id).first()
        if current:
            return current
        return Worker.objects.filter(role="BARBER").first()

    return Worker.objects.filter(role=role).first()


def _to_int_list(value: Any) -> List[int]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        out = []
        for x in value:
            try:
                out.append(int(x))
            except Exception:
                continue
        return out
    # Si llega como string raro, no lo aceptamos silenciosamente
    raise ValueError("Debe ser lista/tupla de enteros.")


# ==========================================================
# API View
# ==========================================================
class AppointmentInlineEditAPIView(APIView):
    """
    Edición rápida SIN validar disponibilidad (solo STAFF/ADMIN).

    Este endpoint:
    - Actualiza start/end del Appointment
    - Sincroniza start/end en blocks
    - Puede cambiar BARBER (worker del bloque BARBER) con barber_id/worker_id
    - Puede cambiar servicios reconstruyendo AppointmentServiceLine (con snapshots NO nulos)
    - Recalcula recommended_subtotal y recommended_total

    Payload ejemplo:
    {
      "start_datetime": "2026-02-20T10:00:00-05:00",
      "duration_minutes": 60,                  # opcional
      "end_datetime": "2026-02-20T11:00:00-05:00",  # opcional (si no viene y duration sí, se calcula)
      "barber_id": 5,                          # opcional
      "service_ids": [1,2,3],                  # opcional (si viene, rearmamos service_lines)
      "note": "opcional",
      ...otros campos directos de Appointment...
    }

    NOTA:
    - Tus servicios NO están en M2M de AppointmentBlock; están en AppointmentServiceLine (service_lines).
    - Por eso SIEMPRE se reconstruyen las líneas con snapshots obligatorios.
    """

    def post(self, request, appointment_id: int):
        return self._handle(request, appointment_id)

    def patch(self, request, appointment_id: int):
        return self._handle(request, appointment_id)

    def _handle(self, request, appointment_id: int):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "No autenticado."}, status=status.HTTP_401_UNAUTHORIZED)

        data = request.data or {}

        appt_start_field, appt_end_field = _datetime_field_names_for_model(Appointment)
        block_start_field, block_end_field = _datetime_field_names_for_model(AppointmentBlock)

        # start/end entrantes (alias friendly)
        start_in = data.get(appt_start_field, data.get("start_datetime", data.get("start")))
        end_in = data.get(appt_end_field, data.get("end_datetime", data.get("end")))

        new_start_dt = _parse_dt(start_in)
        new_end_dt = _parse_dt(end_in)

        # duration
        duration_raw = data.get("duration_minutes", None)
        duration_int: Optional[int] = None
        if duration_raw not in (None, ""):
            try:
                duration_int = int(duration_raw)
            except Exception:
                return Response({"detail": "duration_minutes debe ser numérico."}, status=status.HTTP_400_BAD_REQUEST)
            if duration_int <= 0:
                return Response({"detail": "duration_minutes debe ser > 0."}, status=status.HTTP_400_BAD_REQUEST)

        # service_ids (puede venir o no)
        service_ids_present = "service_ids" in data
        ids_int: Optional[List[int]] = None
        if service_ids_present:
            try:
                ids_int = _to_int_list(data.get("service_ids"))
            except ValueError as ve:
                return Response({"detail": f"service_ids inválido: {str(ve)}"}, status=status.HTTP_400_BAD_REQUEST)
            if not ids_int:
                return Response({"detail": "Selecciona al menos un servicio."}, status=status.HTTP_400_BAD_REQUEST)

        # barber/worker incoming
        incoming_barber = data.get("barber_id", None)
        if incoming_barber in (None, ""):
            incoming_barber = data.get("worker_id", None)

        barber_id_int: Optional[int] = None
        if incoming_barber not in (None, "", "AUTO"):
            try:
                barber_id_int = int(incoming_barber)
            except Exception:
                return Response({"detail": "barber_id/worker_id debe ser numérico."}, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            try:
                appt = Appointment.objects.select_for_update().get(id=appointment_id)
            except Appointment.DoesNotExist:
                return Response({"detail": "Cita no encontrada."}, status=status.HTTP_404_NOT_FOUND)

            before_snapshot = {
                "start": getattr(appt, appt_start_field, None),
                "end": getattr(appt, appt_end_field, None),
                "status": getattr(appt, "status", None),
            }

            # base times actuales
            current_start = getattr(appt, appt_start_field)
            current_end = getattr(appt, appt_end_field)

            if new_start_dt is None:
                new_start_dt = current_start

            if new_end_dt is None:
                if duration_int is not None:
                    new_end_dt = new_start_dt + timedelta(minutes=duration_int)
                else:
                    new_end_dt = current_end

            if new_end_dt <= new_start_dt:
                return Response({"detail": "La fecha/hora final debe ser mayor que la inicial."}, status=status.HTTP_400_BAD_REQUEST)

            # ---------
            # 1) Actualiza Appointment (campos directos)
            # ---------
            fields = _field_map(Appointment)
            update_fields: List[str] = []

            setattr(appt, appt_start_field, new_start_dt)
            setattr(appt, appt_end_field, new_end_dt)
            update_fields.extend([appt_start_field, appt_end_field])

            special_keys = {
                "duration_minutes",
                "service_ids",
                "id",
                "pk",
                "start_datetime",
                "start",
                "end_datetime",
                "end",
                appt_start_field,
                appt_end_field,
                "barber_id",
                "worker_id",
            }

            for key, raw_value in data.items():
                if key in special_keys:
                    continue

                # FK por *_id (solo si el field existe en Appointment)
                if key.endswith("_id") and key[:-3] in fields:
                    fk_field_name = key[:-3]
                    fk_field = fields[fk_field_name]
                    if getattr(fk_field, "many_to_one", False) or getattr(fk_field, "is_relation", False):
                        try:
                            setattr(appt, key, int(raw_value) if raw_value is not None else None)
                            update_fields.append(key)
                        except Exception:
                            return Response({"detail": f"Valor inválido para {key}."}, status=status.HTTP_400_BAD_REQUEST)
                    continue

                if key in fields:
                    field = fields[key]
                    if getattr(field, "primary_key", False):
                        continue
                    if getattr(field, "auto_now", False) or getattr(field, "auto_now_add", False):
                        continue

                    coerced = _coerce_value(field, raw_value)

                    if getattr(field, "choices", None) and coerced is not None:
                        if not _validate_choice(field, coerced):
                            return Response({"detail": f"Valor inválido para {key}. No está en choices."}, status=status.HTTP_400_BAD_REQUEST)

                    if field.get_internal_type() == "DateTimeField" and raw_value is not None and coerced is None:
                        return Response({"detail": f"Formato inválido para {key}. Usa ISO 8601."}, status=status.HTTP_400_BAD_REQUEST)

                    setattr(appt, key, coerced)
                    update_fields.append(key)

            appt.save(update_fields=sorted(set(update_fields)))

            # ---------
            # 2) Cargar blocks actuales (con worker)
            # ---------
            blocks = list(
                AppointmentBlock.objects.select_for_update()
                .filter(appointment_id=appt.id)
                .select_related("worker")
                .order_by("sequence", "id")
            )

            # ---------
            # 3) Si NO vienen service_ids -> solo sync tiempos + (opcional) barber_id a todos los blocks
            #    Pero tu caso clave es cuando sí vienen service_ids
            # ---------
            if ids_int is None:
                for b in blocks:
                    setattr(b, block_start_field, new_start_dt)
                    setattr(b, block_end_field, new_end_dt)

                    # si mandan barber_id, aplicarlo al bloque BARBER si existe
                    if barber_id_int is not None and getattr(b.worker, "role", None) == "BARBER":
                        b.worker_id = barber_id_int

                    try:
                        b.save(update_fields=[block_start_field, block_end_field, "worker"])
                    except Exception:
                        # si falla por constraint uniq_worker_start_datetime_block u otro
                        return Response({"detail": "No se pudo actualizar el bloque (conflicto worker/start)."}, status=status.HTTP_400_BAD_REQUEST)

            # ---------
            # 4) Si vienen service_ids -> reconstruimos blocks por rol + service_lines con snapshots
            # ---------
            else:
                # 4.1 servicios de catálogo
                svcs = list(CatalogService.objects.filter(id__in=ids_int).select_related("category"))
                if len(svcs) != len(ids_int):
                    return Response({"detail": "Uno o más service_ids no existen."}, status=status.HTTP_400_BAD_REQUEST)

                svc_by_id: Dict[int, CatalogService] = {int(s.id): s for s in svcs}
                svc_role: Dict[int, str] = {int(s.id): _group_for_service(s) for s in svcs}
                roles_present = set(svc_role.values())  # BARBER/NAILS/FACIAL

                # 4.2 index blocks existentes por rol
                by_role: Dict[str, AppointmentBlock] = {}
                for b in blocks:
                    role = getattr(getattr(b, "worker", None), "role", None)
                    if role in ("BARBER", "NAILS", "FACIAL") and role not in by_role:
                        by_role[role] = b

                # 4.3 crear/actualizar blocks requeridos en orden fijo
                order = ["BARBER", "NAILS", "FACIAL"]
                kept_blocks: List[AppointmentBlock] = []
                seq = 1

                for role in order:
                    if role not in roles_present:
                        continue

                    existing = by_role.get(role)
                    current_worker = existing.worker if existing else None
                    worker = _pick_worker_for_role(
                        role,
                        barber_id=barber_id_int if role == "BARBER" else None,
                        current=current_worker,
                    )

                    if not worker:
                        return Response({"detail": f"No existe trabajador configurado para el rol {role}."}, status=status.HTTP_400_BAD_REQUEST)

                    if existing:
                        existing.sequence = seq
                        existing.worker = worker
                        setattr(existing, block_start_field, new_start_dt)
                        setattr(existing, block_end_field, new_end_dt)
                        try:
                            existing.save(update_fields=["sequence", "worker", block_start_field, block_end_field])
                        except IntegrityError as ie:
                            return Response({"detail": f"Conflicto de bloque (worker/start): {str(ie)}"}, status=status.HTTP_400_BAD_REQUEST)
                        kept_blocks.append(existing)
                    else:
                        try:
                            nb = AppointmentBlock.objects.create(
                                appointment=appt,
                                sequence=seq,
                                worker=worker,
                                start_datetime=new_start_dt,
                                end_datetime=new_end_dt,
                            )
                        except IntegrityError as ie:
                            return Response({"detail": f"Conflicto creando bloque (worker/start): {str(ie)}"}, status=status.HTTP_400_BAD_REQUEST)
                        kept_blocks.append(nb)

                    seq += 1

                # 4.4 eliminar blocks que ya no aplican (roles no presentes)
                for b in blocks:
                    role = getattr(getattr(b, "worker", None), "role", None)
                    if role in ("BARBER", "NAILS", "FACIAL") and role not in roles_present:
                        b.delete()

                # 4.5 reconstruir service_lines (con snapshots NO nulos)
                subtotal = Decimal("0")

                for b in kept_blocks:
                    role = getattr(b.worker, "role", None)

                    # ids de este rol (respetar el orden recibido)
                    role_ids = [int(sid) for sid in ids_int if svc_role.get(int(sid)) == role]

                    # borrar anteriores
                    AppointmentServiceLine.objects.filter(appointment_block=b).delete()

                    lines: List[AppointmentServiceLine] = []
                    for sid in role_ids:
                        svc = svc_by_id[int(sid)]

                        duration = int(getattr(svc, "duration_minutes", 0) or 0)
                        buf_before = int(getattr(svc, "buffer_before_minutes", 0) or 0)
                        buf_after = int(getattr(svc, "buffer_after_minutes", 0) or 0)
                        price = Decimal(str(getattr(svc, "price", 0) or 0))

                        # OJO: duration_minutes_snapshot es NOT NULL -> siempre mandamos int
                        lines.append(
                            AppointmentServiceLine(
                                appointment_block=b,
                                service=svc,
                                service_name_snapshot=str(getattr(svc, "name", "") or ""),
                                duration_minutes_snapshot=duration,
                                buffer_before_snapshot=buf_before,
                                buffer_after_snapshot=buf_after,
                                price_snapshot=price,
                            )
                        )

                        subtotal += price

                    # si por alguna razón un rol queda sin líneas, igual no debería romper
                    if lines:
                        try:
                            AppointmentServiceLine.objects.bulk_create(lines)
                        except Exception as ex:
                            return Response(
                                {"detail": f"Error actualizando servicios del bloque: {type(ex).__name__}: {str(ex)}"},
                                status=status.HTTP_400_BAD_REQUEST,
                            )

                # 4.6 actualizar totales recomendados
                appt.recommended_subtotal = subtotal
                disc = appt.recommended_discount or Decimal("0")
                appt.recommended_total = max(subtotal - disc, Decimal("0"))
                appt.save(update_fields=["recommended_subtotal", "recommended_total"])

            # ---------
            # 5) Audit (si existe)
            # ---------
            after_snapshot = {
                "start": getattr(appt, appt_start_field, None),
                "end": getattr(appt, appt_end_field, None),
                "status": getattr(appt, "status", None),
            }

            if AppointmentAudit is not None:
                try:
                    AppointmentAudit.objects.create(
                        appointment=appt,
                        action="INLINE_EDIT",
                        performed_by=user,
                        performed_at=timezone.now(),
                        reason=data.get("note") or data.get("reason") or None,
                        detail_json={"before": before_snapshot, "after": after_snapshot},
                    )
                except Exception:
                    pass

            return Response(
                {
                    "id": appt.id,
                    "status": getattr(appt, "status", None),
                    "start_datetime": getattr(appt, appt_start_field),
                    "end_datetime": getattr(appt, appt_end_field),
                    "updated_fields": sorted(set(update_fields)),
                    "detail": "Edición aplicada (sin validar disponibilidad).",
                },
                status=status.HTTP_200_OK,
            )
