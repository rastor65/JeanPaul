import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { catchError, map, of } from 'rxjs';
import { environment } from '../../../environments/environment';

type MeDTO = {
  id?: number;
  username?: string;
  is_staff?: boolean;
  is_superuser?: boolean;
};

export const superuserGuard: CanMatchFn = () => {
  const http = inject(HttpClient);
  const router = inject(Router);

  const base = ((environment as any).API_URI)
    .toString()
    .trim()
    .replace(/\/+$/, '');

  const url = `${base}/api/auth/me/`;

  return http.get<MeDTO>(url, { withCredentials: true }).pipe(
    map((me) => {
      const ok = !!me?.is_superuser;

      if (!ok) {
        router.navigateByUrl('/dashboard'); // o '/unauthorized' si tienes esa ruta
      }

      return ok;
    }),
    catchError(() => {
      router.navigateByUrl('/login');
      return of(false);
    })
  );
};
