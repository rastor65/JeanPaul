import { Injectable, inject } from '@angular/core';
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

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);

  // tokens en memoria (tu código ya tenía accessToken declarado)
  accessToken = '';
  refreshToken = '';

  // usuario en memoria + stream
  private userSubject = new BehaviorSubject<AuthUser | null>(null);
  user$ = this.userSubject.asObservable();

  // storage elegido (local o session)
  private storage: Storage = localStorage;

  private readonly STORE_KEY = 'jp_auth_v1';

  private readonly LOGIN_PATH = '/api/auth/login/';
  private readonly ME_PATH = '/api/auth/me/';

  // candidatos refresh (por si tu backend usa SimpleJWT o ruta custom)
  private readonly REFRESH_CANDIDATES = [
    '/api/auth/refresh/',
    '/api/token/refresh/',
    '/api/auth/token/refresh/',
    '/api/auth/jwt/refresh/',
  ];

  constructor() {
    this.restoreSession();
  }

  // -----------------------
  // API base
  // -----------------------
  private api(path: string): string {
    const base = ((environment as any).API_URI)
      .toString()
      .trim()
      .replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }

  // -----------------------
  // Sesión
  // -----------------------
  private persistSession(rememberMe: boolean) {
    this.storage = rememberMe ? localStorage : sessionStorage;

    const payload = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      user: this.userSubject.value,
      rememberMe,
    };

    try {
      localStorage.removeItem(this.STORE_KEY);
      sessionStorage.removeItem(this.STORE_KEY);
      this.storage.setItem(this.STORE_KEY, JSON.stringify(payload));
    } catch { }
  }

  private restoreSession() {
    const read = (st: Storage) => {
      try {
        const raw = st.getItem(this.STORE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    };

    const local = read(localStorage);
    const session = read(sessionStorage);

    const data = local || session;

    if (data?.accessToken) this.accessToken = String(data.accessToken);
    if (data?.refreshToken) this.refreshToken = String(data.refreshToken);
    if (data?.user) this.userSubject.next(data.user as AuthUser);

    const rememberMe = !!data?.rememberMe;
    this.storage = rememberMe ? localStorage : sessionStorage;
  }

  clearSessionLocal() {
    this.accessToken = '';
    this.refreshToken = '';
    this.userSubject.next(null);

    try {
      localStorage.removeItem(this.STORE_KEY);
      sessionStorage.removeItem(this.STORE_KEY);
    } catch { }
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
      this.http.post<LoginResponse>(this.api(this.LOGIN_PATH), { username, password }, {withCredentials: true})
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
        this.http.get<AuthUser>(this.api(this.ME_PATH), { withCredentials: true })
      );

      this.userSubject.next(me);
      // preserva tokens/rememberMe que ya estaban
      const rememberMe = this.storage === localStorage;
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
      this.http.post<RefreshResponse>(this.api(p), { refresh: rt }).pipe(
        map((res) => {
          const token = (res?.access || res?.token || '').toString().trim();
          return token || '';
        }),
        catchError((err) => {
          // si la ruta no existe, probamos la siguiente
          if (err?.status === 404) return of('');
          return throwError(() => err);
        })
      )
    );

    // concat prueba en orden; first toma el primer token no vacío
    return concat(...calls).pipe(
      first((token) => !!token, ''),
      map((token) => {
        if (!token) return false;

        this.accessToken = token;

        // persistir sin cambiar rememberMe
        const rememberMe = this.storage === localStorage;
        this.persistSession(rememberMe);

        return true;
      }),
      catchError(() => of(false))
    );
  }
}
