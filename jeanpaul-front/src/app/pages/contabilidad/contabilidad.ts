import { CommonModule } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom, Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { StaffingAdminApi } from '../../core/api/staffing-admin.api';

type Status = 'RESERVED' | 'CANCELLED' | 'ATTENDED' | 'NO_SHOW';
type PayMethod = 'CASH' | 'TRANSFER' | 'CARD' | null;

type WorkerItem = { id: number; label: string; role?: string; active?: boolean; ids?: number[] };

type AppointmentDTO = {
  id: number;
  status: Status;
  start_datetime: string;
  end_datetime: string;

  customer?: { id: number | null; name: string; phone?: string | null; birth_date?: unknown };

  blocks?: Array<{
    id: number;
    worker: number;
    worker_label?: string;
    start_datetime: string;
    end_datetime: string;
    services?: Array<{ id: number; name: string; price: unknown }>;
  }>;

  recommended_total?: unknown;

  // Staff fields
  paid_total?: unknown;
  payment_method?: PayMethod;
  paid_at?: string | null;
  paid_by?: string | null;

  // Derivados
  _generated: number;
  _paid: number;
  _collected: number;
  _pending: number;

  _workers: string[];
  _workerIds: number[];
  _services: string[];
};

type Toast = { id: number; type: 'success' | 'error' | 'info'; title: string; message: string };

type SeriesPoint = { key: string; label: string; short: string; generated: number; collected: number };

type PayrollBase = 'COLLECTED' | 'GENERATED';

type PayrollRow = {
  worker_id: number;
  worker_label: string;
  role: string;
  attended: number;
  produced: number;
  collected: number;
  base: number;
  pct: number;
  workerPay: number;
  shopGain: number;
};

type PayrollCategory = {
  role: string;
  pct: number;
  workers: PayrollRow[];
  producedTotal: number;
  collectedTotal: number;
  baseTotal: number;
  workerPayTotal: number;
  shopGainTotal: number;
};

@Component({
  selector: 'app-contabilidad',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule],
  templateUrl: './contabilidad.html',
  styleUrls: ['./contabilidad.scss'],
})
export class ContabilidadComponent implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private http = inject(HttpClient);
  private staffing = inject(StaffingAdminApi);
  private cdr = inject(ChangeDetectorRef);

  private readonly HTTP_TIMEOUT_MS = 15000;
  private readonly APPTS_PATH = '/api/appointments/staff/';

  // -----------------------
  // LOADING (robusto)
  // -----------------------
  loading = false;
  private loadingCount = 0;
  private loadingWatchdog: any = null;
  private destroyed = false;

  private mark() {
    if (this.destroyed) return;
    this.cdr.markForCheck();
  }

  private workerIndex = new Map<number, { label: string; role: string }>();

  private startWatchdog() {
    this.stopWatchdog();
    this.loadingWatchdog = setTimeout(() => {
      if (this.loading) {
        console.warn('[Contabilidad] Watchdog apagó loading (evitó spinner pegado).');
        this.hardStopLoading();
      }
    }, this.HTTP_TIMEOUT_MS + 5000);
  }

  private stopWatchdog() {
    if (this.loadingWatchdog) {
      clearTimeout(this.loadingWatchdog);
      this.loadingWatchdog = null;
    }
  }

  private beginLoading() {
    this.loadingCount += 1;
    if (this.loadingCount === 1) this.startWatchdog();
    this.loading = this.loadingCount > 0;
    this.mark();
  }

  private endLoading() {
    this.loadingCount = Math.max(0, this.loadingCount - 1);
    if (this.loadingCount === 0) this.stopWatchdog();
    this.loading = this.loadingCount > 0;
    this.mark();
  }

  private hardStopLoading() {
    this.loadingCount = 0;
    this.loading = false;
    this.stopWatchdog();
    this.mark();
  }

  private asNum(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private pickLabel(w: any): string {
    if (!w) return '';

    // Casos comunes
    const direct =
      w.label ?? w.name ?? w.full_name ?? w.fullName ??
      w.username ?? w.display_name ?? w.displayName;

    if (direct && String(direct).trim()) return String(direct).trim();

    // Nombres/apellidos (es/en)
    const fn = (w.first_name ?? w.firstName ?? w.nombres ?? w.nombre ?? '').toString().trim();
    const ln = (w.last_name ?? w.lastName ?? w.apellidos ?? w.apellido ?? '').toString().trim();
    const full = `${fn} ${ln}`.trim();
    if (full) return full;

    // Anidado en user
    if (w.user) {
      const u = w.user;
      const uLabel =
        u.label ?? u.name ?? u.full_name ?? u.fullName ??
        u.username ?? u.email;
      if (uLabel && String(uLabel).trim()) return String(uLabel).trim();

      const ufn = (u.first_name ?? u.firstName ?? u.nombres ?? u.nombre ?? '').toString().trim();
      const uln = (u.last_name ?? u.lastName ?? u.apellidos ?? u.apellido ?? '').toString().trim();
      const ufull = `${ufn} ${uln}`.trim();
      if (ufull) return ufull;
    }

    return '';
  }

  private collectIds(w: any): number[] {
    if (!w) return [];
    const candidates = [
      w.id,
      w.worker_id, w.workerId,
      w.user_id, w.userId,
      w.employee_id, w.employeeId,
      w.staff_id, w.staffId,
      w.profile_id, w.profileId,
      w.user?.id,
    ];

    const ids = candidates
      .map((x) => this.asNum(x))
      .filter((x): x is number => x != null);

    // únicos
    return Array.from(new Set(ids));
  }

  private rebuildWorkerIndex() {
    this.workerIndex.clear();

    for (const w of this.workers) {
      const role = this.roleKey(w.role);
      const ids = (w.ids && w.ids.length) ? w.ids : [w.id];

      for (const id of ids) {
        this.workerIndex.set(id, { label: w.label, role });
      }
    }
  }

  private workerLabelById(id: number): string {
    return this.workerIndex.get(id)?.label ?? String(id);
  }

  private workerRoleById(id: number): string {
    return this.workerIndex.get(id)?.role ?? this.roleKey(undefined);
  }

  /** Soporta blocks.worker como number o como object */
  private getWorkerId(raw: any): number | null {
    if (raw == null) return null;
    if (typeof raw === 'number' || typeof raw === 'string') return this.asNum(raw);

    if (typeof raw === 'object') {
      return (
        this.asNum(raw.id) ??
        this.asNum(raw.worker_id ?? raw.workerId) ??
        this.asNum(raw.user_id ?? raw.userId) ??
        this.asNum(raw.user?.id)
      );
    }
    return null;
  }

  private getWorkerLabelFromBlock(workerRaw: any, wid: number | null, workerLabelField?: any): string {
    // 1) worker_label explícito del backend
    const wl = (workerLabelField ?? '').toString().trim();
    if (wl) return wl;

    // 2) Si viene worker como objeto, intentamos sacar label/nombre
    if (workerRaw && typeof workerRaw === 'object') {
      const picked = this.pickLabel(workerRaw);
      if (picked) return picked;
    }

    // 3) buscar por índice (multi-IDs)
    if (wid != null) return this.workerLabelById(wid);

    // 4) fallback
    return String(workerRaw ?? '—');
  }

  // -----------------------
  // Estado general
  // -----------------------
  private reloadSeq = 0;

  workers: WorkerItem[] = [];

  appointments: AppointmentDTO[] = [];
  filteredAppointments: AppointmentDTO[] = [];

  showDetails = false;
  page = 1;
  pageSize = 20;
  totalPages = 1;
  viewAppointments: AppointmentDTO[] = [];

  sortKey: 'date' | 'customer' | 'status' | 'generated' | 'collected' | 'pending' = 'date';
  sortDir: 'asc' | 'desc' = 'desc';

  quick: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | 'CUSTOM' = 'MONTH';

  totalGenerated = 0;
  totalCollected = 0;
  totalPending = 0;
  countAttended = 0;
  avgTicket = 0;

  sumCash = 0;
  sumTransfer = 0;
  sumCard = 0;

  series: SeriesPoint[] = [];
  seriesMax = 0;

  // -----------------------
  // Liquidación
  // -----------------------
  payrollBase: PayrollBase = 'COLLECTED';
  rolePct: Record<string, number> = {};
  payrollCategories: PayrollCategory[] = [];
  payrollBaseTotal = 0;
  payrollWorkerTotal = 0;
  payrollShopTotal = 0;
  private readonly ROLE_PCT_KEY = 'contabilidad_role_pct_v1';

  toasts: Toast[] = [];
  private toastSeq = 1;

  private subs = new Subscription();

  filtersForm = this.fb.group({
    from: ['', [Validators.required]],
    to: ['', [Validators.required]],
    groupBy: ['DAY' as 'DAY' | 'WEEK' | 'MONTH'],       // ahora se muestra en la sección del gráfico
    workerId: [0],
    status: ['ALL' as 'ALL' | Status],
    paymentMethod: ['ALL' as 'ALL' | 'NONE' | 'CASH' | 'TRANSFER' | 'CARD'],
    moneyMode: ['BOTH' as 'BOTH' | 'GENERATED' | 'COLLECTED'], // ahora se muestra en la sección del gráfico
    q: [''],
  });

  ngOnInit(): void {
    this.loadRolePct();

    this.setQuick('DAY', false);
    this.subs.add(this.filtersForm.valueChanges.subscribe(() => this.safeComputeAll()));

    void this.init();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.subs.unsubscribe();
    this.stopWatchdog();
  }

  private async init() {
    await this.loadWorkers();
    await this.reload();
  }

  // -----------------------
  // API helpers
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
  // Workers
  // -----------------------

  private async loadWorkers() {
    this.beginLoading();
    try {
      const data = await firstValueFrom(this.staffing.listWorkers().pipe(timeout(this.HTTP_TIMEOUT_MS)));
      this.workers = (data || []).map((w: any) => {
        const id = Number(w.id);
        const label = this.pickLabel(w) || String(id);
        const ids = this.collectIds(w);
        if (!ids.includes(id)) ids.unshift(id);

        return {
          id,
          label,
          role: w.role,
          active: w.active !== false,
          ids,
        } as WorkerItem;
      });

      this.rebuildWorkerIndex();
      this.ensureRolePctDefaults();
    } catch (e: any) {
      const code = e?.status ? ` (HTTP ${e.status})` : '';
      this.toast('error', 'Error', `No se pudieron cargar los trabajadores${code}.`);
      this.workers = [];
    } finally {
      this.endLoading();
    }
  }

  // -----------------------
  // Robust fetch
  // -----------------------
  private extractList<T>(resp: any): T[] {
    if (!resp) return [];
    if (Array.isArray(resp)) return resp as T[];
    if (Array.isArray(resp.results)) return resp.results as T[];
    if (Array.isArray(resp.data)) return resp.data as T[];
    return [];
  }

  private async fetchWithParamVariants(url: string, from: string, to: string): Promise<AppointmentDTO[] | null> {
    const variants: Array<[string, string]> = [
      ['from', 'to'],
      ['start', 'end'],
      ['start_date', 'end_date'],
      ['date_from', 'date_to'],
    ];

    for (const [k1, k2] of variants) {
      const params = new HttpParams().set(k1, from).set(k2, to);

      try {
        const resp = await firstValueFrom(
          this.http.get<any>(url, { params, withCredentials: true }).pipe(timeout(this.HTTP_TIMEOUT_MS))
        );
        const list = this.extractList<AppointmentDTO>(resp);
        return (list || []).map((a) => this.enrichAppointment(a));
      } catch (e: any) {
        if (e?.status === 400) continue;
        throw e;
      }
    }
    return null;
  }

  private getCandidates(): string[] {
    if (this.APPTS_PATH && this.APPTS_PATH.trim()) return [this.APPTS_PATH.trim()];
    return [
      '/api/booking/appointments/staff/',
      '/api/booking/appointments/',
      '/api/appointments/staff/',
      '/api/appointments/',
      '/api/booking/agenda/staff/',
      '/api/agenda/staff/',
    ];
  }

  // -----------------------
  // Reload
  // -----------------------
  async reload() {
    const v = this.filtersForm.getRawValue();
    const from = (v.from || '').toString().trim();
    const to = (v.to || '').toString().trim();

    if (!from || !to) {
      this.hardStopLoading();
      this.toast('info', 'Rango', 'Selecciona un rango de fechas válido.');
      return;
    }

    const seq = ++this.reloadSeq;
    this.beginLoading();

    try {
      const candidates = this.getCandidates();
      let lastErr: any = null;

      for (const path of candidates) {
        const url = this.api(path);

        try {
          const list = await this.fetchWithParamVariants(url, from, to);

          if (seq !== this.reloadSeq) return;

          if (list !== null) {
            this.appointments = list;
            this.page = 1;
            this.safeComputeAll();

            this.hardStopLoading();
            this.toast('success', 'Listo', 'Datos contables actualizados.');
            return;
          }
        } catch (e: any) {
          lastErr = e;
          if (e?.status === 404) continue;
          continue;
        }
      }

      const code = lastErr?.status ? ` (HTTP ${lastErr.status})` : '';
      this.toast('error', 'Error', `No se pudo cargar el listado de turnos${code}. Revisa endpoint y parámetros.`);
      this.appointments = [];
      this.safeComputeAll();

      if (seq === this.reloadSeq) this.hardStopLoading();
    } finally {
      this.endLoading();
      if (seq === this.reloadSeq && this.loading) this.hardStopLoading();
    }
  }

  onDateRangeChanged() {
    this.quick = 'CUSTOM';
  }

  // -----------------------
  // Quick ranges
  // -----------------------
  setQuick(mode: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | 'CUSTOM', autoReload = true) {
    this.quick = mode;

    const today = new Date();
    let from = new Date(today);
    let to = new Date(today);

    if (mode === 'WEEK') {
      from = this.startOfWeek(today);
      to = this.addDays(from, 6);
    } else if (mode === 'MONTH') {
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    } else if (mode === 'YEAR') {
      from = new Date(today.getFullYear(), 0, 1);
      to = new Date(today.getFullYear(), 11, 31);
    } else if (mode === 'CUSTOM') {
      autoReload = false;
    }

    if (mode !== 'CUSTOM') {
      this.filtersForm.patchValue({ from: this.toISODate(from), to: this.toISODate(to) }, { emitEvent: true });
    }

    if (autoReload) void this.reload();
  }

  resetFilters() {
    const currentFrom = this.filtersForm.getRawValue().from || '';
    const currentTo = this.filtersForm.getRawValue().to || '';

    this.filtersForm.reset({
      from: currentFrom,
      to: currentTo,
      groupBy: 'DAY',
      workerId: 0,
      status: 'ALL',
      paymentMethod: 'ALL',
      moneyMode: 'BOTH',
      q: '',
    });

    this.page = 1;
    this.safeComputeAll();
  }

  // -----------------------
  // Computations
  // -----------------------
  private enrichAppointment(a: AppointmentDTO): AppointmentDTO {
    const blocks = a.blocks || [];

    let servicesTotal = 0;
    const workerLabels: string[] = [];
    const workerIds: number[] = [];
    const services: string[] = [];

    for (const b of blocks) {
      const wid = this.getWorkerId((b as any)?.worker);

      if (wid != null) {
        workerIds.push(wid);

        const label = this.getWorkerLabelFromBlock(
          (b as any)?.worker,
          wid,
          (b as any)?.worker_label
        );

        workerLabels.push(label);
      }

      for (const s of b.services || []) {
        if (s?.name) services.push(String(s.name));
        servicesTotal += this.toNumber((s as any)?.price);
      }
    }

    const recommended = this.toNumber(a.recommended_total);
    const generated = recommended > 0 ? recommended : servicesTotal;

    const paidRaw = this.toNumber(a.paid_total);

    const hasPaymentEvidence =
      !!a.paid_at || (a.payment_method != null && String(a.payment_method).trim() !== '') || paidRaw > 0;

    const collected = hasPaymentEvidence ? paidRaw : 0;
    const pending = Math.max(0, generated - collected);

    const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
    const uniqNum = (xs: number[]) => Array.from(new Set(xs.filter((x) => Number.isFinite(x))));

    return {
      ...a,
      payment_method: (a.payment_method ?? null) as PayMethod,

      _generated: this.round2(generated),
      _paid: this.round2(paidRaw),
      _collected: this.round2(collected),
      _pending: this.round2(pending),

      _workers: uniq(workerLabels),
      _workerIds: uniqNum(workerIds),
      _services: uniq(services),
    };
  }

  private safeComputeAll() {
    try {
      this.computeAll();
    } catch (e) {
      console.error('computeAll error:', e);
      this.toast('error', 'UI', 'Ocurrió un error procesando los datos en pantalla.');
      this.filteredAppointments = [];
      this.series = [];
      this.viewAppointments = [];
      this.totalPages = 1;
      this.page = 1;

      this.payrollCategories = [];
      this.payrollBaseTotal = 0;
      this.payrollWorkerTotal = 0;
      this.payrollShopTotal = 0;

      this.hardStopLoading();
    }
  }

  private computeAll() {
    this.applyFilters();
    this.computeKpis();
    this.computeSeries();
    this.computePayroll();
    this.computePager();
  }

  private applyFilters() {
    const v = this.filtersForm.getRawValue();
    const q = (v.q || '').toLowerCase().trim();
    const status = v.status || 'ALL';
    const method = v.paymentMethod || 'ALL';
    const workerId = Number(v.workerId || 0);

    const base = this.appointments || [];

    this.filteredAppointments = base.filter((a) => {
      if (status !== 'ALL' && a.status !== status) return false;

      if (method === 'NONE') {
        if ((a._collected || 0) > 0) return false;
      } else if (method !== 'ALL') {
        if ((a._collected || 0) <= 0) return false;
        if ((a.payment_method || null) !== method) return false;
      }

      if (workerId > 0) {
        const w = this.workers.find((x) => x.id === workerId);
        const ids = (w?.ids && w.ids.length) ? w.ids : [workerId];
        const match = a._workerIds.some((id) => ids.includes(id));
        if (!match) return false;
      }

      if (q) {
        const cn = (a.customer?.name || '').toLowerCase();
        const ph = (a.customer?.phone || '').toLowerCase();
        const id = String(a.id);
        const sv = (a._services || []).join(' ').toLowerCase();
        const wk = (a._workers || []).join(' ').toLowerCase();
        if (!(cn.includes(q) || ph.includes(q) || id.includes(q) || sv.includes(q) || wk.includes(q))) return false;
      }

      return true;
    });

    this.filteredAppointments.sort((a, b) => this.compare(a, b));
  }

  private computeKpis() {
    let gen = 0;
    let col = 0;

    let attended = 0;

    let cash = 0;
    let transfer = 0;
    let card = 0;

    let collectedCount = 0;

    for (const a of this.filteredAppointments) {
      if (a.status === 'ATTENDED') {
        attended++;
        gen += a._generated || 0;

        if ((a._collected || 0) > 0) {
          col += a._collected;
          collectedCount++;

          if (a.payment_method === 'CASH') cash += a._collected;
          if (a.payment_method === 'TRANSFER') transfer += a._collected;
          if (a.payment_method === 'CARD') card += a._collected;
        }
      }
    }

    this.totalGenerated = this.round2(gen);
    this.totalCollected = this.round2(col);
    this.totalPending = this.round2(gen - col);

    this.countAttended = attended;

    this.sumCash = this.round2(cash);
    this.sumTransfer = this.round2(transfer);
    this.sumCard = this.round2(card);

    this.avgTicket = collectedCount > 0 ? this.round2(col / collectedCount) : 0;
  }

  private computeSeries() {
    const v = this.filtersForm.getRawValue();
    const groupBy = (v.groupBy || 'DAY') as 'DAY' | 'WEEK' | 'MONTH';
    const moneyMode = (v.moneyMode || 'BOTH') as 'BOTH' | 'GENERATED' | 'COLLECTED';

    const map = new Map<string, { key: string; label: string; short: string; generated: number; collected: number }>();

    for (const a of this.filteredAppointments) {
      if (a.status !== 'ATTENDED') continue;

      const keyObj = this.groupKey(a.start_datetime, groupBy);
      if (!map.has(keyObj.key)) map.set(keyObj.key, { ...keyObj, generated: 0, collected: 0 });

      const row = map.get(keyObj.key)!;

      if (moneyMode === 'BOTH' || moneyMode === 'GENERATED') row.generated += a._generated || 0;
      if (moneyMode === 'BOTH' || moneyMode === 'COLLECTED') row.collected += a._collected || 0;
    }

    const arr = Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));

    this.series = arr.map((x) => ({
      key: x.key,
      label: x.label,
      short: x.short,
      generated: this.round2(x.generated),
      collected: this.round2(x.collected),
    }));

    let mx = 0;
    for (const s of this.series) mx = Math.max(mx, s.generated, s.collected);
    this.seriesMax = mx;
  }

  // -----------------------
  // Liquidación (por categoría)
  // -----------------------
  private roleKey(role?: string) {
    const r = (role || '').toString().trim();
    return r ? r : 'Sin categoría';
  }

  private loadRolePct() {
    try {
      const raw = localStorage.getItem(this.ROLE_PCT_KEY);
      this.rolePct = raw ? JSON.parse(raw) : {};
    } catch {
      this.rolePct = {};
    }
  }

  private saveRolePct() {
    try {
      localStorage.setItem(this.ROLE_PCT_KEY, JSON.stringify(this.rolePct || {}));
    } catch { }
  }

  private ensureRolePctDefaults() {
    const roles = new Set<string>();
    for (const w of this.workers) roles.add(this.roleKey(w.role));

    for (const r of roles) {
      const v = Number(this.rolePct[r]);
      if (this.rolePct[r] == null || !Number.isFinite(v)) this.rolePct[r] = 50;
    }
    this.saveRolePct();
  }

  setRolePct(role: string, pct: any) {
    const r = this.roleKey(role);
    let v = Number(pct);
    if (!Number.isFinite(v)) v = 0;
    v = Math.max(0, Math.min(100, Math.round(v)));
    this.rolePct[r] = v;
    this.saveRolePct();
    this.computePayroll();
  }

  setPayrollBase(b: PayrollBase) {
    this.payrollBase = b;
    this.computePayroll();
  }

  private computePayroll() {
    const baseMode = this.payrollBase;

    const agg = new Map<number, { attended: number; produced: number; collected: number }>();

    for (const a of this.filteredAppointments || []) {
      if (a.status !== 'ATTENDED') continue;

      const shares = this.computeWorkerShares(a);
      if (!shares.length) continue;

      for (const ws of shares) {
        const id = ws.worker_id;
        if (!agg.has(id)) agg.set(id, { attended: 0, produced: 0, collected: 0 });

        const row = agg.get(id)!;
        row.attended += 1;
        row.produced += (a._generated || 0) * ws.share;
        row.collected += (a._collected || 0) * ws.share;
      }
    }

    const rows: PayrollRow[] = [];
    for (const [id, v] of agg.entries()) {
      const role = this.workerRoleById(id);
      const pct = Number(this.rolePct[role] ?? 50);

      const produced = this.round2(v.produced);
      const collected = this.round2(v.collected);
      const base = baseMode === 'COLLECTED' ? collected : produced;

      const workerPay = this.round2(base * (pct / 100));
      const shopGain = this.round2(base - workerPay);

      const label = this.workerLabelById(id);

      rows.push({
        worker_id: id,
        worker_label: label,
        role,
        attended: v.attended,
        produced,
        collected,
        base,
        pct,
        workerPay,
        shopGain,
      });
    }

    const byRole = new Map<string, PayrollCategory>();

    for (const r of rows) {
      const role = this.roleKey(r.role);
      if (!byRole.has(role)) {
        const pct = Number(this.rolePct[role] ?? 50);
        byRole.set(role, {
          role,
          pct,
          workers: [],
          producedTotal: 0,
          collectedTotal: 0,
          baseTotal: 0,
          workerPayTotal: 0,
          shopGainTotal: 0,
        });
      }

      const cat = byRole.get(role)!;
      cat.workers.push(r);

      cat.producedTotal += r.produced;
      cat.collectedTotal += r.collected;
      cat.baseTotal += r.base;
      cat.workerPayTotal += r.workerPay;
      cat.shopGainTotal += r.shopGain;
    }

    const cats = Array.from(byRole.values()).map((c) => {
      c.producedTotal = this.round2(c.producedTotal);
      c.collectedTotal = this.round2(c.collectedTotal);
      c.baseTotal = this.round2(c.baseTotal);
      c.workerPayTotal = this.round2(c.workerPayTotal);
      c.shopGainTotal = this.round2(c.shopGainTotal);
      c.workers.sort((a, b) => b.base - a.base);
      return c;
    });

    cats.sort((a, b) => b.baseTotal - a.baseTotal);
    this.payrollCategories = cats;

    this.payrollBaseTotal = this.round2(cats.reduce((acc, c) => acc + c.baseTotal, 0));
    this.payrollWorkerTotal = this.round2(cats.reduce((acc, c) => acc + c.workerPayTotal, 0));
    this.payrollShopTotal = this.round2(cats.reduce((acc, c) => acc + c.shopGainTotal, 0));

    this.mark();
  }

  private computeWorkerShares(a: AppointmentDTO): Array<{ worker_id: number; share: number }> {
    const blocks = a.blocks || [];
    const bases = new Map<number, number>();

    for (const b of blocks) {
      const wid = this.getWorkerId((b as any)?.worker);
      if (wid == null) continue;

      let base = 0;
      for (const s of b.services || []) base += this.toNumber((s as any).price);
      bases.set(wid, (bases.get(wid) || 0) + base);
    }

    const workerIds = Array.from(
      new Set(
        blocks
          .map((x: any) => this.getWorkerId(x?.worker))
          .filter((x): x is number => x != null)
      )
    );

    const n = workerIds.length;
    if (n === 0) return [];

    const totalBase = Array.from(bases.values()).reduce((acc, x) => acc + (x || 0), 0);

    if (totalBase <= 0) {
      const eq = 1 / n;
      return workerIds.map((id) => ({ worker_id: id, share: eq }));
    }

    return workerIds.map((id) => ({ worker_id: id, share: (bases.get(id) || 0) / totalBase }));
  }

  // -----------------------
  // Pager
  // -----------------------
  private computePager() {
    const total = this.filteredAppointments.length;
    this.totalPages = Math.max(1, Math.ceil(total / this.pageSize));
    this.page = Math.min(this.page, this.totalPages);

    const start = (this.page - 1) * this.pageSize;
    const end = start + this.pageSize;

    this.viewAppointments = this.filteredAppointments.slice(start, end);
  }

  prevPage() {
    this.page = Math.max(1, this.page - 1);
    this.computePager();
  }
  nextPage() {
    this.page = Math.min(this.totalPages, this.page + 1);
    this.computePager();
  }
  setPageSize(n: unknown) {
    this.pageSize = Number(n || 20);
    this.page = 1;
    this.computePager();
  }

  toggleDetails() {
    this.showDetails = !this.showDetails;
  }

  // -----------------------
  // Sorting
  // -----------------------
  setSort(key: 'date' | 'customer' | 'status' | 'generated' | 'collected' | 'pending') {
    if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      this.sortKey = key;
      this.sortDir = key === 'date' ? 'desc' : 'asc';
    }
    this.filteredAppointments.sort((a, b) => this.compare(a, b));
    this.computePager();
  }

  private compare(a: AppointmentDTO, b: AppointmentDTO) {
    const dir = this.sortDir === 'asc' ? 1 : -1;
    const va = this.sortValue(a);
    const vb = this.sortValue(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  }

  private sortValue(a: AppointmentDTO): string | number {
    if (this.sortKey === 'date') return new Date(a.start_datetime).getTime();
    if (this.sortKey === 'customer') return (a.customer?.name || '').toLowerCase();
    if (this.sortKey === 'status') return (a.status || '').toString();
    if (this.sortKey === 'generated') return a._generated || 0;
    if (this.sortKey === 'collected') return a._collected || 0;
    if (this.sortKey === 'pending') return a._pending || 0;
    return 0;
  }

  // -----------------------
  // CSV export
  // -----------------------
  exportCsv() {
    if (!this.filteredAppointments.length) {
      this.toast('info', 'Exportar', 'No hay datos para exportar.');
      return;
    }

    const rows = this.filteredAppointments.map((a) => ({
      id: a.id,
      status: a.status,
      start: a.start_datetime,
      end: a.end_datetime,
      customer: a.customer?.name || '',
      workers: (a._workers || []).join(' | '),
      services: (a._services || []).join(' | '),
      generated_total: a._generated || 0,
      collected_total: a._collected || 0,
      pending_total: a._pending || 0,
      payment_method: a.payment_method || '',
      paid_at: a.paid_at || '',
    }));

    const headers = Object.keys(rows[0] || {});
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => esc((r as any)[h])).join(','))].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `contabilidad_${this.filtersForm.getRawValue().from}_${this.filtersForm.getRawValue().to}.csv`;
    a.click();

    URL.revokeObjectURL(url);
    this.toast('success', 'Exportado', 'CSV generado.');
  }

  // -----------------------
  // UI helpers
  // -----------------------
  labelStatus(s: Status) {
    if (s === 'ATTENDED') return 'Atendido';
    if (s === 'RESERVED') return 'Reservado';
    if (s === 'CANCELLED') return 'Cancelado';
    if (s === 'NO_SHOW') return 'No show';
    return s;
  }

  labelMethod(m: PayMethod | undefined) {
    if (m === 'CASH') return 'Efectivo';
    if (m === 'TRANSFER') return 'Transferencia';
    if (m === 'CARD') return 'Tarjeta';
    return '—';
  }

  money(n: number | null | undefined) {
    const v = Number(n || 0);
    try {
      return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
    } catch {
      return `$ ${Math.round(v)}`;
    }
  }

  pct(v: number, max: number) {
    if (!max || max <= 0) return 0;
    return Math.max(0, Math.min(100, (v / max) * 100));
  }

  fmtDate(iso: string) {
    const d = new Date(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  fmtTime(iso: string) {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  // -----------------------
  // Grouping
  // -----------------------
  private groupKey(iso: string, mode: 'DAY' | 'WEEK' | 'MONTH') {
    const d = new Date(iso);

    if (mode === 'DAY') {
      const key = this.toISODate(d);
      return { key, label: key, short: key.slice(5) };
    }

    if (mode === 'MONTH') {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return { key, label: key, short: key };
    }

    const monday = this.startOfWeek(d);
    const key = this.toISODate(monday);
    return { key, label: `Semana ${key}`, short: key.slice(5) };
  }

  // -----------------------
  // Time/date helpers
  // -----------------------
  private startOfWeek(d: Date) {
    const x = new Date(d);
    const day = x.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // lunes
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private addDays(d: Date, n: number) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  private toISODate(d: Date) {
    const x = new Date(d);
    const yyyy = x.getFullYear();
    const mm = String(x.getMonth() + 1).padStart(2, '0');
    const dd = String(x.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // -----------------------
  // Numbers
  // -----------------------
  private toNumber(v: unknown): number {
    if (v == null) return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const s = String(v).replace(',', '.').replace(/[^\d.]/g, '').trim();
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  private round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  // -----------------------
  // toast
  // -----------------------
  private toast(type: Toast['type'], title: string, message: string) {
    const id = this.toastSeq++;
    this.toasts.push({ id, type, title, message });
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), 3200);
  }
}
