import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, finalize, map, shareReplay, timeout } from 'rxjs/operators';
import { AuthService } from './auth';

@Injectable({ providedIn: 'root' })
export class AuthRefreshCoordinator {
  private auth = inject(AuthService);

  // Una sola petición de refresh en vuelo (shared)
  private refreshInFlight$?: Observable<string>;

  // Ajusta si quieres
  private readonly TIMEOUT_MS = 12000;

  refreshToken(): Observable<string> {
    if (!this.refreshInFlight$) {
      this.refreshInFlight$ = this.auth.refresh().pipe(
        timeout(this.TIMEOUT_MS),
        map((ok) => {
          const token = ok ? this.auth.getAccessToken() : '';
          if (!token) throw new Error('refresh_failed');
          return token;
        }),
        shareReplay(1),
        finalize(() => {
          this.refreshInFlight$ = undefined;
        }),
        catchError((err) => {
          // Limpia sesión local cuando el refresh falla
          this.auth.clearSessionLocal();
          return throwError(() => err);
        })
      );
    }

    return this.refreshInFlight$;
  }
}
