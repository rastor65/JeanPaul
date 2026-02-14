import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type CustomerType = 'CASUAL' | 'FREQUENT';

export interface PublicServiceCategory {
  id: number;
  name: string;
}

export interface PublicService {
  id: number;
  name: string;
  category: PublicServiceCategory;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  description: string;
  requirements: string;
  active: boolean;
}

export interface PublicWorker {
  id: number;
  display_name: string;
  role: string; // "BARBER"
}

export interface AvailabilityOption {
  option_id: string;
  appointment_start: string;
  appointment_end: string;
  gap_total_minutes: number;
  blocks: Array<{
    sequence: number;
    worker_id: number;
    start: string;
    end: string;
    service_ids: number[];
    services: Array<{
      id: number;
      name: string;
      duration: number;
      buffer_before: number;
      buffer_after: number;
    }>;
  }>;
}

export interface AvailabilityRequest {
  date: string;                 // YYYY-MM-DD
  service_ids: number[];
  barber_choice: 'SPECIFIC' | 'NEAREST';
  barber_id?: number | null;
}

export interface PublicAppointmentRequest {
  option_id: string;
  customer: {
    customer_type: CustomerType;
    name: string;
    phone?: string | null;
    birth_date?: string | null; // YYYY-MM-DD
  };
}

export interface PublicAppointmentResponse {
  appointment_id: number;
  customer_id: number;
  start_datetime: string;
  end_datetime: string;
}

@Injectable({ providedIn: 'root' })
export class BookingPublicService {
  private API = 'https://jean-paul.up.railway.app/api';

  constructor(private http: HttpClient) {}

  // Servicios públicos
  getPublicServices(): Observable<PublicService[]> {
    return this.http.get<PublicService[]>(`${this.API}/public/services/`);
  }

  // Barberos públicos
  getPublicBarbers(): Observable<PublicWorker[]> {
    return this.http.get<PublicWorker[]>(`${this.API}/public/workers/barbers/`);
  }

  // Disponibilidad (ojo: este endpoint en tu backend actualmente está con IsAuthenticated;
  // si ya lo cambiaste a AllowAny, esto funciona sin login)
  getAvailabilityOptions(body: AvailabilityRequest): Observable<AvailabilityOption[]> {
    return this.http.post<AvailabilityOption[]>(`${this.API}/availability/options/`, body);
  }

  // ✅ Reservar SIN login (public)
  createPublicAppointment(body: PublicAppointmentRequest): Observable<PublicAppointmentResponse> {
    return this.http.post<PublicAppointmentResponse>(`${this.API}/public/appointments/`, body);
  }
}
