import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { AuthService } from '../services/auth';

function normalizeBase(url: string): string {
  return (url || '').toString().trim().replace(/\/+$/, '');
}

function isApiUrl(reqUrl: string, apiBase: string): boolean {
  // Absoluta: http://127.0.0.1:8000/...
  if (reqUrl.startsWith(apiBase)) return true;

  // Relativa: /api/...
  if (reqUrl.startsWith('/api/')) return true;

  // Relativa sin slash: api/...
  if (reqUrl.startsWith('api/')) return true;

  return false;
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);

  const apiBase = normalizeBase(
    ((environment as any).API_URI ?? 'http://127.0.0.1:8000') as string
  );

  if (!isApiUrl(req.url, apiBase)) return next(req);

  // No metas Authorization en login/refresh/logout para evitar loops raros
  if (
    req.url.includes('/api/auth/login/') ||
    req.url.includes('/api/auth/refresh/') ||
    req.url.includes('/api/auth/logout/')
  ) {
    return next(req);
  }

  const token = auth.getAccessToken();
  if (!token) return next(req);

  return next(
    req.clone({
      setHeaders: { Authorization: `Bearer ${token}` },
    })
  );
};
