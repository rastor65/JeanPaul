import { CommonModule, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  PLATFORM_ID,
  inject,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom, Subject } from 'rxjs';
import { takeUntil, timeout } from 'rxjs/operators';

import { StaffingAdminApi } from '../../core/api/staffing-admin.api';

type ExType = 'TIME_OFF' | 'EXTRA_WORKING';

interface WorkerItem {
  id: number;
  label: string;      // lo que se muestra (nombre final)
  role?: string;      // BARBER | NAILS | FACIAL | ...
  active?: boolean;

  // opcionales si tu API los trae (para armar label)
  name?: string;
  full_name?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface ScheduleRule {
  id: number;
  worker: number;
  day_of_week: number; // 0..6 (Lunes..Domingo)
  start_time: string;  // "HH:MM"
  end_time: string;    // "HH:MM"
  active: boolean;
}

interface BreakItem {
  id: number;
  worker: number;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

interface ExceptionItem {
  id: number;
  worker: number;
  date: string; // "YYYY-MM-DD"
  type: ExType;
  start_time?: string | null;
  end_time?: string | null;
  note?: string;
}

interface Toast {
  id: number;
  type: 'success' | 'error' | 'info';
  title: string;
  message: string;
}

type TimelineKind = 'FREE' | 'CLOSED' | 'BREAK' | 'OFF' | 'BOOKED';

interface TimelineCell {
  kind: TimelineKind;
  title: string;
}

type WeekTemplateId = 'WEEKDAYS_9_19' | 'WEEKDAYS_10_20' | 'ALLDAYS_9_19';

@Component({
  selector: 'app-horarios',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './horarios.html',
  styleUrls: ['./horarios.scss'],
})
export class HorariosComponent implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private platformId = inject(PLATFORM_ID);
  private api = inject(StaffingAdminApi);
  private cdr = inject(ChangeDetectorRef);

  private destroy$ = new Subject<void>();

  // ===== LOADER robusto (token) =====
  loading = false;
  private loadingToken = 0;
  private loadingFailSafe: any = null;

  private readonly REQ_TIMEOUT_MS = 12000;
  private readonly FAILSAFE_MS = 20000;

  workers: WorkerItem[] = [];
  filteredWorkers: WorkerItem[] = [];
  roleLabels: Record<string, string> = {
    BARBER: 'Barberos',
    NAILS: 'Uñas',
    FACIAL: 'Facial',
    STAFF: 'Personal',
    ADMIN: 'Administración',
    OTHER: 'Otros',
  };

  roleOrder: string[] = ['BARBER', 'NAILS', 'FACIAL', 'STAFF', 'ADMIN', 'OTHER'];

  workerGroups: Array<{ role: string; title: string; workers: WorkerItem[]; count: number }> = [];

  selectedWorker: WorkerItem | null = null;

  viewMode: 'WEEK' | 'EXCEPTIONS' | 'SIMULATOR' = 'WEEK';

  weekStart = this.startOfWeek(new Date()); // lunes
  weekDays: { dow: number; date: Date; iso: string; label: string; short: string }[] = [];

  rules: ScheduleRule[] = [];
  breaks: BreakItem[] = [];
  exceptions: ExceptionItem[] = [];

  // ===== Timeline =====
  timelineStartMin = 8 * 60;   // 08:00
  timelineEndMin = 20 * 60;    // 20:00
  timelineStepMin = 15;        // 15 min
  timelineCellsCount = 0;
  timelineStartLabel = '08:00';
  timelineEndLabel = '20:00';

  timelinesByIso: Record<string, TimelineCell[]> = {};
  defaultTimelineCells: TimelineCell[] = [];

  // ===== forms =====
  filterForm = this.fb.group({
    q: [''],
    role: ['ALL'],
    active: ['ALL'],
  });

  bulkForm = this.fb.group({
    days: this.fb.group({
      0: [true],
      1: [true],
      2: [true],
      3: [true],
      4: [true],
      5: [false],
      6: [false],
    }),
    start_time: ['09:00', [Validators.required]],
    end_time: ['19:00', [Validators.required]],
    active: [true],
  });

  categoryBulkForm = this.fb.group({
    role: ['BARBER', [Validators.required]],
    overwrite_existing: [true], // true = actualiza si existe; false = solo crea si no existe
    only_active: [true],        // aplica solo a trabajadores activos
    days: this.fb.group({
      0: [true],
      1: [true],
      2: [true],
      3: [true],
      4: [true],
      5: [false],
      6: [false],
    }),
    start_time: ['09:00', [Validators.required]],
    end_time: ['19:00', [Validators.required]],
    active: [true],
  });


  ruleForm = this.fb.group({
    id: [0],
    day_of_week: [0, [Validators.required]],
    start_time: ['09:00', [Validators.required]],
    end_time: ['19:00', [Validators.required]],
    active: [true],
  });

  breakForm = this.fb.group({
    id: [0],
    day_of_week: [0, [Validators.required]],
    start_time: ['13:00', [Validators.required]],
    end_time: ['14:00', [Validators.required]],
  });

  exceptionForm = this.fb.group({
    id: [0],
    date: ['', [Validators.required]],
    type: ['TIME_OFF' as ExType, [Validators.required]],
    start_time: [''],
    end_time: [''],
    note: [''],
  });

  copyForm = this.fb.group({
    target_worker_id: [0, [Validators.required]],
    copy_breaks: [true],
    overwrite: [false],
  });

  // ===== drawer / confirm / toasts =====
  drawerOpen = false;
  drawerTitle = '';
  drawerMode: 'RULE' | 'BREAK' | 'EXCEPTION' | 'BULK' | 'COPY' | 'BULK_CATEGORY' = 'RULE';

  confirmOpen = false;
  confirmTitle = '';
  confirmText = '';
  confirmAction: (() => void) | null = null;

  toasts: Toast[] = [];
  private toastSeq = 1;

  // Para ignorar respuestas viejas si cambias rápido de trabajador
  private bundleReqId = 0;

  // ===== Presets para UX (rápido y sin errores) =====
  rulePresets: Array<{ label: string; start: string; end: string }> = [
    { label: '08:00–18:00', start: '08:00', end: '18:00' },
    { label: '09:00–19:00', start: '09:00', end: '19:00' },
    { label: '10:00–20:00', start: '10:00', end: '20:00' },
  ];

  breakPresets: Array<{ label: string; start: string; end: string }> = [
    { label: '12:30–13:30', start: '12:30', end: '13:30' },
    { label: '13:00–14:00', start: '13:00', end: '14:00' },
    { label: '15:00–15:15', start: '15:00', end: '15:15' },
  ];

  ngOnInit(): void {
    this.buildWeekDays();
    this.initTimelineDefaults();

    if (!isPlatformBrowser(this.platformId)) return;

    this.loadWorkers();

    this.filterForm.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.applyWorkerFilters();
        this.cdr.markForCheck();
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();

    this.loading = false;
    this.loadingToken++;
    if (this.loadingFailSafe) clearTimeout(this.loadingFailSafe);
  }

  // ---------------------------
  // LOADER (token) + failsafe + CD
  // ---------------------------
  private beginLoading(): number {
    const token = ++this.loadingToken;
    this.loading = true;

    if (this.loadingFailSafe) clearTimeout(this.loadingFailSafe);
    this.loadingFailSafe = setTimeout(() => {
      if (token === this.loadingToken && this.loading) {
        this.loading = false;
        this.toast('error', 'Tiempo de espera', 'La pantalla tardó demasiado. Revisa consola/network.');
        this.cdr.markForCheck();
      }
    }, this.FAILSAFE_MS);

    this.cdr.markForCheck();
    return token;
  }

  private endLoading(token: number) {
    if (token !== this.loadingToken) return;
    this.loading = false;
    if (this.loadingFailSafe) clearTimeout(this.loadingFailSafe);
    this.cdr.markForCheck();
  }

  private async withLoading<T>(fn: () => Promise<T>): Promise<T> {
    const t = this.beginLoading();
    try {
      return await fn();
    } finally {
      this.endLoading(t);
    }
  }

  private async httpOnce<T>(label: string, obs: any): Promise<T> {
    try {
      return await firstValueFrom(obs.pipe(timeout(this.REQ_TIMEOUT_MS)));
    } catch {
      throw new Error(label);
    }
  }

  openCategoryBulk(role?: string) {
    this.drawerMode = 'BULK_CATEGORY';
    this.drawerTitle = 'Acción masiva · Por categoría';

    const finalRole = role || 'BARBER';
    this.categoryBulkForm.patchValue({ role: finalRole });

    this.drawerOpen = true;
    this.cdr.markForCheck();
  }

  async applyCategoryBulk() {
    const v = this.categoryBulkForm.getRawValue();

    if (!this.validTimeRange(v.start_time!, v.end_time!)) {
      this.toast('error', 'Validación', 'La hora de fin debe ser mayor que la de inicio.');
      return;
    }

    const daysGroup: any = (this.categoryBulkForm.get('days') as any)?.value || {};
    const selectedDays = Object.keys(daysGroup).filter(k => !!daysGroup[k]).map(k => Number(k));

    if (!selectedDays.length) {
      this.toast('info', 'Acción masiva', 'Selecciona al menos un día.');
      return;
    }

    const role = v.role || 'OTHER';

    // trabajadores destino
    const targets = this.workers.filter(w => {
      const matchRole = (w.role || 'OTHER') === role;
      const matchActive = !v.only_active || w.active !== false;
      return matchRole && matchActive;
    });

    if (!targets.length) {
      this.toast('info', 'Acción masiva', 'No hay trabajadores en esa categoría con esos filtros.');
      return;
    }

    await this.withLoading(async () => {
      let okWorkers = 0;
      let skipped = 0;
      let failed = 0;

      for (const w of targets) {
        try {
          const existingRules = await this.httpOnce<ScheduleRule[]>('listRules', this.api.listRules(w.id));
          const map = new Map<number, ScheduleRule>();
          for (const r of (existingRules || [])) map.set(r.day_of_week, r);

          for (const dow of selectedDays) {
            const exist = map.get(dow);

            const payload = {
              day_of_week: dow,
              start_time: v.start_time!,
              end_time: v.end_time!,
              active: !!v.active,
            };

            if (exist) {
              if (!v.overwrite_existing) {
                skipped++;
                continue;
              }
              await this.httpOnce('updateRule', this.api.updateRule(w.id, exist.id, payload));
            } else {
              await this.httpOnce('createRule', this.api.createRule(w.id, payload));
            }
          }

          okWorkers++;
        } catch {
          failed++;
        }
      }

      this.toast(
        failed ? 'info' : 'success',
        'Acción masiva',
        `Categoría: ${this.roleLabels[role] || role}. Aplicado a ${okWorkers}. Saltados: ${skipped}. Fallos: ${failed}.`
      );

      this.drawerOpen = false;

      // si el trabajador seleccionado pertenece a esa categoría, refresca vista
      if (this.selectedWorker && (this.selectedWorker.role || 'OTHER') === role) {
        await this.loadScheduleBundle();
      }
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo aplicar la acción masiva por categoría.');
    });
  }

  // ---------------------------
  // load
  // ---------------------------
  async loadWorkers() {
    await this.withLoading(async () => {
      const data = await this.httpOnce<WorkerItem[]>('workers', this.api.listWorkers());

      this.workers = (data || []).map((w: any) => ({
        ...w,
        label: this.normalizeWorkerLabel(w),
        role: w.role || 'OTHER',
      })) as any;

      this.applyWorkerFilters();

      // Auto-selección del primero
      if (!this.selectedWorker && this.filteredWorkers.length) {
        await this.selectWorker(this.filteredWorkers[0]);
      }

      this.cdr.markForCheck();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudieron cargar los trabajadores.');
    });
  }

  async loadScheduleBundle() {
    if (!this.selectedWorker) return;

    const workerId = this.selectedWorker.id;
    const reqId = ++this.bundleReqId;

    await this.withLoading(async () => {
      const pRules = this.httpOnce<ScheduleRule[]>('rules', this.api.listRules(workerId));
      const pBreaks = this.httpOnce<BreakItem[]>('breaks', this.api.listBreaks(workerId));
      const pExceptions = this.httpOnce<ExceptionItem[]>('exceptions', this.api.listExceptions(workerId));

      const results = await Promise.allSettled([pRules, pBreaks, pExceptions]);

      if (reqId !== this.bundleReqId) return;

      const failed: string[] = [];

      if (results[0].status === 'fulfilled') this.rules = (results[0].value || []) as any;
      else { this.rules = []; failed.push('reglas'); }

      if (results[1].status === 'fulfilled') this.breaks = (results[1].value || []) as any;
      else { this.breaks = []; failed.push('descansos'); }

      if (results[2].status === 'fulfilled') this.exceptions = (results[2].value || []) as any;
      else { this.exceptions = []; failed.push('excepciones'); }

      if (failed.length) {
        this.toast('error', 'Carga parcial', `No se pudo cargar: ${failed.join(', ')}.`);
      }

      this.rebuildTimelines();
      this.cdr.markForCheck();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudieron cargar los horarios.');
    });
  }

  // ---------------------------
  // filtering
  // ---------------------------
  applyWorkerFilters() {
    const v = this.filterForm.getRawValue();
    const q = (v.q || '').toLowerCase().trim();
    const role = v.role || 'ALL';
    const active = v.active || 'ALL';

    this.filteredWorkers = this.workers.filter(w => {
      const matchQ = !q || (w.label || '').toLowerCase().includes(q);
      const matchRole = role === 'ALL' || (w.role === role);
      const matchActive =
        active === 'ALL' ||
        (active === 'ACTIVE' ? w.active !== false : w.active === false);

      return matchQ && matchRole && matchActive;
    });
    this.buildWorkerGroups();
  }

  private buildWorkerGroups() {
    const byRole = new Map<string, WorkerItem[]>();

    for (const w of this.filteredWorkers) {
      const r = w.role || 'OTHER';
      if (!byRole.has(r)) byRole.set(r, []);
      byRole.get(r)!.push(w);
    }

    // Ordenar por nombre dentro de cada grupo
    for (const [r, arr] of byRole.entries()) {
      arr.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
      byRole.set(r, arr);
    }

    // Construir grupos en orden fijo
    const groups: Array<{ role: string; title: string; workers: WorkerItem[]; count: number }> = [];

    for (const r of this.roleOrder) {
      const arr = byRole.get(r) || [];
      if (arr.length) {
        groups.push({
          role: r,
          title: this.roleLabels[r] || r,
          workers: arr,
          count: arr.length,
        });
      }
    }

    // Roles no previstos
    for (const [r, arr] of byRole.entries()) {
      if (this.roleOrder.includes(r)) continue;
      groups.push({ role: r, title: this.roleLabels[r] || r, workers: arr, count: arr.length });
    }

    this.workerGroups = groups;
  }

  private normalizeWorkerLabel(w: any): string {
    const fromApi =
      w?.label ||
      w?.full_name ||
      w?.name ||
      (w?.first_name || w?.last_name ? `${w?.first_name || ''} ${w?.last_name || ''}`.trim() : '') ||
      w?.username;

    const finalName = (fromApi || `Trabajador ${w?.id ?? ''}`).trim();
    return finalName || `Trabajador ${w?.id ?? ''}`;
  }

  async selectWorker(w: WorkerItem) {
    if (this.selectedWorker?.id === w.id) return;

    this.selectedWorker = w;
    this.viewMode = 'WEEK';

    this.bundleReqId++;
    this.cdr.markForCheck();
    await this.loadScheduleBundle();
  }

  // ---------------------------
  // week nav
  // ---------------------------
  async prevWeek() {
    this.weekStart = this.addDays(this.weekStart, -7);
    this.buildWeekDays();
    this.rebuildTimelines();
    this.cdr.markForCheck();
    await this.loadScheduleBundle();
  }

  async nextWeek() {
    this.weekStart = this.addDays(this.weekStart, 7);
    this.buildWeekDays();
    this.rebuildTimelines();
    this.cdr.markForCheck();
    await this.loadScheduleBundle();
  }

  async goToday() {
    this.weekStart = this.startOfWeek(new Date());
    this.buildWeekDays();
    this.rebuildTimelines();
    this.cdr.markForCheck();
    await this.loadScheduleBundle();
  }

  onPickWeekStart(ev: Event) {
    const val = (ev.target as HTMLInputElement).value;
    if (!val) return;

    const d = new Date(val + 'T00:00:00');
    this.weekStart = this.startOfWeek(d);
    this.buildWeekDays();
    this.rebuildTimelines();
    this.cdr.markForCheck();
    this.loadScheduleBundle();
  }

  // ---------------------------
  // getters
  // ---------------------------
  ruleForDow(dow: number): ScheduleRule | null {
    return this.rules.find(r => r.day_of_week === dow) || null;
  }

  breaksForDow(dow: number): BreakItem[] {
    return this.breaks
      .filter(b => b.day_of_week === dow)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  }

  exceptionsForISO(iso: string): ExceptionItem[] {
    return this.exceptions
      .filter(e => e.date === iso)
      .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  }

  dayHasAnything(dow: number, iso: string) {
    const r = this.ruleForDow(dow);
    const b = this.breaksForDow(dow).length;
    const e = this.exceptionsForISO(iso).length;
    return !!r || b > 0 || e > 0;
  }

  // ---------------------------
  // drawer openers
  // ---------------------------
  openRuleEditor(dow: number) {
    const existing = this.ruleForDow(dow);
    this.drawerMode = 'RULE';
    this.drawerTitle = existing
      ? `Editar jornada · ${this.dayLabel(dow)}`
      : `Crear jornada · ${this.dayLabel(dow)}`;

    this.ruleForm.reset({
      id: existing?.id || 0,
      day_of_week: dow,
      start_time: existing?.start_time || '09:00',
      end_time: existing?.end_time || '19:00',
      active: existing?.active ?? true,
    });

    this.drawerOpen = true;
    this.cdr.markForCheck();
  }

  openBreakEditor(dow: number, item?: BreakItem) {
    this.drawerMode = 'BREAK';
    this.drawerTitle = item
      ? `Editar descanso · ${this.dayLabel(dow)}`
      : `Agregar descanso · ${this.dayLabel(dow)}`;

    this.breakForm.reset({
      id: item?.id || 0,
      day_of_week: dow,
      start_time: item?.start_time || '13:00',
      end_time: item?.end_time || '14:00',
    });

    this.drawerOpen = true;
    this.cdr.markForCheck();
  }

  openExceptionEditor(iso: string, item?: ExceptionItem) {
    this.drawerMode = 'EXCEPTION';
    this.drawerTitle = item ? `Editar excepción · ${iso}` : `Agregar excepción · ${iso}`;

    this.exceptionForm.reset({
      id: item?.id || 0,
      date: iso,
      type: (item?.type || 'TIME_OFF') as ExType,
      start_time: item?.start_time || '',
      end_time: item?.end_time || '',
      note: item?.note || '',
    });

    this.drawerOpen = true;
    this.cdr.markForCheck();
  }

  openBulk(preset?: { days?: number[]; start?: string; end?: string; active?: boolean }) {
    this.drawerMode = 'BULK';
    this.drawerTitle = 'Acción masiva · Aplicar jornada';

    if (preset) {
      if (preset.start) this.bulkForm.patchValue({ start_time: preset.start });
      if (preset.end) this.bulkForm.patchValue({ end_time: preset.end });
      if (typeof preset.active === 'boolean') this.bulkForm.patchValue({ active: preset.active });

      if (preset.days) {
        const g = this.bulkForm.get('days') as any;
        for (let i = 0; i < 7; i++) g.get(String(i))?.setValue(preset.days.includes(i));
      }
    }

    this.drawerOpen = true;
    this.cdr.markForCheck();
  }

  openCopyWeek() {
    this.drawerMode = 'COPY';
    this.drawerTitle = 'Copiar semana a otro trabajador';
    this.copyForm.reset({ target_worker_id: 0, copy_breaks: true, overwrite: false });
    this.drawerOpen = true;
    this.cdr.markForCheck();
  }

  closeDrawer() {
    this.drawerOpen = false;
    this.cdr.markForCheck();
  }

  // ---------------------------
  // QUICK UX helpers (presets)
  // ---------------------------
  setRulePreset(start: string, end: string) {
    this.ruleForm.patchValue({ start_time: start, end_time: end, active: true });
    this.cdr.markForCheck();
  }

  setRuleClosed() {
    this.ruleForm.patchValue({ active: false });
    this.cdr.markForCheck();
  }

  setBreakPreset(start: string, end: string) {
    this.breakForm.patchValue({ start_time: start, end_time: end });
    this.cdr.markForCheck();
  }

  setExceptionFullDay() {
    this.exceptionForm.patchValue({ start_time: '', end_time: '' });
    this.cdr.markForCheck();
  }

  setExceptionPreset(start: string, end: string) {
    this.exceptionForm.patchValue({ start_time: start, end_time: end });
    this.cdr.markForCheck();
  }

  bulkSelectDays(kind: 'WEEKDAYS' | 'ALL' | 'WEEKEND' | 'NONE') {
    const g = this.bulkForm.get('days') as any;
    const set = (arr: number[]) => {
      for (let i = 0; i < 7; i++) g.get(String(i))?.setValue(arr.includes(i));
    };
    if (kind === 'WEEKDAYS') set([0, 1, 2, 3, 4]);
    if (kind === 'WEEKEND') set([5, 6]);
    if (kind === 'ALL') set([0, 1, 2, 3, 4, 5, 6]);
    if (kind === 'NONE') set([]);
    this.cdr.markForCheck();
  }

  askApplyWeekTemplate(t: WeekTemplateId) {
    const label =
      t === 'WEEKDAYS_9_19' ? 'Lun–Vie (09:00–19:00)' :
        t === 'WEEKDAYS_10_20' ? 'Lun–Vie (10:00–20:00)' :
          'Lun–Dom (09:00–19:00)';

    this.confirmTitle = 'Aplicar plantilla';
    this.confirmText = `Se aplicará la plantilla "${label}" (crea/actualiza jornadas).`;
    this.confirmAction = async () => { await this.applyWeekTemplate(t); };
    this.confirmOpen = true;
    this.cdr.markForCheck();
  }

  private async applyWeekTemplate(t: WeekTemplateId) {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    const days = t === 'ALLDAYS_9_19' ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4];
    const start = (t === 'WEEKDAYS_10_20') ? '10:00' : '09:00';
    const end = (t === 'WEEKDAYS_10_20') ? '20:00' : '19:00';

    await this.withLoading(async () => {
      for (const dow of days) {
        const existing = this.ruleForDow(dow);
        const payload = { day_of_week: dow, start_time: start, end_time: end, active: true };
        if (existing) {
          await this.httpOnce('tplUpdateRule', this.api.updateRule(workerId, existing.id, payload));
        } else {
          await this.httpOnce('tplCreateRule', this.api.createRule(workerId, payload));
        }
      }
      this.toast('success', 'Aplicado', 'Plantilla aplicada correctamente.');
      this.confirmOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo aplicar la plantilla.');
    });
  }

  askCopyPreviousDay(dow: number) {
    if (dow <= 0) return;

    const from = dow - 1;
    this.confirmTitle = 'Copiar jornada';
    this.confirmText = `Se copiará la jornada de ${this.dayLabel(from)} a ${this.dayLabel(dow)} (sobrescribe la jornada del día destino).`;
    this.confirmAction = async () => { await this.copyDayRule(from, dow); };
    this.confirmOpen = true;
    this.cdr.markForCheck();
  }

  private async copyDayRule(fromDow: number, toDow: number) {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    const from = this.ruleForDow(fromDow);
    if (!from) {
      this.toast('info', 'Copiar', `No hay jornada en ${this.dayLabel(fromDow)}.`);
      return;
    }

    await this.withLoading(async () => {
      const to = this.ruleForDow(toDow);
      const payload = { day_of_week: toDow, start_time: from.start_time, end_time: from.end_time, active: from.active };

      if (to) {
        await this.httpOnce('copyUpdateRule', this.api.updateRule(workerId, to.id, payload));
      } else {
        await this.httpOnce('copyCreateRule', this.api.createRule(workerId, payload));
      }

      this.toast('success', 'Copiado', `Jornada copiada a ${this.dayLabel(toDow)}.`);
      this.confirmOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo copiar la jornada.');
    });
  }

  // ---------------------------
  // CRUD rules/breaks/exceptions
  // ---------------------------
  async saveRule() {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    const v = this.ruleForm.getRawValue();
    if (!this.validTimeRange(v.start_time!, v.end_time!)) {
      this.toast('error', 'Validación', 'La hora de fin debe ser mayor que la de inicio.');
      return;
    }

    await this.withLoading(async () => {
      const payload = {
        day_of_week: Number(v.day_of_week),
        start_time: v.start_time!,
        end_time: v.end_time!,
        active: !!v.active,
      };

      if ((v.id || 0) > 0) {
        await this.httpOnce('updateRule', this.api.updateRule(workerId, Number(v.id), payload));
      } else {
        await this.httpOnce('createRule', this.api.createRule(workerId, payload));
      }

      this.toast('success', 'Guardado', 'Jornada actualizada.');
      this.drawerOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo guardar la jornada.');
    });
  }

  async saveBreak() {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    const v = this.breakForm.getRawValue();
    if (!this.validTimeRange(v.start_time!, v.end_time!)) {
      this.toast('error', 'Validación', 'El descanso debe tener fin mayor que inicio.');
      return;
    }

    const dow = Number(v.day_of_week);
    const rule = this.ruleForDow(dow);
    if (!rule || !rule.active) {
      this.toast('info', 'Primero define la jornada', 'Para crear descansos, crea una jornada activa para ese día.');
      return;
    }

    if (!this.isInside(v.start_time!, v.end_time!, rule.start_time, rule.end_time)) {
      this.toast('error', 'Validación', 'El descanso debe estar dentro del horario laboral.');
      return;
    }

    await this.withLoading(async () => {
      const payload = {
        day_of_week: dow,
        start_time: v.start_time!,
        end_time: v.end_time!,
      };

      if ((v.id || 0) > 0) {
        await this.httpOnce('updateBreak', this.api.updateBreak(workerId, Number(v.id), payload));
      } else {
        await this.httpOnce('createBreak', this.api.createBreak(workerId, payload));
      }

      this.toast('success', 'Guardado', 'Descanso actualizado.');
      this.drawerOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo guardar el descanso.');
    });
  }

  async saveException() {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    const v = this.exceptionForm.getRawValue();
    const type = v.type as ExType;

    const hasHours = !!(v.start_time && v.end_time);
    if (hasHours && !this.validTimeRange(v.start_time!, v.end_time!)) {
      this.toast('error', 'Validación', 'La excepción por rango requiere fin mayor que inicio.');
      return;
    }

    await this.withLoading(async () => {
      const payload = {
        date: v.date!,
        type,
        start_time: hasHours ? v.start_time : null,
        end_time: hasHours ? v.end_time : null,
        note: v.note || '',
      };

      if ((v.id || 0) > 0) {
        await this.httpOnce('updateException', this.api.updateException(workerId, Number(v.id), payload));
      } else {
        await this.httpOnce('createException', this.api.createException(workerId, payload));
      }

      this.toast('success', 'Guardado', 'Excepción actualizada.');
      this.drawerOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo guardar la excepción.');
    });
  }

  // ---------------------------
  // bulk apply
  // ---------------------------
  async applyBulk() {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    const v = this.bulkForm.getRawValue();
    if (!this.validTimeRange(v.start_time!, v.end_time!)) {
      this.toast('error', 'Validación', 'La hora de fin debe ser mayor que la de inicio.');
      return;
    }

    const daysGroup: any = (this.bulkForm.get('days') as any)?.value || {};
    const selectedDays = Object.keys(daysGroup).filter(k => !!daysGroup[k]).map(k => Number(k));

    if (!selectedDays.length) {
      this.toast('info', 'Acción masiva', 'Selecciona al menos un día.');
      return;
    }

    await this.withLoading(async () => {
      for (const dow of selectedDays) {
        const existing = this.ruleForDow(dow);
        const payload = {
          day_of_week: dow,
          start_time: v.start_time!,
          end_time: v.end_time!,
          active: !!v.active,
        };

        if (existing) {
          await this.httpOnce('bulkUpdateRule', this.api.updateRule(workerId, existing.id, payload));
        } else {
          await this.httpOnce('bulkCreateRule', this.api.createRule(workerId, payload));
        }
      }

      this.toast('success', 'Aplicado', 'Jornada aplicada a los días seleccionados.');
      this.drawerOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo aplicar la jornada masiva.');
    });
  }

  // ---------------------------
  // copy week
  // ---------------------------
  async copyWeek() {
    if (!this.selectedWorker) return;
    const fromId = this.selectedWorker.id;

    const v = this.copyForm.getRawValue();
    const toId = Number(v.target_worker_id);

    if (!toId || toId === fromId) {
      this.toast('info', 'Copiar', 'Selecciona un trabajador destino válido.');
      return;
    }

    await this.withLoading(async () => {
      const [toRules, toBreaks] = await Promise.all([
        this.httpOnce<ScheduleRule[]>('toRules', this.api.listRules(toId)),
        this.httpOnce<BreakItem[]>('toBreaks', this.api.listBreaks(toId)),
      ]);

      if (v.overwrite) {
        for (const r of (toRules || []) as any[]) {
          await this.httpOnce('deleteRule', this.api.deleteRule(toId, r.id));
        }
        for (const b of (toBreaks || []) as any[]) {
          await this.httpOnce('deleteBreak', this.api.deleteBreak(toId, b.id));
        }
      }

      for (const r of this.rules) {
        await this.httpOnce('createRule', this.api.createRule(toId, {
          day_of_week: r.day_of_week,
          start_time: r.start_time,
          end_time: r.end_time,
          active: r.active,
        }));
      }

      if (v.copy_breaks) {
        for (const b of this.breaks) {
          await this.httpOnce('createBreak', this.api.createBreak(toId, {
            day_of_week: b.day_of_week,
            start_time: b.start_time,
            end_time: b.end_time,
          }));
        }
      }

      this.toast('success', 'Copiado', 'Semana copiada correctamente.');
      this.drawerOpen = false;
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo copiar la semana.');
    });
  }

  // ---------------------------
  // delete with confirm
  // ---------------------------
  askDeleteRule(rule: ScheduleRule) {
    this.confirmTitle = 'Eliminar jornada';
    this.confirmText = `Se eliminará la jornada de ${this.dayLabel(rule.day_of_week)}.`;
    this.confirmAction = async () => { await this.deleteRule(rule.id); };
    this.confirmOpen = true;
    this.cdr.markForCheck();
  }

  async deleteRule(ruleId: number) {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    await this.withLoading(async () => {
      await this.httpOnce('deleteRule', this.api.deleteRule(workerId, ruleId));
      this.toast('success', 'Eliminado', 'Jornada eliminada.');
      this.confirmOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo eliminar la jornada.');
    });
  }

  askDeleteBreak(item: BreakItem) {
    this.confirmTitle = 'Eliminar descanso';
    this.confirmText = `Se eliminará el descanso ${item.start_time}–${item.end_time}.`;
    this.confirmAction = async () => { await this.deleteBreak(item.id); };
    this.confirmOpen = true;
    this.cdr.markForCheck();
  }

  async deleteBreak(id: number) {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    await this.withLoading(async () => {
      await this.httpOnce('deleteBreak', this.api.deleteBreak(workerId, id));
      this.toast('success', 'Eliminado', 'Descanso eliminado.');
      this.confirmOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo eliminar el descanso.');
    });
  }

  askDeleteException(item: ExceptionItem) {
    this.confirmTitle = 'Eliminar excepción';
    this.confirmText = `Se eliminará la excepción del ${item.date}.`;
    this.confirmAction = async () => { await this.deleteException(item.id); };
    this.confirmOpen = true;
    this.cdr.markForCheck();
  }

  async deleteException(id: number) {
    if (!this.selectedWorker) return;
    const workerId = this.selectedWorker.id;

    await this.withLoading(async () => {
      await this.httpOnce('deleteException', this.api.deleteException(workerId, id));
      this.toast('success', 'Eliminado', 'Excepción eliminada.');
      this.confirmOpen = false;
      await this.loadScheduleBundle();
    }).catch(() => {
      this.toast('error', 'Error', 'No se pudo eliminar la excepción.');
    });
  }

  closeConfirm() {
    this.confirmOpen = false;
    this.confirmAction = null;
    this.cdr.markForCheck();
  }

  runConfirm() {
    if (this.confirmAction) this.confirmAction();
  }

  // ---------------------------
  // toast
  // ---------------------------
  toast(type: Toast['type'], title: string, message: string) {
    const id = this.toastSeq++;
    this.toasts.push({ id, type, title, message });
    this.cdr.markForCheck();
    setTimeout(() => {
      this.toasts = this.toasts.filter(t => t.id !== id);
      this.cdr.markForCheck();
    }, 3200);
  }

  // ---------------------------
  // Timeline build
  // ---------------------------
  private initTimelineDefaults() {
    this.timelineCellsCount = Math.ceil((this.timelineEndMin - this.timelineStartMin) / this.timelineStepMin);
    this.timelineStartLabel = this.minToHHMM(this.timelineStartMin);
    this.timelineEndLabel = this.minToHHMM(this.timelineEndMin);

    this.defaultTimelineCells = Array.from({ length: this.timelineCellsCount }, (_, i) => ({
      kind: 'CLOSED' as TimelineKind,
      title: `${this.segmentLabel(i)} · Cerrado`,
    }));
  }

  private rebuildTimelines() {
    const map: Record<string, TimelineCell[]> = {};
    for (const d of this.weekDays) {
      map[d.iso] = this.buildTimelineCells(d.dow, d.iso);
    }
    this.timelinesByIso = map;
  }

  timelineForISO(iso: string): TimelineCell[] {
    return this.timelinesByIso[iso] || this.defaultTimelineCells;
  }

  cellClass(c: TimelineCell): string {
    if (c.kind === 'FREE') return 'free';
    if (c.kind === 'BREAK') return 'break';
    if (c.kind === 'OFF') return 'off';
    if (c.kind === 'BOOKED') return 'booked';
    return 'closed';
  }

  private buildTimelineCells(dow: number, iso: string): TimelineCell[] {
    const rule = this.ruleForDow(dow);
    let available: Array<[number, number]> = [];

    if (rule && rule.active) {
      available.push([this.toMin(rule.start_time), this.toMin(rule.end_time)]);
    }

    const breaks = this.breaksForDow(dow).map(b => [this.toMin(b.start_time), this.toMin(b.end_time)] as [number, number]);
    const ex = this.exceptionsForISO(iso);

    const off: Array<[number, number]> = [];
    const extra: Array<[number, number]> = [];

    for (const e of ex) {
      const hasHours = !!(e.start_time && e.end_time);
      const a: [number, number] = hasHours
        ? [this.toMin(e.start_time as string), this.toMin(e.end_time as string)]
        : [this.timelineStartMin, this.timelineEndMin];

      if (e.type === 'TIME_OFF') off.push(a);
      if (e.type === 'EXTRA_WORKING') extra.push(a);
    }

    const isFullDayOff = off.some(([a, b]) => a <= this.timelineStartMin && b >= this.timelineEndMin);
    if (isFullDayOff) available = [];

    if (extra.length) available = this.mergeIntervals([...available, ...extra]);
    if (breaks.length && available.length) available = this.subtractIntervals(available, breaks);

    const booked: Array<[number, number]> = []; // TODO: integrar turnos cuando tengas endpoint

    const cells: TimelineCell[] = [];
    for (let i = 0; i < this.timelineCellsCount; i++) {
      const segStart = this.timelineStartMin + i * this.timelineStepMin;
      const segEnd = segStart + this.timelineStepMin;
      const mid = Math.floor((segStart + segEnd) / 2);

      let kind: TimelineKind = 'CLOSED';

      if (this.inIntervals(mid, off)) kind = 'OFF';
      else if (this.inIntervals(mid, booked)) kind = 'BOOKED';
      else if (this.inIntervals(mid, breaks)) kind = 'BREAK';
      else if (this.inIntervals(mid, available)) kind = 'FREE';
      else kind = 'CLOSED';

      const title = `${this.minToHHMM(segStart)}-${this.minToHHMM(segEnd)} · ${this.kindLabel(kind)}`;
      cells.push({ kind, title });
    }

    return cells;
  }

  private kindLabel(k: TimelineKind): string {
    if (k === 'FREE') return 'Libre';
    if (k === 'BREAK') return 'Descanso';
    if (k === 'OFF') return 'Ausente';
    if (k === 'BOOKED') return 'Ocupado';
    return 'Cerrado';
  }

  private segmentLabel(i: number): string {
    const segStart = this.timelineStartMin + i * this.timelineStepMin;
    const segEnd = segStart + this.timelineStepMin;
    return `${this.minToHHMM(segStart)}-${this.minToHHMM(segEnd)}`;
  }

  private minToHHMM(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private inIntervals(x: number, arr: Array<[number, number]>): boolean {
    return arr.some(([a, b]) => x >= a && x < b);
  }

  private mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
    if (!list.length) return [];
    const s = [...list].sort((a, b) => a[0] - b[0]);

    const out: Array<[number, number]> = [];
    let cur = s[0];

    for (let i = 1; i < s.length; i++) {
      const nxt = s[i];
      if (nxt[0] <= cur[1]) {
        cur = [cur[0], Math.max(cur[1], nxt[1])];
      } else {
        out.push(cur);
        cur = nxt;
      }
    }
    out.push(cur);
    return out;
  }

  private subtractIntervals(base: Array<[number, number]>, cuts: Array<[number, number]>): Array<[number, number]> {
    if (!base.length) return [];
    if (!cuts.length) return base;

    const mergedCuts = this.mergeIntervals(cuts);
    let result: Array<[number, number]> = [];

    for (const [a, b] of base) {
      let cur: Array<[number, number]> = [[a, b]];

      for (const [c1, c2] of mergedCuts) {
        const next: Array<[number, number]> = [];
        for (const [x1, x2] of cur) {
          if (c2 <= x1 || c1 >= x2) {
            next.push([x1, x2]);
            continue;
          }
          if (c1 > x1) next.push([x1, Math.max(x1, c1)]);
          if (c2 < x2) next.push([Math.min(x2, c2), x2]);
        }
        cur = next;
        if (!cur.length) break;
      }

      result = result.concat(cur);
    }

    return result.filter(([x1, x2]) => x2 > x1);
  }

  // ---------------------------
  // time helpers
  // ---------------------------
  validTimeRange(a: string, b: string) {
    return this.toMin(b) > this.toMin(a);
  }

  isInside(bStart: string, bEnd: string, wStart: string, wEnd: string) {
    return this.toMin(bStart) >= this.toMin(wStart) && this.toMin(bEnd) <= this.toMin(wEnd);
  }

  toMin(hhmm: string) {
    const [h, m] = (hhmm || '0:0').split(':').map(n => Number(n));
    return h * 60 + m;
  }

  // ---------------------------
  // date helpers
  // ---------------------------
  startOfWeek(d: Date) {
    const x = new Date(d);
    const day = x.getDay(); // 0 dom..6 sáb
    const diff = (day === 0 ? -6 : 1) - day; // lunes
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  addDays(d: Date, n: number) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  toISODate(d: Date) {
    const x = new Date(d);
    const yyyy = x.getFullYear();
    const mm = String(x.getMonth() + 1).padStart(2, '0');
    const dd = String(x.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  dayLabel(dow: number) {
    return ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'][dow] || '';
  }

  dayShort(dow: number) {
    return ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'][dow] || '';
  }

  buildWeekDays() {
    this.weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = this.addDays(this.weekStart, i);
      this.weekDays.push({
        dow: i,
        date: d,
        iso: this.toISODate(d),
        label: this.dayLabel(i),
        short: this.dayShort(i),
      });
    }
  }

  exBadge(e: ExceptionItem) {
    return e.type === 'TIME_OFF' ? 'Ausente' : 'Extra';
  }

  // ---------------------------
  // trackBy
  // ---------------------------
  trackById(_: number, x: any) { return x?.id ?? _; }
  trackByISO(_: number, x: any) { return x?.iso ?? _; }
  trackByIdx(i: number) { return i; }
}
