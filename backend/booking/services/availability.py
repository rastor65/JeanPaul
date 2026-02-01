from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from itertools import permutations
from typing import List, Tuple, Optional, Dict

from django.utils import timezone
from django.db.models import Q

from catalog.models import Service
from staffing.models import Worker, WorkerScheduleRule, WorkerBreak, WorkerException
from booking.models import Appointment, AppointmentBlock


MIN_STEP_MINUTES = 5  # granularidad

@dataclass
class ServiceSnap:
    id: int
    name: str
    duration: int
    buffer_before: int
    buffer_after: int
    price: str  # string para Decimal-friendly
    effective_minutes: int

@dataclass
class BlockSpec:
    key: str               # "BARBERY", "NAILS", "FACIAL"
    worker_id: int
    minutes: int
    services: List[ServiceSnap]

@dataclass
class PlannedBlock:
    sequence: int
    worker_id: int
    start: datetime
    end: datetime
    services: List[ServiceSnap]

@dataclass
class OptionPlan:
    start: datetime
    end: datetime
    blocks: List[PlannedBlock]
    gap_total_minutes: int


def _round_up_to_step(dt: datetime, step_minutes: int = MIN_STEP_MINUTES) -> datetime:
    # redondea hacia arriba a múltiplos de step_minutes
    minute = (dt.minute + (step_minutes - 1)) // step_minutes * step_minutes
    if minute >= 60:
        dt = dt.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    else:
        dt = dt.replace(minute=minute, second=0, microsecond=0)
    return dt


def _dt(date_obj, t: time) -> datetime:
    # crea datetime aware en TZ actual
    naive = datetime.combine(date_obj, t)
    return timezone.make_aware(naive, timezone.get_current_timezone())


def _merge_intervals(intervals: List[Tuple[datetime, datetime]]) -> List[Tuple[datetime, datetime]]:
    if not intervals:
        return []
    intervals = sorted(intervals, key=lambda x: x[0])
    merged = [intervals[0]]
    for s, e in intervals[1:]:
        last_s, last_e = merged[-1]
        if s <= last_e:
            merged[-1] = (last_s, max(last_e, e))
        else:
            merged.append((s, e))
    return merged


def _subtract_intervals(base: List[Tuple[datetime, datetime]],
                        blocks: List[Tuple[datetime, datetime]]) -> List[Tuple[datetime, datetime]]:
    if not base:
        return []
    if not blocks:
        return base

    blocks = _merge_intervals(blocks)
    result = []
    for start, end in base:
        cursor = start
        for bs, be in blocks:
            if be <= cursor:
                continue
            if bs >= end:
                break
            if bs > cursor:
                result.append((cursor, min(bs, end)))
            cursor = max(cursor, be)
            if cursor >= end:
                break
        if cursor < end:
            result.append((cursor, end))
    return result


def get_service_snaps(service_ids: List[int]) -> List[ServiceSnap]:
    services = Service.objects.filter(id__in=service_ids, active=True).select_related("category")
    by_id = {s.id: s for s in services}
    snaps: List[ServiceSnap] = []
    for sid in service_ids:
        s = by_id.get(sid)
        if not s:
            raise ValueError(f"Servicio inválido/inactivo: {sid}")
        effective = int(s.duration_minutes) + int(s.buffer_before_minutes) + int(s.buffer_after_minutes)
        snaps.append(ServiceSnap(
            id=s.id,
            name=s.name,
            duration=int(s.duration_minutes),
            buffer_before=int(s.buffer_before_minutes),
            buffer_after=int(s.buffer_after_minutes),
            price=str(s.price),
            effective_minutes=effective
        ))
    return snaps


def build_block_specs(service_snaps: List[ServiceSnap],
                      barber_worker_id: Optional[int],
                      nails_worker_id: Optional[int],
                      facial_worker_id: Optional[int],
                      service_id_to_worker: Dict[int, int]) -> List[BlockSpec]:
    """
    service_id_to_worker: mapea servicio->worker (cuando assignment_type FIXED_WORKER) o
    servicios barbería se asignan al barbero seleccionado.
    """
    grouped: Dict[int, List[ServiceSnap]] = {}
    for snap in service_snaps:
        wid = service_id_to_worker.get(snap.id)
        if wid is None:
            # barbería
            if barber_worker_id is None:
                raise ValueError("Falta barbero para servicios de barbería.")
            wid = barber_worker_id
        grouped.setdefault(wid, []).append(snap)

    specs: List[BlockSpec] = []
    for wid, snaps in grouped.items():
        total = sum(x.effective_minutes for x in snaps)
        key = "BARBERY"
        if nails_worker_id and wid == nails_worker_id:
            key = "NAILS"
        if facial_worker_id and wid == facial_worker_id:
            key = "FACIAL"
        specs.append(BlockSpec(key=key, worker_id=wid, minutes=total, services=snaps))
    return specs


def working_intervals_for_worker(date_obj, worker_id: int,
                                 window_start: datetime,
                                 window_end: datetime) -> List[Tuple[datetime, datetime]]:
    """
    Construye intervalos trabajables (schedule - breaks + exceptions) dentro de la ventana
    """
    worker = Worker.objects.get(id=worker_id, active=True)
    dow = date_obj.weekday()

    rules = WorkerScheduleRule.objects.filter(worker=worker, day_of_week=dow, active=True)
    base: List[Tuple[datetime, datetime]] = []
    for r in rules:
        s = _dt(date_obj, r.start_time)
        e = _dt(date_obj, r.end_time)
        base.append((max(s, window_start), min(e, window_end)))
    base = [(s, e) for s, e in base if s < e]

    # breaks
    breaks = WorkerBreak.objects.filter(worker=worker, day_of_week=dow)
    break_intervals = []
    for b in breaks:
        bs = _dt(date_obj, b.start_time)
        be = _dt(date_obj, b.end_time)
        break_intervals.append((max(bs, window_start), min(be, window_end)))
    break_intervals = [(s, e) for s, e in break_intervals if s < e]

    base = _subtract_intervals(base, break_intervals)

    # exceptions
    exceptions = WorkerException.objects.filter(worker=worker, date=date_obj)
    for ex in exceptions:
        if ex.type == "TIME_OFF":
            if ex.start_time and ex.end_time:
                off_s = _dt(date_obj, ex.start_time)
                off_e = _dt(date_obj, ex.end_time)
                base = _subtract_intervals(base, [(max(off_s, window_start), min(off_e, window_end))])
            else:
                # todo el día off
                return []
        elif ex.type == "EXTRA_WORKING":
            if ex.start_time and ex.end_time:
                extra_s = _dt(date_obj, ex.start_time)
                extra_e = _dt(date_obj, ex.end_time)
                base.append((max(extra_s, window_start), min(extra_e, window_end)))
                base = _merge_intervals([(s, e) for s, e in base if s < e])

    return base


def busy_intervals_for_worker(worker_id: int, window_start: datetime, window_end: datetime) -> List[Tuple[datetime, datetime]]:
    blocks = AppointmentBlock.objects.filter(
        worker_id=worker_id,
        start_datetime__lt=window_end,
        end_datetime__gt=window_start,
        appointment__status__in=["RESERVED"]  # MVP: bloquea solo reservadas
    ).select_related("appointment")
    return [(b.start_datetime, b.end_datetime) for b in blocks]


def find_first_slot(free_intervals: List[Tuple[datetime, datetime]],
                    cursor: datetime, minutes: int) -> Optional[Tuple[datetime, datetime]]:
    dur = timedelta(minutes=minutes)
    for s, e in free_intervals:
        start = max(s, cursor)
        end = start + dur
        if end <= e:
            return start, end
    return None


def simulate_sequence(date_obj,
                      seq_specs: List[BlockSpec],
                      free_by_worker: Dict[int, List[Tuple[datetime, datetime]]],
                      start_dt: datetime) -> Optional[OptionPlan]:
    cursor = start_dt
    gap_total = 0
    planned: List[PlannedBlock] = []
    for i, spec in enumerate(seq_specs, start=1):
        slot = find_first_slot(free_by_worker[spec.worker_id], cursor, spec.minutes)
        if not slot:
            return None
        bs, be = slot
        if bs > cursor:
            gap_total += int((bs - cursor).total_seconds() // 60)
        planned.append(PlannedBlock(
            sequence=i,
            worker_id=spec.worker_id,
            start=bs,
            end=be,
            services=spec.services
        ))
        cursor = be

    return OptionPlan(start=planned[0].start, end=planned[-1].end, blocks=planned, gap_total_minutes=gap_total)


def generate_options(date_obj,
                     window_start: datetime,
                     window_end: datetime,
                     block_specs: List[BlockSpec],
                     limit: int = 20) -> List[OptionPlan]:
    # precalcular free intervals por worker
    free_by_worker: Dict[int, List[Tuple[datetime, datetime]]] = {}
    for wid in {b.worker_id for b in block_specs}:
        working = working_intervals_for_worker(date_obj, wid, window_start, window_end)
        busy = busy_intervals_for_worker(wid, window_start, window_end)
        free = _subtract_intervals(working, busy)
        free_by_worker[wid] = free

    # rango de inicios candidatos (paso fijo)
    start_cursor = _round_up_to_step(window_start)
    options: List[OptionPlan] = []

    all_perms = list(permutations(block_specs, r=len(block_specs)))
    # para evitar explosión, len<=3 normalmente

    t = start_cursor
    while t < window_end:
        for perm_specs in all_perms:
            plan = simulate_sequence(date_obj, list(perm_specs), free_by_worker, t)
            if plan:
                options.append(plan)
        t = t + timedelta(minutes=MIN_STEP_MINUTES)

    # ordenar por gap_total, luego fin más temprano
    options.sort(key=lambda o: (o.gap_total_minutes, o.end))
    # deduplicar por (start,end,workers sequence)
    seen = set()
    unique = []
    for o in options:
        key = (o.start, o.end, tuple((b.worker_id, b.start, b.end) for b in o.blocks))
        if key in seen:
            continue
        seen.add(key)
        unique.append(o)
        if len(unique) >= limit:
            break
    return unique
