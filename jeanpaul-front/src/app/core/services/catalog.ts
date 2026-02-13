import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { Observable } from 'rxjs';

export interface ServiceCategoryDTO {
  id: number;
  name: string;
}

export interface ServiceDTO {
  id: number;
  name: string;
  category: ServiceCategoryDTO;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  description: string;
  requirements: string;
  active: boolean;
}

export interface WorkerDTO {
  id: number;
  display_name: string;
  role: 'BARBER' | 'NAILS' | 'FACIAL';
}

@Injectable({ providedIn: 'root' })
export class CatalogService {
  constructor(private http: HttpClient) {}

  // Público (landing)
  getServices(): Observable<ServiceDTO[]> {
    return this.http.get<ServiceDTO[]>(`${environment.API_URI}/api/public/services/`);
  }

  getCategories(): Observable<ServiceCategoryDTO[]> {
    return this.http.get<ServiceCategoryDTO[]>(`${environment.API_URI}/api/public/service-categories/`);
  }

  // Público: barberos reales
  getBarbers(): Observable<WorkerDTO[]> {
    return this.http.get<WorkerDTO[]>(`${environment.API_URI}/api/public/workers/barbers/`);
  }
}
