import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, shareReplay } from 'rxjs';
import { environment } from '../../../environments/environment';

export type AgendaStatus = 'RESERVED' | 'CANCELLED' | 'ATTENDED' | 'NO_SHOW';

export type AgendaCustomer = {
  id: number | null;
  name: string;
  phone: string | null;
  birth_date: string | null;
};

export type AgendaServiceSummary = {
  id: number;
  name: string;
  duration_minutes: number;
  buffer_before: number;
  buffer_after: number;
  price: string;
};

export type AgendaBlock = {
  id: number;
  sequence: number;
  worker: number;
  worker_label: string;
  start_datetime: string;
  end_datetime: string;
  services: AgendaServiceSummary[];
};

export type AgendaAppointment = {
  id: number;
  status: AgendaStatus;
  start_datetime: string;
  end_datetime: string;
  customer: AgendaCustomer;
  blocks: AgendaBlock[];
  recommended_total: string;
};

export type MyAgendaResponse = {
  date: string;
  worker_id: number;
  count: number;
  results: AgendaAppointment[];
};

@Injectable({ providedIn: 'root' })
export class AgendaService {
  private http = inject(HttpClient);

  // si ya tienes un interceptor que agrega /api, cambia esto a ''
  private baseUrl = environment.API_URI;

  private cache = new Map<string, Observable<MyAgendaResponse>>();

  getMyAgenda(dateYYYYMMDD: string): Observable<MyAgendaResponse> {
    const key = dateYYYYMMDD;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const params = new HttpParams().set('date', dateYYYYMMDD);

    const req$ = this.http
      .get<MyAgendaResponse>(`${this.baseUrl}/api/agenda/my/`, { params })
      .pipe(shareReplay({ bufferSize: 1, refCount: true }));

    this.cache.set(key, req$);
    return req$;
  }

  refreshMyAgenda(dateYYYYMMDD: string): Observable<MyAgendaResponse> {
    this.cache.delete(dateYYYYMMDD);
    return this.getMyAgenda(dateYYYYMMDD);
  }

  attend(id: number) {
    return this.http.post(`${this.baseUrl}/api/appointments/${id}/attend/`, {});
  }
  noShow(id: number) {
    return this.http.post(`${this.baseUrl}/api/appointments/${id}/no-show/`, {});
  }
  cancel(id: number, reason?: string) {
    return this.http.post(`${this.baseUrl}/api/appointments/${id}/cancel/`, { reason });
  }
}
