import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { AuthService } from '../services/auth'; // ajusta el path si aplica

export const jwtInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);

  const base = environment.API_URI.replace(/\/+$/, '');
  const isApiCall = req.url.startsWith(base);

  if (!isApiCall) return next(req);

  const token = (auth.getAccessToken?.() || auth.accessToken || '').trim();
  if (!token) return next(req);

  return next(
    req.clone({
      setHeaders: { Authorization: `Bearer ${token}` },
    })
  );
};
