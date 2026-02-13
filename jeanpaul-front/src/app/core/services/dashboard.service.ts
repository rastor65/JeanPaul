import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { Observable, forkJoin, of, throwError } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';

export type AppointmentStatus =
  | 'Reservado'
  | 'En curso'
  | 'Atendido'
  | 'Cancelado'
  | 'No show'
  | 'Pendiente pago'
  | string;

export interface AgendaItem {
  id?: number;
  time: string;
  title: string;
  customer: string;
  worker?: string;
  status: AppointmentStatus;
}

export interface DashboardVM {
  kpi: {
    todayAppointments: number;
    reserved: number;
    inProgress: number;
    attended: number;
    revenueToday: number;
    nextTime: string;
    nextLabel: string;
  };
  agendaToday: AgendaItem[];
  updatedAt: Date;
}

type LoadMode = 'auto' | 'staff' | 'my';
type Paginated<T> = { results?: T[] } & Record<string, any>;
type ListResponse<T> = T[] | Paginated<T>;

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private http = inject(HttpClient);

  private API =
    `${(environment as any).API_URI || ''}`.replace(/\/$/, '') + '/api';

  loadToday(mode: LoadMode = 'auto', date: Date = new Date()): Observable<DashboardVM> {
    const day = this.toISODate(date);
    const params = this.dayParams(day);

    const agenda$ =
      mode === 'staff'
        ? this.getList<any>(`${this.API}/agenda/staff/`, params)
        : mode === 'my'
          ? this.getList<any>(`${this.API}/agenda/my/`, params)
          : this.getList<any>(`${this.API}/agenda/staff/`, params).pipe(
              catchError(() => this.getList<any>(`${this.API}/agenda/my/`, params))
            );

    // appointments/staff devuelve de varios días → filtramos por el día
    const appts$ =
      mode === 'my'
        ? of([] as any[]) // no hay /appointments/my/
        : this.getList<any>(`${this.API}/appointments/staff/`, params).pipe(
            map(list => this.onlyDay(list, day)),
            catchError(() => of([] as any[]))
          );

    return forkJoin({ agenda: agenda$, appts: appts$ }).pipe(
      map(({ agenda, appts }) => this.buildVM(agenda, appts))
    );
  }

  // Acciones reales (según tus URLs)
  cancelAppointment(id: number) {
    return this.http.post(`${this.API}/appointments/${id}/cancel/`, {});
  }
  attendAppointment(id: number) {
    return this.http.post(`${this.API}/appointments/${id}/attend/`, {});
  }
  noShowAppointment(id: number) {
    return this.http.post(`${this.API}/appointments/${id}/no-show/`, {});
  }
  payAppointment(id: number, payload: any) {
    return this.http.post(`${this.API}/appointments/${id}/payment/`, payload);
  }

  // -------------------------
  // Helper genérico (evita "never" y soporta {results:[]})
  // -------------------------
  private getList<T>(url: string, params: HttpParams): Observable<T[]> {
    return this.http.get<ListResponse<T>>(url, { params }).pipe(
      timeout({ first: 8000 }),
      map((res) => this.toList<T>(res)),
      catchError((err) => throwError(() => this.normalizeHttpError(err)))
    );
  }

  private toList<T>(res: ListResponse<T> | unknown): T[] {
    if (Array.isArray(res)) return res as T[];
    if (res && typeof res === 'object') {
      const anyRes = res as any;
      if (Array.isArray(anyRes.results)) return anyRes.results as T[];
    }
    return [];
  }

  private normalizeHttpError(err: any): any {
    if (err instanceof HttpErrorResponse) {
      const msg = (err.message || '').toString().toLowerCase();
      // típico: status 200 pero parse error por HTML / redirección
      if (err.status === 200 && msg.includes('parsing')) {
        return new Error('Respuesta no-JSON (posible redirección/login). Revisa auth y URL /api.');
      }
      return err;
    }
    return err;
  }

  private onlyDay(list: any[], day: string): any[] {
    return (list || []).filter(x => {
      const v = (x?.start_datetime || x?.start || x?.start_time || '').toString();
      return v.startsWith(day); // "2026-02-11T..."
    });
  }

  // -------------------------
  // VM builder
  // -------------------------
  private buildVM(agendaRaw: any[], apptsRaw: any[]): DashboardVM {
    // Para el dashboard, preferimos agenda si viene (ya viene filtrada y paginada bien)
    const base = (agendaRaw && agendaRaw.length) ? agendaRaw : apptsRaw;

    const items = this.toAgendaItems(base);

    const total = items.length;

    const reserved = items.filter(i => this.normStatus(i.status) === 'reservado').length;
    const inProgress = items.filter(i => this.normStatus(i.status) === 'en curso').length;
    const attended = items.filter(i => this.normStatus(i.status) === 'atendido').length;

    const revenueToday = this.sumRevenue(base);
    const next = this.findNext(items);

    return {
      kpi: {
        todayAppointments: total,
        reserved,
        inProgress,
        attended,
        revenueToday,
        nextTime: next?.time ?? '—',
        nextLabel: next ? `${next.title} • ${next.customer}` : '—',
      },
      agendaToday: items,
      updatedAt: new Date(),
    };
  }

  private toAgendaItems(list: any[]): AgendaItem[] {
    const rows = (list || []).map((x: any) => ({
      id: x?.id,
      time: this.pickTime(x),
      title: this.pickTitle(x),
      customer: this.pickCustomer(x),
      worker: this.pickWorker(x),
      status: this.pickStatus(x),
    })) as AgendaItem[];

    return this.sortByTime(rows);
  }

  private sortByTime(items: AgendaItem[]) {
    return [...items].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  }

  private findNext(items: AgendaItem[]): AgendaItem | null {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const upcoming = items.filter((i) => {
      const t = i.time || '';
      const s = this.normStatus(i.status);
      return t >= hhmm && s !== 'cancelado';
    });

    return upcoming.length ? upcoming[0] : null;
  }

  // -------------------------
  // Parsers según tu JSON real
  // -------------------------
  private pickTime(x: any): string {
    const v = (x?.start_datetime || x?.start || x?.start_time || '').toString();
    // "2026-02-11T00:01:00-05:00" -> "00:01"
    if (v.includes('T')) return (v.split('T')[1] || '').slice(0, 5) || '—';
    if (v.includes(':')) return v.slice(0, 5);
    return '—';
  }

  private pickCustomer(x: any): string {
    return (x?.customer?.name || x?.customer_name || x?.nombre_cliente || 'Cliente').toString();
  }

  private pickWorker(x: any): string | undefined {
    const blocks = Array.isArray(x?.blocks) ? x.blocks : [];
    const labels = blocks
      .map((b: any) => (b?.worker_label || '').toString().trim())
      .filter(Boolean);

    const uniq = Array.from(new Set(labels));
    if (!uniq.length) return undefined;
    return uniq.join(' + ');
  }

  private pickTitle(x: any): string {
    // servicios vienen en blocks[].services[]
    const blocks = Array.isArray(x?.blocks) ? x.blocks : [];
    const names: string[] = [];

    for (const b of blocks) {
      const svcs = Array.isArray(b?.services) ? b.services : [];
      for (const s of svcs) {
        const n = (s?.name || s?.title || '').toString().trim();
        if (n) names.push(n);
      }
    }

    const uniq = Array.from(new Set(names));
    if (!uniq.length) return 'Servicio';

    // UI compacta: "Corte +2"
    if (uniq.length === 1) return uniq[0];
    return `${uniq[0]} +${uniq.length - 1}`;
  }

  private pickStatus(x: any): AppointmentStatus {
    const raw = (x?.status || x?.state || '').toString().toUpperCase().trim();

    const mapStatus: Record<string, AppointmentStatus> = {
      RESERVED: 'Reservado',
      IN_PROGRESS: 'En curso',
      ATTENDED: 'Atendido',
      CANCELED: 'Cancelado',
      CANCELLED: 'Cancelado',
      NO_SHOW: 'No show',
      PAYMENT_PENDING: 'Pendiente pago',
      PENDING_PAYMENT: 'Pendiente pago',
    };

    return mapStatus[raw] || (raw ? raw : 'Pendiente pago');
  }

  private normStatus(s: any): string {
    return (s || '').toString().toLowerCase();
  }

  private sumRevenue(list: any[]): number {
    let sum = 0;
    for (const a of list || []) {
      // tu payload tiene paid_total (number o null)
      const v = a?.paid_total ?? a?.paid ?? a?.amount_paid ?? a?.total_paid ?? 0;
      const n = Number(v);
      if (!Number.isNaN(n)) sum += n;
    }
    return sum;
  }

  // -------------------------
  // Params
  // -------------------------
  private toISODate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private dayParams(day: string): HttpParams {
    // Mantengo ambos porque tu backend los acepta
    return new HttpParams().set('date', day).set('day', day);
  }
}
