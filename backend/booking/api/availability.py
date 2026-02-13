from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, time
from typing import Any, Iterable

from django.conf import settings
from django.db.models import Q
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from booking.models import AppointmentBlock
from booking.tokens import encode_option_id
from catalog.models import Service

# staffing
from staffing.models import Worker, WorkerScheduleRule, WorkerBreak, WorkerException


# -----------------------------
# Config por defecto (ajustable en settings.py)
# -----------------------------
DEFAULT_OPEN_TIME = getattr(settings, "BOOKING_OPEN_TIME", "09:00")    # "HH:MM" fallback
DEFAULT_CLOSE_TIME = getattr(settings, "BOOKING_CLOSE_TIME", "19:00")  # "HH:MM" fallback
DEFAULT_SLOT_INTERVAL = int(getattr(settings, "BOOKING_SLOT_INTERVAL_MINUTES", 5))
DEFAULT_OPTIONS_LIMIT = int(getattr(settings, "BOOKING_OPTIONS_LIMIT", 200))

DEFAULT_FIXED_NAILS_WORKER_ID = int(getattr(settings, "FIXED_NAILS_WORKER_ID", 0) or 0)
DEFAULT_FIXED_FACIAL_WORKER_ID = int(getattr(settings, "FIXED_FACIAL_WORKER_ID", 0) or 0)


@dataclass(frozen=True)
class ServiceInfo:
    id: int
    name: str
    duration: int
    buffer_before: int
    buffer_after: int
    group: str  # "BARBER" | "NAILS" | "FACIAL"


@dataclass(frozen=True)
class Interval:
    start: datetime
    end: datetime


def overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and a_end > b_start


def merge_intervals(intervals: list[Interval]) -> list[Interval]:
    if not intervals:
        return []
    intervals = sorted(intervals, key=lambda x: x.start)
    out = [intervals[0]]
    for it in intervals[1:]:
        last = out[-1]
        if it.start <= last.end:
            out[-1] = Interval(start=last.start, end=max(last.end, it.end))
        else:
            out.append(it)
    return out


def subtract_interval(base: Interval, cut: Interval) -> list[Interval]:
    """
    Devuelve base - cut (puede resultar en 0, 1 o 2 intervalos).
    """
    if not overlaps(base.start, base.end, cut.start, cut.end):
        return [base]

    # cut cubre todo
    if cut.start <= base.start and cut.end >= base.end:
        return []

    # corta al inicio
    if cut.start <= base.start < cut.end < base.end:
        return [Interval(start=cut.end, end=base.end)]

    # corta al final
    if base.start < cut.start < base.end <= cut.end:
        return [Interval(start=base.start, end=cut.start)]

    # corte en el medio -> dos pedazos
    if base.start < cut.start and cut.end < base.end:
        return [
            Interval(start=base.start, end=cut.start),
            Interval(start=cut.end, end=base.end),
        ]

    return [base]


class AvailabilityOptionsAPIView(APIView):
    """
    Devuelve opciones de turno (no se permite elegir una hora exacta).
    Ahora usa horario REAL del worker:
      - WorkerScheduleRule (por día de semana)
      - WorkerBreak (por día de semana)
      - WorkerException (por fecha)
      - y evita cruces con AppointmentBlock
    """
    permission_classes = []

    # caches por request
    _work_intervals: dict[int, list[Interval]]
    _conflicts: dict[int, list[Interval]]

    def post(self, request):
        self._work_intervals = {}
        self._conflicts = {}

        payload = request.data if isinstance(request.data, dict) else {}

        date_str = payload.get("date")
        service_ids = payload.get("service_ids") or []
        if not date_str:
            return Response({"detail": "date es requerido (YYYY-MM-DD)."}, status=400)
        if not service_ids:
            return Response({"detail": "service_ids es requerido."}, status=400)

        # Preferencias barbero
        barber_choice = (payload.get("barber_choice") or "SPECIFIC").upper()  # SPECIFIC | NEAREST
        barber_id = payload.get("barber_id")  # opcional

        slot_interval = int(payload.get("slot_interval_minutes") or DEFAULT_SLOT_INTERVAL)
        options_limit = int(payload.get("limit") or DEFAULT_OPTIONS_LIMIT)

        # Cargar servicios (solo activos)
        services_qs = Service.objects.filter(id__in=service_ids, active=True)
        services = list(services_qs)
        if len(services) != len(service_ids):
            return Response({"detail": "Uno o más servicios no existen o están inactivos."}, status=400)

        service_infos = [self._to_service_info(s) for s in services]

        # Agrupar por tipo
        barber_services = [si for si in service_infos if si.group == "BARBER"]
        nails_services = [si for si in service_infos if si.group == "NAILS"]
        facial_services = [si for si in service_infos if si.group == "FACIAL"]

        # Definir candidatos barbero
        barber_candidates = self._resolve_barber_candidates(barber_choice, barber_id) if barber_services else []

        # Workers fijos (uñas/facial): primero intenta desde servicio/category, si no, fallback settings
        nails_worker_id = self._resolve_fixed_worker_for_group(services, group="NAILS") or int(payload.get("nails_worker_id") or DEFAULT_FIXED_NAILS_WORKER_ID or 0)
        facial_worker_id = self._resolve_fixed_worker_for_group(services, group="FACIAL") or int(payload.get("facial_worker_id") or DEFAULT_FIXED_FACIAL_WORKER_ID or 0)

        if nails_services and not nails_worker_id:
            return Response({"detail": "No está configurado el trabajador fijo de uñas."}, status=500)
        if facial_services and not facial_worker_id:
            return Response({"detail": "No está configurado el trabajador fijo de facial."}, status=500)

        # Parse fecha y TZ
        tz = timezone.get_current_timezone()
        date_obj = datetime.fromisoformat(date_str).date()

        # Secuencias posibles (secuencial por cliente)
        sequences = self._build_sequences(
            has_barber=bool(barber_services),
            has_nails=bool(nails_services),
            has_facial=bool(facial_services),
        )

        total_minutes = (
            self._block_minutes(barber_services)
            + self._block_minutes(nails_services)
            + self._block_minutes(facial_services)
        )
        if total_minutes <= 0:
            return Response({"detail": "Los servicios seleccionados no tienen duración válida."}, status=400)

        # 1) Preparar lista de workers involucrados para cache de horarios y conflictos
        involved_workers: set[int] = set()
        for b in barber_candidates:
            involved_workers.add(int(b))
        if nails_services:
            involved_workers.add(int(nails_worker_id))
        if facial_services:
            involved_workers.add(int(facial_worker_id))

        # 2) Construir work intervals reales por worker para ese date
        for wid in involved_workers:
            self._work_intervals[wid] = self._get_worker_work_intervals(wid, date_obj, tz)

        # Si NO hay ningún worker con horario ese día, devuelve vacío
        any_work = any(self._work_intervals.get(wid) for wid in involved_workers)
        if not any_work:
            return Response([], status=200)

        # 3) Definir ventana global para iterar start_cursor (min->max) basada en horarios reales
        day_open, day_close = self._global_day_window_from_workers(involved_workers)
        if not day_open or not day_close or day_close <= day_open:
            return Response([], status=200)

        latest_start = day_close - timedelta(minutes=total_minutes)
        if latest_start < day_open:
            return Response([], status=200)

        # 4) Cache de conflictos (AppointmentBlocks) por worker dentro del rango global
        self._prefetch_conflicts(involved_workers, day_open, day_close)

        # 5) Generar opciones
        options: list[dict[str, Any]] = []
        seen_signatures: set[str] = set()

        start_cursor = day_open
        while start_cursor <= latest_start and len(options) < options_limit:
            opt = self._try_build_one_option(
                start_time=start_cursor,
                sequences=sequences,
                barber_candidates=barber_candidates,
                barber_services=barber_services,
                nails_services=nails_services,
                facial_services=facial_services,
                fixed_nails_worker_id=nails_worker_id,
                fixed_facial_worker_id=facial_worker_id,
            )

            if opt:
                signature = self._option_signature(opt)
                if signature not in seen_signatures:
                    seen_signatures.add(signature)

                    token_payload = {
                        "appointment_start": opt["appointment_start"],
                        "appointment_end": opt["appointment_end"],
                        "gap_total_minutes": 0,
                        "blocks": [
                            {
                                "sequence": b["sequence"],
                                "worker_id": b["worker_id"],
                                "start": b["start"],
                                "end": b["end"],
                                "service_ids": b["service_ids"],
                            }
                            for b in opt["blocks"]
                        ],
                    }
                    opt["option_id"] = encode_option_id(token_payload)
                    options.append(opt)

            start_cursor = start_cursor + timedelta(minutes=slot_interval)

        return Response(options, status=200)

    # -----------------------------
    # Construcción de opciones
    # -----------------------------
    def _try_build_one_option(
        self,
        *,
        start_time: datetime,
        sequences: list[list[str]],
        barber_candidates: list[int],
        barber_services: list[ServiceInfo],
        nails_services: list[ServiceInfo],
        facial_services: list[ServiceInfo],
        fixed_nails_worker_id: int,
        fixed_facial_worker_id: int,
    ) -> dict[str, Any] | None:
        sequences_sorted = sequences[:]

        if barber_services:
            barber_block_minutes = self._block_minutes(barber_services)
            barber_free_now = any(
                self._is_worker_available(
                    worker_id=b_id,
                    start_dt=start_time,
                    end_dt=start_time + timedelta(minutes=barber_block_minutes),
                )
                for b_id in barber_candidates
            )
            if barber_free_now:
                sequences_sorted.sort(key=lambda seq: 0 if seq[0] == "BARBER" else 1)
            else:
                sequences_sorted.sort(key=lambda seq: 0 if seq[0] != "BARBER" else 1)

        for seq in sequences_sorted:
            candidate_barbers = barber_candidates if "BARBER" in seq else [0]

            for barber_id in candidate_barbers:
                built = self._build_schedule_for_sequence(
                    start_time=start_time,
                    seq=seq,
                    barber_id=barber_id,
                    barber_services=barber_services,
                    nails_services=nails_services,
                    facial_services=facial_services,
                    fixed_nails_worker_id=fixed_nails_worker_id,
                    fixed_facial_worker_id=fixed_facial_worker_id,
                )
                if built:
                    return built

        return None

    def _build_schedule_for_sequence(
        self,
        *,
        start_time: datetime,
        seq: list[str],
        barber_id: int,
        barber_services: list[ServiceInfo],
        nails_services: list[ServiceInfo],
        facial_services: list[ServiceInfo],
        fixed_nails_worker_id: int,
        fixed_facial_worker_id: int,
    ) -> dict[str, Any] | None:
        cursor = start_time
        blocks: list[dict[str, Any]] = []
        sequence_num = 1

        for group in seq:
            if group == "BARBER":
                if not barber_services:
                    continue
                worker_id = int(barber_id) if barber_id else 0
                if not worker_id:
                    return None
                minutes = self._block_minutes(barber_services)
                start_dt, end_dt = cursor, cursor + timedelta(minutes=minutes)

                if not self._is_worker_available(worker_id, start_dt, end_dt):
                    return None

                blocks.append(self._block_dict(sequence_num, worker_id, start_dt, end_dt, barber_services))
                cursor = end_dt
                sequence_num += 1

            elif group == "NAILS":
                if not nails_services:
                    continue
                worker_id = int(fixed_nails_worker_id)
                minutes = self._block_minutes(nails_services)
                start_dt, end_dt = cursor, cursor + timedelta(minutes=minutes)

                if not self._is_worker_available(worker_id, start_dt, end_dt):
                    return None

                blocks.append(self._block_dict(sequence_num, worker_id, start_dt, end_dt, nails_services))
                cursor = end_dt
                sequence_num += 1

            elif group == "FACIAL":
                if not facial_services:
                    continue
                worker_id = int(fixed_facial_worker_id)
                minutes = self._block_minutes(facial_services)
                start_dt, end_dt = cursor, cursor + timedelta(minutes=minutes)

                if not self._is_worker_available(worker_id, start_dt, end_dt):
                    return None

                blocks.append(self._block_dict(sequence_num, worker_id, start_dt, end_dt, facial_services))
                cursor = end_dt
                sequence_num += 1

        if not blocks:
            return None

        return {
            "option_id": "",
            "appointment_start": blocks[0]["start"],
            "appointment_end": blocks[-1]["end"],
            "gap_total_minutes": 0,
            "blocks": blocks,
        }

    # -----------------------------
    # Disponibilidad REAL
    # -----------------------------
    def _is_worker_available(self, worker_id: int, start_dt: datetime, end_dt: datetime) -> bool:
        # 1) dentro de horario laboral real
        work = self._work_intervals.get(worker_id) or []
        if not any(start_dt >= it.start and end_dt <= it.end for it in work):
            return False

        # 2) no choca con bloques existentes
        conflicts = self._conflicts.get(worker_id) or []
        for c in conflicts:
            if overlaps(start_dt, end_dt, c.start, c.end):
                return False

        return True

    def _prefetch_conflicts(self, worker_ids: set[int], start_dt: datetime, end_dt: datetime) -> None:
        qs = (
            AppointmentBlock.objects
            .filter(worker_id__in=list(worker_ids))
            .filter(Q(start_datetime__lt=end_dt) & Q(end_datetime__gt=start_dt))
            .values("worker_id", "start_datetime", "end_datetime")
        )
        for row in qs:
            wid = int(row["worker_id"])
            self._conflicts.setdefault(wid, []).append(
                Interval(start=row["start_datetime"], end=row["end_datetime"])
            )
        for wid in list(self._conflicts.keys()):
            self._conflicts[wid] = merge_intervals(self._conflicts[wid])

    def _get_worker_work_intervals(self, worker_id: int, date_obj, tz) -> list[Interval]:
        """
        Construye intervalos laborales reales para un worker en una fecha:
          base: schedule_rules del weekday (active=True)
          minus: breaks del weekday
          exceptions:
            - TIME_OFF: elimina todo el día o un rango
            - EXTRA_WORKING: agrega un rango
        """
        weekday = date_obj.weekday()  # 0=lunes ... 6=domingo

        base_rules = list(
            WorkerScheduleRule.objects.filter(worker_id=worker_id, day_of_week=weekday, active=True)
            .values("start_time", "end_time")
        )

        # Si no tiene reglas: NO trabaja (supuesto)
        if not base_rules:
            return []

        base_intervals: list[Interval] = []
        for r in base_rules:
            s = timezone.make_aware(datetime.combine(date_obj, r["start_time"]), tz)
            e = timezone.make_aware(datetime.combine(date_obj, r["end_time"]), tz)
            if e > s:
                base_intervals.append(Interval(start=s, end=e))

        base_intervals = merge_intervals(base_intervals)

        # breaks (restar)
        breaks = list(
            WorkerBreak.objects.filter(worker_id=worker_id, day_of_week=weekday)
            .values("start_time", "end_time")
        )
        for b in breaks:
            bs = timezone.make_aware(datetime.combine(date_obj, b["start_time"]), tz)
            be = timezone.make_aware(datetime.combine(date_obj, b["end_time"]), tz)
            cut = Interval(start=bs, end=be)
            new_list: list[Interval] = []
            for it in base_intervals:
                new_list.extend(subtract_interval(it, cut))
            base_intervals = merge_intervals(new_list)

        # exceptions (aplicar por fecha)
        exs = list(
            WorkerException.objects.filter(worker_id=worker_id, date=date_obj)
            .values("type", "start_time", "end_time")
        )

        for ex in exs:
            etype = ex["type"]

            # TIME_OFF
            if etype == WorkerException.TYPE_TIME_OFF:
                if ex["start_time"] is None or ex["end_time"] is None:
                    # día completo libre
                    return []
                off_s = timezone.make_aware(datetime.combine(date_obj, ex["start_time"]), tz)
                off_e = timezone.make_aware(datetime.combine(date_obj, ex["end_time"]), tz)
                cut = Interval(start=off_s, end=off_e)
                new_list: list[Interval] = []
                for it in base_intervals:
                    new_list.extend(subtract_interval(it, cut))
                base_intervals = merge_intervals(new_list)

            # EXTRA_WORKING
            elif etype == WorkerException.TYPE_EXTRA_WORKING:
                if ex["start_time"] is None or ex["end_time"] is None:
                    # si no hay horas, no agregamos nada (puedes cambiar esta regla si lo deseas)
                    continue
                extra_s = timezone.make_aware(datetime.combine(date_obj, ex["start_time"]), tz)
                extra_e = timezone.make_aware(datetime.combine(date_obj, ex["end_time"]), tz)
                if extra_e > extra_s:
                    base_intervals.append(Interval(start=extra_s, end=extra_e))
                    base_intervals = merge_intervals(base_intervals)

        return base_intervals

    def _global_day_window_from_workers(self, worker_ids: set[int]) -> tuple[datetime | None, datetime | None]:
        starts: list[datetime] = []
        ends: list[datetime] = []
        for wid in worker_ids:
            for it in (self._work_intervals.get(wid) or []):
                starts.append(it.start)
                ends.append(it.end)
        if not starts or not ends:
            return None, None
        return min(starts), max(ends)

    # -----------------------------
    # Helpers (bloques / secuencias / servicios)
    # -----------------------------
    def _block_minutes(self, services: list[ServiceInfo]) -> int:
        return sum((s.buffer_before + s.duration + s.buffer_after) for s in services)

    def _block_dict(self, seq: int, worker_id: int, start_dt: datetime, end_dt: datetime, services: list[ServiceInfo]) -> dict[str, Any]:
        return {
            "sequence": seq,
            "worker_id": worker_id,
            "start": start_dt.isoformat(timespec="seconds"),
            "end": end_dt.isoformat(timespec="seconds"),
            "service_ids": [s.id for s in services],
            "services": [
                {
                    "id": s.id,
                    "name": s.name,
                    "duration": s.duration,
                    "buffer_before": s.buffer_before,
                    "buffer_after": s.buffer_after,
                }
                for s in services
            ],
        }

    def _build_sequences(self, *, has_barber: bool, has_nails: bool, has_facial: bool) -> list[list[str]]:
        groups = []
        if has_barber:
            groups.append("BARBER")
        if has_nails:
            groups.append("NAILS")
        if has_facial:
            groups.append("FACIAL")

        if groups == ["BARBER"]:
            return [["BARBER"]]
        if groups == ["NAILS"]:
            return [["NAILS"]]
        if groups == ["FACIAL"]:
            return [["FACIAL"]]

        if set(groups) == {"BARBER", "NAILS"}:
            return [["BARBER", "NAILS"], ["NAILS", "BARBER"]]
        if set(groups) == {"BARBER", "FACIAL"}:
            return [["BARBER", "FACIAL"], ["FACIAL", "BARBER"]]
        if set(groups) == {"NAILS", "FACIAL"}:
            return [["NAILS", "FACIAL"], ["FACIAL", "NAILS"]]

        return [
            ["BARBER", "NAILS", "FACIAL"],
            ["BARBER", "FACIAL", "NAILS"],
            ["NAILS", "FACIAL", "BARBER"],
            ["FACIAL", "NAILS", "BARBER"],
        ]

    def _resolve_barber_candidates(self, barber_choice: str, barber_id: Any) -> list[int]:
        if barber_choice != "NEAREST":
            return [int(barber_id or 0)] if int(barber_id or 0) else []

        qs = Worker.objects.filter(active=True, role=Worker.ROLE_BARBER).order_by("id")
        ids = list(qs.values_list("id", flat=True))
        return [int(i) for i in ids]

    def _resolve_fixed_worker_for_group(self, services: list[Service], group: str) -> int | None:
        """
        Devuelve el worker fijo para un grupo (NAILS/FACIAL/...) si existe.
        Prioridad:
        1) servicio.assignment_type == FIXED_WORKER => service.fixed_worker
        2) category.default_fixed_worker
        """
        for s in services:
            fixed_worker_id = None

            at = getattr(s, "assignment_type", None)
            fw = getattr(s, "fixed_worker_id", None)
            if at == "FIXED_WORKER" and fw:
                fixed_worker_id = int(fw)

            if not fixed_worker_id:
                dfw = getattr(s.category, "default_fixed_worker_id", None)
                if dfw:
                    fixed_worker_id = int(dfw)

            if fixed_worker_id:
                role = Worker.objects.filter(id=fixed_worker_id).values_list("role", flat=True).first()
                if role and str(role) == group:
                    return fixed_worker_id

        return None

    def _to_service_info(self, s: Service) -> ServiceInfo:
        return ServiceInfo(
            id=int(s.id),
            name=str(s.name),
            duration=int(s.duration_minutes or 0),
            buffer_before=int(s.buffer_before_minutes or 0),
            buffer_after=int(s.buffer_after_minutes or 0),
            group=self._infer_group(s),
        )

    def _infer_group(self, s: Service) -> str:
        """
        Regla robusta:
        1) Si el servicio (o su categoría) tiene worker fijo => el grupo es el role de ese worker.
        2) Si no, es BARBER (se asigna con SPECIFIC/NEAREST).
        """
        fixed_worker_id = None

        at = getattr(s, "assignment_type", None)
        fw = getattr(s, "fixed_worker_id", None)
        if at == "FIXED_WORKER" and fw:
            fixed_worker_id = int(fw)

        if not fixed_worker_id:
            dfw = getattr(s.category, "default_fixed_worker_id", None)
            if dfw:
                fixed_worker_id = int(dfw)

        if fixed_worker_id:
            role = Worker.objects.filter(id=fixed_worker_id).values_list("role", flat=True).first()
            if role:
                return str(role)

        return "BARBER"


    def _option_signature(self, opt: dict[str, Any]) -> str:
        parts = [opt["appointment_start"], opt["appointment_end"]]
        for b in opt["blocks"]:
            parts.append(f'{b["worker_id"]}:{b["start"]}-{b["end"]}:{",".join(map(str, b["service_ids"]))}')
        return "|".join(parts)
