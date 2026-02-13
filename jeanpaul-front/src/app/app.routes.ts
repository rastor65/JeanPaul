import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth-guard';
import { featureGuard } from './core/auth/feature.guards';
import { features } from 'process';

export const routes: Routes = [
  // Público: landing en /
  {
    path: '',
    loadComponent: () =>
      import('./layout/public-shell/public-shell')
        .then(m => m.PublicShellComponent),
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./pages/landing/landing')
            .then(m => m.LandingComponent)
      }
    ]
  },

  // Login público
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login')
        .then(m => m.Login)
  },

  // Privado
  {
    path: 'app',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./layout/app-shell/app-shell')
        .then(m => m.AppShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'home' },

      {
        path: 'home',
        loadComponent: () =>
          import('./pages/home/home')
            .then(m => m.Home),
        canMatch: [featureGuard],
        data: { feature: 'home'}
      },

      // ✅ Agenda trabajador (ya la tienes)
      {
        path: 'agenda',
        loadComponent: () =>
          import('./pages/agenda/agenda')
            .then(m => m.AgendaComponent),
        canMatch: [featureGuard],
        data: { feature: 'agenda'}
      },

      // ✅ Turnos (Recepción/Staff)
      {
        path: 'turnos',
        loadComponent: () =>
          import('./pages/turnos/turnos')
            .then(m => m.TurnosComponent),
        canMatch: [featureGuard],
        data: { feature: 'turnos'}
      },
      {
        path: 'catalogo',
        loadComponent: () =>
          import('./pages/catalogo/catalogo')
            .then(m => m.CatalogoComponent),
        canMatch: [featureGuard],
        data: { feature: 'catalogo'}
      },
      {
        path: 'usuarios',
        loadComponent: () =>
          import('./pages/usuarios/usuarios')
            .then(m => m.UsuariosComponent),
        canMatch: [featureGuard],
        data: { feature: 'usuarios'}
      },
      {
        path: 'horarios',
        loadComponent: () =>
          import('./pages/horarios/horarios')
            .then(m => m.HorariosComponent),
        canMatch: [featureGuard],
        data: { feature: 'horarios'}
      },
      {
        path: 'contabilidad',
        loadComponent: () =>
          import('./pages/contabilidad/contabilidad')
            .then(m => m.ContabilidadComponent),
        canMatch: [featureGuard],
        data: { feature: 'contabilidad'}
      },
    ]
  },

  { path: '**', redirectTo: '' }
];
