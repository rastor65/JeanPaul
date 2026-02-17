import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { BookingService, AvailabilityOption } from '../../core/services/booking';

type StatusFilter = 'ALL' | 'RESERVED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW';
type Status = 'RESERVED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW';
type PayMethod = 'CASH' | 'TRANSFER' | 'CARD';
type CustomerType = 'CASUAL' | 'FREQUENT';

type QueueTab = 'DUE' | 'ENDING' | 'RUN' | 'WORKER';

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

type Worker = {
  id: number;
  label: string;
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

type Group = 'BARBER' | 'NAILS' | 'FACIAL';

@Component({
  selector: 'app-turnos',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './turnos.html',
  styleUrls: ['./turnos.scss'], // ✅ corregido (styleUrl -> styleUrls)
})
export class TurnosComponent implements OnDestroy {
  private http = inject(HttpClient);
  private booking = inject(BookingService);

  date = signal<string>(this.toISODate(new Date()));
  status = signal<StatusFilter>('ALL');
  query = signal<string>('');
  workerId = signal<string>('');

  loading = signal<boolean>(false);
  error = signal<string>('');
  busyId = signal<number | null>(null);

  results = signal<Appointment[]>([]);
  selectedId = signal<number | null>(null);

  autoRefresh = signal<boolean>(false);
  private refreshTimer: any = null;

  // reloj UI (para “por terminar / por cobrar” sin depender solo del refresh)
  nowMs = signal<number>(Date.now());
  private clockTimer: any = null;

  services = signal<Service[]>([]);
  workers = signal<Worker[]>([]);
  catalogLoading = signal<boolean>(false);

  payOpen = signal<boolean>(false);
  payAmount = signal<string>('');
  payMethod = signal<PayMethod>('CASH');
  payNote = signal<string>('');

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

  // ✅ Caja rápida
  queueTab = signal<QueueTab>('DUE');

  selected = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.results().find(x => x.id === id) ?? null;
  });

  filtered = computed(() => {
    const st = this.status();
    const q = this.query().trim().toLowerCase();
    let list = this.results();

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

  counts = computed(() => {
    const base = { ALL: 0, RESERVED: 0, ATTENDED: 0, CANCELLED: 0, NO_SHOW: 0 } as Record<StatusFilter, number>;
    const items = this.results();
    base.ALL = items.length;
    for (const a of items) base[a.status] = (base[a.status] ?? 0) + 1;
    return base;
  });

  kpis = computed(() => {
    const items = this.results();
    const billable = items.filter(a => this.isBillable(a));

    const sumRecommended = billable.reduce(
      (acc, a) => acc + this.toNum(a.recommended_total),
      0
    );

    const sumPaid = billable.reduce(
      (acc, a) => acc + this.toNum(a.paid_total ?? '0'),
      0
    );

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

  cServicesFiltered = computed(() => {
    const q = this.cServiceQuery().trim().toLowerCase();
    const list = this.services();
    if (!q) return list;
    return list.filter(s => (s.name ?? '').toLowerCase().includes(q));
  });

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
  // ✅ Caja rápida: lógica
  // ============================
  attention = computed(() => {
    const items = this.results();
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
      if (e > now && (e - now) <= 15 * 60_000) ending++;
    }

    return { due, ending, running };
  });

  quickQueue = computed(() => {
    const items = this.results();
    const tab = this.queueTab();
    const now = this.nowMs();

    const okBase = (ap: Appointment) =>
      ap.status !== 'CANCELLED' &&
      ap.status !== 'NO_SHOW' &&
      !this.isPaid(ap);

    const due = items
      .filter(ap => okBase(ap) && this.ms(ap.end_datetime) <= now)
      .sort((a, b) => this.ms(b.end_datetime) - this.ms(a.end_datetime))
      .slice(0, 10);

    const ending = items
      .filter(ap => okBase(ap) && this.ms(ap.end_datetime) > now && (this.ms(ap.end_datetime) - now) <= 15 * 60_000)
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
    const items = this.results();
    const now = this.nowMs();

    // agrupar por trabajador principal (bloque 1)
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
      // prioridad:
      // 1) terminado sin cobro (últimos primero)
      const due = arr
        .filter(a => this.ms(a.end_datetime) <= now)
        .sort((a, b) => this.ms(b.end_datetime) - this.ms(a.end_datetime));
      if (due[0]) return due[0];

      // 2) por terminar (más cercano)
      const ending = arr
        .filter(a => this.ms(a.end_datetime) > now && (this.ms(a.end_datetime) - now) <= 15 * 60_000)
        .sort((a, b) => this.ms(a.end_datetime) - this.ms(b.end_datetime));
      if (ending[0]) return ending[0];

      // 3) en curso
      const running = arr
        .filter(a => now >= this.ms(a.start_datetime) && now < this.ms(a.end_datetime))
        .sort((a, b) => this.ms(a.end_datetime) - this.ms(b.end_datetime));
      if (running[0]) return running[0];

      // 4) siguiente
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

    // ordenar por prioridad global
    out.sort((a, b) => {
      const ak = this.timeKey(a.ap);
      const bk = this.timeKey(b.ap);
      const pri = (k: string) => (k === 'DUE' ? 0 : k === 'ENDING' ? 1 : k === 'RUN' ? 2 : 3);
      const pd = pri(ak) - pri(bk);
      if (pd !== 0) return pd;

      // luego por end
      return this.ms(a.ap.end_datetime) - this.ms(b.ap.end_datetime);
    });

    return out.slice(0, 12);
  });

  constructor() {
    this.loadCatalog();
    this.refresh();

    // actualiza reloj cada 20s para etiquetas “por cobrar / por terminar”
    this.clockTimer = setInterval(() => this.nowMs.set(Date.now()), 20_000);
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
    const base = ((environment as any).API_URI)
      .toString()
      .trim()
      .replace(/\/+$/, '');
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

  setWorkerId(v: string) {
    this.workerId.set(v ?? '');
  }

  select(ap: Appointment) {
    this.selectedId.set(ap.id);
  }

  selectNextDue() {
    const items = this.results();
    const now = this.nowMs();
    const due = items
      .filter(a => a.status !== 'CANCELLED' && a.status !== 'NO_SHOW' && !this.isPaid(a) && this.ms(a.end_datetime) <= now)
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
  loadCatalog() {
    this.catalogLoading.set(true);

    const svcUrl = this.api('/api/staff/services/');
    const wUrl = this.api('/api/public/workers/barbers/');

    const svc$ = this.http.get<any>(svcUrl, { withCredentials: true });
    const w$ = this.http.get<any>(wUrl, { withCredentials: true });

    svc$.subscribe({
      next: (res) => {
        const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
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
      },
      error: () => {
        this.services.set([]);
      }
    });

    w$.subscribe({
      next: (res) => {
        const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
        const normalized: Worker[] = arr.map((x: any) => ({
          id: Number(x.id),
          label:
            x.label ??
            x.display_name ??
            x.name ??
            x.full_name ??
            x.fullName ??
            x.username ??
            `Worker ${x.id}`,
        }));
        this.workers.set(normalized);
        this.catalogLoading.set(false);
      },
      error: () => {
        this.workers.set([]);
        this.catalogLoading.set(false);
      }
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

    const st = this.status();
    if (st !== 'ALL') params = params.set('status', st);

    const q = this.query().trim();
    if (q) params = params.set('q', q);

    const wid = this.workerId().trim();
    if (wid) params = params.set('worker_id', wid);

    this.http.get<StaffAgendaResponse>(requestUrl, { params, withCredentials: true }).subscribe({
      next: (res) => {
        this.loading.set(false);
        const items = Array.isArray(res?.results) ? res.results : [];
        this.results.set(items);

        const current = this.selectedId();
        if (current && items.some(x => x.id === current)) return;
        this.selectedId.set(items[0]?.id ?? null);
      },
      error: (err) => {
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
      this.toastMsg('Este turno no se cobra: fue cancelado o no asistió.');
      return;
    }

    this.selectedId.set(ap.id);
    this.error.set('');
    this.payMethod.set('CASH');
    this.payNote.set('');

    const rec = (ap.recommended_total ?? '').toString().trim();
    this.payAmount.set(rec && rec !== '0' ? rec : '');
    this.payOpen.set(true);
  }

  closePayment() {
    this.payOpen.set(false);
  }

  async quickCheckout(ap: Appointment) {
    if (!ap) return;

    if (!this.isBillable(ap)) {
      this.toastMsg('Este turno no se cobra: fue cancelado o no asistió.');
      return;
    }
    if (this.isPaid(ap)) return;

    // si está RESERVED, lo finalizamos primero y luego cobramos
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

    // ✅ parse robusto COP (30.000 => 30000)
    const amt = this.parseCOP(this.payAmount());
    if (amt <= 0) {
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
      error: (err) => {
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
      error: (err) => {
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
      const amt = this.parseCOP(this.cPayAmount());
      if (amt <= 0) return { ok: false, msg: 'Pago inválido.' };
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

      const option_id = await this.resolveOptionIdFromAvailability(date, time, service_ids);

      const payload: any = {
        option_id,
        customer: {
          customer_type,
          name,
          phone: customer_type === 'FREQUENT' ? phone : null,
          birth_date: customer_type === 'FREQUENT' ? birth_date : null,
        }
      };

      const res: any = await firstValueFrom(this.booking.createPublicAppointment(payload));

      const createdId =
        Number(res?.appointment_id) ||
        Number(res?.id) ||
        Number(res?.appointment?.id) ||
        null;

      this.toastMsg(createdId ? `Turno creado #${createdId}` : 'Turno creado.');
      this.refresh();
      if (createdId) this.selectedId.set(createdId);

      if (createdId && this.cMarkAttend()) {
        this.doAction(createdId, 'attend', () => this.patchStatus(createdId, 'ATTENDED'));
      }

      if (createdId && this.cRegisterPayment()) {
        const amt = this.parseCOP(this.cPayAmount());
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
  // Availability -> option_id
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
    const s = this.services().find(x => x.id === id);
    const catName = (s as any)?.category?.name || '';
    return this.inferGroupFromCategoryName(catName);
  }

  private hasBarberServicesSelected(serviceIds: number[]): boolean {
    return serviceIds.some((id) => this.groupOfServiceId(id) === 'BARBER');
  }

  private async resolveOptionIdFromAvailability(date: string, time: string, service_ids: number[]): Promise<string> {
    const workerRaw = this.cWorkerId().trim();
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
            'Cambia la hora o selecciona un turno dentro de los disponibles.'
        }
      };
    }

    const rawId: any = (picked as any).id ?? (picked as any).option_id ?? null;
    if (!rawId) {
      throw { error: { detail: 'La disponibilidad no trae un id de opción válido.' } };
    }

    return String(rawId);
  }

  private pickAvailabilityOptionByTime(options: AvailabilityOption[], date: string, time: string): AvailabilityOption | null {
    const t = time.length === 5 ? `${time}:00` : time;
    const desired = new Date(`${date}T${t}`);

    const exact = options.find((o: AvailabilityOption) => {
      const d = new Date((o as any).appointment_start);
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

    for (const o of options) {
      const d = new Date((o as any).appointment_start);
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
    const head = ['id', 'status', 'start', 'end', 'customer', 'phone', 'worker', 'services', 'recommended_total', 'paid_total', 'payment_method'];
    const data = rows.map(a => ([
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
    ]));

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

  // ✅ WhatsApp: si es número local CO (10 dígitos) se le agrega 57
  waLink(phone: string | null) {
    let p = (phone ?? '').replace(/\D/g, '');
    if (!p) return '';
    if (p.length === 10) p = `57${p}`;
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

  serviceCount(ap: Appointment): number {
    let n = 0;
    for (const b of ap.blocks) n += (b.services?.length ?? 0);
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
    if (e > now && (e - now) <= 15 * 60_000) return 'ENDING';
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
      return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
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

  // ✅ Parser COP para inputs (30.000 / 30,000 / $30.000 => 30000)
  private parseCOP(v: any): number {
    if (v == null) return 0;
    const digits = String(v).replace(/\D/g, '');
    if (!digits) return 0;
    const n = Number(digits);
    return Number.isFinite(n) ? n : 0;
  }

  // ✅ Parser numérico robusto (soporta miles con . o ,)
  private toNum(v: any): number {
    if (v == null) return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;

    let s = String(v).trim();
    if (!s) return 0;

    // quita moneda y espacios
    s = s.replace(/\s/g, '').replace(/[^\d.,-]/g, '');

    const hasDot = s.includes('.');
    const hasComma = s.includes(',');

    if (hasDot && hasComma) {
      // el último separador define el decimal
      const lastDot = s.lastIndexOf('.');
      const lastComma = s.lastIndexOf(',');
      if (lastComma > lastDot) {
        // 1.234,56 -> miles '.', decimal ','
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        // 1,234.56 -> miles ',', decimal '.'
        s = s.replace(/,/g, '');
      }
    } else if (hasComma && !hasDot) {
      // 30,000 (miles) o 123,45 (decimal)
      const idx = s.lastIndexOf(',');
      const decimals = s.length - idx - 1;
      if (decimals === 2) s = s.replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasDot && !hasComma) {
      // 30.000 (miles) o 123.45 (decimal)
      const idx = s.lastIndexOf('.');
      const decimals = s.length - idx - 1;
      if (decimals === 2) {
        // decimal válido
      } else {
        s = s.replace(/\./g, '');
      }
    }

    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  private toastMsg(msg: string) {
    this.toast.set(msg);
    setTimeout(() => {
      if (this.toast() === msg) this.toast.set('');
    }, 2400);
  }
}
