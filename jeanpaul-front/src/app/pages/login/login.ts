import { Component, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  identifier = '';
  password = '';
  loading = false;
  errorMsg = '';
  year = new Date().getFullYear();
  showPassword = false;

  capsLockOn = false;
  helpOpen = false;
  rememberMe = true;

  // Opcional: estado API
  showApiStatus = false;
  apiOk = true;

  constructor(
    private auth: AuthService,
    private router: Router,
    private zone: NgZone,
    private cdr: ChangeDetectorRef
  ) {}

  async onSubmit() {
    this.errorMsg = '';

    const username = this.identifier.trim();
    const password = this.password.trim();

    if (!username || !password) {
      this.errorMsg = 'Por favor completa usuario y contraseña.';
      return;
    }

    // Activa loading y fuerza render inmediato
    this.loading = true;
    this.cdr.detectChanges();

    try {
      // Si tu AuthService soporta rememberMe, puedes pasarlo aquí:
      // await this.auth.login(username, password, { rememberMe: this.rememberMe });
      await this.auth.login(username, password);

      // (Opcional pero útil) asegura que el usuario quede cargado en memoria
      // si tu login solo guarda tokens y no setea user.
      await this.auth.ensureMe?.();

      this.zone.run(() => {
        this.router.navigateByUrl('/app');
      });
    } catch (e: any) {
      this.zone.run(() => {
        const detail =
          e?.error?.detail ||
          e?.error?.message ||
          e?.message ||
          'No fue posible iniciar sesión. Verifica tus credenciales.';
        this.errorMsg = detail;
        this.cdr.markForCheck();
      });
    } finally {
      // Asegura que el cambio se refleje aunque el servicio use fetch/promises
      this.zone.run(() => {
        this.loading = false;
        this.cdr.markForCheck();
      });
    }
  }

  openHelp() {
    this.helpOpen = true;
  }

  closeHelp() {
    this.helpOpen = false;
  }

  onCapsCheck(ev: KeyboardEvent) {
    const state = (ev as any).getModifierState?.('CapsLock');
    this.capsLockOn = !!state;
  }

  togglePassword() {
    this.showPassword = !this.showPassword;
  }
}
