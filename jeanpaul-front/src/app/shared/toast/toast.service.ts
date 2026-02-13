import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  ttlMs?: number;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private _toasts = new BehaviorSubject<ToastMessage[]>([]);
  toasts$ = this._toasts.asObservable();

  show(toast: Omit<ToastMessage, 'id'>) {
    const id = crypto?.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
    const ttl = toast.ttlMs ?? 3500;

    const next = [...this._toasts.value, { ...toast, id, ttlMs: ttl }];
    this._toasts.next(next);

    setTimeout(() => this.dismiss(id), ttl);
  }

  success(message: string, title = 'Listo') {
    this.show({ type: 'success', title, message });
  }

  error(message: string, title = 'Error') {
    this.show({ type: 'error', title, message, ttlMs: 5000 });
  }

  info(message: string, title = 'Info') {
    this.show({ type: 'info', title, message });
  }

  dismiss(id: string) {
    this._toasts.next(this._toasts.value.filter(t => t.id !== id));
  }

  clear() {
    this._toasts.next([]);
  }
}
