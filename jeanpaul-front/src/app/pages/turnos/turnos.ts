import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, OnDestroy, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { BookingService, AvailabilityOption } from '../../core/services/booking';
import { firstValueFrom, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

type StatusFilter = 'ALL' | 'RESERVED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW';
type Status = 'RESERVED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW';
type PayMethod = 'CASH' | 'TRANSFER' | 'CARD';
type CustomerType = 'CASUAL' | 'FREQUENT';

type QueueTab = 'DUE' | 'ENDING' | 'RUN' | 'WORKER';
type EditMode = 'RESCHEDULE' | 'MANUAL';

type Customer = {
  id: number | null;
  name: string;
  phone: string | null;
  birth_date: string | null;
};

type Service = {
  id: number;
  name: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  price?: string | number;
  category?: any;
  active?: boolean;
};

type Group = 'BARBER' | 'NAILS' | 'FACIAL';

type Worker = {
  id: number;
  label: string;
  labelFull: string;
  role?: Group;
};

type BlockService = {
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
  services: BlockService[];
};

type Appointment = {
  id: number;
  status: Status;
  start_datetime: string;
  end_datetime: string;
  customer: Customer;
  blocks: Block[];
  recommended_total: string;

  paid_total?: string | null;
  payment_method?: string | null;
  paid_at?: string | null;
  paid_by?: string | null;
};

type StaffAgendaResponse = {
  date: string;
  count: number;
  results: Appointment[];
};

@Component({
  selector: 'app-turnos',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './turnos.html',
  styleUrl: './turnos.scss',
})
export class TurnosComponent implements OnDestroy {
  private http = inject(HttpClient);
  private booking = inject(BookingService);

  date = signal<string>(this.toISODate(new Date()));
  status = signal<StatusFilter>('ALL');
  query = signal<string>('');

  // Filtro por trabajador (solo UI)
  workerId = signal<string>(''); // '' = todos

  loading = signal<boolean>(false);
  error = signal<string>('');
  busyId = signal<number | null>(null);

  results = signal<Appointment[]>([]);
  selectedId = signal<number | null>(null);

  autoRefresh = signal<boolean>(false);
  private refreshTimer: any = null;
  readonly Number = Number;

  // reloj UI (para “por terminar / por cobrar” sin depender solo del refresh)
  nowMs = signal<number>(Date.now());
  private clockTimer: any = null;

  services = signal<Service[]>([]);
  workers = signal<Worker[]>([]);
  catalogLoading = signal<boolean>(false);

  // Pago
  payOpen = signal<boolean>(false);
  payAmount = signal<string>('');
  payMethod = signal<PayMethod>('CASH');
  payNote = signal<string>('');

  // Crear
  createOpen = signal<boolean>(false);

  cCustomerType = signal<CustomerType>('CASUAL');
  cName = signal<string>('');
  cPhone = signal<string>('');
  cBirth = signal<string>('');

  cWorkerId = signal<string>('AUTO');
  cTime = signal<string>('');

  cServiceQuery = signal<string>('');
  cSelectedServiceIds = signal<number[]>([]);

  cMarkAttend = signal<boolean>(false);
  cRegisterPayment = signal<boolean>(false);
  cPayAmount = signal<string>('');
  cPayMethod = signal<PayMethod>('CASH');

  toast = signal<string>('');

  // Caja rápida
  queueTab = signal<QueueTab>('DUE');

  // ============================
  // ✅ EDICIÓN
  // ============================
  editOpen = signal<boolean>(false);
  eMode = signal<EditMode>('RESCHEDULE'); // RESCHEDULE = cambiar barbero/hora/servicios con disponibilidad
  eTime = signal<string>('');             // HH:MM
  eDuration = signal<number>(0);          // minutos (solo MANUAL)
  eBarberId = signal<string>('AUTO');     // AUTO o id (solo RESCHEDULE y si hay servicios barber)
  eServiceQuery = signal<string>('');
  eSelectedServiceIds = signal<number[]>([]);
  eNote = signal<string>('');             // opcional, si el backend lo soporta

  // ============================
  // ✅ FILTRO BASE POR TRABAJADOR
  // ============================
  private matchesWorker(ap: Appointment, workerIdNum: number): boolean {
    const blocks = ap?.blocks ?? [];
    for (const b of blocks) {
      if (Number(b.worker) === workerIdNum) return true;
    }

    // fallback por label (por si el backend no manda worker id en el bloque)
    const w = this.workers().find(x => x.id === workerIdNum);
    const label = (w?.label ?? '').trim().toLowerCase();
    if (label) {
      const labels = blocks.map(b => (b.worker_label ?? '').trim().toLowerCase());
      if (labels.some(l => l && (l === label || l.includes(label)))) return true;
    }

    return false;
  }

  baseByWorker = computed(() => {
    const items = this.results();
    const widRaw = (this.workerId() ?? '').trim();
    if (!widRaw) return items;

    const wid = Number(widRaw);
    if (!Number.isFinite(wid)) return items;

    return items.filter(ap => this.matchesWorker(ap, wid));
  });

  selected = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.results().find(x => x.id === id) ?? null;
  });

  filtered = computed(() => {
    const st = this.status();
    const q = this.query().trim().toLowerCase();

    let list = this.baseByWorker();

    if (st !== 'ALL') list = list.filter(a => a.status === st);

    if (q) {
      list = list.filter(a => {
        const name = (a.customer.name ?? '').toLowerCase();
        const phone = (a.customer.phone ?? '').toLowerCase();
        const svc = (this.flattenServices(a) ?? '').toLowerCase();
        const worker = (a.blocks[0]?.worker_label ?? '').toLowerCase();
        return name.includes(q) || phone.includes(q) || svc.includes(q) || worker.includes(q);
      });
    }

    return list;
  });

  groups = computed(() => {
    const list = this.filtered().slice().sort((a, b) =>
      new Date(a.start_datetime).getTime() - new Date(b.start_datetime).getTime()
    );
    const map = new Map<string, Appointment[]>();
    for (const ap of list) {
      const key = this.hourLabel(ap.start_datetime);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ap);
    }
    return Array.from(map.entries()).map(([hour, items]) => ({ hour, items }));
  });

  // Conteos por estado respetando el filtro de trabajador (pero NO el buscador)
  counts = computed(() => {
    const base = { ALL: 0, RESERVED: 0, ATTENDED: 0, CANCELLED: 0, NO_SHOW: 0 } as Record<
      StatusFilter,
      number
    >;

    const items = this.baseByWorker();
    base.ALL = items.length;
    for (const a of items) base[a.status] = (base[a.status] ?? 0) + 1;

    return base;
  });

  // KPIs respetando el filtro de trabajador (pero NO el buscador)
  kpis = computed(() => {
    const items = this.baseByWorker();

    const billable = items.filter(a => this.isBillable(a));
    const sumRecommended = billable.reduce((acc, a) => acc + this.toNum(a.recommended_total), 0);
    const sumPaid = billable.reduce((acc, a) => acc + this.toNum(a.paid_total ?? '0'), 0);

    return {
      total: items.length,
      reserved: items.filter(x => x.status === 'RESERVED').length,
      attended: items.filter(x => x.status === 'ATTENDED').length,
      cancelled: items.filter(x => x.status === 'CANCELLED').length,
      noShow: items.filter(x => x.status === 'NO_SHOW').length,
      recommended: sumRecommended,
      paid: sumPaid,
    };
  });

  // Crear: servicios filtrados
  cServicesFiltered = computed(() => {
    const q = this.cServiceQuery().trim().toLowerCase();
    const list = this.services();
    if (!q) return list;
    return list.filter(s => (s.name ?? '').toLowerCase().includes(q));
  });

  // Crear: duración por servicios
  cDurationPreview = computed(() => {
    const ids = this.cSelectedServiceIds();
    const byId = new Map(this.services().map(s => [s.id, s]));
    let mins = 0;

    for (const id of ids) {
      const s = byId.get(id);
      if (!s) continue;
      mins += Number(s.duration_minutes ?? 0);
      mins += Number(s.buffer_before_minutes ?? 0);
      mins += Number(s.buffer_after_minutes ?? 0);
    }
    return mins;
  });

  // ============================
  // ✅ Caja rápida (respeta filtro trabajador)
  // ============================
  attention = computed(() => {
    const items = this.baseByWorker();
    const now = this.nowMs();

    let due = 0;
    let ending = 0;
    let running = 0;

    for (const ap of items) {
      if (ap.status === 'CANCELLED' || ap.status === 'NO_SHOW') continue;
      if (this.isPaid(ap)) continue;

      const s = this.ms(ap.start_datetime);
      const e = this.ms(ap.end_datetime);

      if (now >= s && now < e) running++;
      if (e <= now) due++;
      if (e > now && e - now <= 15 * 60_000) ending++;
    }

    return { due, ending, running };
  });

  quickQueue = computed(() => {
    const items = this.baseByWorker();
    const tab = this.queueTab();
    const now = this.nowMs();

    const okBase = (ap: Appointment) =>
      ap.status !== 'CANCELLED' && ap.status !== 'NO_SHOW' && !this.isPaid(ap);

    const due = items
      .filter(ap => okBase(ap) && this.ms(ap.end_datetime) <= now)
      .sort((a, b) => this.ms(b.end_datetime) - this.ms(a.end_datetime))
      .slice(0, 10);

    const ending = items
      .filter(
        ap => okBase(ap) && this.ms(ap.end_datetime) > now && this.ms(ap.end_datetime) - now <= 15 * 60_000
      )
      .sort((a, b) => this.ms(a.end_datetime) - this.ms(b.end_datetime))
      .slice(0, 10);

    const run = items
      .filter(ap => okBase(ap) && now >= this.ms(ap.start_datetime) && now < this.ms(ap.end_datetime))
      .sort((a, b) => this.ms(a.end_datetime) - this.ms(b.end_datetime))
      .slice(0, 10);

    if (tab === 'DUE') return due;
    if (tab === 'ENDING') return ending;
    return run;
  });

  workerFocus = computed(() => {
    const items = this.baseByWorker();
    const now = this.nowMs();

    const map = new Map<string, Appointment[]>();
    for (const ap of items) {
      const w = this.primaryWorkerLabel(ap);
      if (!w || w === '—') continue;
      if (ap.status === 'CANCELLED' || ap.status === 'NO_SHOW') continue;
      if (this.isPaid(ap)) continue;
      if (!map.has(w)) map.set(w, []);
      map.get(w)!.push(ap);
    }

    const pickForWorker = (arr: Appointment[]): Appointment | null => {
      const due = arr
        .filter(a => this.ms(a.end_datetime) <= now)
        .sort((a, b) => this.ms(b.end_datetime) - this.ms(a.end_datetime));
      if (due[0]) return due[0];

      const ending = arr
        .filter(a => this.ms(a.end_datetime) > now && this.ms(a.end_datetime) - now <= 15 * 60_000)
        .sort((a, b) => this.ms(a.end_datetime) - this.ms(b.end_datetime));
      if (ending[0]) return ending[0];

      const running = arr
        .filter(a => now >= this.ms(a.start_datetime) && now < this.ms(a.end_datetime))
        .sort((a, b) => this.ms(a.end_datetime) - this.ms(b.end_datetime));
      if (running[0]) return running[0];

      const next = arr
        .filter(a => this.ms(a.start_datetime) > now)
        .sort((a, b) => this.ms(a.start_datetime) - this.ms(b.start_datetime));
      return next[0] ?? null;
    };

    const out: { worker: string; ap: Appointment }[] = [];
    for (const [worker, arr] of map.entries()) {
      const picked = pickForWorker(arr);
      if (picked) out.push({ worker, ap: picked });
    }

    out.sort((a, b) => {
      const ak = this.timeKey(a.ap);
      const bk = this.timeKey(b.ap);
      const pri = (k: string) => (k === 'DUE' ? 0 : k === 'ENDING' ? 1 : k === 'RUN' ? 2 : 3);
      const pd = pri(ak) - pri(bk);
      if (pd !== 0) return pd;
      return this.ms(a.ap.end_datetime) - this.ms(b.ap.end_datetime);
    });

    return out.slice(0, 12);
  });

  // ============================
  // ✅ EDICIÓN: computeds
  // ============================
  eServicesFiltered = computed(() => {
    const q = this.eServiceQuery().trim().toLowerCase();
    const list = this.services();
    if (!q) return list;
    return list.filter(s => (s.name ?? '').toLowerCase().includes(q));
  });

  eDurationByServices = computed(() => {
    const ids = this.eSelectedServiceIds();
    const byId = new Map(this.services().map(s => [s.id, s]));
    let mins = 0;

    for (const id of ids) {
      const s = byId.get(id);
      if (!s) continue;
      mins += Number(s.duration_minutes ?? 0);
      mins += Number(s.buffer_before_minutes ?? 0);
      mins += Number(s.buffer_after_minutes ?? 0);
    }
    return mins;
  });

  eHasBarberServices = computed(() => {
    const ids = this.eSelectedServiceIds();
    return this.hasBarberServicesSelected(ids);
  });

  eEndTime = computed(() => {
    const t = (this.eTime() ?? '').trim();
    const mins = Number(this.eDuration() ?? 0);
    if (!t || !Number.isFinite(mins) || mins <= 0) return '—';
    const end = this.addMinutesToHHMM(t, mins);
    return end || '—';
  });

  // ============================
  // Workers
  // ============================
  barberWorkers = computed(() => this.workers().filter(w => w.role === 'BARBER'));

  constructor() {
    this.loadCatalog();
    this.refresh();

    this.clockTimer = setInterval(() => this.nowMs.set(Date.now()), 20_000);

    // asegura que la selección siempre pertenezca al listado filtrado
    effect(() => {
      const list = this.filtered();
      const current = this.selectedId();

      if (current && list.some(x => x.id === current)) return;
      this.selectedId.set(list[0]?.id ?? null);
    });
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private api(path: string): string {
    const base = ((environment as any).API_URI).toString().trim().replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }

  // -----------------------------
  // Navegación fecha
  // -----------------------------
  setDate(v: string) {
    if (!v) return;
    this.date.set(v);
    this.refresh();
  }

  setToday() {
    this.date.set(this.toISODate(new Date()));
    this.refresh();
  }

  prevDay() {
    const d = new Date(`${this.date()}T00:00:00`);
    d.setDate(d.getDate() - 1);
    this.date.set(this.toISODate(d));
    this.refresh();
  }

  nextDay() {
    const d = new Date(`${this.date()}T00:00:00`);
    d.setDate(d.getDate() + 1);
    this.date.set(this.toISODate(d));
    this.refresh();
  }

  setStatus(st: StatusFilter) {
    this.status.set(st);
  }

  setQuery(v: string) {
    this.query.set(v ?? '');
  }

  // filtro por trabajador: solo UI
  setWorkerId(v: string) {
    this.workerId.set(v ?? '');
  }

  select(ap: Appointment) {
    this.selectedId.set(ap.id);
  }

  selectNextDue() {
    const items = this.baseByWorker();
    const now = this.nowMs();

    const due = items
      .filter(
        a =>
          a.status !== 'CANCELLED' &&
          a.status !== 'NO_SHOW' &&
          !this.isPaid(a) &&
          this.ms(a.end_datetime) <= now
      )
      .sort((a, b) => this.ms(b.end_datetime) - this.ms(a.end_datetime))[0];

    if (due) {
      this.selectedId.set(due.id);
      this.toastMsg('Turno seleccionado para cobro.');
    } else {
      this.toastMsg('No hay turnos pendientes de cobro.');
    }
  }

  trackById(_: number, it: Appointment) {
    return it.id;
  }

  toggleAutoRefresh() {
    const next = !this.autoRefresh();
    this.autoRefresh.set(next);

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (next) {
      this.refreshTimer = setInterval(() => this.refresh(), 60_000);
    }
  }

  // -----------------------------
  // Catálogo
  // -----------------------------
  private normalizeWorkers(res: any, role?: Group): Worker[] {
    const arr = Array.isArray(res) ? res : Array.isArray(res?.results) ? res.results : [];
    const roleText = (r?: Group) =>
      r === 'BARBER' ? 'Barber'
        : r === 'NAILS' ? 'Uñas'
          : r === 'FACIAL' ? 'Facial'
            : '';

    return arr.map((x: any) => {
      const id = Number(x.id);
      const baseLabel =
        x.label ??
        x.display_name ??
        x.name ??
        x.full_name ??
        x.fullName ??
        x.username ??
        `Worker ${id}`;

      const rawRole = (x.role ?? x.group ?? x.category ?? '').toString().toUpperCase();
      const inferred: Group | undefined =
        rawRole.includes('NAIL') || rawRole.includes('UÑ') || rawRole.includes('UNA') ? 'NAILS'
          : rawRole.includes('FAC') ? 'FACIAL'
            : rawRole.includes('BARB') ? 'BARBER'
              : undefined;

      const finalRole = role ?? inferred;

      return {
        id,
        label: String(baseLabel),
        labelFull: finalRole ? `${baseLabel} • ${roleText(finalRole)}` : String(baseLabel),
        role: finalRole,
      };
    });
  }

  private loadWorkersAll$() {
    const allUrl = this.api('/api/public/workers/');
    const bUrl = this.api('/api/public/workers/barbers/');
    const nUrl = this.api('/api/public/workers/nails/');
    const fUrl = this.api('/api/public/workers/facial/');

    const safeGet = (url: string) =>
      this.http.get<any>(url, { withCredentials: true }).pipe(catchError(() => of({ results: [] })));

    return forkJoin({
      all: safeGet(allUrl),
      barbers: safeGet(bUrl),
      nails: safeGet(nUrl),
      facial: safeGet(fUrl),
    }).pipe(
      map(({ all, barbers, nails, facial }) => {
        const merged: Worker[] = [
          ...this.normalizeWorkers(all),
          ...this.normalizeWorkers(barbers, 'BARBER'),
          ...this.normalizeWorkers(nails, 'NAILS'),
          ...this.normalizeWorkers(facial, 'FACIAL'),
        ];

        const mapById = new Map<number, Worker>();
        for (const w of merged) {
          if (!w?.id) continue;
          const prev = mapById.get(w.id);
          if (!prev) mapById.set(w.id, w);
          else {
            const better = {
              ...prev,
              ...w,
              role: w.role ?? prev.role,
              labelFull: w.labelFull ?? prev.labelFull,
            };
            mapById.set(w.id, better);
          }
        }

        return Array.from(mapById.values()).sort((a, b) => a.label.localeCompare(b.label));
      })
    );
  }

  loadCatalog() {
    this.catalogLoading.set(true);

    const svcUrl = this.api('/api/staff/services/');
    const svc$ = this.http.get<any>(svcUrl, { withCredentials: true }).pipe(catchError(() => of({ results: [] })));

    const workers$ = this.loadWorkersAll$().pipe(catchError(() => of([] as Worker[])));

    forkJoin({ svc: svc$, workers: workers$ }).subscribe({
      next: ({ svc, workers }) => {
        const arr = Array.isArray(svc) ? svc : Array.isArray(svc?.results) ? svc.results : [];
        const normalized: Service[] = arr.map((x: any) => ({
          id: Number(x.id),
          name: x.name ?? `Servicio ${x.id}`,
          duration_minutes: Number(x.duration_minutes ?? x.duration ?? x.duracion ?? 0),
          buffer_before_minutes: Number(x.buffer_before_minutes ?? x.buffer_before ?? x.tiempo_extra_antes ?? 0),
          buffer_after_minutes: Number(x.buffer_after_minutes ?? x.buffer_after ?? x.tiempo_extra_despues ?? 0),
          price: x.price ?? x.precio ?? '0',
          category: x.category ?? x.categoria ?? null,
          active: typeof x.active === 'boolean' ? x.active : true,
        }));
        this.services.set(normalized);
        this.workers.set(workers);
      },
      error: () => {
        this.services.set([]);
        this.workers.set([]);
      },
      complete: () => {
        this.catalogLoading.set(false);
      },
    });
  }

  // -----------------------------
  // Agenda staff
  // -----------------------------
  refresh() {
    this.error.set('');
    this.loading.set(true);

    const requestUrl = this.api('/api/agenda/staff/');
    let params = new HttpParams().set('date', this.date());

    // Importante: solo date al backend. Los filtros (status/query/worker) son 100% UI.
    this.http.get<StaffAgendaResponse>(requestUrl, { params, withCredentials: true }).subscribe({
      next: res => {
        this.loading.set(false);
        const items = Array.isArray(res?.results) ? res.results : [];
        this.results.set(items);

        const current = this.selectedId();
        if (current && items.some(x => x.id === current)) return;
        this.selectedId.set(items[0]?.id ?? null);
      },
      error: err => {
        this.loading.set(false);
        this.setHttpError(err, requestUrl);
      },
    });
  }

  markAttend(ap: Appointment) {
    if (!ap || ap.status !== 'RESERVED') return;
    this.doAction(ap.id, 'attend', () => this.patchStatus(ap.id, 'ATTENDED'));
  }

  markNoShow(ap: Appointment) {
    if (!ap || ap.status !== 'RESERVED') return;
    this.doAction(ap.id, 'no-show', () => this.patchStatus(ap.id, 'NO_SHOW'));
  }

  cancel(ap: Appointment) {
    if (!ap || ap.status !== 'RESERVED') return;
    const ok = confirm('¿Cancelar este turno?');
    if (!ok) return;
    this.doAction(ap.id, 'cancel', () => this.patchStatus(ap.id, 'CANCELLED'));
  }

  // -----------------------------
  // Pago
  // -----------------------------
  openPayment(ap: Appointment) {
    if (!ap) return;

    if (!this.isBillable(ap)) {
      this.toastMsg('Este turno no se cobra (no asistió o canceló).');
      return;
    }

    this.selectedId.set(ap.id);
    this.error.set('');
    this.payMethod.set('CASH');
    this.payNote.set('');
    this.payAmount.set(this.toIntString(ap.recommended_total));
    this.payOpen.set(true);
  }

  closePayment() {
    this.payOpen.set(false);
  }

  async quickCheckout(ap: Appointment) {
    if (!ap) return;

    if (!this.isBillable(ap)) {
      this.toastMsg('Este turno no se cobra (no asistió o canceló).');
      return;
    }
    if (this.isPaid(ap)) return;

    if (ap.status === 'RESERVED') {
      try {
        this.busyId.set(ap.id);
        const url = this.api(`/api/appointments/${ap.id}/attend/`);
        await firstValueFrom(this.http.post<any>(url, {}, { withCredentials: true }));
        this.patchStatus(ap.id, 'ATTENDED');
      } catch (e: any) {
        this.busyId.set(null);
        this.error.set(this.extractDetailFromAny(e) || 'No se pudo finalizar el turno.');
        return;
      } finally {
        this.busyId.set(null);
      }
    }

    this.openPayment(ap);
  }

  savePayment(ap: Appointment) {
    if (!ap) return;

    const amt = Math.trunc(this.toNum(this.payAmount()));
    if (!amt || !Number.isFinite(amt) || amt <= 0) {
      this.error.set('Ingresa un valor de pago válido.');
      return;
    }

    this.error.set('');
    this.busyId.set(ap.id);

    const url = this.api(`/api/appointments/${ap.id}/payment/`);
    const payload: any = {
      paid_total: amt,
      payment_method: this.payMethod(),
      note: this.payNote() || null,
    };

    this.http.post<any>(url, payload, { withCredentials: true }).subscribe({
      next: () => {
        this.busyId.set(null);
        this.payOpen.set(false);
        this.toastMsg('Pago registrado.');
        this.refresh();
      },
      error: err => {
        this.busyId.set(null);
        this.setHttpError(err, url);
      },
    });
  }

  private doAction(id: number, action: 'attend' | 'no-show' | 'cancel', onOk: () => void) {
    this.error.set('');
    this.busyId.set(id);

    const url = this.api(`/api/appointments/${id}/${action}/`);
    this.http.post<any>(url, {}, { withCredentials: true }).subscribe({
      next: () => {
        this.busyId.set(null);
        onOk();
        this.toastMsg('Acción aplicada.');
      },
      error: err => {
        this.busyId.set(null);
        this.setHttpError(err, url);
      },
    });
  }

  private patchStatus(id: number, status: Status) {
    const arr = this.results().slice();
    const i = arr.findIndex(x => x.id === id);
    if (i >= 0) {
      arr[i] = { ...arr[i], status };
      this.results.set(arr);
    }
  }

  // -----------------------------
  // Crear turno
  // -----------------------------
  toggleCreate() {
    const next = !this.createOpen();
    this.createOpen.set(next);
    if (next) this.seedCreateDefaults();
  }

  private seedCreateDefaults() {
    this.cCustomerType.set('CASUAL');
    this.cName.set('');
    this.cPhone.set('');
    this.cBirth.set('');
    this.cWorkerId.set('AUTO');
    this.cTime.set('');
    this.cServiceQuery.set('');
    this.cSelectedServiceIds.set([]);
    this.cMarkAttend.set(false);
    this.cRegisterPayment.set(false);
    this.cPayAmount.set('');
    this.cPayMethod.set('CASH');
  }

  toggleService(id: number) {
    const set = new Set(this.cSelectedServiceIds());
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.cSelectedServiceIds.set(Array.from(set));
  }

  canCreate(): { ok: boolean; msg?: string } {
    const type = this.cCustomerType();
    const name = this.cName().trim();
    const phone = this.cPhone().trim();
    const birth = this.cBirth().trim();
    const time = this.cTime().trim();
    const svc = this.cSelectedServiceIds();

    if (!name) return { ok: false, msg: 'Nombre es requerido.' };

    if (type === 'FREQUENT') {
      if (!phone) return { ok: false, msg: 'Cliente frecuente requiere teléfono.' };
      if (!birth) return { ok: false, msg: 'Cliente frecuente requiere fecha de nacimiento.' };
    }

    if (!time) return { ok: false, msg: 'Selecciona una hora (HH:MM).' };
    if (!svc.length) return { ok: false, msg: 'Selecciona al menos un servicio.' };

    if (this.cRegisterPayment()) {
      const amt = Math.trunc(this.toNum(this.cPayAmount()));
      if (!amt || !Number.isFinite(amt) || amt <= 0) return { ok: false, msg: 'Pago inválido.' };
    }

    return { ok: true };
  }

  async createAppointment() {
    this.error.set('');
    const check = this.canCreate();
    if (!check.ok) {
      this.error.set(check.msg || 'Formulario incompleto.');
      return;
    }

    try {
      this.catalogLoading.set(true);

      const customer_type = this.cCustomerType();
      const name = this.cName().trim();
      const phone = this.cPhone().trim();
      const birth_date = this.cBirth().trim() || null;

      const service_ids = this.cSelectedServiceIds().map(Number);
      const date = this.date();
      const time = this.cTime().trim();

      const option_id = await this.resolveOptionIdFromAvailability(
        date,
        time,
        service_ids,
        this.cWorkerId()
      );

      const payload: any = {
        option_id,
        customer: {
          customer_type,
          name,
          phone: customer_type === 'FREQUENT' ? phone : null,
          birth_date: customer_type === 'FREQUENT' ? birth_date : null,
        },
      };

      const res: any = await firstValueFrom(this.booking.createPublicAppointment(payload));

      const createdId =
        Number(res?.appointment_id) || Number(res?.id) || Number(res?.appointment?.id) || null;

      this.toastMsg(createdId ? `Turno creado #${createdId}` : 'Turno creado.');
      this.refresh();
      if (createdId) this.selectedId.set(createdId);

      if (createdId && this.cMarkAttend()) {
        this.doAction(createdId, 'attend', () => this.patchStatus(createdId, 'ATTENDED'));
      }

      if (createdId && this.cRegisterPayment()) {
        const amt = Math.trunc(this.toNum(this.cPayAmount()));
        const url = this.api(`/api/appointments/${createdId}/payment/`);
        const payPayload: any = { paid_total: amt, payment_method: this.cPayMethod() };
        this.http.post<any>(url, payPayload, { withCredentials: true }).subscribe({
          next: () => this.toastMsg('Pago registrado al crear.'),
          error: () => this.toastMsg('Turno creado, pero el pago no se pudo registrar.'),
        });
      }

      this.createOpen.set(false);
      this.catalogLoading.set(false);
    } catch (e: any) {
      this.catalogLoading.set(false);
      const msg = this.extractDetailFromAny(e) || 'No se pudo crear el turno.';
      this.error.set(msg);
    }
  }

  // -----------------------------
  // ✅ EDITAR turno (modal)
  // -----------------------------
  openEdit(ap: Appointment) {
    if (!ap) return;

    if (this.isPaid(ap)) {
      const ok = confirm('Este turno ya tiene pago registrado. ¿Deseas editarlo de todas formas?');
      if (!ok) return;
    }

    this.selectedId.set(ap.id);
    this.error.set('');

    this.eMode.set('RESCHEDULE');
    this.eTime.set(this.hhmmFromDatetime(ap.start_datetime));

    const dur = this.durationMins(ap.start_datetime, ap.end_datetime);
    this.eDuration.set(dur || 0);

    const svcIds = this.extractServiceIds(ap);
    this.eSelectedServiceIds.set(svcIds);

    // ✅ Barbero correcto según los servicios/barber-block
    const barberId = this.findBarberWorkerIdFromBlocks(ap, svcIds);
    this.eBarberId.set(barberId || 'AUTO');

    this.eServiceQuery.set('');
    this.eNote.set('');
    this.editOpen.set(true);
  }

  closeEdit() {
    this.editOpen.set(false);
  }

  toggleEditService(id: number) {
    const set = new Set(this.eSelectedServiceIds());
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.eSelectedServiceIds.set(Array.from(set));
  }

  async saveEdit(ap: Appointment) {
    if (!ap) return;

    this.error.set('');

    const date = this.date();
    const time = (this.eTime() ?? '').trim();
    const service_ids = this.eSelectedServiceIds().map(Number).filter(n => Number.isFinite(n));
    const note = (this.eNote() ?? '').trim();

    if (!time) {
      this.error.set('Selecciona una hora (HH:MM).');
      return;
    }
    if (!service_ids.length) {
      this.error.set('Selecciona al menos un servicio.');
      return;
    }

    this.busyId.set(ap.id);

    try {
      if (this.eMode() === 'RESCHEDULE') {
        // payload “nuevo backend” (deja que el backend resuelva internamente)
        const workerRaw = (this.eBarberId() ?? '').trim();
        const workerIdNum = workerRaw && workerRaw !== 'AUTO' ? Number(workerRaw) : null;

        const basePayload: any = {
          date,
          time,
          service_ids,
          note: note || null,
          // aliases típicos
          appointment_date: date,
          appointment_time: time,
        };

        if (this.hasBarberServicesSelected(service_ids)) {
          basePayload.barber_choice = workerIdNum ? 'SPECIFIC' : 'NEAREST';
          basePayload.barber_id = workerIdNum ? Number(workerIdNum) : null;

          // aliases comunes
          basePayload.worker_id = workerIdNum ? Number(workerIdNum) : null;
          basePayload.worker = workerIdNum ? Number(workerIdNum) : null;
        }

        // 1) ✅ Intenta editar sin option_id (backend actualizado)
        try {
          await this.tryEndpoints([
            { method: 'POST', url: this.api(`/api/appointments/${ap.id}/reschedule/`), body: basePayload },
            { method: 'POST', url: this.api(`/api/staff/appointments/${ap.id}/reschedule/`), body: basePayload },
            { method: 'PATCH', url: this.api(`/api/appointments/${ap.id}/`), body: basePayload },
            { method: 'PATCH', url: this.api(`/api/staff/appointments/${ap.id}/`), body: basePayload },
          ]);

          this.toastMsg('Turno reprogramado.');
          this.editOpen.set(false);
          this.refresh();
          return;
        } catch (e1: any) {
          // sigue al plan B (option_id)
        }

        // 2) ✅ Plan B: calcular option_id desde disponibilidad y enviar option_id
        const option_id = await this.resolveOptionIdFromAvailability(date, time, service_ids, this.eBarberId());

        await this.tryEndpoints([
          {
            method: 'PATCH',
            url: this.api(`/api/appointments/${ap.id}/`),
            body: { option_id, note: note || null },
          },
          {
            method: 'PATCH',
            url: this.api(`/api/staff/appointments/${ap.id}/`),
            body: { option_id, note: note || null },
          },
          {
            method: 'POST',
            url: this.api(`/api/appointments/${ap.id}/reschedule/`),
            body: { option_id, note: note || null },
          },
          {
            method: 'POST',
            url: this.api(`/api/staff/appointments/${ap.id}/reschedule/`),
            body: { option_id, note: note || null },
          },
          {
            method: 'POST',
            url: this.api(`/api/appointments/${ap.id}/change-option/`),
            body: { option_id, note: note || null },
          },
        ]);

        this.toastMsg('Turno reprogramado.');
        this.editOpen.set(false);
        this.refresh();
        return;
      }

      // MANUAL: ajustar duración/hora fin sin validar disponibilidad
      const duration = Number(this.eDuration() ?? 0);
      if (!Number.isFinite(duration) || duration <= 0) {
        this.error.set('Ingresa una duración válida en minutos.');
        return;
      }

      const startDt = this.buildIsoWithOffset(date, time);
      const endDt = this.buildIsoWithOffsetFromStart(date, time, duration);

      await this.tryEndpoints([
        {
          method: 'PATCH',
          url: this.api(`/api/appointments/${ap.id}/`),
          body: { start_datetime: startDt, end_datetime: endDt, service_ids, note: note || null },
        },
        {
          method: 'POST',
          url: this.api(`/api/appointments/${ap.id}/override/`),
          body: { start_datetime: startDt, end_datetime: endDt, service_ids, note: note || null },
        },
        {
          method: 'POST',
          url: this.api(`/api/appointments/${ap.id}/manual/`),
          body: { start_datetime: startDt, end_datetime: endDt, service_ids, note: note || null },
        },
        {
          method: 'POST',
          url: this.api(`/api/appointments/${ap.id}/reschedule/`),
          body: { start_datetime: startDt, end_datetime: endDt, service_ids, note: note || null },
        },
      ]);

      this.toastMsg('Turno actualizado (ajuste manual).');
      this.editOpen.set(false);
      this.refresh();
    } catch (e: any) {
      const msg = this.extractDetailFromAny(e) || 'No se pudo editar el turno.';
      this.error.set(msg);
    } finally {
      this.busyId.set(null);
    }
  }

  private async tryEndpoints(attempts: Array<{ method: 'POST' | 'PATCH' | 'PUT'; url: string; body: any }>) {
    let lastErr: any = null;

    for (const a of attempts) {
      try {
        const res = await firstValueFrom(
          this.http.request<any>(a.method, a.url, {
            body: a.body,
            withCredentials: true,
          })
        );
        return res;
      } catch (err: any) {
        lastErr = err;
        const status = err?.status ?? 0;

        // no seguir intentando si es auth
        if (status === 401 || status === 403) throw err;

        // en 404/405/400 puede ser que el endpoint/serializer no exista: probamos siguiente
        if ([400, 404, 405, 422].includes(status)) continue;

        // otros errores: cortar
        throw err;
      }
    }

    throw lastErr;
  }

  private extractServiceIds(ap: Appointment): number[] {
    const out = new Set<number>();

    const byName = new Map<string, number>();
    for (const s of this.services()) {
      const key = String(s.name ?? '').trim().toLowerCase();
      if (key) byName.set(key, s.id);
    }

    const pickId = (raw: any): number | null => {
      const id =
        raw?.id ??
        raw?.service_id ??
        raw?.serviceId ??
        raw?.service?.id ??
        raw?.service?.pk ??
        raw?.pk ??
        null;

      const n = Number(id);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const pickName = (raw: any): number | null => {
      const name =
        raw?.name ??
        raw?.service_name ??
        raw?.service?.name ??
        raw?.serviceName ??
        '';
      const key = String(name).trim().toLowerCase();
      if (!key) return null;
      const mapped = byName.get(key);
      return mapped ? Number(mapped) : null;
    };

    for (const b of ap.blocks ?? []) {
      for (const s of (b as any).services ?? []) {
        const id = pickId(s) ?? pickName(s);
        if (id) out.add(id);
      }
    }

    return Array.from(out);
  }

  // -----------------------------
  // Availability -> option_id (usado en crear y reprogramar)
  // -----------------------------
  private inferGroupFromCategoryName(catName: string): Group {
    const raw = (catName || '').toLowerCase();
    const nailsKeys = ['uña', 'unas', 'uñas', 'manicure', 'pedicure', 'nails'];
    const facialKeys = ['facial', 'limpieza facial', 'rostro', 'skin'];

    if (nailsKeys.some(k => raw.includes(k))) return 'NAILS';
    if (facialKeys.some(k => raw.includes(k))) return 'FACIAL';
    return 'BARBER';
  }

  private groupOfServiceId(id: number): Group {
    const s: any = this.services().find(x => x.id === id);
    if (!s) return 'BARBER';

    const cat =
      typeof s.category === 'string'
        ? s.category
        : (s.category?.name ?? s.category?.nombre ?? '');

    return this.inferGroupFromCategoryName(String(cat || ''));
  }

  private findBarberWorkerIdFromBlocks(ap: Appointment, serviceIds: number[]): string {
    // Si el turno tiene servicios BARBER, busca el bloque que tenga alguno de esos servicios
    const hasBarber = this.hasBarberServicesSelected(serviceIds);
    if (!hasBarber) return 'AUTO';

    for (const b of ap.blocks ?? []) {
      const idsInBlock: number[] = [];
      for (const s of (b as any).services ?? []) {
        const id = Number((s as any).id ?? (s as any).service_id ?? (s as any).service?.id);
        if (Number.isFinite(id)) idsInBlock.push(id);
      }
      const blockHasBarber = idsInBlock.some(id => this.groupOfServiceId(id) === 'BARBER');
      if (blockHasBarber && (b as any).worker) return String((b as any).worker);
    }

    // fallback: primer bloque
    const b0: any = ap.blocks?.[0];
    return b0?.worker ? String(b0.worker) : 'AUTO';
  }

  private hasBarberServicesSelected(serviceIds: number[]): boolean {
    return serviceIds.some(id => this.groupOfServiceId(id) === 'BARBER');
  }

  private async resolveOptionIdFromAvailability(
    date: string,
    time: string,
    service_ids: number[],
    workerRawForBarber: string
  ): Promise<string> {
    const workerRaw = (workerRawForBarber ?? '').trim();
    const workerIdNum = workerRaw && workerRaw !== 'AUTO' ? Number(workerRaw) : null;

    const payload: any = {
      date,
      service_ids,
      limit: 300,
      slot_interval_minutes: 5,
    };

    if (this.hasBarberServicesSelected(service_ids)) {
      payload.barber_choice = workerIdNum ? 'SPECIFIC' : 'NEAREST';
      payload.barber_id = workerIdNum ? Number(workerIdNum) : null;
    }

    const opts = await firstValueFrom(this.booking.getAvailabilityOptions(payload));
    const list: AvailabilityOption[] = Array.isArray(opts) ? opts : [];

    if (!list.length) {
      throw { error: { detail: 'No hay disponibilidad para la fecha/servicios seleccionados.' } };
    }

    const picked = this.pickAvailabilityOptionByTime(list, date, time);
    if (!picked) {
      throw {
        error: {
          detail:
            'La hora seleccionada no coincide con un slot disponible. ' +
            'Cambia la hora o selecciona un turno dentro de los disponibles.',
        },
      };
    }

    const rawId: any = (picked as any).id ?? (picked as any).option_id ?? null;
    if (!rawId) {
      throw { error: { detail: 'La disponibilidad no trae un id de opción válido.' } };
    }

    return String(rawId);
  }

  private pickAvailabilityOptionByTime(
    options: AvailabilityOption[],
    date: string,
    time: string
  ): AvailabilityOption | null {
    const t = time.length === 5 ? `${time}:00` : time;
    const desired = new Date(`${date}T${t}`);

    const startOf = (o: any): Date | null => {
      const raw =
        o?.appointment_start ??
        o?.start_datetime ??
        o?.start ??
        o?.start_time ??
        o?.begin ??
        null;

      if (!raw) return null;

      // Si viene solo "HH:MM" o "HH:MM:SS"
      if (typeof raw === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(raw.trim())) {
        const tt = raw.trim().length === 5 ? `${raw.trim()}:00` : raw.trim();
        const d = new Date(`${date}T${tt}`);
        return Number.isFinite(d.getTime()) ? d : null;
      }

      const d = new Date(raw);
      return Number.isFinite(d.getTime()) ? d : null;
    };

    const exact = options.find((o: any) => {
      const d = startOf(o);
      if (!d) return false;
      return (
        d.getFullYear() === desired.getFullYear() &&
        d.getMonth() === desired.getMonth() &&
        d.getDate() === desired.getDate() &&
        d.getHours() === desired.getHours() &&
        d.getMinutes() === desired.getMinutes()
      );
    });
    if (exact) return exact;

    let best: AvailabilityOption | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (const o of options as any[]) {
      const d = startOf(o);
      if (!d) continue;
      const diff = Math.abs(d.getTime() - desired.getTime());
      if (diff < bestDiff) {
        bestDiff = diff;
        best = o;
      }
    }

    const bestMin = Math.round(bestDiff / 60000);
    return best && bestMin <= 10 ? best : null;
  }

  // -----------------------------
  // Export / helpers
  // -----------------------------
  exportCSV() {
    const rows = this.filtered();
    const head = [
      'id',
      'status',
      'start',
      'end',
      'customer',
      'phone',
      'worker',
      'services',
      'recommended_total',
      'paid_total',
      'payment_method',
    ];
    const data = rows.map(a => [
      a.id,
      a.status,
      a.start_datetime,
      a.end_datetime,
      a.customer.name ?? '',
      a.customer.phone ?? '',
      a.blocks[0]?.worker_label ?? '',
      this.flattenServices(a),
      a.recommended_total ?? '',
      a.paid_total ?? '',
      a.payment_method ?? '',
    ]);

    const csv = [head, ...data]
      .map(line => line.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `turnos_${this.date()}.csv`;
    a.click();

    URL.revokeObjectURL(url);
    this.toastMsg('CSV descargado.');
  }

  copy(text: string) {
    const t = (text ?? '').toString().trim();
    if (!t) return;
    navigator.clipboard?.writeText(t).then(() => this.toastMsg('Copiado.'));
  }

  waLink(phone: string | null) {
    const p = (phone ?? '').replace(/\D/g, '');
    if (!p) return '';
    return `https://wa.me/${p}`;
  }

  private setHttpError(err: any, requestUrl: string) {
    const e = err as HttpErrorResponse;
    const status = e?.status ?? 0;

    console.error('[TURNOS ERROR]', { requestUrl, status, error: e?.error });

    if (status === 401) {
      this.error.set('Las credenciales de autenticación no se proveyeron. (HTTP 401)');
      return;
    }
    if (status === 403) {
      this.error.set('No autorizado. Esta vista es solo para administración/recepción (staff).');
      return;
    }

    this.error.set(this.extractDetail(e) || 'No se pudo cargar la información.');
  }

  private extractDetail(e: HttpErrorResponse): string {
    const err: any = e?.error;

    if (err && typeof err === 'object') {
      if (typeof err.detail === 'string') return err.detail;

      const parts: string[] = [];
      for (const [k, v] of Object.entries(err)) {
        if (Array.isArray(v)) parts.push(`${k}: ${v.join(' ')}`);
        else if (typeof v === 'string') parts.push(`${k}: ${v}`);
        else if (v && typeof v === 'object') parts.push(`${k}: ${JSON.stringify(v)}`);
      }
      if (parts.length) return parts.join(' | ');
    }

    if (typeof err === 'string') return err;
    return (e?.message || '').toString();
  }

  private extractDetailFromAny(e: any): string {
    const detail = e?.error?.detail;
    if (typeof detail === 'string') return detail;

    const http = e as HttpErrorResponse;
    if (http?.error?.detail) return String(http.error.detail);

    if (typeof e?.message === 'string') return e.message;
    return '';
  }

  dateLabel(iso: string) {
    try {
      const d = new Date(`${iso}T00:00:00`);
      return d.toLocaleDateString('es-CO', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
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

  serviceCount(ap: Appointment): number {
    let n = 0;
    for (const b of ap.blocks) n += b.services?.length ?? 0;
    return n;
  }

  flattenServices(ap: Appointment): string {
    const names: string[] = [];
    for (const b of ap.blocks) {
      for (const s of b.services) names.push(s.name);
    }
    return names.join(' • ');
  }

  primaryWorkerLabel(ap: Appointment): string {
    const labels = (ap.blocks ?? [])
      .map(b => (b.worker_label ?? '').trim())
      .filter(Boolean);
    if (!labels.length) return '—';
    return labels[0];
  }

  // ============================
  // Tiempo (por cobrar / por terminar / en curso)
  // ============================
  private ms(dt: string): number {
    const t = new Date(dt).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  isPaid(ap: Appointment): boolean {
    return this.toNum(ap.paid_total ?? '0') > 0;
  }

  isBillable(ap: Appointment): boolean {
    return ap.status !== 'CANCELLED' && ap.status !== 'NO_SHOW';
  }

  timeKey(ap: Appointment): 'DUE' | 'ENDING' | 'RUN' | 'OTHER' {
    if (ap.status === 'CANCELLED' || ap.status === 'NO_SHOW') return 'OTHER';
    if (this.isPaid(ap)) return 'OTHER';

    const now = this.nowMs();
    const s = this.ms(ap.start_datetime);
    const e = this.ms(ap.end_datetime);

    if (e <= now) return 'DUE';
    if (e > now && e - now <= 15 * 60_000) return 'ENDING';
    if (now >= s && now < e) return 'RUN';
    return 'OTHER';
  }

  relativeEnd(ap: Appointment): string {
    const now = this.nowMs();
    const e = this.ms(ap.end_datetime);
    const diffMin = Math.round((e - now) / 60000);

    if (diffMin === 0) return 'Termina ahora';
    if (diffMin > 0) return `Termina en ${diffMin} min`;
    return `Hace ${Math.abs(diffMin)} min`;
  }

  timePillLabel(ap: Appointment): string {
    if (ap.status === 'CANCELLED') return 'Cancelado';
    if (ap.status === 'NO_SHOW') return 'No show';
    if (this.isPaid(ap)) return 'Pagado';

    const k = this.timeKey(ap);
    if (k === 'DUE') return 'Por cobrar';
    if (k === 'ENDING') return 'Por terminar';
    if (k === 'RUN') return 'En curso';

    const now = this.nowMs();
    const s = this.ms(ap.start_datetime);
    const toStart = Math.round((s - now) / 60000);
    if (toStart > 0 && toStart <= 10) return 'Próximo';

    return ap.status === 'ATTENDED' ? 'Atendido' : 'Programado';
  }

  timePillClass(ap: Appointment): string {
    if (ap.status === 'CANCELLED') return 'tpill--cancel';
    if (ap.status === 'NO_SHOW') return 'tpill--noshow';
    if (this.isPaid(ap)) return 'tpill--paid';

    const k = this.timeKey(ap);
    if (k === 'DUE') return 'tpill--due';
    if (k === 'ENDING') return 'tpill--ending';
    if (k === 'RUN') return 'tpill--run';

    return 'tpill--other';
  }

  money(v: any): string {
    const n = typeof v === 'number' ? v : this.toNum(v);
    try {
      return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(n);
    } catch {
      return `$${n}`;
    }
  }

  toISODate(d: Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Soporta: "30000.00", "30.000", "30.000,50", "$ 30.000"
  private toNum(v: any): number {
    if (v == null) return 0;

    let s = String(v).trim();
    s = s.replace(/\s/g, '').replace(/[^\d.,-]/g, '');

    const neg = s.startsWith('-');
    s = s.replace(/-/g, '');

    const hasDot = s.includes('.');
    const hasComma = s.includes(',');

    if (hasDot && hasComma) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (hasComma && !hasDot) {
      s = s.replace(',', '.');
    } else if (hasDot && !hasComma) {
      const lastDot = s.lastIndexOf('.');
      const decPart = s.slice(lastDot + 1);
      if (decPart.length === 3 && /^\d{3}$/.test(decPart)) {
        s = s.replace(/\./g, '');
      }
    }

    const n = Number(s);
    const out = neg ? -n : n;
    return Number.isFinite(out) ? out : 0;
  }

  private toIntString(v: any): string {
    const n = this.toNum(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return String(Math.trunc(n));
  }

  private toastMsg(msg: string) {
    this.toast.set(msg);
    setTimeout(() => {
      if (this.toast() === msg) this.toast.set('');
    }, 2400);
  }

  // ============================
  // ✅ Helpers edición tiempo ISO con offset
  // ============================
  private hhmmFromDatetime(dt: string): string {
    try {
      const d = new Date(dt);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    } catch {
      return '';
    }
  }

  private addMinutesToHHMM(time: string, mins: number): string {
    const t = (time ?? '').trim();
    if (!t) return '';
    const [hh, mm] = t.split(':').map(x => Number(x));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return '';
    const base = new Date(`${this.date()}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
    const end = new Date(base.getTime() + mins * 60_000);
    const eh = String(end.getHours()).padStart(2, '0');
    const em = String(end.getMinutes()).padStart(2, '0');
    return `${eh}:${em}`;
  }

  private buildIsoWithOffset(date: string, time: string): string {
    const t = time.length === 5 ? `${time}:00` : time;
    const d = new Date(`${date}T${t}`);

    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');

    const offMin = -d.getTimezoneOffset(); // ej Colombia: -300
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    const oh = String(Math.floor(abs / 60)).padStart(2, '0');
    const om = String(abs % 60).padStart(2, '0');

    return `${y}-${m}-${day}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
  }

  private buildIsoWithOffsetFromStart(date: string, time: string, addMinutes: number): string {
    const t = time.length === 5 ? `${time}:00` : time;
    const start = new Date(`${date}T${t}`);
    const end = new Date(start.getTime() + addMinutes * 60_000);

    const y = end.getFullYear();
    const m = String(end.getMonth() + 1).padStart(2, '0');
    const day = String(end.getDate()).padStart(2, '0');
    const hh = String(end.getHours()).padStart(2, '0');
    const mm = String(end.getMinutes()).padStart(2, '0');
    const ss = String(end.getSeconds()).padStart(2, '0');

    const offMin = -end.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    const oh = String(Math.floor(abs / 60)).padStart(2, '0');
    const om = String(abs % 60).padStart(2, '0');

    return `${y}-${m}-${day}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
  }
}
