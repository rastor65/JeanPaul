import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  effect,
  inject,
  OnDestroy,
  signal,
} from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { animate, style, transition, trigger } from '@angular/animations';

type Status = 'ALL' | 'RESERVED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW';
type TimeFilter = 'ALL' | 'UPCOMING' | 'PAST';

type Customer = {
  id: number | null;
  name: string;
  phone: string | null;
  birth_date: string | null;
};

type Svc = {
  id: number;
  name: string;
  duration_minutes: number;
  buffer_before: number;
  buffer_after: number;
  price: string;
};

type Block = {
  id: number;
  sequence: number;
  worker: number;
  worker_label: string;
  start_datetime: string;
  end_datetime: string;
  services: Svc[];
};

type Appointment = {
  id: number;
  status: 'RESERVED' | 'CANCELLED' | 'ATTENDED' | 'NO_SHOW';
  start_datetime: string;
  end_datetime: string;
  customer: Customer;
  blocks: Block[];
  recommended_total: string;
};

type AgendaResponse = {
  date: string;
  worker_id: number | null;
  count: number;
  results: Appointment[];
};

type ToastKind = 'info' | 'success' | 'error';
type Toast = { kind: ToastKind; text: string };

@Component({
  selector: 'app-agenda',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './agenda.html',
  styleUrl: './agenda.scss',
  animations: [
    trigger('fadeUp', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(8px)' }),
        animate('160ms ease-out', style({ opacity: 1, transform: 'translateY(0)' })),
      ]),
      transition(':leave', [
        animate('120ms ease-in', style({ opacity: 0, transform: 'translateY(8px)' })),
      ]),
    ]),
    trigger('slideIn', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateX(10px)' }),
        animate('180ms ease-out', style({ opacity: 1, transform: 'translateX(0)' })),
      ]),
    ]),
  ],
})
export class AgendaComponent implements OnDestroy {
  private http = inject(HttpClient);

  // -------------------------
  // State
  // -------------------------
  date = signal<string>(this.toISODate(new Date()));
  status = signal<Status>('ALL');
  timeFilter = signal<TimeFilter>('ALL');
  query = signal<string>('');

  compact = signal<boolean>(false);
  autoRefresh = signal<boolean>(true);

  loading = signal<boolean>(false);
  error = signal<string>('');
  busyId = signal<number | null>(null);

  results = signal<Appointment[]>([]);
  selectedId = signal<number | null>(null);

  // worker context
  workerId = signal<number | null>(null);
  onlyMyBlocks = signal<boolean>(true); // para trabajadores: ON por defecto

  // UI extra
  confirmingCancel = signal<Appointment | null>(null);
  toast = signal<Toast | null>(null);

  // reloj para resaltado "ahora / próximo"
  now = signal<Date>(new Date());

  private tickTimer: any = null;
  private autoTimer: any = null;
  private toastTimer: any = null;

  private readonly PREF_KEY = 'jp.agenda.prefs.v3';

  // -------------------------
  // Derived
  // -------------------------
  selected = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.results().find(x => x.id === id) ?? null;
  });

  filtered = computed(() => {
    const st = this.status();
    const tf = this.timeFilter();
    const q = this.query().trim().toLowerCase();
    const items = this.results();

    const nowMs = this.now().getTime();

    let out = items;

    if (st !== 'ALL') out = out.filter(a => a.status === st);

    if (tf !== 'ALL') {
      out = out.filter(a => {
        const sp = this.viewSpan(a);
        const isPast = sp.endMs < nowMs;
        const isUpcoming = sp.startMs >= nowMs;
        return tf === 'PAST' ? isPast : isUpcoming;
      });
    }

    if (q) {
      out = out.filter(a => {
        const name = (a.customer?.name ?? '').toLowerCase();
        const phone = (a.customer?.phone ?? '').toLowerCase();
        const services = (this.viewServiceNames(a).join(' ') ?? '').toLowerCase();
        return name.includes(q) || phone.includes(q) || services.includes(q);
      });
    }

    return out;
  });

  counts = computed(() => {
    const base = { ALL: 0, RESERVED: 0, ATTENDED: 0, CANCELLED: 0, NO_SHOW: 0 } as Record<Status, number>;
    const items = this.results();
    base.ALL = items.length;
    for (const a of items) base[a.status] = (base[a.status] ?? 0) + 1;
    return base;
  });

  ordered = computed(() => {
    return this.filtered()
      .slice()
      .sort((a, b) => this.viewSpan(a).startMs - this.viewSpan(b).startMs);
  });

  groups = computed(() => {
    const list = this.ordered();
    const map = new Map<string, Appointment[]>();
    for (const ap of list) {
      const hour = this.hourLabel(this.viewSpan(ap).start);
      if (!map.has(hour)) map.set(hour, []);
      map.get(hour)!.push(ap);
    }
    return Array.from(map.entries()).map(([hour, items]) => ({ hour, items }));
  });

  gapAfterMap = computed(() => {
    const list = this.ordered();
    const map = new Map<number, number>(); // id -> gap mins to next
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      const gap = this.durationMins(this.viewSpan(a).end, this.viewSpan(b).start);
      if (gap >= 10) map.set(a.id, gap);
    }
    return map;
  });

  overdueCount = computed(() => {
    const nowMs = this.now().getTime();
    return this.results().filter(a => a.status === 'RESERVED' && this.viewSpan(a).startMs < nowMs).length;
  });

  nextUp = computed(() => {
    const nowMs = this.now().getTime();
    const list = this.results()
      .slice()
      .filter(a => a.status === 'RESERVED')
      .sort((a, b) => this.viewSpan(a).startMs - this.viewSpan(b).startMs);

    return list.find(a => this.viewSpan(a).endMs >= nowMs) ?? null;
  });

  nowLabel = computed(() => {
    try {
      return this.now().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  });

  // -------------------------
  // Init
  // -------------------------
  constructor() {
    this.loadPrefs();
    this.setupClock();
    this.setupAutoRefresh();
    this.setupPersistPrefs();
    this.refresh();
  }

  ngOnDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  // -------------------------
  // API helpers (NO hardcode 127)
  // -------------------------
  private api(path: string): string {
    const base = ((environment as any).API_URI)
      .toString()
      .trim()
      .replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }

  // -------------------------
  // Preferences
  // -------------------------
  private loadPrefs() {
    try {
      const raw = localStorage.getItem(this.PREF_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<{
        status: Status;
        timeFilter: TimeFilter;
        compact: boolean;
        autoRefresh: boolean;
        query: string;
        onlyMyBlocks: boolean;
      }>;

      if (p.status) this.status.set(p.status);
      if (p.timeFilter) this.timeFilter.set(p.timeFilter);
      if (typeof p.compact === 'boolean') this.compact.set(p.compact);
      if (typeof p.autoRefresh === 'boolean') this.autoRefresh.set(p.autoRefresh);
      if (typeof p.query === 'string') this.query.set(p.query);
      if (typeof p.onlyMyBlocks === 'boolean') this.onlyMyBlocks.set(p.onlyMyBlocks);
    } catch {
      // ignore
    }
  }

  private setupPersistPrefs() {
    effect(() => {
      try {
        const payload = {
          status: this.status(),
          timeFilter: this.timeFilter(),
          compact: this.compact(),
          autoRefresh: this.autoRefresh(),
          query: this.query(),
          onlyMyBlocks: this.onlyMyBlocks(),
        };
        localStorage.setItem(this.PREF_KEY, JSON.stringify(payload));
      } catch {
        // ignore
      }
    });
  }

  // -------------------------
  // Clock + auto refresh
  // -------------------------
  private setupClock() {
    this.tickTimer = setInterval(() => this.now.set(new Date()), 15_000);
  }

  private setupAutoRefresh() {
    effect(() => {
      const on = this.autoRefresh();
      if (this.autoTimer) clearInterval(this.autoTimer);
      if (!on) return;

      this.autoTimer = setInterval(() => {
        if (document?.hidden) return;
        if (this.loading()) return;
        if (this.busyId() !== null) return;
        this.refresh(true);
      }, 90_000);
    });
  }

  // -------------------------
  // UI actions
  // -------------------------
  setDate(v: string) {
    if (!v) return;
    this.date.set(v);
    this.refresh();
  }

  setToday() {
    this.date.set(this.toISODate(new Date()));
    this.refresh();
  }

  setStatus(st: Status) {
    this.status.set(st);
  }

  setTimeFilter(tf: TimeFilter) {
    this.timeFilter.set(tf);
  }

  setQuery(v: string) {
    this.query.set(v ?? '');
  }

  toggleCompact() {
    this.compact.set(!this.compact());
  }

  toggleAutoRefresh() {
    this.autoRefresh.set(!this.autoRefresh());
    this.toastNow(this.autoRefresh() ? 'Autoactualización activada' : 'Autoactualización desactivada', 'info');
  }

  toggleOnlyMyBlocks() {
    this.onlyMyBlocks.set(!this.onlyMyBlocks());
    this.toastNow(this.onlyMyBlocks() ? 'Mostrando solo tus bloques' : 'Mostrando turno completo', 'info');
  }

  select(ap: Appointment) {
    this.selectedId.set(ap.id);
  }

  selectNext() {
    const list = this.ordered();
    const cur = this.selectedId();
    if (!list.length) return;

    const idx = cur ? list.findIndex(x => x.id === cur) : -1;
    const next = list[Math.min(list.length - 1, idx + 1)] ?? list[0];
    this.selectedId.set(next.id);
  }

  selectPrev() {
    const list = this.ordered();
    const cur = this.selectedId();
    if (!list.length) return;

    const idx = cur ? list.findIndex(x => x.id === cur) : 0;
    const prev = list[Math.max(0, idx - 1)] ?? list[0];
    this.selectedId.set(prev.id);
  }

  trackById(_: number, it: Appointment) {
    return it.id;
  }

  // -------------------------
  // Requests
  // -------------------------
  refresh(silent: boolean = false) {
    this.error.set('');

    if (!silent) this.loading.set(true);

    const requestUrl = this.api('/api/agenda/my/');
    const params = new HttpParams().set('date', this.date());

    this.http.get<AgendaResponse>(requestUrl, { params, withCredentials: true }).subscribe({
      next: (res) => {
        this.loading.set(false);

        this.workerId.set((res as any)?.worker_id ?? null);

        const items = Array.isArray(res?.results) ? res.results : [];
        this.results.set(items);

        const current = this.selectedId();
        if (current && items.some(x => x.id === current)) return;

        const nowMs = this.now().getTime();
        const pick = items
          .slice()
          .filter(a => a.status === 'RESERVED')
          .sort((a, b) => this.viewSpan(a).startMs - this.viewSpan(b).startMs)
          .find(a => this.viewSpan(a).endMs >= nowMs);

        this.selectedId.set(pick?.id ?? items[0]?.id ?? null);
      },
      error: (err) => {
        this.loading.set(false);
        this.setHttpError(err, requestUrl, `${requestUrl}?date=${this.date()}`);
      },
    });
  }

  markAttend(ap: Appointment) {
    if (!ap || ap.status !== 'RESERVED') return;
    this.doAction(ap.id, 'attend', () => {
      this.patchStatus(ap.id, 'ATTENDED');
      this.toastNow('Turno marcado como atendido', 'success');
    });
  }

  markNoShow(ap: Appointment) {
    if (!ap || ap.status !== 'RESERVED') return;
    this.doAction(ap.id, 'no-show', () => {
      this.patchStatus(ap.id, 'NO_SHOW');
      this.toastNow('Turno marcado como no show', 'info');
    });
  }

  askCancel(ap: Appointment) {
    if (!ap || ap.status !== 'RESERVED') return;
    this.confirmingCancel.set(ap);
  }

  confirmCancel() {
    const ap = this.confirmingCancel();
    if (!ap) return;

    this.confirmingCancel.set(null);
    this.doAction(ap.id, 'cancel', () => {
      this.patchStatus(ap.id, 'CANCELLED');
      this.toastNow('Turno cancelado', 'info');
    });
  }

  closeCancel() {
    this.confirmingCancel.set(null);
  }

  private doAction(id: number, action: 'attend' | 'no-show' | 'cancel', onOk: () => void) {
    this.error.set('');
    this.busyId.set(id);

    const url = this.api(`/api/appointments/${id}/${action}/`);

    this.http.post<any>(url, {}, { withCredentials: true }).subscribe({
      next: () => {
        this.busyId.set(null);
        onOk();
      },
      error: (err) => {
        this.busyId.set(null);
        this.setHttpError(err, url, url);
      },
    });
  }

  private patchStatus(id: number, status: Appointment['status']) {
    const arr = this.results().slice();
    const i = arr.findIndex(x => x.id === id);
    if (i >= 0) {
      arr[i] = { ...arr[i], status };
      this.results.set(arr);
    }
  }

  private setHttpError(err: any, requestUrl: string, httpUrl: string) {
    const e = err as HttpErrorResponse;

    const status = e?.status ?? 0;
    const detail =
      (e?.error && typeof e.error === 'object' && (e.error as any).detail) ||
      (typeof e?.error === 'string' ? e.error : '') ||
      e?.message ||
      'No se pudo cargar la agenda.';

    console.error('[AGENDA ERROR]', { requestUrl, httpUrl, status, error: e?.error });

    if (status === 401) {
      this.error.set(
        'Sesión no válida en esta solicitud. Revisa que el frontend use el mismo host del login.'
      );
      return;
    }

    this.error.set(detail || 'No se pudo cargar la agenda.');
    this.toastNow('Ocurrió un error al procesar la solicitud', 'error');
  }

  // -------------------------
  // Worker view helpers (clave)
  // -------------------------
  viewBlocks(ap: Appointment): Block[] {
    const blocks = Array.isArray(ap?.blocks) ? ap.blocks : [];
    const wid = this.workerId();
    const onlyMine = this.onlyMyBlocks();

    if (!onlyMine) return blocks;
    if (!wid) return blocks;

    const mine = blocks.filter(b => b.worker === wid);
    return mine.length ? mine : blocks;
  }

  viewSpan(ap: Appointment): { start: string; end: string; startMs: number; endMs: number; durationMin: number } {
    const blocks = this.viewBlocks(ap);
    if (blocks.length) {
      let start = blocks[0].start_datetime;
      let end = blocks[0].end_datetime;

      for (const b of blocks) {
        if (new Date(b.start_datetime).getTime() < new Date(start).getTime()) start = b.start_datetime;
        if (new Date(b.end_datetime).getTime() > new Date(end).getTime()) end = b.end_datetime;
      }

      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      const durationMin = Math.max(0, Math.round((endMs - startMs) / 60000));
      return { start, end, startMs, endMs, durationMin };
    }

    const startMs = new Date(ap.start_datetime).getTime();
    const endMs = new Date(ap.end_datetime).getTime();
    const durationMin = Math.max(0, Math.round((endMs - startMs) / 60000));
    return { start: ap.start_datetime, end: ap.end_datetime, startMs, endMs, durationMin };
  }

  viewServiceNames(ap: Appointment): string[] {
    const names: string[] = [];
    for (const b of this.viewBlocks(ap)) {
      for (const s of (b.services ?? [])) names.push(s.name);
    }
    // únicos (manteniendo orden)
    return names.filter((x, i) => names.indexOf(x) === i);
  }

  // -------------------------
  // Quick utilities (UX)
  // -------------------------
  async copy(text: string | null | undefined) {
    const v = (text ?? '').trim();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      this.toastNow('Copiado al portapapeles', 'success');
    } catch {
      this.toastNow('No se pudo copiar', 'error');
    }
  }

  copyDetail(ap: Appointment) {
    const sp = this.viewSpan(ap);
    const services = this.viewServiceNames(ap).join(', ') || '—';
    const phone = ap.customer?.phone || '—';
    const msg =
      `Turno #${ap.id}\n` +
      `Cliente: ${ap.customer?.name ?? '—'}\n` +
      `Hora: ${this.timeLabel(sp.start)} - ${this.timeLabel(sp.end)} (${sp.durationMin} min)\n` +
      `Tel: ${phone}\n` +
      `Servicios: ${services}`;
    this.copy(msg);
  }

  private normalizePhone(phone: string): string {
    const d = (phone || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('57')) return d;
    if (d.length === 10) return `57${d}`;
    return d;
  }

  openWhatsApp(ap: Appointment) {
    const phone = (ap.customer?.phone ?? '').trim();
    const p = this.normalizePhone(phone);
    if (!p) return;

    const sp = this.viewSpan(ap);
    const services = this.viewServiceNames(ap).join(', ') || 'servicio';
    const text =
      `Hola ${ap.customer?.name ?? ''}. ` +
      `Te esperamos a las ${this.timeLabel(sp.start)} para: ${services}.`;

    const url = `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  call(phone: string | null | undefined) {
    const v = (phone ?? '').trim();
    if (!v) return;
    window.open(`tel:${v}`, '_self');
  }

  // -------------------------
  // Smart highlighting (usa viewSpan)
  // -------------------------
  isNow(ap: Appointment) {
    const nowMs = this.now().getTime();
    const sp = this.viewSpan(ap);
    return sp.startMs <= nowMs && nowMs <= sp.endMs;
  }

  isSoon(ap: Appointment, mins = 15) {
    const nowMs = this.now().getTime();
    const sp = this.viewSpan(ap);
    const diff = sp.startMs - nowMs;
    return diff >= 0 && diff <= mins * 60000;
  }

  isLate(ap: Appointment) {
    if (ap.status !== 'RESERVED') return false;
    const nowMs = this.now().getTime();
    const sp = this.viewSpan(ap);
    return sp.startMs < nowMs && sp.endMs >= nowMs;
  }

  progress(ap: Appointment) {
    const nowMs = this.now().getTime();
    const sp = this.viewSpan(ap);
    if (nowMs <= sp.startMs) return 0;
    if (nowMs >= sp.endMs) return 100;
    const p = ((nowMs - sp.startMs) / Math.max(1, sp.endMs - sp.startMs)) * 100;
    return Math.max(0, Math.min(100, Math.round(p)));
  }

  relative(ap: Appointment) {
    const nowMs = this.now().getTime();
    const sp = this.viewSpan(ap);
    const diffMin = Math.round((sp.startMs - nowMs) / 60000);

    if (this.isNow(ap)) return 'En curso';
    if (diffMin === 0) return 'Ahora';
    if (diffMin > 0) return `En ${diffMin} min`;
    return `Hace ${Math.abs(diffMin)} min`;
  }

  gapAfter(ap: Appointment) {
    return this.gapAfterMap().get(ap.id) ?? 0;
  }

  // -------------------------
  // Birth helpers (detalle)
  // -------------------------
  birthLabel(bd: string | null | undefined) {
    const v = (bd ?? '').trim();
    if (!v) return '—';
    try {
      const d = new Date(`${v}T00:00:00`);
      return d.toLocaleDateString('es-CO', { year: 'numeric', month: 'short', day: '2-digit' });
    } catch {
      return v;
    }
  }

  ageYears(bd: string | null | undefined) {
    const v = (bd ?? '').trim();
    if (!v) return null;
    try {
      const birth = new Date(`${v}T00:00:00`);
      const ref = new Date(`${this.date()}T00:00:00`);
      let age = ref.getFullYear() - birth.getFullYear();
      const m = ref.getMonth() - birth.getMonth();
      if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age--;
      return age;
    } catch {
      return null;
    }
  }

  isBirthdayOnDate(bd: string | null | undefined) {
    const v = (bd ?? '').trim();
    if (!v) return false;
    try {
      const birth = new Date(`${v}T00:00:00`);
      const ref = new Date(`${this.date()}T00:00:00`);
      return birth.getMonth() === ref.getMonth() && birth.getDate() === ref.getDate();
    } catch {
      return false;
    }
  }

  // -------------------------
  // Formatting helpers
  // -------------------------
  dateLabel(iso: string) {
    try {
      const d = new Date(`${iso}T00:00:00`);
      return d.toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  timeLabel(dt: string) {
    try {
      const d = new Date(dt);
      return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return dt;
    }
  }

  hourLabel(dt: string) {
    try {
      const d = new Date(dt);
      const hh = String(d.getHours()).padStart(2, '0');
      return `${hh}:00`;
    } catch {
      return '—';
    }
  }

  durationMins(a: string, b: string) {
    try {
      const ms = new Date(b).getTime() - new Date(a).getTime();
      return Math.max(0, Math.round(ms / 60000));
    } catch {
      return 0;
    }
  }

  badgeLabel(st: Appointment['status']) {
    switch (st) {
      case 'RESERVED': return 'Reservado';
      case 'ATTENDED': return 'Atendido';
      case 'CANCELLED': return 'Cancelado';
      case 'NO_SHOW': return 'No show';
      default: return st;
    }
  }

  badgeClass(st: Appointment['status']) {
    return `badge badge--${st.toLowerCase()}`;
  }

  // -------------------------
  // Toast
  // -------------------------
  private toastNow(text: string, kind: ToastKind = 'info') {
    this.toast.set({ text, kind });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 2400);
  }

  // -------------------------
  // Date
  // -------------------------
  toISODate(d: Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
