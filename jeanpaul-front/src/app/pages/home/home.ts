import { Component, OnDestroy, OnInit, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';

import { AuthService } from '../../core/services/auth';
import { DashboardService, DashboardVM, AgendaItem } from '../../core/services/dashboard.service';

import { Subject, timer, of } from 'rxjs';
import { takeUntil, take, timeout, catchError, finalize } from 'rxjs/operators';

type RoleLabel = 'Administrador' | 'Barbero' | 'Uñas' | 'Facial' | 'Panel';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private router = inject(Router);
  private dashboard = inject(DashboardService);

  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  displayName = 'Usuario';
  roleLabel: RoleLabel = 'Panel';

  greeting = 'Bienvenido';
  todayLabel = '';
  clockLabel = '';
  year = new Date().getFullYear();

  // Solo debe bloquear cuando NO hay vm todavía (carga inicial)
  loading = true;
  error = '';
  vm: DashboardVM | null = null;

  private destroy$ = new Subject<void>();
  private clockTimer: any;

  // Evita condiciones de carrera (requests viejos pisando estado nuevo)
  private loadSeq = 0;

  private cd() {
    try { this.cdr.detectChanges(); } catch { }
  }

  ngOnInit(): void {
    this.refreshTime();
    this.clockTimer = setInterval(() => {
      this.zone.run(() => {
        this.refreshTime();
        this.cd();
      });
    }, 30_000);

    this.syncUser();
    this.load(true);

    // Refresco cada 60s (no tapa la vista si ya hay datos)
    timer(60_000, 60_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.load(false));
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.clockTimer) clearInterval(this.clockTimer);
  }

  go(path: string) {
    this.router.navigateByUrl(path);
  }

  retry() {
    this.load(true);
  }

  // =========================
  // FIX real: NO quedarse cargando
  // =========================

  private load(showSpinner = true) {
    const seq = ++this.loadSeq;

    if (showSpinner && !this.vm) {
      this.loading = true;
      this.cd();
    }

    this.error = '';
    this.cd();

    const hardStop = setTimeout(() => {
      if (seq !== this.loadSeq) return;

      this.zone.run(() => {
        if (this.vm) {
          this.loading = false;
        } else {
          this.error = this.error || 'No se recibió respuesta del dashboard.';
          this.vm = this.emptyVM();
          this.loading = false;
        }
        this.cd();
      });
    }, 9_500);

    this.dashboard
      .loadToday()
      .pipe(
        take(1),
        timeout({ first: 8000 }),
        catchError((err) => {
          if (seq !== this.loadSeq) return of(this.emptyVM());
          this.zone.run(() => {
            this.error = this.humanError(err);
            this.cd();
          });
          return of(this.emptyVM());
        }),
        takeUntil(this.destroy$),
        finalize(() => {
          clearTimeout(hardStop);
          if (seq === this.loadSeq) {
            this.zone.run(() => {
              this.loading = false;
              this.cd();
            });
          }
        })
      )
      .subscribe((vm) => {
        if (seq !== this.loadSeq) return;

        this.zone.run(() => {
          const safe = vm || this.emptyVM();
          this.vm = { ...safe, updatedAt: new Date() };
          this.loading = false;
          this.cd();
        });
      });
  }

  private emptyVM(): DashboardVM {
    return {
      kpi: {
        todayAppointments: 0,
        reserved: 0,
        inProgress: 0,
        attended: 0,
        revenueToday: 0,
        nextTime: '—',
        nextLabel: '—',
      },
      agendaToday: [],
      updatedAt: new Date(),
    };
  }

  private humanError(err: any): string {
    // Angular suele mandar HttpErrorResponse con .status y .error
    const status = err?.status;
    const msg = (err?.message || '').toString();
    const body = err?.error;

    // Cuando por redirección te llega HTML en vez de JSON
    if (typeof body === 'string' && body.includes('<')) {
      return 'El backend respondió HTML (redirección 302 o URL incorrecta). Revisa que estés pegándole a /api/... y que haya token/cookie válido.';
    }
    if (msg.includes('Unexpected token') || msg.includes('<')) {
      return 'Respuesta no-JSON (posible redirección/login). Revisa endpoints /api y autenticación.';
    }
    if (err?.name === 'TimeoutError') {
      return 'El dashboard tardó demasiado en responder.';
    }
    if (status === 0) {
      return 'No hay conexión con el backend (CORS, URL/puerto incorrecto o backend apagado).';
    }
    if (status === 401 || status === 403) {
      return 'No autorizado. Falta token/cookie para consultar el dashboard.';
    }
    return 'No se pudo cargar el dashboard. Revisa sesión/endpoints.';
  }

  // =========================
  // Helpers UI
  // =========================
  money(v: number | undefined): string {
    const n = Number(v || 0);
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0,
    }).format(n);
  }

  statusClass(s: AgendaItem['status']): string {
    if (s === 'Reservado') return 'st--reserved';
    if (s === 'En curso') return 'st--progress';
    if (s === 'Atendido') return 'st--done';
    if (s === 'Cancelado') return 'st--cancel';
    if (s === 'No show') return 'st--noshow';
    return 'st--pay';
  }

  trackById(_: number, item: AgendaItem) {
    return item.id ?? item.time + item.title + item.customer;
  }

  // =========================
  // Usuario
  // =========================
  private syncUser() {
    const anyAuth: any = this.auth as any;

    const obs =
      anyAuth.me$ ||
      anyAuth.user$ ||
      anyAuth.currentUser$ ||
      anyAuth.currentUserObs$;

    if (obs?.subscribe) {
      obs.pipe(takeUntil(this.destroy$)).subscribe((u: any) => this.applyUser(u));
      return;
    }

    const direct = anyAuth.me || anyAuth.user || anyAuth.currentUser;
    if (direct) this.applyUser(direct);

    const fn = anyAuth.getMe || anyAuth.fetchMe || anyAuth.ensureMe;
    if (typeof fn === 'function') {
      try {
        const res = fn.call(anyAuth);
        if (res?.subscribe) {
          res.pipe(takeUntil(this.destroy$)).subscribe((u: any) => this.applyUser(u));
        }
      } catch { }
    }
  }

  private applyUser(u: any) {
    if (!u) return;

    const full =
      (typeof u.get_full_name === 'function' ? u.get_full_name() : '') ||
      u.full_name ||
      u.fullName ||
      u.name ||
      '';

    const username = u.username || u.user?.username || '';
    this.displayName = (full || username || 'Usuario').toString();

    const role =
      u.role ||
      u.user_role ||
      u.worker_role ||
      u.worker?.role ||
      u.profile?.role ||
      '';

    this.roleLabel = (this.formatRole(role) as RoleLabel) || 'Panel';
  }

  private formatRole(role: string): string {
    const r = (role || '').toUpperCase();
    if (!r) return 'Panel';
    if (r === 'ADMIN' || r === 'SUPERUSER') return 'Administrador';
    if (r === 'BARBER') return 'Barbero';
    if (r === 'NAILS') return 'Uñas';
    if (r === 'FACIAL') return 'Facial';
    return 'Panel';
  }

  // =========================
  // Reloj
  // =========================
  private refreshTime() {
    const now = new Date();
    const h = now.getHours();

    this.greeting = h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches';

    this.todayLabel = new Intl.DateTimeFormat('es-CO', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
    }).format(now);

    this.clockLabel = new Intl.DateTimeFormat('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(now);
  }
}
