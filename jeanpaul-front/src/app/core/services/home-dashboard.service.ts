import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, of, concat, forkJoin } from 'rxjs';
import { catchError, map, take } from 'rxjs/operators';

export type RoleLabel = 'Administrador' | 'Barbero' | 'Uñas' | 'Facial' | 'Panel';

export type AgendaStatus =
  | 'Reservado'
  | 'En curso'
  | 'Atendido'
  | 'Cancelado'
  | 'No show'
  | 'Pendiente pago';

export type AgendaItem = {
  id?: string | number;
  time: string;            // "09:30"
  title: string;           // "Corte + Barba"
  customer: string;        // "Juan Pérez"
  worker?: string;         // "Carlos"
  durationMin?: number;    // 30
  total?: number;          // COP
  tag?: string;            // "Nuevo" | "Frecuente" | "VIP" | "Cumpleaños"
  status: AgendaStatus;
  raw?: any;
};

export type KPI = {
  todayAppointments: number;
  reserved: number;
  inProgress: number;
  attended: number;
  canceled: number;
  noShow: number;

  revenueToday: number;     // total cobrado hoy
  pendingToday: number;     // pendiente por cobrar hoy
  avgTicketToday: number;

  nextTime: string;         // "10:10" o "—"
  nextLabel: string;        // "Barba — Juan"
  occupancyPct: number;     // 0-100 (estimado con duración)
};

export type SeriesPoint = { label: string; value: number };

export type TopItem = { name: string; count: number; total: number };

export type Alerts = {
  lateCount: number;
  pendingPayCount: number;
  unassignedCount: number;
};

export type DataHealth = {
  appointments: boolean;
  payments: boolean;
  services: boolean;
  workers: boolean;
  customers: boolean;
};

export type DashboardVM = {
  kpi: KPI;
  agendaToday: AgendaItem[];
  weekSeries: SeriesPoint[];
  topServices: TopItem[];
  topWorkers: TopItem[];
  alerts: Alerts;
  health: DataHealth;
  updatedAt: Date;
};

type Settings = any;

@Injectable({ providedIn: 'root' })
export class HomeDashboardService {
  private http = inject(HttpClient);

  // Si tienes environment.API_URI, tu interceptor o baseUrl ya lo manejará.
  // Si NO, y necesitas base, agrega aquí y concatena manualmente.
  // private base = '';

  load(date: Date = new Date()): Observable<DashboardVM> {
    const day = this.toDateOnly(date);
    const week = this.lastNDays(date, 7); // [start,end]

    const settings = this.readSettings();

    const apptToday$ = this.fetchAppointmentsRange(day, day);
    const apptWeek$ = this.fetchAppointmentsRange(week.start, week.end);

    const paymentsToday$ = this.fetchPaymentsRange(day, day);
    const services$ = this.fetchServices();
    const workers$ = this.fetchWorkers();
    const customers$ = this.fetchCustomers();

    return forkJoin({
      apptToday: apptToday$,
      apptWeek: apptWeek$,
      paymentsToday: paymentsToday$,
      services: services$,
      workers: workers$,
      customers: customers$,
    }).pipe(
      map(({ apptToday, apptWeek, paymentsToday, services, workers, customers }) => {
        const health: DataHealth = {
          appointments: apptToday.ok || apptWeek.ok,
          payments: paymentsToday.ok,
          services: services.ok,
          workers: workers.ok,
          customers: customers.ok,
        };

        const normServices = this.normalizeServices(services.data);
        const normWorkers = this.normalizeWorkers(workers.data);
        const normCustomers = this.normalizeCustomers(customers.data);

        const todayItems = this.normalizeAppointments(apptToday.data, normServices, normWorkers, normCustomers);
        const weekItems = this.normalizeAppointments(apptWeek.data, normServices, normWorkers, normCustomers);

        const payToday = this.normalizePayments(paymentsToday.data);

        const kpi = this.buildKPI(todayItems, payToday, settings);
        const weekSeries = this.buildWeekSeries(weekItems, date);
        const topServices = this.buildTopServices(todayItems);
        const topWorkers = this.buildTopWorkers(todayItems);
        const alerts = this.buildAlerts(todayItems, settings);

        // agenda visible: ordenada por hora, solo hoy
        const agendaToday = todayItems
          .slice()
          .sort((a, b) => a.time.localeCompare(b.time))
          .slice(0, 12); // vista rápida

        return {
          kpi,
          agendaToday,
          weekSeries,
          topServices,
          topWorkers,
          alerts,
          health,
          updatedAt: new Date(),
        } as DashboardVM;
      }),
      catchError(() => {
        const empty: DashboardVM = {
          kpi: {
            todayAppointments: 0,
            reserved: 0,
            inProgress: 0,
            attended: 0,
            canceled: 0,
            noShow: 0,
            revenueToday: 0,
            pendingToday: 0,
            avgTicketToday: 0,
            nextTime: '—',
            nextLabel: '—',
            occupancyPct: 0,
          },
          agendaToday: [],
          weekSeries: [],
          topServices: [],
          topWorkers: [],
          alerts: { lateCount: 0, pendingPayCount: 0, unassignedCount: 0 },
          health: { appointments: false, payments: false, services: false, workers: false, customers: false },
          updatedAt: new Date(),
        };
        return of(empty);
      })
    );
  }

  // ---------------------------
  // Fetchers (tolerantes)
  // ---------------------------

  private fetchAppointmentsRange(fromDay: string, toDay: string): Observable<{ ok: boolean; data: any[] }> {
    const candidates = [
      { url: '/api/appointments/', params: this.paramsRange(fromDay, toDay) },
      { url: '/api/turnos/', params: this.paramsRange(fromDay, toDay) },
      { url: '/api/agenda/', params: this.paramsRange(fromDay, toDay) },
      { url: '/api/booking/appointments/', params: this.paramsRange(fromDay, toDay) },

      // variantes DRF comunes
      { url: '/api/appointments/', params: this.paramsDRFRange(fromDay, toDay) },
      { url: '/api/turnos/', params: this.paramsDRFRange(fromDay, toDay) },
    ];

    return this.tryGetAny(candidates).pipe(
      map((data) => ({ ok: true, data: this.unwrapList(data) })),
      catchError(() => of({ ok: false, data: [] }))
    );
  }

  private fetchPaymentsRange(fromDay: string, toDay: string): Observable<{ ok: boolean; data: any[] }> {
    const candidates = [
      { url: '/api/payments/', params: this.paramsRange(fromDay, toDay) },
      { url: '/api/pagos/', params: this.paramsRange(fromDay, toDay) },
      { url: '/api/contabilidad/payments/', params: this.paramsRange(fromDay, toDay) },

      { url: '/api/payments/', params: this.paramsDRFRange(fromDay, toDay) },
      { url: '/api/pagos/', params: this.paramsDRFRange(fromDay, toDay) },
    ];

    return this.tryGetAny(candidates).pipe(
      map((data) => ({ ok: true, data: this.unwrapList(data) })),
      catchError(() => of({ ok: false, data: [] }))
    );
  }

  private fetchServices(): Observable<{ ok: boolean; data: any[] }> {
    const candidates = [
      { url: '/api/services/', params: new HttpParams() },
      { url: '/api/servicios/', params: new HttpParams() },
      { url: '/api/catalog/services/', params: new HttpParams() },
      { url: '/api/catalogo/', params: new HttpParams() },
    ];
    return this.tryGetAny(candidates).pipe(
      map((data) => ({ ok: true, data: this.unwrapList(data) })),
      catchError(() => of({ ok: false, data: [] }))
    );
  }

  private fetchWorkers(): Observable<{ ok: boolean; data: any[] }> {
    const candidates = [
      { url: '/api/workers/', params: new HttpParams() },
      { url: '/api/barbers/', params: new HttpParams() },
      { url: '/api/personal/', params: new HttpParams() },
      { url: '/api/staff/', params: new HttpParams() },
      { url: '/api/usuarios/', params: new HttpParams() }, // si tu personal sale por usuarios
    ];
    return this.tryGetAny(candidates).pipe(
      map((data) => ({ ok: true, data: this.unwrapList(data) })),
      catchError(() => of({ ok: false, data: [] }))
    );
  }

  private fetchCustomers(): Observable<{ ok: boolean; data: any[] }> {
    const candidates = [
      { url: '/api/customers/', params: new HttpParams() },
      { url: '/api/clientes/', params: new HttpParams() },
      { url: '/api/persons/', params: new HttpParams() },
      { url: '/api/person/', params: new HttpParams() },
    ];
    return this.tryGetAny(candidates).pipe(
      map((data) => ({ ok: true, data: this.unwrapList(data) })),
      catchError(() => of({ ok: false, data: [] }))
    );
  }

  private tryGetAny(candidates: { url: string; params: HttpParams }[]): Observable<any> {
    const calls = candidates.map((c) =>
      this.http.get(c.url, { params: c.params }).pipe(catchError(() => of(null)))
    );

    return concat(...calls).pipe(
      map((res) => {
        if (res === null) throw new Error('nope');
        return res;
      }),
      take(1)
    );
  }

  private unwrapList(res: any): any[] {
    if (!res) return [];
    if (Array.isArray(res)) return res;
    // DRF paginado
    if (Array.isArray(res.results)) return res.results;
    if (Array.isArray(res.data)) return res.data;
    return [];
  }

  private paramsRange(fromDay: string, toDay: string): HttpParams {
    // combina varias convenciones
    return new HttpParams()
      .set('date', fromDay === toDay ? fromDay : '')
      .set('day', fromDay === toDay ? fromDay : '')
      .set('from', fromDay)
      .set('to', toDay)
      .set('start', fromDay)
      .set('end', toDay)
      .set('start_date', fromDay)
      .set('end_date', toDay);
  }

  private paramsDRFRange(fromDay: string, toDay: string): HttpParams {
    // filtros típicos DRF: field__gte / field__lte
    return new HttpParams()
      .set('date__gte', fromDay)
      .set('date__lte', toDay)
      .set('fecha__gte', fromDay)
      .set('fecha__lte', toDay)
      .set('start__date__gte', fromDay)
      .set('start__date__lte', toDay)
      .set('start_time__date__gte', fromDay)
      .set('start_time__date__lte', toDay);
  }

  // ---------------------------
  // Normalizadores
  // ---------------------------

  private normalizeServices(list: any[]): Map<string | number, { name: string; price?: number; durationMin?: number }> {
    const m = new Map<string | number, { name: string; price?: number; durationMin?: number }>();
    for (const s of list || []) {
      const id = s.id ?? s.pk ?? s.uuid ?? s.code ?? s.codigo;
      if (id == null) continue;

      const name = (s.name ?? s.nombre ?? s.title ?? s.titulo ?? 'Servicio').toString();
      const price = this.num(s.price ?? s.valor ?? s.cost ?? s.costo ?? s.amount);
      const dur = this.num(s.duration_min ?? s.duration ?? s.duracion_min ?? s.duracion ?? s.minutes);
      m.set(id, { name, price: price ?? undefined, durationMin: dur ?? undefined });
    }
    return m;
  }

  private normalizeWorkers(list: any[]): Map<string | number, { name: string; role?: string }> {
    const m = new Map<string | number, { name: string; role?: string }>();
    for (const w of list || []) {
      const id = w.id ?? w.pk ?? w.uuid ?? w.user_id ?? w.user?.id;
      if (id == null) continue;

      const name =
        w.full_name ??
        w.fullName ??
        w.name ??
        w.nombre ??
        (w.user ? `${w.user.first_name ?? ''} ${w.user.last_name ?? ''}`.trim() : '') ??
        w.username ??
        'Trabajador';

      const role = w.role ?? w.rol ?? w.worker_role ?? w.user_role ?? w.profile?.role;
      m.set(id, { name: String(name).trim() || 'Trabajador', role: role ? String(role) : undefined });
    }
    return m;
  }

  private normalizeCustomers(list: any[]): Map<string | number, { name: string; phone?: string; birth?: string }> {
    const m = new Map<string | number, { name: string; phone?: string; birth?: string }>();
    for (const c of list || []) {
      const id = c.id ?? c.pk ?? c.uuid ?? c.customer_id ?? c.person_id;
      if (id == null) continue;

      const name =
        c.full_name ??
        c.fullName ??
        c.name ??
        c.nombre ??
        `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() ??
        'Cliente';

      const phone = c.phone ?? c.telefono ?? c.celular ?? c.mobile;
      const birth = c.birthdate ?? c.fecha_nacimiento ?? c.dob;

      m.set(id, { name: String(name).trim() || 'Cliente', phone: phone ? String(phone) : undefined, birth: birth ? String(birth) : undefined });
    }
    return m;
  }

  private normalizeAppointments(
    list: any[],
    services: Map<any, any>,
    workers: Map<any, any>,
    customers: Map<any, any>
  ): AgendaItem[] {
    const out: AgendaItem[] = [];

    for (const a of list || []) {
      const id = a.id ?? a.pk ?? a.uuid ?? a.code ?? a.codigo;

      const dt = this.pickDateTime(a);
      const day = dt ? this.toDateOnly(dt) : '';

      const time = dt ? this.hhmm(dt) : (a.time ?? a.hora ?? '—').toString().slice(0, 5);

      const status = this.mapStatus(a);

      // customer
      const cid = a.customer_id ?? a.cliente_id ?? a.customer?.id ?? a.cliente?.id ?? a.person?.id ?? a.person_id;
      const cName =
        a.customer_name ??
        a.cliente_nombre ??
        a.customer?.full_name ??
        a.customer?.name ??
        a.cliente?.nombre ??
        a.client?.name ??
        (cid != null ? customers.get(cid)?.name : '') ??
        'Cliente';

      // worker
      const wid = a.worker_id ?? a.trabajador_id ?? a.barber_id ?? a.worker?.id ?? a.trabajador?.id ?? a.barbero?.id;
      const wName =
        a.worker_name ??
        a.trabajador_nombre ??
        a.worker?.name ??
        a.trabajador?.nombre ??
        (wid != null ? workers.get(wid)?.name : '') ??
        '';

      // services
      const svcNames: string[] = [];
      let totalDur = 0;
      let totalMoney: number | undefined;

      const svcRaw =
        a.services ??
        a.servicios ??
        a.items ??
        a.detalle ??
        a.detail ??
        a.service ??
        a.servicio;

      const normalizedSvcs = this.normalizeAppointmentServices(svcRaw);

      for (const s of normalizedSvcs) {
        const sid = s.id ?? s.service_id ?? s.servicio_id ?? s.pk;
        const found = sid != null ? services.get(sid) : null;

        const name = (s.name ?? s.nombre ?? found?.name ?? 'Servicio').toString();
        svcNames.push(name);

        const dur = this.num(s.duration_min ?? s.duration ?? s.duracion ?? found?.durationMin);
        if (dur) totalDur += dur;

        const p = this.num(s.price ?? s.valor ?? s.amount ?? found?.price);
        if (p != null) totalMoney = (totalMoney ?? 0) + p;
      }

      // total desde turno si viene
      const aTotal = this.num(a.total ?? a.valor_total ?? a.amount ?? a.price ?? a.total_amount ?? a.total_price);
      if (aTotal != null) totalMoney = aTotal;

      // tags (frecuente/nuevo/cumple)
      const tag = this.buildTag(a, cid, customers);

      const title = svcNames.length ? svcNames.join(' + ') : (a.title ?? a.titulo ?? 'Turno').toString();

      out.push({
        id,
        time,
        title,
        customer: String(cName).trim() || 'Cliente',
        worker: wName ? String(wName).trim() : undefined,
        durationMin: totalDur || this.num(a.duration_min ?? a.duration ?? a.duracion) || undefined,
        total: totalMoney ?? undefined,
        tag,
        status,
        raw: { ...a, __day: day },
      });
    }

    return out;
  }

  private normalizeAppointmentServices(svcRaw: any): any[] {
    if (!svcRaw) return [];
    if (Array.isArray(svcRaw)) return svcRaw;
    // si viene como string CSV
    if (typeof svcRaw === 'string') {
      return svcRaw
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
    }
    // si viene un objeto único
    return [svcRaw];
  }

  private normalizePayments(list: any[]): { amount: number; status: 'PAID' | 'PENDING' | 'VOID'; day: string }[] {
    const out: { amount: number; status: 'PAID' | 'PENDING' | 'VOID'; day: string }[] = [];
    for (const p of list || []) {
      const amount = this.num(p.amount ?? p.valor ?? p.total ?? p.value ?? p.monto) ?? 0;
      const stRaw = (p.status ?? p.estado ?? p.state ?? '').toString().toUpperCase();
      const status: 'PAID' | 'PENDING' | 'VOID' =
        stRaw.includes('PAID') || stRaw.includes('PAG') || stRaw.includes('COBR') ? 'PAID' :
        stRaw.includes('PEND') ? 'PENDING' :
        stRaw.includes('VOID') || stRaw.includes('ANUL') ? 'VOID' : 'PAID';

      const dt = this.pickDateTime(p) ?? new Date();
      out.push({ amount, status, day: this.toDateOnly(dt) });
    }
    return out;
  }

  // ---------------------------
  // KPIs / series / top / alerts
  // ---------------------------

  private buildKPI(today: AgendaItem[], paymentsToday: { amount: number; status: string }[], settings: Settings): KPI {
    const total = today.length;

    const reserved = today.filter((x) => x.status === 'Reservado').length;
    const inProgress = today.filter((x) => x.status === 'En curso').length;
    const attended = today.filter((x) => x.status === 'Atendido').length;
    const canceled = today.filter((x) => x.status === 'Cancelado').length;
    const noShow = today.filter((x) => x.status === 'No show').length;

    // Cobrado: preferir payments si existen; si no, estimar por turnos atendidos con total
    const paidByPayments = paymentsToday
      .filter((p) => p.status === 'PAID')
      .reduce((acc, p) => acc + (p.amount || 0), 0);

    const estPaidByAppointments = today
      .filter((x) => x.status === 'Atendido')
      .reduce((acc, x) => acc + (x.total || 0), 0);

    const revenueToday = paidByPayments > 0 ? paidByPayments : estPaidByAppointments;

    // Pendiente: turnos reservados/en curso con total (si existe), o pagos pendientes
    const pendingByPayments = paymentsToday
      .filter((p) => p.status === 'PENDING')
      .reduce((acc, p) => acc + (p.amount || 0), 0);

    const pendingByAppointments = today
      .filter((x) => x.status === 'Reservado' || x.status === 'En curso' || x.status === 'Pendiente pago')
      .reduce((acc, x) => acc + (x.total || 0), 0);

    const pendingToday = pendingByPayments > 0 ? pendingByPayments : pendingByAppointments;

    const avgTicketToday = total > 0 ? Math.round(revenueToday / Math.max(1, attended || total)) : 0;

    // Próximo turno (el más cercano en el futuro)
    const now = new Date();
    const nowHHMM = this.hhmm(now);

    const next = today
      .slice()
      .filter((x) => x.time >= nowHHMM && x.status !== 'Cancelado' && x.status !== 'Atendido')
      .sort((a, b) => a.time.localeCompare(b.time))[0];

    const nextTime = next?.time || '—';
    const nextLabel = next ? `${next.title} — ${next.customer}` : '—';

    // Ocupación estimada: suma duraciones / jornada (configurable con settings si luego lo agregas)
    const minutes = today.reduce((acc, x) => acc + (x.durationMin || 0), 0);
    const workdayMin = 10 * 60; // estimado 10h
    const occupancyPct = Math.max(0, Math.min(100, Math.round((minutes / workdayMin) * 100)));

    return {
      todayAppointments: total,
      reserved,
      inProgress,
      attended,
      canceled,
      noShow,
      revenueToday,
      pendingToday,
      avgTicketToday,
      nextTime,
      nextLabel,
      occupancyPct,
    };
  }

  private buildWeekSeries(week: AgendaItem[], today: Date): SeriesPoint[] {
    const points: SeriesPoint[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const day = this.toDateOnly(d);

      const count = week.filter((x) => x.raw?.__day === day && x.status !== 'Cancelado').length;

      points.push({
        label: new Intl.DateTimeFormat('es-CO', { weekday: 'short' }).format(d),
        value: count,
      });
    }
    return points;
  }

  private buildTopServices(today: AgendaItem[]): TopItem[] {
    const m = new Map<string, TopItem>();

    for (const a of today || []) {
      const parts = (a.title || '').split('+').map((x) => x.trim()).filter(Boolean);
      for (const name of (parts.length ? parts : [a.title || 'Servicio'])) {
        const cur = m.get(name) || { name, count: 0, total: 0 };
        cur.count += 1;
        cur.total += a.total || 0;
        m.set(name, cur);
      }
    }

    return Array.from(m.values())
      .sort((a, b) => b.count - a.count || b.total - a.total)
      .slice(0, 5);
  }

  private buildTopWorkers(today: AgendaItem[]): TopItem[] {
    const m = new Map<string, TopItem>();

    for (const a of today || []) {
      const name = a.worker || 'Sin asignar';
      const cur = m.get(name) || { name, count: 0, total: 0 };
      cur.count += 1;
      cur.total += a.total || 0;
      m.set(name, cur);
    }

    return Array.from(m.values())
      .sort((a, b) => b.count - a.count || b.total - a.total)
      .slice(0, 6);
  }

  private buildAlerts(today: AgendaItem[], settings: Settings): Alerts {
    // “Tarde”: si el turno es antes de la hora actual y sigue Reservado/En curso
    const nowHHMM = this.hhmm(new Date());
    const lateCount = today.filter((x) => x.time < nowHHMM && (x.status === 'Reservado' || x.status === 'En curso')).length;

    const pendingPayCount = today.filter((x) => x.status === 'Pendiente pago').length;

    const unassignedCount = today.filter((x) => !x.worker || x.worker === 'Sin asignar').length;

    return { lateCount, pendingPayCount, unassignedCount };
  }

  // ---------------------------
  // Status / tags / datetime
  // ---------------------------

  private mapStatus(a: any): AgendaStatus {
    const raw = (a.status ?? a.estado ?? a.state ?? a.appointment_status ?? '').toString().toUpperCase();

    if (raw.includes('CANCEL')) return 'Cancelado';
    if (raw.includes('NOSHOW') || raw.includes('NO_SHOW') || raw.includes('NO SHOW')) return 'No show';
    if (raw.includes('DONE') || raw.includes('ATTEND') || raw.includes('FINISH') || raw.includes('ATEND')) return 'Atendido';
    if (raw.includes('PROGRESS') || raw.includes('IN_PROGRESS') || raw.includes('EN CURSO')) return 'En curso';
    if (raw.includes('PEND') && raw.includes('PAY')) return 'Pendiente pago';

    // default
    return 'Reservado';
  }

  private buildTag(a: any, customerId: any, customers: Map<any, any>): string | undefined {
    const isVip = !!(a.vip ?? a.is_vip ?? a.cliente_vip);
    if (isVip) return 'VIP';

    const isFrequent = !!(a.frequent ?? a.is_frequent ?? a.frecuente);
    if (isFrequent) return 'Frecuente';

    const isNew = !!(a.is_new ?? a.nuevo ?? a.new_customer);
    if (isNew) return 'Nuevo';

    // cumpleaños (si hay birthdate en cliente y hoy coincide dd-mm)
    if (customerId != null) {
      const birth = customers.get(customerId)?.birth;
      if (birth) {
        const bd = this.safeDate(birth);
        if (bd) {
          const now = new Date();
          if (bd.getDate() === now.getDate() && bd.getMonth() === now.getMonth()) return 'Cumpleaños';
        }
      }
    }

    return undefined;
  }

  private pickDateTime(obj: any): Date | null {
    const candidates = [
      obj.start,
      obj.start_time,
      obj.startTime,
      obj.datetime,
      obj.fecha_hora,
      obj.date_time,
      obj.date,
      obj.fecha,
      obj.created_at,
      obj.createdAt,
    ].filter(Boolean);

    for (const c of candidates) {
      const d = this.safeDate(c);
      if (d) return d;
    }

    // si viene separado fecha/hora
    const dateOnly = obj.date ?? obj.fecha;
    const timeOnly = obj.time ?? obj.hora;
    if (dateOnly && timeOnly) {
      const d = this.safeDate(`${dateOnly}T${String(timeOnly).slice(0, 5)}:00`);
      if (d) return d;
    }

    return null;
  }

  private safeDate(v: any): Date | null {
    try {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }

  private toDateOnly(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private hhmm(d: Date): string {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  private lastNDays(today: Date, n: number): { start: string; end: string } {
    const end = new Date(today);
    const start = new Date(today);
    start.setDate(start.getDate() - (n - 1));
    return { start: this.toDateOnly(start), end: this.toDateOnly(end) };
  }

  private num(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private readSettings(): Settings {
    try {
      const raw = localStorage.getItem('jp_settings_v1');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}
