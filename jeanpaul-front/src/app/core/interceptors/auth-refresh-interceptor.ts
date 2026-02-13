import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, switchMap, throwError, timeout } from 'rxjs';
import { AuthRefreshCoordinator } from '../services/auth-refresh-coordinador.service';
import { AuthService } from '../services/auth';

export const authRefreshInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const coordinator = inject(AuthRefreshCoordinator);

  // Evitar reintentos infinitos
  const alreadyTried = req.headers.get('x-refresh-tried') === '1';

  return next(req).pipe(
    catchError((err: unknown) => {
      const e = err as HttpErrorResponse;

      if (e?.status !== 401) return throwError(() => e);
      if (alreadyTried) {
        // si ya intentó refresh y vuelve a 401, limpia y manda a login
        auth.clearSessionLocal();
        router.navigateByUrl('/login');
        return throwError(() => e);
      }

      // No refrescar cuando el 401 viene de login/refresh/logout
      if (
        req.url.includes('/api/auth/login/') ||
        req.url.includes('/api/auth/refresh/') ||
        req.url.includes('/api/auth/logout/')
      ) {
        auth.clearSessionLocal();
        router.navigateByUrl('/login');
        return throwError(() => e);
      }

      // Single-flight refresh + timeout
      return coordinator.refreshToken().pipe(
        timeout(12000),
        switchMap((token) => {
          const retryReq = req.clone({
            setHeaders: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              'x-refresh-tried': '1',
            },
          });
          return next(retryReq);
        }),
        catchError((refreshErr) => {
          // Refresh falló => limpia y manda a login
          auth.clearSessionLocal();
          router.navigateByUrl('/login');
          return throwError(() => e);
        })
      );
    })
  );
};
