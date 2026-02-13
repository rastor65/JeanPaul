import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, NavigationEnd } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth';
import { SettingsModalComponent } from '../../shared/settings-modal/settings-modal';

type FeatureKey = 'home' | 'agenda' | 'catalogo' | 'turnos' | 'usuarios' | 'horarios' | 'contabilidad';
type RoleKind = 'WORKER' | 'STAFF' | 'SUPERUSER';

type NavItem = {
  label: string;
  link: string;
  exact?: boolean;
  icon: string;
  feature: FeatureKey;
};

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterModule, SettingsModalComponent],
  templateUrl: './header.html',
  styleUrl: './header.scss',
})
export class Header implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private router = inject(Router);

  displayName = 'Usuario';
  roleLabel = 'Panel';

  // Drawer móvil
  menuOpen = false;

  // Submenú usuario
  userMenuOpen = false;

  // Modal Ajustes
  settingsOpen = false;

  private subs = new Subscription();
  private currentUser: any = null;

  // -----------------------
  // NAV (base + visible)
  // -----------------------
  private readonly NAV_ALL: NavItem[] = [
    { label: 'Inicio', link: '/app/home', exact: true, icon: 'home', feature: 'home' },
    { label: 'Agenda', link: '/app/agenda', icon: 'calendar', feature: 'agenda' },
    { label: 'Catálogo', link: '/app/catalogo', icon: 'catalogo', feature: 'catalogo' },
    { label: 'Turnos', link: '/app/turnos', icon: 'pin', feature: 'turnos' },
    { label: 'Usuarios', link: '/app/usuarios', icon: 'users', feature: 'usuarios' },
    { label: 'Horarios', link: '/app/horarios', icon: 'horarios', feature: 'horarios' },
    { label: 'Contabilidad', link: '/app/contabilidad', icon: 'contabilidad', feature: 'contabilidad' },
  ];

  nav: NavItem[] = []; // este es el menú ya filtrado

  // Permisos por feature (según lo que definiste)
  private readonly FEATURE_ACCESS: Record<FeatureKey, RoleKind[]> = {
    home: ['WORKER', 'STAFF', 'SUPERUSER'],
    agenda: ['WORKER'], // solo trabajadores
    catalogo: ['STAFF', 'SUPERUSER'],
    turnos: ['STAFF', 'SUPERUSER'],
    usuarios: ['SUPERUSER'],
    horarios: ['STAFF', 'SUPERUSER'],
    contabilidad: ['SUPERUSER'],
  };

  // -----------------------
  // Handlers globales
  // -----------------------
  private escHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;

    // prioridad: cerrar modal, luego menús
    if (this.settingsOpen) {
      this.closeSettings();
      return;
    }
    if (this.userMenuOpen) {
      this.closeUserMenu();
      return;
    }
    if (this.menuOpen) this.closeMenu();
  };

  private docClickHandler = () => {
    // click fuera cierra submenú (no el drawer)
    if (this.userMenuOpen) this.closeUserMenu();
  };

  ngOnInit(): void {
    // cerrar drawer al navegar
    this.subs.add(
      this.router.events
        .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
        .subscribe(() => {
          this.closeMenu();
          this.closeUserMenu();
        })
    );

    // Inicializa menú sin usuario (por si tarda el me)
    this.rebuildNav(null);

    // user: soporta me$ / user$ / currentUser$ + fallback a ensureMe()
    const anyAuth: any = this.auth as any;
    const obs = anyAuth.me$ || anyAuth.user$ || anyAuth.currentUser$ || anyAuth.currentUserObs$;

    if (obs?.subscribe) {
      this.subs.add(obs.subscribe((u: any) => this.applyUser(u)));
    } else {
      const direct = anyAuth.me || anyAuth.user || anyAuth.currentUser;
      if (direct) this.applyUser(direct);

      const fn = anyAuth.ensureMe || anyAuth.fetchMe || anyAuth.getMe;
      if (typeof fn === 'function') {
        try {
          const res = fn.call(anyAuth);
          if (res?.subscribe) this.subs.add(res.subscribe((u: any) => this.applyUser(u)));
          else if (res?.then) res.then((u: any) => this.applyUser(u)).catch(() => {});
        } catch {}
      }
    }

    // listeners globales
    window.addEventListener('keydown', this.escHandler, { passive: true });
    document.addEventListener('click', this.docClickHandler, { passive: true });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    window.removeEventListener('keydown', this.escHandler);
    document.removeEventListener('click', this.docClickHandler);
    this.syncBodyLock(false); // liberar si algo quedó abierto
  }

  // ---------------- Drawer móvil ----------------
  toggleMenu() {
    this.menuOpen ? this.closeMenu() : this.openMenu();
  }

  openMenu() {
    this.menuOpen = true;
    this.syncBodyLock(true);
  }

  closeMenu() {
    this.menuOpen = false;
    this.syncBodyLock();
  }

  // ---------------- Submenú usuario ----------------
  toggleUserMenu(ev: MouseEvent) {
    ev.stopPropagation();
    this.userMenuOpen ? this.closeUserMenu() : this.openUserMenu();
  }

  openUserMenu() {
    this.userMenuOpen = true;
  }

  closeUserMenu() {
    this.userMenuOpen = false;
  }

  // ---------------- Ajustes modal ----------------
  openSettings() {
    this.closeUserMenu();
    this.settingsOpen = true;
    this.syncBodyLock(true);
  }

  closeSettings() {
    this.settingsOpen = false;
    this.syncBodyLock();
  }

  onSettingsSaved(_settings: any) {}

  private syncBodyLock(forceLock?: boolean) {
    const shouldLock = forceLock === true ? true : (this.menuOpen || this.settingsOpen);
    try {
      if (shouldLock) document.body.classList.add('jp-lock');
      else document.body.classList.remove('jp-lock');
    } catch {}
  }

  // ---------------- RBAC / NAV ----------------
  private roleKind(u: any): RoleKind {
    const su = !!(u?.is_superuser ?? u?.user?.is_superuser);
    if (su) return 'SUPERUSER';

    const st = !!(u?.is_staff ?? u?.user?.is_staff);
    if (st) return 'STAFF';

    return 'WORKER';
  }

  private canAccess(feature: FeatureKey, u: any): boolean {
    const kind = this.roleKind(u);
    const allowed = this.FEATURE_ACCESS[feature] || [];
    return allowed.includes(kind);
  }

  private rebuildNav(u: any) {
    this.nav = this.NAV_ALL.filter((it) => this.canAccess(it.feature, u));
  }

  // ---------------- icons ----------------
  iconPath(key: string): string {
    switch (key) {
      case 'home':
        return 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10.5z';
      case 'calendar':
        return 'M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zm14 8H3v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V10z';
      case 'pin':
        return 'M12 22s7-4.4 7-12a7 7 0 1 0-14 0c0 7.6 7 12 7 12zm0-9.2a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6z';
      case 'users':
        return 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM2 22a6 6 0 0 1 12 0H2zm13.5 0a5.5 5.5 0 0 1 10.5 0H15.5z';
      case 'gear':
        return 'M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5zm9.4 3.1-.9-.5.1-1.1-1.7-2.9-1.1.3-.8-.7-.3-1.1H8.3L8 5.6l-.8.7-1.1-.3-1.7 2.9.1 1.1-.9.5v3.8l.9.5-.1 1.1 1.7 2.9 1.1-.3.8.7.3 1.1h7.4l.3-1.1.8-.7 1.1.3 1.7-2.9-.1-1.1.9-.5v-3.8z';
      case 'catalogo':
        return 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z';
      case 'horarios':
        return 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 11h5v-2h-4V6h-2v7z';
      case 'contabilidad':
        return 'M4 20h16v2H2V4h2v16zm4-2H6v-7h2v7zm5 0h-2V8h2v10zm5 0h-2v-5h2v5z';
      default:
        return '';
    }
  }

  // ---------------- user ----------------
  private applyUser(u: any) {
    if (!u) return;

    this.currentUser = u;

    const full =
      (typeof u.get_full_name === 'function' ? u.get_full_name() : '') ||
      u.full_name ||
      u.fullName ||
      u.name ||
      '';

    const username = u.username || u.user?.username || '';
    this.displayName = (full || username || 'Usuario').toString();

    // etiqueta de rol
    const kind = this.roleKind(u);
    if (kind === 'SUPERUSER') this.roleLabel = 'Superadmin';
    else if (kind === 'STAFF') this.roleLabel = 'Staff';
    else {
      // trabajador: intenta mostrar tipo (barbero/uñas/facial) si existe
      const role =
        u.role ||
        u.user_role ||
        u.worker_role ||
        u.worker?.role ||
        u.profile?.role ||
        '';
      this.roleLabel = this.formatWorkerRole(role) || 'Trabajador';
    }

    // reconstruye menú según permisos
    this.rebuildNav(u);
  }

  private formatWorkerRole(role: string): string {
    const r = (role || '').toUpperCase().trim();
    if (!r) return '';
    if (r === 'BARBER') return 'Trabajador • Barbero';
    if (r === 'NAILS') return 'Trabajador • Uñas';
    if (r === 'FACIAL') return 'Trabajador • Facial';
    return `Trabajador • ${role}`;
  }

  logout() {
    const anyAuth: any = this.auth as any;

    this.closeUserMenu();
    this.closeMenu();
    this.closeSettings();

    try {
      const res = anyAuth.logout?.();
      if (res?.subscribe) {
        this.subs.add(
          res.subscribe({
            next: () => this.finishLogout(),
            error: () => this.finishLogout(),
          })
        );
        return;
      }
    } catch {}

    this.finishLogout();
  }

  private finishLogout() {
    try {
      localStorage.removeItem('access');
      localStorage.removeItem('refresh');
      localStorage.removeItem('token');
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
    } catch {}

    this.currentUser = null;
    this.rebuildNav(null);

    this.router.navigateByUrl('/');
  }
}
