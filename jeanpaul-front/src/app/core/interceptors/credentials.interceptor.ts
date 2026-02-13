import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../../../environments/environment';

export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  const base = (environment as any).API_URI?.toString()?.replace(/\/+$/, '') ?? '';
  const isApiCall = base ? req.url.startsWith(base) : req.url.includes('/api/');

  const cloned = req.clone({
    withCredentials: isApiCall ? true : req.withCredentials,
    setHeaders: {
      Accept: req.headers.get('Accept') ?? 'application/json',
    },
  });

  return next(cloned);
};
