from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.models import Appointment, AppointmentBlock, AppointmentServiceLine
from catalog.models import Service as CatalogService
from staffing.models import Worker

try:
    from booking.models import AppointmentAudit
except Exception:  # pragma: no cover
    AppointmentAudit = None


# -----------------------------
# Helpers generales
# -----------------------------
def _datetime_field_names_for_model(model) -> Tuple[str, str]:
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
    if value is None:
        return None
    if hasattr(value, "tzinfo"):
        return value
    if isinstance(value, str):
        return parse_datetime(value)
    return None


def _ensure_tz_compat(dt):
    """
    Si USE_TZ=False y dt es aware -> lo vuelve naive.
    Si USE_TZ=True y dt es naive -> lo vuelve aware en timezone local.
    """
    if dt is None:
        return None

    if getattr(settings, "USE_TZ", False):
        if timezone.is_naive(dt):
            return timezone.make_aware(dt, timezone.get_current_timezone())
        return dt
    else:
        if timezone.is_aware(dt):
            return timezone.make_naive(dt, timezone.get_current_timezone())
        return dt


def _to_int_list(value: Any) -> List[int]:
    """
    Acepta:
    - [1,2,3]
    - ("1","2")
    - "1,2,3"
    """
    if value is None:
        return []
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        parts = [p.strip() for p in raw.split(",")]
        out = []
        for p in parts:
            if not p:
                continue
            out.append(int(p))
        return out
    if isinstance(value, (list, tuple)):
        out = []
        for x in value:
            if x in (None, ""):
                continue
            out.append(int(x))
        return out
    raise ValueError("Debe ser lista/tupla de enteros o string '1,2,3'.")


# -----------------------------
# Inferencia de rol (BARBER/NAILS/FACIAL)
# -----------------------------
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
    """
    Intenta sacar un "group/role" explícito de la categoría si existe,
    y si no, infiere por nombre.
    """
    try:
        cat = getattr(svc, "category", None)
        # si tu categoría tiene algo tipo key/group/codigo
        for attr in ("group", "role", "key", "code", "codigo"):
            v = getattr(cat, attr, None)
            if v:
                vv = str(v).upper()
                if "NAIL" in vv or "UÑ" in vv or "UNA" in vv:
                    return "NAILS"
                if "FAC" in vv:
                    return "FACIAL"
                if "BARB" in vv:
                    return "BARBER"
    except Exception:
        pass

    cat_name = ""
    try:
        cat = getattr(svc, "category", None)
        cat_name = getattr(cat, "name", "") or getattr(cat, "nombre", "") or ""
    except Exception:
        cat_name = ""

    text = f"{cat_name} {getattr(svc, 'name', '')}"
    return _infer_group_from_text(text)


def _pick_worker_for_role(role: str, barber_id: Optional[int], current_worker: Optional[Worker]) -> Optional[Worker]:
    """
    - BARBER: si barber_id viene -> ese. Si no, conserva current_worker. Si no, primero BARBER.
    - NAILS/FACIAL: conserva current_worker si ya existe; si no, primero de su rol.
    """
    if role == "BARBER":
        if barber_id:
            return Worker.objects.filter(id=barber_id).first()
        if current_worker:
            return current_worker
        return Worker.objects.filter(role="BARBER").first()

    if current_worker:
        return current_worker

    return Worker.objects.filter(role=role).first()


def _safe_price(v: Any) -> Decimal:
    try:
        return Decimal(str(v or "0"))
    except Exception:
        return Decimal("0")


# -----------------------------
# API View
# -----------------------------
class AppointmentInlineEditAPIView(APIView):
    """
    Edita un turno SIN validar disponibilidad.

    Soporta URL kwarg appointment_id o pk.
    """

    def post(self, request, appointment_id: Optional[int] = None, pk: Optional[int] = None, **kwargs):
        return self._handle(request, appointment_id=appointment_id, pk=pk, **kwargs)

    def patch(self, request, appointment_id: Optional[int] = None, pk: Optional[int] = None, **kwargs):
        return self._handle(request, appointment_id=appointment_id, pk=pk, **kwargs)

    def _handle(self, request, appointment_id: Optional[int] = None, pk: Optional[int] = None, **kwargs):
        user = request.user
        if not user or not user.is_authenticated:
            return Response({"detail": "No autenticado."}, status=status.HTTP_401_UNAUTHORIZED)

        # ✅ agarra el id venga como venga
        appt_id = appointment_id or pk or kwargs.get("appointment_id") or kwargs.get("pk")
        try:
            appt_id = int(appt_id)
        except Exception:
            return Response({"detail": "Id de cita inválido en la URL."}, status=status.HTTP_400_BAD_REQUEST)

        data = request.data or {}

        appt_start_field, appt_end_field = _datetime_field_names_for_model(Appointment)
        block_start_field, block_end_field = _datetime_field_names_for_model(AppointmentBlock)

        # start/end
        start_in = data.get(appt_start_field, data.get("start_datetime", data.get("start")))
        end_in = data.get(appt_end_field, data.get("end_datetime", data.get("end")))

        new_start_dt = _ensure_tz_compat(_parse_dt(start_in))
        new_end_dt = _ensure_tz_compat(_parse_dt(end_in))

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

        # service_ids (si viene, reemplaza servicios)
        service_ids_present = "service_ids" in data
        ids_int: Optional[List[int]] = None
        if service_ids_present:
            try:
                ids_int = _to_int_list(data.get("service_ids"))
            except Exception as ve:
                return Response({"detail": f"service_ids inválido: {str(ve)}"}, status=status.HTTP_400_BAD_REQUEST)
            if not ids_int:
                return Response({"detail": "Selecciona al menos un servicio."}, status=status.HTTP_400_BAD_REQUEST)

        # barber_id / worker_id
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
                appt = Appointment.objects.select_for_update().get(id=appt_id)
            except Appointment.DoesNotExist:
                return Response({"detail": "Cita no encontrada."}, status=status.HTTP_404_NOT_FOUND)

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

            # 1) update appointment times
            setattr(appt, appt_start_field, new_start_dt)
            setattr(appt, appt_end_field, new_end_dt)
            appt.save(update_fields=[appt_start_field, appt_end_field])

            # 2) blocks existentes
            blocks = list(
                AppointmentBlock.objects.select_for_update()
                .filter(appointment_id=appt.id)
                .select_related("worker")
                .order_by("sequence", "id")
            )

            # Siempre sincroniza start/end en blocks
            for b in blocks:
                setattr(b, block_start_field, new_start_dt)
                setattr(b, block_end_field, new_end_dt)

            # Si NO cambias servicios, solo intenta cambiar barbero si viene
            if ids_int is None:
                if barber_id_int is not None:
                    for b in blocks:
                        if getattr(b.worker, "role", None) == "BARBER":
                            b.worker_id = barber_id_int
                # guarda blocks
                for b in blocks:
                    try:
                        b.save(update_fields=[block_start_field, block_end_field, "worker"])
                    except IntegrityError as ie:
                        return Response({"detail": f"Conflicto worker/start en bloque: {str(ie)}"}, status=status.HTTP_400_BAD_REQUEST)

                return Response(
                    {
                        "id": appt.id,
                        "start_datetime": getattr(appt, appt_start_field),
                        "end_datetime": getattr(appt, appt_end_field),
                        "detail": "Edición aplicada (tiempo/worker).",
                    },
                    status=status.HTTP_200_OK,
                )

            # 3) Si cambia servicios -> reconstruimos blocks por rol y service_lines con snapshots
            svcs = list(CatalogService.objects.filter(id__in=ids_int).select_related("category"))
            if len(svcs) != len(ids_int):
                return Response({"detail": "Uno o más service_ids no existen."}, status=status.HTTP_400_BAD_REQUEST)

            svc_by_id: Dict[int, CatalogService] = {int(s.id): s for s in svcs}
            svc_role: Dict[int, str] = {int(s.id): _group_for_service(s) for s in svcs}
            roles_present = set(svc_role.values())  # BARBER/NAILS/FACIAL

            # por rol, toma el primer bloque existente
            by_role: Dict[str, AppointmentBlock] = {}
            extra_blocks: List[AppointmentBlock] = []
            for b in blocks:
                r = getattr(getattr(b, "worker", None), "role", None)
                if r in ("BARBER", "NAILS", "FACIAL"):
                    if r not in by_role:
                        by_role[r] = b
                    else:
                        extra_blocks.append(b)

            # elimina bloques duplicados si existían
            for b in extra_blocks:
                b.delete()

            order = ["BARBER", "NAILS", "FACIAL"]
            kept_blocks: List[AppointmentBlock] = []
            seq = 1

            for role in order:
                if role not in roles_present:
                    continue

                existing = by_role.get(role)
                current_worker = existing.worker if existing else None
                worker = _pick_worker_for_role(role, barber_id_int if role == "BARBER" else None, current_worker)

                if not worker:
                    return Response({"detail": f"No existe trabajador para rol {role}."}, status=status.HTTP_400_BAD_REQUEST)

                if existing:
                    existing.sequence = seq
                    existing.worker = worker
                    setattr(existing, block_start_field, new_start_dt)
                    setattr(existing, block_end_field, new_end_dt)
                    try:
                        existing.save(update_fields=["sequence", "worker", block_start_field, block_end_field])
                    except IntegrityError as ie:
                        return Response({"detail": f"Conflicto worker/start en bloque {role}: {str(ie)}"}, status=status.HTTP_400_BAD_REQUEST)
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
                        return Response({"detail": f"Conflicto creando bloque {role}: {str(ie)}"}, status=status.HTTP_400_BAD_REQUEST)
                    kept_blocks.append(nb)

                seq += 1

            # elimina bloques de roles que ya no están
            for b in blocks:
                r = getattr(getattr(b, "worker", None), "role", None)
                if r in ("BARBER", "NAILS", "FACIAL") and r not in roles_present:
                    b.delete()

            # service_lines: borrar y recrear con snapshots completos
            subtotal = Decimal("0")

            for b in kept_blocks:
                role = getattr(b.worker, "role", None)

                role_ids = [int(sid) for sid in ids_int if svc_role.get(int(sid)) == role]

                AppointmentServiceLine.objects.filter(appointment_block=b).delete()

                new_lines: List[AppointmentServiceLine] = []
                for sid in role_ids:
                    svc = svc_by_id[int(sid)]
                    duration = int(getattr(svc, "duration_minutes", 0) or 0)
                    buf_before = int(getattr(svc, "buffer_before_minutes", 0) or 0)
                    buf_after = int(getattr(svc, "buffer_after_minutes", 0) or 0)
                    price = _safe_price(getattr(svc, "price", 0))

                    new_lines.append(
                        AppointmentServiceLine(
                            appointment_block=b,
                            service=svc,
                            service_name_snapshot=str(getattr(svc, "name", "") or ""),
                            duration_minutes_snapshot=duration,  # NOT NULL
                            buffer_before_snapshot=buf_before,
                            buffer_after_snapshot=buf_after,
                            price_snapshot=price,  # NOT NULL
                        )
                    )
                    subtotal += price

                if new_lines:
                    try:
                        AppointmentServiceLine.objects.bulk_create(new_lines)
                    except Exception as ex:
                        return Response(
                            {"detail": f"Error creando service_lines: {type(ex).__name__}: {str(ex)}"},
                            status=status.HTTP_400_BAD_REQUEST,
                        )

            # recalcular totales
            appt.recommended_subtotal = subtotal
            disc = appt.recommended_discount or Decimal("0")
            appt.recommended_total = max(subtotal - disc, Decimal("0"))
            appt.save(update_fields=["recommended_subtotal", "recommended_total"])

            # Audit (si existe)
            if AppointmentAudit is not None:
                try:
                    # si INLINE_EDIT no está en choices, usamos STATUS_CHANGE para no ensuciar choices
                    action_val = "INLINE_EDIT"
                    allowed = set()
                    try:
                        allowed = {c[0] for c in getattr(AppointmentAudit, "ACTION_CHOICES", [])}
                    except Exception:
                        allowed = set()
                    if allowed and action_val not in allowed:
                        action_val = getattr(AppointmentAudit, "ACTION_STATUS_CHANGE", "STATUS_CHANGE")

                    AppointmentAudit.objects.create(
                        appointment=appt,
                        action=action_val,
                        performed_by=user,
                        performed_at=timezone.now(),
                        reason=data.get("note") or None,
                        detail_json={
                            "service_ids": ids_int,
                            "barber_id": barber_id_int,
                            "start": str(getattr(appt, appt_start_field)),
                            "end": str(getattr(appt, appt_end_field)),
                        },
                    )
                except Exception:
                    pass

            # Respuesta útil para verificar en Network
            return Response(
                {
                    "id": appt.id,
                    "start_datetime": getattr(appt, appt_start_field),
                    "end_datetime": getattr(appt, appt_end_field),
                    "roles_present": sorted(list(roles_present)),
                    "blocks": [
                        {
                            "id": b.id,
                            "sequence": b.sequence,
                            "worker_id": b.worker_id,
                            "worker_role": getattr(b.worker, "role", None),
                            "service_lines": AppointmentServiceLine.objects.filter(appointment_block=b).count(),
                        }
                        for b in kept_blocks
                    ],
                    "recommended_subtotal": str(appt.recommended_subtotal),
                    "recommended_total": str(appt.recommended_total),
                    "detail": "Edición aplicada (tiempo + worker + servicios) sin validar disponibilidad.",
                },
                status=status.HTTP_200_OK,
            )
