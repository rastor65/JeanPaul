import { CommonModule } from '@angular/common';
import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { environment } from '../../../environments/environment';

type Tab = 'SERVICES' | 'CATEGORIES';
type AssignmentType = 'ROLE_BASED' | 'FIXED_WORKER';

type WorkerOpt = { id: number; label: string };

type Category = {
  id: number;
  name: string;
  active?: boolean;
  default_fixed_worker?: number | null;
  default_fixed_worker_label?: string | null;
};

type Service = {
  id: number;
  name: string;
  category: { id: number; name: string };
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  price: string;
  active: boolean;
  description: string;
  requirements: string;
  assignment_type: AssignmentType;
  fixed_worker_label?: string | null;
};

@Component({
  selector: 'app-catalogo',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './catalogo.html',
  styleUrl: './catalogo.scss',
})
export class CatalogoComponent {
  private http = inject(HttpClient);

  // ----------------------------
  // Tabs & data
  // ----------------------------
  tab = signal<Tab>('SERVICES');

  loading = signal(false);
  error = signal('');
  toast = signal('');

  categories = signal<Category[]>([]);
  services = signal<Service[]>([]);
  workers = signal<WorkerOpt[]>([]);

  // ----------------------------
  // Filters
  // ----------------------------
  sQuery = signal('');
  sShow = signal<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  sCat = signal<number | 'ALL'>('ALL');

  cQuery = signal('');
  cShow = signal<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  // ----------------------------
  // Modals
  // ----------------------------
  svcModalOpen = signal(false);
  catModalOpen = signal(false);

  // Confirm modal (reemplaza window.confirm)
  confirmOpen = signal(false);
  confirmTitle = signal('');
  confirmMsg = signal('');
  confirmBusy = signal(false);
  private confirmFn: (() => void) | null = null;

  // Service form
  svcId = signal<number | null>(null);
  svcName = signal('');
  svcCategoryId = signal<number | null>(null);
  svcDuration = signal<number>(30);
  svcBufBefore = signal<number>(0);
  svcBufAfter = signal<number>(0);
  svcPrice = signal<string>('0');
  svcActive = signal<boolean>(true);
  svcDesc = signal<string>('');
  svcReq = signal<string>('');
  svcAssign = signal<AssignmentType>('ROLE_BASED');
  svcFixedWorkerId = signal<number | null>(null);

  // Category form
  catId = signal<number | null>(null);
  catName = signal('');
  catActive = signal<boolean>(true);
  catDefaultWorker = signal<number | null>(null);

  // ----------------------------
  // Traducciones (Backend -> UI)
  // ----------------------------
  private readonly ASSIGNMENT_LABEL: Record<AssignmentType, string> = {
    ROLE_BASED: 'Por rol (disponible)',
    FIXED_WORKER: 'Trabajador fijo',
  };

  private readonly ASSIGNMENT_HELP: Record<AssignmentType, string> = {
    ROLE_BASED: 'El sistema asigna el trabajador según disponibilidad/rol.',
    FIXED_WORKER: 'Este servicio siempre lo realiza el trabajador seleccionado.',
  };

  assignmentLabel(v: any): string {
    return this.ASSIGNMENT_LABEL[v as AssignmentType] ?? String(v ?? '—');
  }

  assignmentHelp(v: any): string {
    return this.ASSIGNMENT_HELP[v as AssignmentType] ?? '';
  }

  // ----------------------------
  // Derived lists
  // ----------------------------
  filteredServices = computed(() => {
    const q = this.sQuery().trim().toLowerCase();
    const show = this.sShow();
    const cat = this.sCat();

    let list = this.services();

    if (show !== 'ALL') list = list.filter(s => (show === 'ACTIVE' ? s.active : !s.active));
    if (cat !== 'ALL') list = list.filter(s => s.category?.id === cat);

    if (q) {
      list = list.filter(s => {
        const t = `${s.name} ${s.category?.name ?? ''} ${s.description ?? ''}`.toLowerCase();
        return t.includes(q);
      });
    }

    return list;
  });

  filteredCategories = computed(() => {
    const q = this.cQuery().trim().toLowerCase();
    const show = this.cShow();

    let list = this.categories();

    if (show !== 'ALL') list = list.filter(c => (show === 'ACTIVE' ? c.active !== false : c.active === false));
    if (q) list = list.filter(c => (c.name ?? '').toLowerCase().includes(q));

    return list;
  });

  // KPIs
  svcCounts = computed(() => {
    const all = this.services();
    const active = all.filter(x => x.active).length;
    const inactive = all.length - active;
    return { all: all.length, active, inactive };
  });

  catCounts = computed(() => {
    const all = this.categories();
    const active = all.filter(x => x.active !== false).length;
    const inactive = all.length - active;
    return { all: all.length, active, inactive };
  });

  // Conteo de servicios por categoría
  servicesByCategory = computed(() => {
    const map = new Map<number, number>();
    for (const s of this.services()) {
      const id = s.category?.id;
      if (!id) continue;
      map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  });

  categoryServiceCount(catId: number): number {
    return this.servicesByCategory().get(catId) ?? 0;
  }

  totalMinutes(s: Service): number {
    return Number(s.duration_minutes ?? 0) + Number(s.buffer_before_minutes ?? 0) + Number(s.buffer_after_minutes ?? 0);
  }

  constructor() {
    this.loadAll();
  }

  @HostListener('document:keydown.escape')
  onEsc() {
    if (this.confirmOpen()) this.closeConfirm();
    else if (this.svcModalOpen()) this.closeServiceModal();
    else if (this.catModalOpen()) this.closeCategoryModal();
  }

  // ----------------------------
  // URL builder
  // ----------------------------
  private api(path: string): string {
    const base = ((environment as any).API_URI)
      .toString()
      .trim()
      .replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }

  // ----------------------------
  // Load
  // ----------------------------
  loadAll() {
    this.error.set('');
    this.loading.set(true);

    const catUrl = this.api('/api/staff/service-categories/');
    const svcUrl = this.api('/api/staff/services/');
    const wUrl = this.api('/api/staff/workers/');

    this.http.get<Category[] | any>(catUrl, { withCredentials: true }).subscribe({
      next: (res) => {
        const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
        this.categories.set(arr);

        // preselección para crear servicio
        if (!this.svcCategoryId() && arr.length) this.svcCategoryId.set(arr[0].id);

        // dependemos de categorías para filtros
        this.loadServices();
      },
      error: (e) => {
        this.loading.set(false);
        this.setHttpError(e, catUrl);
      }
    });

    // Workers (opcional)
    this.http.get<WorkerOpt[] | any>(wUrl, { withCredentials: true }).subscribe({
      next: (res) => {
        const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
        this.workers.set(arr);
      },
      error: () => {
        this.workers.set([]);
      }
    });
  }

  loadServices() {
    const svcUrl = this.api('/api/staff/services/');
    this.http.get<Service[] | any>(svcUrl, { withCredentials: true }).subscribe({
      next: (res) => {
        this.loading.set(false);
        const arr = Array.isArray(res) ? res : (Array.isArray(res?.results) ? res.results : []);
        this.services.set(arr);
      },
      error: (e) => {
        this.loading.set(false);
        this.setHttpError(e, svcUrl);
      }
    });
  }

  // ----------------------------
  // Tabs
  // ----------------------------
  setTab(t: Tab) {
    this.tab.set(t);
    this.error.set('');
  }

  // ----------------------------
  // Filters helpers
  // ----------------------------
  resetServiceFilters() {
    this.sQuery.set('');
    this.sShow.set('ALL');
    this.sCat.set('ALL');
  }

  resetCategoryFilters() {
    this.cQuery.set('');
    this.cShow.set('ALL');
  }

  // ----------------------------
  // Confirm modal
  // ----------------------------
  openConfirm(title: string, msg: string, fn: () => void) {
    this.confirmTitle.set(title);
    this.confirmMsg.set(msg);
    this.confirmBusy.set(false);
    this.confirmFn = fn;
    this.confirmOpen.set(true);
  }

  closeConfirm() {
    if (this.confirmBusy()) return;
    this.confirmOpen.set(false);
    this.confirmTitle.set('');
    this.confirmMsg.set('');
    this.confirmFn = null;
  }

  confirmYes() {
    if (!this.confirmFn) return;
    this.confirmBusy.set(true);
    try {
      this.confirmFn();
    } catch {
      this.confirmBusy.set(false);
      this.closeConfirm();
    }
  }

  // ----------------------------
  // Service modal
  // ----------------------------
  openCreateService() {
    this.error.set('');
    this.svcModalOpen.set(true);

    this.svcId.set(null);
    this.svcName.set('');

    // Si el filtro de categoría está activo, úsalo como default
    const filterCat = this.sCat();
    const defaultCat = filterCat !== 'ALL' ? (filterCat as number) : (this.categories()[0]?.id ?? null);
    this.svcCategoryId.set(defaultCat);

    this.svcDuration.set(30);
    this.svcBufBefore.set(0);
    this.svcBufAfter.set(0);
    this.svcPrice.set('0');
    this.svcActive.set(true);
    this.svcDesc.set('');
    this.svcReq.set('');
    this.svcAssign.set('ROLE_BASED');
    this.svcFixedWorkerId.set(null);
  }

  openEditService(s: Service) {
    this.error.set('');
    this.svcModalOpen.set(true);

    this.svcId.set(s.id);
    this.svcName.set(s.name ?? '');
    this.svcCategoryId.set(s.category?.id ?? null);
    this.svcDuration.set(Number(s.duration_minutes ?? 0));
    this.svcBufBefore.set(Number(s.buffer_before_minutes ?? 0));
    this.svcBufAfter.set(Number(s.buffer_after_minutes ?? 0));
    this.svcPrice.set(String(s.price ?? '0'));
    this.svcActive.set(!!s.active);
    this.svcDesc.set(s.description ?? '');
    this.svcReq.set(s.requirements ?? '');
    this.svcAssign.set((s.assignment_type as AssignmentType) ?? 'ROLE_BASED');

    // El backend hoy devuelve fixed_worker_label; si luego envías el id, lo setearías aquí.
    this.svcFixedWorkerId.set(null);
  }

  closeServiceModal() {
    this.svcModalOpen.set(false);
  }

  saveService() {
    this.error.set('');

    const name = this.svcName().trim();
    const categoryId = this.svcCategoryId();
    if (!name) return this.error.set('El nombre del servicio es obligatorio.');
    if (!categoryId) return this.error.set('Selecciona una categoría.');

    const assign = this.svcAssign();
    const fixedWorkerId = this.svcFixedWorkerId();

    if (assign === 'FIXED_WORKER' && !fixedWorkerId) {
      return this.error.set('Si la asignación es "Trabajador fijo", debes seleccionar el trabajador.');
    }

    const payload: any = {
      name,
      category_id: categoryId,
      duration_minutes: Math.max(0, Number(this.svcDuration() || 0)),
      buffer_before_minutes: Math.max(0, Number(this.svcBufBefore() || 0)),
      buffer_after_minutes: Math.max(0, Number(this.svcBufAfter() || 0)),
      price: String(this.svcPrice() || '0'),
      active: !!this.svcActive(),
      description: this.svcDesc() || '',
      requirements: this.svcReq() || '',
      assignment_type: assign,
      fixed_worker_id: assign === 'FIXED_WORKER' ? fixedWorkerId : null,
    };

    const id = this.svcId();
    const url = id
      ? this.api(`/api/staff/services/${id}/`)
      : this.api('/api/staff/services/');

    const req$ = id
      ? this.http.patch<any>(url, payload, { withCredentials: true })
      : this.http.post<any>(url, payload, { withCredentials: true });

    this.loading.set(true);
    req$.subscribe({
      next: () => {
        this.loading.set(false);
        this.svcModalOpen.set(false);
        this.toastMsg(id ? 'Servicio actualizado.' : 'Servicio creado.');
        this.loadServices();
      },
      error: (e) => {
        this.loading.set(false);
        this.setHttpError(e, url);
      }
    });
  }

  toggleServiceActive(s: Service) {
    const url = this.api(`/api/staff/services/${s.id}/`);
    const next = !s.active;

    // Optimista
    const arr = this.services().slice();
    const i = arr.findIndex(x => x.id === s.id);
    if (i >= 0) {
      arr[i] = { ...arr[i], active: next };
      this.services.set(arr);
    }

    this.http.patch<any>(url, { active: next }, { withCredentials: true }).subscribe({
      next: () => this.toastMsg('Estado actualizado.'),
      error: (e) => {
        // rollback
        const arr2 = this.services().slice();
        const j = arr2.findIndex(x => x.id === s.id);
        if (j >= 0) {
          arr2[j] = { ...arr2[j], active: !next };
          this.services.set(arr2);
        }
        this.setHttpError(e, url);
      }
    });
  }

  deleteService(s: Service) {
    this.openConfirm(
      'Eliminar servicio',
      `¿Deseas eliminar el servicio "${s.name}"? Esta acción no se puede deshacer.`,
      () => {
        const url = this.api(`/api/staff/services/${s.id}/`);
        this.loading.set(true);

        this.http.delete<any>(url, { withCredentials: true }).subscribe({
          next: () => {
            this.loading.set(false);
            this.toastMsg('Servicio eliminado.');
            this.closeConfirm();
            this.loadServices();
          },
          error: (e) => {
            this.loading.set(false);
            this.confirmBusy.set(false);
            this.setHttpError(e, url);
          }
        });
      }
    );
  }

  // ----------------------------
  // Category modal
  // ----------------------------
  openCreateCategory() {
    this.error.set('');
    this.catModalOpen.set(true);

    this.catId.set(null);
    this.catName.set('');
    this.catActive.set(true);
    this.catDefaultWorker.set(null);
  }

  openEditCategory(c: Category) {
    this.error.set('');
    this.catModalOpen.set(true);

    this.catId.set(c.id);
    this.catName.set(c.name ?? '');
    this.catActive.set(c.active !== false);
    this.catDefaultWorker.set((c.default_fixed_worker ?? null) as any);
  }

  closeCategoryModal() {
    this.catModalOpen.set(false);
  }

  saveCategory() {
    this.error.set('');

    const name = this.catName().trim();
    if (!name) return this.error.set('El nombre de la categoría es obligatorio.');

    const payload: any = {
      name,
      active: !!this.catActive(),
      default_fixed_worker: this.catDefaultWorker(),
    };

    const id = this.catId();
    const url = id
      ? this.api(`/api/staff/service-categories/${id}/`)
      : this.api('/api/staff/service-categories/');

    const req$ = id
      ? this.http.patch<any>(url, payload, { withCredentials: true })
      : this.http.post<any>(url, payload, { withCredentials: true });

    this.loading.set(true);
    req$.subscribe({
      next: () => {
        this.loading.set(false);
        this.catModalOpen.set(false);
        this.toastMsg(id ? 'Categoría actualizada.' : 'Categoría creada.');
        this.loadAll();
      },
      error: (e) => {
        this.loading.set(false);
        this.setHttpError(e, url);
      }
    });
  }

  toggleCategoryActive(c: Category) {
    const url = this.api(`/api/staff/service-categories/${c.id}/`);
    const next = !(c.active !== false);

    const arr = this.categories().slice();
    const i = arr.findIndex(x => x.id === c.id);
    if (i >= 0) {
      arr[i] = { ...arr[i], active: !next ? false : true };
      this.categories.set(arr);
    }

    this.http.patch<any>(url, { active: !next ? false : true }, { withCredentials: true }).subscribe({
      next: () => this.toastMsg('Estado actualizado.'),
      error: (e) => {
        this.setHttpError(e, url);
        this.loadAll();
      }
    });
  }

  deleteCategory(c: Category) {
    this.openConfirm(
      'Eliminar categoría',
      `¿Deseas eliminar la categoría "${c.name}"? Puede fallar si tiene servicios asociados.`,
      () => {
        const url = this.api(`/api/staff/service-categories/${c.id}/`);
        this.loading.set(true);

        this.http.delete<any>(url, { withCredentials: true }).subscribe({
          next: () => {
            this.loading.set(false);
            this.toastMsg('Categoría eliminada.');
            this.closeConfirm();
            this.loadAll();
          },
          error: (e) => {
            this.loading.set(false);
            this.confirmBusy.set(false);
            this.setHttpError(e, url);
          }
        });
      }
    );
  }

  // ----------------------------
  // Helpers
  // ----------------------------
  priceLabel(v: any) {
    const s = String(v ?? '0').replace(',', '.');
    const n = Number(s);
    if (!Number.isFinite(n)) return String(v ?? '0');
    return n.toLocaleString('es-CO');
  }

  // ----------------------------
  // Error handling
  // ----------------------------
  private setHttpError(err: any, url: string) {
    const e = err as HttpErrorResponse;

    console.error('[CATALOGO ERROR]', {
      url,
      status: e?.status,
      error: e?.error,
    });

    if (e?.status === 401) {
      this.error.set('No autenticado (HTTP 401). Inicia sesión nuevamente.');
      return;
    }
    if (e?.status === 403) {
      this.error.set('No autorizado. Solo staff/admin puede usar este módulo.');
      return;
    }

    const detail =
      (e?.error && typeof e.error === 'object' && (e.error as any).detail) ||
      (typeof e?.error === 'string' ? e.error : '') ||
      e?.message ||
      'Error';

    this.error.set(String(detail));
  }

  private toastMsg(msg: string) {
    this.toast.set(msg);
    setTimeout(() => {
      if (this.toast() === msg) this.toast.set('');
    }, 2200);
  }
}
