import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { Observable } from 'rxjs';

export interface AvailabilityBlock {
  sequence: number;
  worker_id: number;
  start: string; // ISO
  end: string;   // ISO
  service_ids: number[];
  services: {
    id: number;
    name: string;
    duration: number;
    buffer_before: number;
    buffer_after: number;
  }[];
}

export interface AvailabilityOption {
  option_id: string;
  appointment_start: string; // ISO
  appointment_end: string;   // ISO
  gap_total_minutes: number;
  blocks: AvailabilityBlock[];
}

@Injectable({ providedIn: 'root' })
export class BookingService {
  constructor(private http: HttpClient) {}

  getAvailabilityOptions(payload: {
    date: string; // YYYY-MM-DD
    service_ids: number[];
    barber_choice?: 'SPECIFIC' | 'NEAREST';
    barber_id?: number | null;
    limit?: number;
    slot_interval_minutes?: number;
  }): Observable<AvailabilityOption[]> {
    return this.http.post<AvailabilityOption[]>(
      `${environment.API_URI}/api/availability/options/`,
      payload
    );
  }

  /**
   * Reserva pública: enviamos option_id (ideal) y start_datetime (fallback)
   * para que el backend use lo que tenga implementado.
   */
  createPublicAppointment(payload: any): Observable<any> {
    return this.http.post(`${environment.API_URI}/api/public/appointments/`, payload);
  }

  getAgenda(paramsObj: any) {
    let params = new HttpParams();
    Object.keys(paramsObj || {}).forEach((k) => {
      if (paramsObj[k] !== null && paramsObj[k] !== undefined && paramsObj[k] !== '') {
        params = params.set(k, String(paramsObj[k]));
      }
    });
    return this.http.get<any[]>(`${environment.API_URI}/api/appointments/agenda/`, { params });
  }

  updateAppointmentStatus(id: number, body: { status: string }) {
    return this.http.patch(`${environment.API_URI}/api/appointments/${id}/status/`, body);
  }
}
