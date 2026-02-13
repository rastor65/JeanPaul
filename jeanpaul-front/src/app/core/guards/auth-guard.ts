import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { AuthService } from '../services/auth';
import { from, Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export const authGuard: CanActivateFn = (): Observable<boolean | UrlTree> => {
  const platformId = inject(PLATFORM_ID);
  const router = inject(Router);

  if (!isPlatformBrowser(platformId)) {
    return of(router.parseUrl('/login'));
  }

  const auth = inject(AuthService);

  if (!auth.isAuthenticated()) {
    return of(router.parseUrl('/login'));
  }

  // asegura user/role (si falla, no bloquea si hay token)
  return from(auth.ensureMe()).pipe(
    map(() => true),
    catchError(() => of(true))
  );
};
