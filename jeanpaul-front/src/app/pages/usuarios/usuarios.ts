import { CommonModule, isPlatformBrowser } from '@angular/common';
import { Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';

type Tab = 'STAFF' | 'CUSTOMERS';

type Worker = {
  id: number;
  display_name: string;
  role: 'BARBER' | 'NAILS' | 'FACIAL';
  active: boolean;
  user_id: number | null;
  username?: string | null;
  email?: string | null;
  phone?: string | null;
};

type Customer = {
  id: number;
  customer_type?: string;
  name: string;
  phone?: string | null;
  birth_date?: string | null;
  active?: boolean;
};

type AccountUser = {
  id: number;
  username: string;
  email?: string | null;
  phone?: string | null;
  first_name?: string;
  last_name?: string;
  is_active: boolean;
  is_staff: boolean;
  is_superuser: boolean;
};

type StaffRow = {
  worker: Worker;
  user: AccountUser | null;
  roleLabel: string;
  active: boolean;
  hasAccount: boolean;
  panelAccess: boolean;
  displayContact: string; // username/email
};

@Component({
  selector: 'app-usuarios',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './usuarios.html',
  styleUrl: './usuarios.scss',
})
export class UsuariosComponent {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID);

  tab = signal<Tab>('STAFF');

  loading = signal<boolean>(false);
  error = signal<string>('');
  toast = signal<string>('');

  // búsqueda (server-side + client-side)
  q = signal<string>('');

  // data
  workers = signal<Worker[]>([]);
  customers = signal<Customer[]>([]);
  users = signal<AccountUser[]>([]);

  // filtros (solo UI, muy simples)
  staffRole = signal<'ALL' | Worker['role']>('ALL');
  staffShow = signal<'ALL' | 'ACTIVE' | 'INACTIVE' | 'NO_ACCOUNT'>('ALL');
  staffPanel = signal<'ALL' | 'PANEL' | 'NO_PANEL'>('ALL');

  customerType = signal<'ALL' | 'CASUAL' | 'FREQUENT'>('ALL');
  customerShow = signal<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  // ---- Modal único (Personal / Cliente)
  modalOpen = signal<boolean>(false);
  modalKind = signal<'STAFF' | 'CUSTOMER'>('STAFF');

  // edición
  editingWorkerId = signal<number | null>(null);
  editingUserId = signal<number | null>(null);

  // STAFF form (worker + user)
  w_display_name = signal<string>('');
  w_role = signal<Worker['role']>('BARBER');
  w_active = signal<boolean>(true);

  // modo cuenta: CREAR / VINCULAR (cuando no hay cuenta)
  accountMode = signal<'EXISTING' | 'CREATE' | 'LINK'>('EXISTING');
  linkUserId = signal<number | null>(null);

  u_username = signal<string>('');
  u_password = signal<string>(''); // crear o reset opcional
  u_email = signal<string>('');
  u_phone = signal<string>('');
  u_first = signal<string>('');
  u_last = signal<string>('');
  u_active = signal<boolean>(true);
  u_staff = signal<boolean>(true); // normalmente sí para el panel interno
  u_super = signal<boolean>(false);

  // CUSTOMER form
  c_type = signal<'CASUAL' | 'FREQUENT'>('FREQUENT');
  c_name = signal<string>('');
  c_phone = signal<string>('');
  c_birth = signal<string>(''); // YYYY-MM-DD
  c_active = signal<boolean>(true);

  // -----------------------------
  // labels (ES)
  // -----------------------------
  roleLabel(role: Worker['role']): string {
    const map: Record<Worker['role'], string> = {
      BARBER: 'Barbero',
      NAILS: 'Uñas',
      FACIAL: 'Facial',
    };
    return map[role] ?? role;
  }

  customerTypeLabel(t?: string | null): string {
    if (t === 'CASUAL') return 'Casual';
    if (t === 'FREQUENT') return 'Frecuente';
    return t ?? '—';
  }

  // -----------------------------
  // computed: unificación Personal
  // -----------------------------
  staffRows = computed<StaffRow[]>(() => {
    const usersById = new Map<number, AccountUser>();
    for (const u of this.users()) usersById.set(u.id, u);

    return this.workers().map(w => {
      const u = w.user_id ? usersById.get(w.user_id) ?? null : null;
      const username = u?.username || w.username || '';
      const email = u?.email || w.email || '';
      const displayContact = [username, email].filter(Boolean).join(' • ') || 'Sin cuenta';

      return {
        worker: w,
        user: u,
        roleLabel: this.roleLabel(w.role),
        active: !!w.active,
        hasAccount: !!u,
        panelAccess: !!u?.is_staff,
        displayContact,
      };
    });
  });

  filteredStaff = computed(() => {
    const q = this.q().trim().toLowerCase();
    const role = this.staffRole();
    const show = this.staffShow();
    const panel = this.staffPanel();

    let list = this.staffRows();

    if (role !== 'ALL') list = list.filter(r => r.worker.role === role);

    if (show === 'ACTIVE') list = list.filter(r => r.active);
    if (show === 'INACTIVE') list = list.filter(r => !r.active);
    if (show === 'NO_ACCOUNT') list = list.filter(r => !r.hasAccount);

    if (panel === 'PANEL') list = list.filter(r => r.user?.is_staff);
    if (panel === 'NO_PANEL') list = list.filter(r => r.hasAccount && !r.user?.is_staff);

    if (q) {
      list = list.filter(r => {
        const w = r.worker;
        const u = r.user;
        const hay = `${w.display_name} ${r.roleLabel} ${u?.username ?? ''} ${u?.email ?? ''} ${u?.phone ?? ''}`.toLowerCase();
        return hay.includes(q);
      });
    }

    return list;
  });

  // cuentas sin trabajador (por si te queda alguna “huérfana”)
  unlinkedUsers = computed(() => {
    const linked = new Set<number>();
    for (const w of this.workers()) if (w.user_id) linked.add(w.user_id);
    return this.users().filter(u => !linked.has(u.id));
  });

  filteredCustomers = computed(() => {
    const q = this.q().trim().toLowerCase();
    const t = this.customerType();
    const show = this.customerShow();

    let list = this.customers();

    if (t !== 'ALL') list = list.filter(c => (c.customer_type ?? '') === t);
    if (show === 'ACTIVE') list = list.filter(c => (c.active ?? true) === true);
    if (show === 'INACTIVE') list = list.filter(c => (c.active ?? true) === false);

    if (q) {
      list = list.filter(c => {
        const hay = `${c.name} ${c.phone ?? ''} ${c.customer_type ?? ''}`.toLowerCase();
        return hay.includes(q);
      });
    }

    return list;
  });

  // métricas rápidas
  staffStats = computed(() => {
    const all = this.staffRows();
    const total = all.length;
    const activos = all.filter(x => x.active).length;
    const sinCuenta = all.filter(x => !x.hasAccount).length;
    const conPanel = all.filter(x => x.user?.is_staff).length;
    return { total, activos, sinCuenta, conPanel };
  });

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.refreshAll();
    }
  }

  // -----------------------------
  // API helper
  // -----------------------------
  private api(path: string): string {
    const base = ((environment as any).API_URI ?? 'http://localhost:8000')
      .toString()
      .trim()
      .replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }

  // -----------------------------
  // UI actions
  // -----------------------------
  setTab(t: Tab) {
    this.tab.set(t);
    this.error.set('');
  }

  setQ(v: string) {
    this.q.set(v ?? '');
  }

  clearFilters() {
    this.staffRole.set('ALL');
    this.staffShow.set('ALL');
    this.staffPanel.set('ALL');
    this.customerType.set('ALL');
    this.customerShow.set('ALL');
    this.q.set('');
  }

  // -----------------------------
  // Loaders
  // -----------------------------
  refreshAll() {
    this.error.set('');
    this.loading.set(true);

    const params = this.q().trim()
      ? new HttpParams().set('q', this.q().trim())
      : new HttpParams();

    const uUsers = this.api('/api/staff/users/');
    const uWorkers = this.api('/api/staff/workers/manage/');
    const uCustomers = this.api('/api/staff/customers/');

    let done = 0;
    const finish = () => {
      done += 1;
      if (done >= 3) this.loading.set(false);
    };

    this.http.get<AccountUser[]>(uUsers, { params, withCredentials: true }).subscribe({
      next: (res: any) => {
        const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
        this.users.set(arr);
        finish();
      },
      error: (err) => {
        this.setHttpError(err, uUsers);
        finish();
      }
    });

    this.http.get<Worker[]>(uWorkers, { params, withCredentials: true }).subscribe({
      next: (res: any) => {
        const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
        this.workers.set(arr);
        finish();
      },
      error: (err) => {
        this.setHttpError(err, uWorkers);
        finish();
      }
    });

    this.http.get<Customer[]>(uCustomers, { params, withCredentials: true }).subscribe({
      next: (res: any) => {
        const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
        this.customers.set(arr);
        finish();
      },
      error: (err) => {
        this.setHttpError(err, uCustomers);
        finish();
      }
    });
  }

  // -----------------------------
  // Acciones rápidas (Personal)
  // -----------------------------
  toggleStaffActive(row: StaffRow) {
    const w = row.worker;
    const u = row.user;

    const next = !w.active;

    // optimista
    this.workers.set(this.workers().map(x => x.id === w.id ? { ...x, active: next } : x));
    if (u) this.users.set(this.users().map(x => x.id === u.id ? { ...x, is_active: next } : x));

    const wUrl = this.api(`/api/staff/workers/manage/${w.id}/`);
    const tasks: Array<Promise<any>> = [];

    tasks.push(new Promise((resolve, reject) => {
      this.http.patch(wUrl, { active: next }, { withCredentials: true }).subscribe({ next: resolve, error: reject });
    }));

    if (u) {
      const uUrl = this.api(`/api/staff/users/${u.id}/`);
      tasks.push(new Promise((resolve, reject) => {
        this.http.patch(uUrl, { is_active: next }, { withCredentials: true }).subscribe({ next: resolve, error: reject });
      }));
    }

    Promise.all(tasks).then(() => {
      this.toastMsg('Estado actualizado.');
    }).catch((err) => {
      this.setHttpError(err, wUrl);
      this.refreshAll();
    });
  }

  resetPasswordFromRow(row: StaffRow) {
    if (!row.user) return;
    const pwd = prompt(`Nueva contraseña para ${row.user.username}:`);
    if (!pwd) return;

    const url = this.api(`/api/staff/users/${row.user.id}/reset-password/`);
    this.loading.set(true);

    this.http.post(url, { password: pwd }, { withCredentials: true }).subscribe({
      next: () => {
        this.loading.set(false);
        this.toastMsg('Contraseña actualizada.');
      },
      error: (err) => {
        this.loading.set(false);
        this.setHttpError(err, url);
      }
    });
  }

  // -----------------------------
  // Modal: abrir/cerrar
  // -----------------------------
  openNewStaff() {
    this.modalKind.set('STAFF');
    this.editingWorkerId.set(null);
    this.editingUserId.set(null);

    this.w_display_name.set('');
    this.w_role.set('BARBER');
    this.w_active.set(true);

    this.accountMode.set('CREATE');
    this.linkUserId.set(null);

    this.u_username.set('');
    this.u_password.set('');
    this.u_email.set('');
    this.u_phone.set('');
    this.u_first.set('');
    this.u_last.set('');
    this.u_active.set(true);
    this.u_staff.set(true);
    this.u_super.set(false);

    this.modalOpen.set(true);
  }

  openEditStaff(row: StaffRow) {
    this.modalKind.set('STAFF');
    this.editingWorkerId.set(row.worker.id);
    this.editingUserId.set(row.user?.id ?? null);

    this.w_display_name.set(row.worker.display_name ?? '');
    this.w_role.set(row.worker.role);
    this.w_active.set(!!row.worker.active);

    if (row.user) {
      this.accountMode.set('EXISTING');
      this.linkUserId.set(null);

      this.u_username.set(row.user.username ?? '');
      this.u_password.set('');
      this.u_email.set(row.user.email ?? '');
      this.u_phone.set(row.user.phone ?? '');
      this.u_first.set(row.user.first_name ?? '');
      this.u_last.set(row.user.last_name ?? '');
      this.u_active.set(!!row.user.is_active);
      this.u_staff.set(!!row.user.is_staff);
      this.u_super.set(!!row.user.is_superuser);
    } else {
      // trabajador sin cuenta: permitir crear o vincular
      this.accountMode.set('CREATE');
      this.linkUserId.set(null);

      this.u_username.set('');
      this.u_password.set('');
      this.u_email.set('');
      this.u_phone.set('');
      this.u_first.set('');
      this.u_last.set('');
      this.u_active.set(true);
      this.u_staff.set(true);
      this.u_super.set(false);
    }

    this.modalOpen.set(true);
  }

  openNewCustomer() {
    this.modalKind.set('CUSTOMER');
    this.editingWorkerId.set(null);
    this.editingUserId.set(null);

    this.c_type.set('FREQUENT');
    this.c_name.set('');
    this.c_phone.set('');
    this.c_birth.set('');
    this.c_active.set(true);

    this.modalOpen.set(true);
  }

  openEditCustomer(c: Customer) {
    this.modalKind.set('CUSTOMER');
    this.editingWorkerId.set(c.id);
    this.editingUserId.set(null);

    this.c_type.set((c.customer_type as any) || 'FREQUENT');
    this.c_name.set(c.name ?? '');
    this.c_phone.set(c.phone ?? '');
    this.c_birth.set(c.birth_date ?? '');
    this.c_active.set(c.active ?? true);

    this.modalOpen.set(true);
  }

  closeModal() {
    this.modalOpen.set(false);
    this.error.set('');
  }

  // -----------------------------
  // Guardar modal
  // -----------------------------
  saveModal() {
    if (this.modalKind() === 'CUSTOMER') return this.saveCustomer();
    return this.saveStaff();
  }

  private saveStaff() {
    this.error.set('');

    const workerId = this.editingWorkerId();
    const userId = this.editingUserId();
    const mode = this.accountMode();

    const display_name = this.w_display_name().trim();
    if (!display_name) return this.error.set('El nombre del trabajador es requerido.');

    const workerPayload: any = {
      display_name,
      role: this.w_role(),
      active: !!this.w_active(),
      user_id: null as any,
    };

    const patchWorker = (id: number, payload: any) => {
      const url = this.api(`/api/staff/workers/manage/${id}/`);
      return this.http.patch(url, payload, { withCredentials: true });
    };

    const createWorker = (payload: any) => {
      const url = this.api('/api/staff/workers/manage/');
      return this.http.post(url, payload, { withCredentials: true });
    };

    const patchUser = (id: number, payload: any) => {
      const url = this.api(`/api/staff/users/${id}/`);
      return this.http.patch(url, payload, { withCredentials: true });
    };

    const createUser = (payload: any) => {
      const url = this.api('/api/staff/users/');
      return this.http.post<any>(url, payload, { withCredentials: true });
    };

    const resetPass = (id: number, password: string) => {
      const url = this.api(`/api/staff/users/${id}/reset-password/`);
      return this.http.post(url, { password }, { withCredentials: true });
    };

    // payload user
    const uPayload: any = {
      username: this.u_username().trim(),
      email: this.u_email().trim() || null,
      phone: this.u_phone().trim() || null,
      first_name: this.u_first().trim() || '',
      last_name: this.u_last().trim() || '',
      is_active: !!this.u_active(),
      is_staff: !!this.u_staff(),
      is_superuser: !!this.u_super(),
    };

    this.loading.set(true);

    // 1) NUEVO TRABAJADOR
    if (!workerId) {
      // Crear o Vincular cuenta
      if (mode === 'LINK') {
        const pick = this.linkUserId();
        if (!pick) {
          this.loading.set(false);
          return this.error.set('Selecciona una cuenta existente para vincular.');
        }
        workerPayload.user_id = pick;

        createWorker(workerPayload).subscribe({
          next: () => {
            this.loading.set(false);
            this.toastMsg('Trabajador creado y vinculado.');
            this.closeModal();
            this.refreshAll();
          },
          error: (err) => {
            this.loading.set(false);
            this.setHttpError(err, this.api('/api/staff/workers/manage/'));
          }
        });
        return;
      }

      // CREATE
      const pwd = this.u_password().trim();
      if (!uPayload.username) {
        this.loading.set(false);
        return this.error.set('El usuario (username) es requerido.');
      }
      if (!pwd) {
        this.loading.set(false);
        return this.error.set('Para crear la cuenta debes indicar una contraseña.');
      }

      const createPayload = { ...uPayload, password: pwd };

      createUser(createPayload).subscribe({
        next: (created) => {
          const newId = created?.id;
          workerPayload.user_id = newId;

          createWorker(workerPayload).subscribe({
            next: () => {
              this.loading.set(false);
              this.toastMsg('Trabajador y cuenta creados.');
              this.closeModal();
              this.refreshAll();
            },
            error: (err) => {
              this.loading.set(false);
              this.setHttpError(err, this.api('/api/staff/workers/manage/'));
            }
          });
        },
        error: (err) => {
          this.loading.set(false);
          this.setHttpError(err, this.api('/api/staff/users/'));
        }
      });
      return;
    }

    // 2) EDITAR TRABAJADOR
    const finishOk = (msg: string) => {
      this.loading.set(false);
      this.toastMsg(msg);
      this.closeModal();
      this.refreshAll();
    };

    // si no hay cuenta y eligen LINK/CREATE
    if (!userId) {
      if (mode === 'LINK') {
        const pick = this.linkUserId();
        if (!pick) {
          this.loading.set(false);
          return this.error.set('Selecciona una cuenta existente para vincular.');
        }
        workerPayload.user_id = pick;

        patchWorker(workerId, workerPayload).subscribe({
          next: () => finishOk('Trabajador actualizado y vinculado.'),
          error: (err) => {
            this.loading.set(false);
            this.setHttpError(err, this.api(`/api/staff/workers/manage/${workerId}/`));
          }
        });
        return;
      }

      // CREATE
      const pwd = this.u_password().trim();
      if (!uPayload.username) {
        this.loading.set(false);
        return this.error.set('El usuario (username) es requerido.');
      }
      if (!pwd) {
        this.loading.set(false);
        return this.error.set('Para crear la cuenta debes indicar una contraseña.');
      }

      createUser({ ...uPayload, password: pwd }).subscribe({
        next: (created) => {
          workerPayload.user_id = created?.id;

          patchWorker(workerId, workerPayload).subscribe({
            next: () => finishOk('Cuenta creada y vinculada.'),
            error: (err) => {
              this.loading.set(false);
              this.setHttpError(err, this.api(`/api/staff/workers/manage/${workerId}/`));
            }
          });
        },
        error: (err) => {
          this.loading.set(false);
          this.setHttpError(err, this.api('/api/staff/users/'));
        }
      });
      return;
    }

    // EXISTING: actualizar worker + user
    workerPayload.user_id = userId;

    // si el usuario cambió a “vincular otra cuenta” (opcional)
    if (mode === 'LINK') {
      const pick = this.linkUserId();
      if (!pick) {
        this.loading.set(false);
        return this.error.set('Selecciona una cuenta para vincular.');
      }
      workerPayload.user_id = pick;

      patchWorker(workerId, workerPayload).subscribe({
        next: () => finishOk('Trabajador vinculado a otra cuenta.'),
        error: (err) => {
          this.loading.set(false);
          this.setHttpError(err, this.api(`/api/staff/workers/manage/${workerId}/`));
        }
      });
      return;
    }

    // normal: patch user + patch worker
    patchUser(userId, uPayload).subscribe({
      next: () => {
        patchWorker(workerId, workerPayload).subscribe({
          next: () => {
            const pwd = this.u_password().trim();
            if (pwd) {
              resetPass(userId, pwd).subscribe({
                next: () => finishOk('Actualizado. Contraseña restablecida.'),
                error: (err) => {
                  this.loading.set(false);
                  this.setHttpError(err, this.api(`/api/staff/users/${userId}/reset-password/`));
                }
              });
            } else {
              finishOk('Trabajador actualizado.');
            }
          },
          error: (err) => {
            this.loading.set(false);
            this.setHttpError(err, this.api(`/api/staff/workers/manage/${workerId}/`));
          }
        });
      },
      error: (err) => {
        this.loading.set(false);
        this.setHttpError(err, this.api(`/api/staff/users/${userId}/`));
      }
    });
  }

  private saveCustomer() {
    this.error.set('');

    const id = this.editingWorkerId(); // reutilizado para customer id
    const url = id
      ? this.api(`/api/staff/customers/${id}/`)
      : this.api('/api/staff/customers/');

    const payload: any = {
      customer_type: this.c_type(),
      name: this.c_name().trim(),
      phone: this.c_phone().trim() || null,
      birth_date: this.c_birth().trim() || null,
      active: !!this.c_active(),
    };

    if (!payload.name) return this.error.set('El nombre del cliente es requerido.');

    const req$ = id
      ? this.http.patch(url, payload, { withCredentials: true })
      : this.http.post(url, payload, { withCredentials: true });

    this.loading.set(true);
    req$.subscribe({
      next: () => {
        this.loading.set(false);
        this.toastMsg('Cliente guardado.');
        this.closeModal();
        this.refreshAll();
      },
      error: (err) => {
        this.loading.set(false);
        this.setHttpError(err, url);
      }
    });
  }

  // -----------------------------
  // Errors / toast
  // -----------------------------
  private setHttpError(err: any, url: string) {
    const e = err as HttpErrorResponse;
    const status = e?.status ?? 0;

    if (status === 401) {
      this.error.set('401: No autenticado. Inicia sesión nuevamente.');
      return;
    }
    if (status === 403) {
      this.error.set('403: No autorizado. Debes iniciar sesión con un usuario con acceso al panel.');
      return;
    }

    const detail =
      (e?.error && typeof e.error === 'object' && (e.error as any).detail) ||
      (typeof e?.error === 'string' ? e.error : '') ||
      e?.message ||
      '';

    this.error.set(String(detail || `Error HTTP (${status}) en ${url}`));
  }

  private toastMsg(msg: string) {
    this.toast.set(msg);
    setTimeout(() => {
      if (this.toast() === msg) this.toast.set('');
    }, 2400);
  }
}
