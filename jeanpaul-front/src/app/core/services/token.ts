import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TokenService {
  private ACCESS_KEY = 'jp_access';
  private REFRESH_KEY = 'jp_refresh';

  setTokens(access: string, refresh?: string) {
    localStorage.setItem(this.ACCESS_KEY, access);
    if (refresh) localStorage.setItem(this.REFRESH_KEY, refresh);
  }

  getAccess(): string | null {
    return localStorage.getItem(this.ACCESS_KEY);
  }

  clear() {
    localStorage.removeItem(this.ACCESS_KEY);
    localStorage.removeItem(this.REFRESH_KEY);
  }

  isLoggedIn(): boolean {
    return !!this.getAccess();
  }
}
