import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { Observable, throwError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import {
  WorkerManage, WorkerScheduleRule, WorkerBreak, WorkerException
} from '../models/staffing.models';

@Injectable({ providedIn: 'root' })
export class StaffingAdminApi {
  // Normaliza para evitar //api si API_URI termina con "/"
  private base = `${String(environment.API_URI || '').replace(/\/+$/, '')}/api`;

  // Si quieres, ajusta este tiempo (ms)
  private readonly REQ_TIMEOUT_MS = 15000;

  constructor(private http: HttpClient) {}

  // Helper: evita “requests colgadas” por interceptores/refresh mal manejados
  private safe<T>(obs$: Observable<T>, label: string): Observable<T> {
    return obs$.pipe(
      timeout(this.REQ_TIMEOUT_MS),
      catchError((err) => {
        // Log útil para depurar (puedes quitarlo si no lo quieres)
        // OJO: Esto NO rompe tu UI, solo hace que el observable termine con error.
        // Si un interceptor dejó la petición “pendiente”, el timeout la corta.
        console.error(`[StaffingAdminApi] ${label} failed:`, err);

        return throwError(() => err);
      })
    );
  }

  // Workers
  listWorkers(params?: { q?: string; role?: string; active?: string }) {
    let p = new HttpParams();

    const q = params?.q?.trim();
    const role = params?.role?.trim();
    const active = params?.active?.trim();

    if (q) p = p.set('q', q);
    if (role && role !== 'ALL') p = p.set('role', role);
    if (active && active !== 'ALL') p = p.set('active', active);

    return this.safe(
      this.http.get<WorkerManage[]>(
        `${this.base}/staff/workers/manage/`,
        { params: p }
      ),
      'listWorkers'
    );
  }

  createWorker(payload: Partial<WorkerManage>) {
    return this.safe(
      this.http.post<WorkerManage>(`${this.base}/staff/workers/manage/`, payload),
      'createWorker'
    );
  }

  updateWorker(id: number, payload: Partial<WorkerManage>) {
    return this.safe(
      this.http.put<WorkerManage>(`${this.base}/staff/workers/manage/${id}/`, payload),
      'updateWorker'
    );
  }

  deactivateWorker(id: number) {
    return this.safe(
      this.http.delete<{ detail: string }>(`${this.base}/staff/workers/manage/${id}/`),
      'deactivateWorker'
    );
  }

  // Schedule rules
  listRules(workerId: number) {
    return this.safe(
      this.http.get<WorkerScheduleRule[]>(
        `${this.base}/staff/workers/manage/${workerId}/schedule-rules/`
      ),
      'listRules'
    );
  }

  createRule(workerId: number, payload: Partial<WorkerScheduleRule>) {
    return this.safe(
      this.http.post<WorkerScheduleRule>(
        `${this.base}/staff/workers/manage/${workerId}/schedule-rules/`,
        payload
      ),
      'createRule'
    );
  }

  updateRule(workerId: number, id: number, payload: Partial<WorkerScheduleRule>) {
    return this.safe(
      this.http.put<WorkerScheduleRule>(
        `${this.base}/staff/workers/manage/${workerId}/schedule-rules/${id}/`,
        payload
      ),
      'updateRule'
    );
  }

  deleteRule(workerId: number, id: number) {
    return this.safe(
      this.http.delete<void>(
        `${this.base}/staff/workers/manage/${workerId}/schedule-rules/${id}/`
      ),
      'deleteRule'
    );
  }

  // Breaks
  listBreaks(workerId: number) {
    return this.safe(
      this.http.get<WorkerBreak[]>(
        `${this.base}/staff/workers/manage/${workerId}/breaks/`
      ),
      'listBreaks'
    );
  }

  createBreak(workerId: number, payload: Partial<WorkerBreak>) {
    return this.safe(
      this.http.post<WorkerBreak>(
        `${this.base}/staff/workers/manage/${workerId}/breaks/`,
        payload
      ),
      'createBreak'
    );
  }

  updateBreak(workerId: number, id: number, payload: Partial<WorkerBreak>) {
    return this.safe(
      this.http.put<WorkerBreak>(
        `${this.base}/staff/workers/manage/${workerId}/breaks/${id}/`,
        payload
      ),
      'updateBreak'
    );
  }

  deleteBreak(workerId: number, id: number) {
    return this.safe(
      this.http.delete<void>(
        `${this.base}/staff/workers/manage/${workerId}/breaks/${id}/`
      ),
      'deleteBreak'
    );
  }

  // Exceptions
  listExceptions(workerId: number) {
    return this.safe(
      this.http.get<WorkerException[]>(
        `${this.base}/staff/workers/manage/${workerId}/exceptions/`
      ),
      'listExceptions'
    );
  }

  createException(workerId: number, payload: Partial<WorkerException>) {
    return this.safe(
      this.http.post<WorkerException>(
        `${this.base}/staff/workers/manage/${workerId}/exceptions/`,
        payload
      ),
      'createException'
    );
  }

  updateException(workerId: number, id: number, payload: Partial<WorkerException>) {
    return this.safe(
      this.http.put<WorkerException>(
        `${this.base}/staff/workers/manage/${workerId}/exceptions/${id}/`,
        payload
      ),
      'updateException'
    );
  }

  deleteException(workerId: number, id: number) {
    return this.safe(
      this.http.delete<void>(
        `${this.base}/staff/workers/manage/${workerId}/exceptions/${id}/`
      ),
      'deleteException'
    );
  }
}
