import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  signal,
} from '@angular/core';

type WorkerLite = {
  id: number;
  label?: string;
  labelFull?: string;
  role?: string;
  name?: string;
  display_name?: string;
  full_name?: string;
  user?: any;
};

type AppointmentLike = {
  id: number;
  status?: string;

  // lo normal en tu agenda staff
  start_datetime?: string;
  end_datetime?: string;

  // fallback por si vienen con otros nombres
  start?: string;
  end?: string;

  customer?: { name?: string | null; phone?: string | null };

  // clave para detectar el worker real
  blocks?: Array<any>;

  // fallback por label
  worker_label?: string;
};

type Segment = {
  appointmentId: number;
  leftPct: number;
  widthPct: number;
  tooltip: string;
};

@Component({
  selector: 'app-worker-itinerary-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './worker-itinerary-modal.html',
  styleUrls: ['./worker-itinerary-modal.scss'],
})
export class WorkerItineraryModalComponent {
  // ==========================
  // Inputs
  // ==========================
  @Input() visible = false;

  @Input() set workers(v: WorkerLite[] | null | undefined) {
    this._workers.set(Array.isArray(v) ? v : []);
    // si no hay seleccionado, setea el primero
    queueMicrotask(() => this.ensureSelectedWorker());
  }

  @Input() set appointments(v: AppointmentLike[] | null | undefined) {
    this._appointments.set(Array.isArray(v) ? v : []);
  }

  // YYYY-MM-DD
  @Input() set date(v: string | null | undefined) {
    this._date.set((v ?? '').trim());
  }

  @Input() set initialWorkerId(v: number | null | undefined) {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
    this._initialWorkerId.set(n);
    queueMicrotask(() => this.ensureSelectedWorker());
  }

  // ==========================
  // Outputs
  // ==========================
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() close = new EventEmitter<void>();
  @Output() viewAppointment = new EventEmitter<number>();

  // ==========================
  // State
  // ==========================
  private _workers = signal<WorkerLite[]>([]);
  private _appointments = signal<AppointmentLike[]>([]);
  private _date = signal<string>('');
  private _initialWorkerId = signal<number | null>(null);

  selectedWorkerId = signal<number | null>(null);

  // Horario mostrado (ajústalo si quieres)
  private readonly startHour = 7;
  private readonly endHour = 20; // inclusive en la UI

  // ==========================
  // Computeds usados en el HTML
  // ==========================
  workersList = computed(() => this._workers());

  selectedWorker = computed(() => {
    const id = this.selectedWorkerId();
    if (!id) return null;
    return this._workers().find(w => Number(w.id) === Number(id)) ?? null;
  });

  hours = computed(() => {
    const out: number[] = [];
    for (let h = this.startHour; h <= this.endHour; h++) out.push(h);
    return out;
  });

  // Mapa: hour -> segmentos ocupados
  segmentsByHour = computed(() => {
    const worker = this.selectedWorker();
    if (!worker) return new Map<number, Segment[]>();

    const workerId = Number(worker.id);
    const dateStr = this._date();
    const appts = this._appointments();

    const map = new Map<number, Segment[]>();
    for (const h of this.hours()) map.set(h, []);

    // Si no hay fecha, igual intentamos, pero lo ideal es pasar YYYY-MM-DD desde turnos
    const dayStart = dateStr ? new Date(`${dateStr}T00:00:00`) : null;

    const relevant = appts.filter(ap => {
      // No marcan ocupado
      const st = (ap.status ?? '').toUpperCase();
      if (st === 'CANCELLED' || st === 'NO_SHOW') return false;

      // Coincidir trabajador
      if (!this.appointmentMatchesWorker(ap, workerId, worker)) return false;

      // Si hay fecha, filtrar por día (por si llegaran cruzados)
      if (dayStart) {
        const s = this.ms(this.getStart(ap));
        if (!s) return false;
        const d = new Date(s);
        const isoDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate()
        ).padStart(2, '0')}`;
        if (isoDay !== dateStr) return false;
      }

      return true;
    });

    for (const ap of relevant) {
      const startMs = this.ms(this.getStart(ap));
      const endMs = this.ms(this.getEnd(ap));
      if (!startMs || !endMs || endMs <= startMs) continue;

      for (const h of this.hours()) {
        const hourStart = this.buildHourMs(dateStr, h);
        const hourEnd = this.buildHourMs(dateStr, h + 1);

        const overlapStart = Math.max(startMs, hourStart);
        const overlapEnd = Math.min(endMs, hourEnd);

        if (overlapEnd <= overlapStart) continue;

        const leftMin = (overlapStart - hourStart) / 60000;
        const widthMin = (overlapEnd - overlapStart) / 60000;

        const leftPct = this.clamp((leftMin / 60) * 100, 0, 100);
        const widthPct = this.clamp((widthMin / 60) * 100, 0, 100);

        const seg: Segment = {
          appointmentId: ap.id,
          leftPct,
          widthPct: Math.max(widthPct, 0.7), // evita que "desaparezca" por segmentos muy pequeños
          tooltip: this.buildTooltip(ap),
        };

        map.get(h)!.push(seg);
      }
    }

    // ordenar segmentos por inicio dentro de la hora
    for (const [h, segs] of map.entries()) {
      segs.sort((a, b) => a.leftPct - b.leftPct);
      map.set(h, segs);
    }

    return map;
  });

  // ==========================
  // UI helpers
  // ==========================
  trackWorker = (_: number, w: WorkerLite) => w.id;
  trackHour = (_: number, h: number) => h;
  trackSegment = (_: number, s: Segment) => `${s.appointmentId}-${s.leftPct}-${s.widthPct}`;

  formatHour(h: number) {
    return `${String(h).padStart(2, '0')}:00`;
  }

  selectWorker(id: number) {
    this.selectedWorkerId.set(Number(id));
  }

  onSegmentClick(id: number) {
    this.viewAppointment.emit(id);
  }

  // Cierra
  doClose() {
    this.visibleChange.emit(false);
    this.close.emit();
  }

  // Click afuera del modal
  onBackdropMouseDown(ev: MouseEvent) {
    const target = ev.target as HTMLElement;
    if (target?.classList?.contains('modal-backdrop')) this.doClose();
  }

  // Label robusto
  workerLabel(w: any): string {
    if (!w) return '—';

    const labelFull = String(w.labelFull ?? '').trim();
    if (labelFull) return labelFull;

    const label = String(w.label ?? '').trim();
    if (label) return label;

    const direct =
      w.display_name ??
      w.displayName ??
      w.full_name ??
      w.fullName ??
      w.name ??
      w.nombre ??
      null;

    if (direct && String(direct).trim()) return String(direct).trim();

    const u = w.user ?? w.usuario ?? w.account ?? null;
    const first =
      u?.first_name ?? u?.firstName ?? u?.nombres ??
      w.first_name ?? w.firstName ?? w.nombres ?? '';

    const last =
      u?.last_name ?? u?.lastName ?? u?.apellidos ??
      w.last_name ?? w.lastName ?? w.apellidos ?? '';

    const full = `${String(first ?? '').trim()} ${String(last ?? '').trim()}`.trim();
    if (full) return full;

    return `Trabajador #${w.id ?? ''}`.trim();
  }

  // ==========================
  // Internals
  // ==========================
  private ensureSelectedWorker() {
    const list = this._workers();
    if (!list.length) {
      this.selectedWorkerId.set(null);
      return;
    }

    const init = this._initialWorkerId();
    if (init && list.some(w => Number(w.id) === Number(init))) {
      this.selectedWorkerId.set(Number(init));
      return;
    }

    const current = this.selectedWorkerId();
    if (current && list.some(w => Number(w.id) === Number(current))) return;

    this.selectedWorkerId.set(Number(list[0].id));
  }

  private appointmentMatchesWorker(ap: AppointmentLike, workerId: number, workerObj: WorkerLite): boolean {
    // 1) por IDs en blocks (principal)
    const ids = this.extractWorkerIdsFromAppointment(ap);
    if (ids.length && ids.includes(workerId)) return true;

    // 2) por worker_id directos (si existieran)
    const direct =
      (ap as any).worker ??
      (ap as any).worker_id ??
      (ap as any).workerId ??
      (ap as any).barber_id ??
      null;

    const n = Number(direct);
    if (Number.isFinite(n) && n === workerId) return true;

    // 3) fallback por label
    const label = this.norm(this.workerLabel(workerObj));
    if (!label) return false;

    const labels: string[] = [];

    if ((ap as any).worker_label) labels.push(String((ap as any).worker_label));
    for (const b of ap.blocks ?? []) {
      if (b?.worker_label) labels.push(String(b.worker_label));
      if (b?.workerLabel) labels.push(String(b.workerLabel));
    }

    return labels.map(x => this.norm(x)).some(x => x && (x === label || x.includes(label)));
  }

  private extractWorkerIdsFromAppointment(ap: AppointmentLike): number[] {
    const out = new Set<number>();
    const blocks = Array.isArray(ap.blocks) ? ap.blocks : [];

    for (const b of blocks) {
      const raw =
        b?.worker ??
        b?.worker_id ??
        b?.workerId ??
        b?.worker?.id ??
        b?.worker?.pk ??
        null;

      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) out.add(n);
    }

    return Array.from(out);
  }

  private getStart(ap: AppointmentLike): string {
    return (
      ap.start_datetime ??
      (ap as any).appointment_start ??
      ap.start ??
      ''
    );
  }

  private getEnd(ap: AppointmentLike): string {
    return (
      ap.end_datetime ??
      (ap as any).appointment_end ??
      ap.end ??
      ''
    );
  }

  private ms(dt: string): number {
    if (!dt) return 0;
    const t = new Date(dt).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  private buildHourMs(dateStr: string, hour: number): number {
    // hour puede ser 21 cuando calculamos h+1, sigue siendo válido
    const d = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  }

  private buildTooltip(ap: AppointmentLike): string {
    const s = this.timeLabel(this.getStart(ap));
    const e = this.timeLabel(this.getEnd(ap));
    const customer = String(ap.customer?.name ?? '').trim();

    const services = this.flattenServices(ap);
    const parts = [`${s}–${e}`];
    if (customer) parts.push(customer);
    if (services) parts.push(services);

    return parts.join(' • ');
  }

  private flattenServices(ap: AppointmentLike): string {
    const names: string[] = [];
    for (const b of ap.blocks ?? []) {
      for (const s of (b?.services ?? [])) {
        const name = s?.name ?? s?.service_name ?? s?.service?.name ?? '';
        if (name) names.push(String(name));
      }
    }
    return names.join(' • ');
  }

  private timeLabel(dt: string): string {
    try {
      const d = new Date(dt);
      return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return dt;
    }
  }

  private norm(s: string): string {
    return (s ?? '').toString().trim().toLowerCase();
  }

  private clamp(n: number, a: number, b: number) {
    return Math.max(a, Math.min(b, n));
  }
}
