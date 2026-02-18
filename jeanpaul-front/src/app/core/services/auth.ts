import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, concat, firstValueFrom, of, throwError } from 'rxjs';
import { catchError, first, map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { Feature, canAccessFeature, roleFromUser, Role } from '../auth/rbac';

export type AuthUser = {
  id: number;
  username: string;
  email: string;
  phone?: string | null;
  is_staff: boolean;
  is_superuser: boolean;
};

type LoginResponse = {
  user: AuthUser;
  access: string;
  refresh: string;
};

type RefreshResponse = {
  access?: string;
  token?: string;
};

type StoreKind = 'local' | 'session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);

  // tokens en memoria
  accessToken = '';
  refreshToken = '';

  // usuario en memoria + stream
  private userSubject = new BehaviorSubject<AuthUser | null>(null);
  user$ = this.userSubject.asObservable();

  // en vez de Storage = localStorage (rompe SSR)
  private storeKind: StoreKind = 'local';

  private readonly STORE_KEY = 'jp_auth_v1';
  private readonly LOGIN_PATH = '/api/auth/login/';
  private readonly ME_PATH = '/api/auth/me/';

  private readonly REFRESH_CANDIDATES = [
    '/api/auth/refresh/',
    '/api/token/refresh/',
    '/api/auth/token/refresh/',
    '/api/auth/jwt/refresh/',
  ];

  constructor() {
    // SSR-safe
    this.restoreSession();
  }

  private get isBrowser(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  // -----------------------
  // API base
  // -----------------------
  private api(path: string): string {
    const base = ((environment as any).API_URI).toString().trim().replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }

  // -----------------------
  // Storage (SSR-safe)
  // -----------------------
  private getStorage(kind: StoreKind): Storage | null {
    if (!this.isBrowser) return null;
    try {
      // usar window.* para evitar ReferenceError en SSR
      return kind === 'local' ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  }

  private readFrom(kind: StoreKind): any | null {
    const st = this.getStorage(kind);
    if (!st) return null;
    try {
      const raw = st.getItem(this.STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private writeTo(kind: StoreKind, payload: any): void {
    const st = this.getStorage(kind);
    if (!st) return;
    try {
      st.setItem(this.STORE_KEY, JSON.stringify(payload));
    } catch {}
  }

  private removeFrom(kind: StoreKind): void {
    const st = this.getStorage(kind);
    if (!st) return;
    try {
      st.removeItem(this.STORE_KEY);
    } catch {}
  }

  // -----------------------
  // Sesión
  // -----------------------
  private persistSession(rememberMe: boolean) {
    // decide dónde guardar
    this.storeKind = rememberMe ? 'local' : 'session';

    const payload = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      user: this.userSubject.value,
      rememberMe,
    };

    // limpia ambos y guarda en el que toca
    this.removeFrom('local');
    this.removeFrom('session');
    this.writeTo(this.storeKind, payload);
  }

  private restoreSession() {
    // en SSR no hay storage: no hace nada, pero no revienta
    const local = this.readFrom('local');
    const session = this.readFrom('session');

    const data = local || session;
    if (!data) return;

    if (data?.accessToken) this.accessToken = String(data.accessToken);
    if (data?.refreshToken) this.refreshToken = String(data.refreshToken);
    if (data?.user) this.userSubject.next(data.user as AuthUser);

    const rememberMe = !!data?.rememberMe;
    this.storeKind = rememberMe ? 'local' : 'session';
  }

  clearSessionLocal() {
    this.accessToken = '';
    this.refreshToken = '';
    this.userSubject.next(null);

    this.removeFrom('local');
    this.removeFrom('session');
  }

  // Alias útil
  getAccessToken(): string {
    return this.accessToken || '';
  }

  get user(): AuthUser | null {
    return this.userSubject.value;
  }

  get role(): Role {
    return roleFromUser(this.user);
  }

  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  // RBAC
  can(feature: Feature): boolean {
    return canAccessFeature(this.user, feature);
  }

  // -----------------------
  // Login / Me
  // -----------------------
  async login(username: string, password: string, opts?: { rememberMe?: boolean }): Promise<AuthUser> {
    const rememberMe = opts?.rememberMe !== false; // por defecto true

    const resp = await firstValueFrom(
      this.http.post<LoginResponse>(
        this.api(this.LOGIN_PATH),
        { username, password },
        { withCredentials: true }
      )
    );

    this.accessToken = resp?.access ? String(resp.access) : '';
    this.refreshToken = resp?.refresh ? String(resp.refresh) : '';

    const u = resp?.user ?? null;
    this.userSubject.next(u);

    this.persistSession(rememberMe);

    return u as AuthUser;
  }

  async ensureMe(): Promise<AuthUser | null> {
    if (!this.accessToken) return null;

    try {
      const me = await firstValueFrom(
        this.http.get<AuthUser>(this.api(this.ME_PATH), {
          withCredentials: true,
          headers: { Authorization: `Bearer ${this.accessToken}` },
        })
      );

      this.userSubject.next(me);

      // no cambia rememberMe, usa lo que ya estaba
      const rememberMe = this.storeKind === 'local';
      this.persistSession(rememberMe);

      return me;
    } catch {
      return this.userSubject.value;
    }
  }

  logout() {
    this.clearSessionLocal();
  }

  // -----------------------
  // Refresh (Observable) para interceptor/coordinator
  // -----------------------
  refresh(): Observable<boolean> {
    const rt = (this.refreshToken || '').trim();
    if (!rt) return of(false);

    const calls = this.REFRESH_CANDIDATES.map((p) =>
      this.http
        .post<RefreshResponse>(this.api(p), { refresh: rt }, { withCredentials: true })
        .pipe(
          map((res) => {
            const token = (res?.access || res?.token || '').toString().trim();
            return token || '';
          }),
          catchError((err) => {
            if (err?.status === 404) return of('');
            return throwError(() => err);
          })
        )
    );

    return concat(...calls).pipe(
      first((token) => !!token, ''),
      map((token) => {
        if (!token) return false;

        this.accessToken = token;

        const rememberMe = this.storeKind === 'local';
        this.persistSession(rememberMe);

        return true;
      }),
      catchError(() => of(false))
    );
  }
}
