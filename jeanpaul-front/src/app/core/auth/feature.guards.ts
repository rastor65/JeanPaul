import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { Feature } from '../auth/rbac';

export const featureGuard: CanActivateFn = async (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // Si tu login route es otra, cámbiala aquí
  const LOGIN_URL = '/login';
  const FALLBACK_URL = '/app/home';

  // feature viene desde route.data.feature
  const feature = route.data?.['feature'] as Feature | undefined;

  // Carga user si hay tokens
  await auth.ensureMe();

  if (!auth.isAuthenticated) {
    return router.parseUrl(LOGIN_URL);
  }

  // Si la ruta no define feature, se deja pasar
  if (!feature) return true;

  // Permiso OK
  if (auth.can(feature)) return true;

  // Sin permiso -> a inicio (o donde prefieras)
  return router.parseUrl(FALLBACK_URL);
};
