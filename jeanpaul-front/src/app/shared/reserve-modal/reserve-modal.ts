import {
  Component,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  ElementRef,
  ChangeDetectorRef,
  NgZone,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { CatalogService, ServiceDTO, WorkerDTO } from '../../core/services/catalog';
import { BookingService, AvailabilityOption } from '../../core/services/booking';
import { ToastService } from '../toast/toast.service';

type CustomerType = 'CASUAL' | 'FREQUENT';
type BarberChoice = 'SPECIFIC' | 'NEAREST';
type SlotPeriod = 'ALL' | 'AM' | 'PM';

type ServiceCategoryGroup = {
  name: string;
  services: ServiceDTO[];
};

@Component({
  selector: 'app-reserve-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './reserve-modal.html',
  styleUrl: './reserve-modal.scss',
})
export class ReserveModalComponent {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();

  @ViewChild('slotsEl') slotsEl?: ElementRef<HTMLElement>;

  loading = false;
  loadingAvailability = false;

  msg = '';
  err = '';

  // Cliente
  customerType: CustomerType = 'CASUAL';
  name = '';
  phone = '';
  birth_date = ''; // YYYY-MM-DD

  // Servicios
  services: ServiceDTO[] = [];
  selectedServiceIds: number[] = [];

  // Barberos
  barbers: WorkerDTO[] = [];
  barberChoice: BarberChoice = 'NEAREST';
  barberId: number | null = null;

  // Fecha
  date = ''; // YYYY-MM-DD
  minDate = this.todayISO();

  // Disponibilidad
  options: AvailabilityOption[] = [];
  selectedOptionId: string | null = null;

  // Filtros disponibilidad
  slotSearch = '';
  slotPeriod: SlotPeriod = 'ALL';

  // Parámetros
  slotIntervalMinutes = 5;
  optionsLimit = 300;

  constructor(
    private catalog: CatalogService,
    private booking: BookingService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
    private toast: ToastService
  ) { }

  ngOnInit() {
    this.loadCatalog();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['open']?.currentValue === true) {
      if (!this.date) this.date = this.todayISO();
      this.msg = '';
      this.err = '';
      this.cdr.detectChanges();
    }
  }

  private loadCatalog() {
    this.catalog.getServices().subscribe({
      next: (list) => {
        this.services = (list || []).filter((s: any) => (typeof s.active === 'boolean' ? s.active : true));
        this.cdr.detectChanges();
      },
      error: () => {
        this.services = [];
        this.cdr.detectChanges();
      },
    });

    this.catalog.getBarbers().subscribe({
      next: (list) => {
        this.barbers = list || [];
        this.cdr.detectChanges();
      },
      error: () => {
        this.barbers = [];
        this.cdr.detectChanges();
      },
    });
  }

  close() {
    this.reset();
    this.closed.emit();
  }

  // ==========================================
  // IMPORTANTE: NO usar "as any" en el HTML
  // ==========================================
  optionId(opt: AvailabilityOption): string {
    const anyOpt = opt as any;
    const v = anyOpt?.option_id ?? anyOpt?.optionId ?? anyOpt?.id ?? '';
    return String(v || '');
  }

  // trackBy (evita re-render masivo)
  trackByCat(_i: number, c: ServiceCategoryGroup) {
    return c.name;
  }
  trackBySvc(_i: number, s: ServiceDTO) {
    return (s as any)?.id;
  }
  trackByOpt = (_i: number, opt: AvailabilityOption) => this.optionId(opt);
  trackByBlock(_i: number, b: any) {
    return `${b?.worker_id}-${b?.start}-${b?.end}-${b?.sequence}`;
  }

  // -----------------------------
  // Helpers servicios / UI
  // -----------------------------
  categoryName(s: ServiceDTO): string {
    const anyS: any = s as any;
    const name = anyS?.category?.name;
    return name && String(name).trim() ? String(name).trim() : 'General';
  }

  bufferTotal(s: ServiceDTO): number {
    const anyS: any = s as any;
    const b1 = Number(anyS?.buffer_before_minutes ?? 0);
    const b2 = Number(anyS?.buffer_after_minutes ?? 0);
    return b1 + b2;
  }

  isSelectedService(id: number): boolean {
    return this.selectedServiceIds.includes(id);
  }

  toggleService(id: number) {
    if (this.isSelectedService(id)) {
      this.selectedServiceIds = this.selectedServiceIds.filter((x) => x !== id);
    } else {
      this.selectedServiceIds = [...this.selectedServiceIds, id];
    }

    if (!this.hasBarberServices) {
      this.barberChoice = 'NEAREST';
      this.barberId = null;
    }

    this.invalidateAvailability();
    this.cdr.detectChanges();
  }

  get groupedServices(): ServiceCategoryGroup[] {
    const map = new Map<string, ServiceDTO[]>();

    for (const s of this.services) {
      const cat = this.categoryName(s);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(s);
    }

    const out: ServiceCategoryGroup[] = [];
    for (const [name, list] of map.entries()) {
      out.push({
        name,
        services: [...list].sort((a: any, b: any) => String(a?.name || '').localeCompare(String(b?.name || ''))),
      });
    }

    out.sort((a, b) => {
      if (a.name === 'General') return 1;
      if (b.name === 'General') return -1;
      return a.name.localeCompare(b.name);
    });

    return out;
  }

  // -----------------------------
  // Grupos / reglas (frontend)
  // -----------------------------
  private inferGroupFromCategoryName(catName: string): 'BARBER' | 'NAILS' | 'FACIAL' {
    const raw = (catName || '').toLowerCase();
    const nailsKeys = ['uña', 'unas', 'uñas', 'manicure', 'pedicure', 'nails'];
    const facialKeys = ['facial', 'limpieza facial', 'rostro', 'skin'];

    if (nailsKeys.some((k) => raw.includes(k))) return 'NAILS';
    if (facialKeys.some((k) => raw.includes(k))) return 'FACIAL';
    return 'BARBER';
  }

  private groupOfServiceId(id: number): 'BARBER' | 'NAILS' | 'FACIAL' {
    const s = this.services.find((x: any) => Number((x as any)?.id) === Number(id));
    const catName = this.categoryName(s as any);
    return this.inferGroupFromCategoryName(catName);
  }

  get hasBarberServices(): boolean {
    return this.selectedServiceIds.some((id) => this.groupOfServiceId(id) === 'BARBER');
  }

  get hasNailsOrFacial(): boolean {
    return this.selectedServiceIds.some((id) => {
      const g = this.groupOfServiceId(id);
      return g === 'NAILS' || g === 'FACIAL';
    });
  }

  // -----------------------------
  // Cambios de inputs
  // -----------------------------
  onDateChange() {
    this.invalidateAvailability();
    this.cdr.detectChanges();
  }

  onCustomerTypeChange() {
    if (this.customerType === 'CASUAL') {
      this.phone = '';
      this.birth_date = '';
    }
    this.msg = '';
    this.err = '';
    this.cdr.detectChanges();
  }

  setBarberChoice(choice: BarberChoice) {
    this.barberChoice = choice;
    if (choice === 'NEAREST') this.barberId = null;
    this.invalidateAvailability();
    this.cdr.detectChanges();
  }

  onBarberChange() {
    this.invalidateAvailability();
    this.cdr.detectChanges();
  }

  get hasName(): boolean {
    return (this.name || '').trim().length > 0;
  }

  private invalidateAvailability() {
    this.options = [];
    this.selectedOptionId = null;
    this.slotSearch = '';
    this.slotPeriod = 'ALL';
    this.msg = '';
    this.err = '';
  }

  // -----------------------------
  // Validaciones
  // -----------------------------
  validateAvailabilityBase(): string | null {
    if (this.selectedServiceIds.length === 0) return 'Debes seleccionar al menos un servicio.';
    if (!this.date) return 'Debes seleccionar una fecha.';

    if (this.hasBarberServices && this.barberChoice === 'SPECIFIC' && !this.barberId) {
      return 'Selecciona un barbero o usa “Próximo disponible”.';
    }
    return null;
  }

  validateReservationBase(): string | null {
    const a = this.validateAvailabilityBase();
    if (a) return a;

    if (!this.name.trim()) return 'El nombre es obligatorio.';

    if (this.customerType === 'FREQUENT') {
      if (!this.phone.trim()) return 'El teléfono es obligatorio para cliente frecuente.';
      if (!this.birth_date.trim()) return 'La fecha de nacimiento es obligatoria para cliente frecuente.';
    }

    if (!this.selectedOptionId) return 'Debes seleccionar un horario disponible.';
    return null;
  }

  // -----------------------------
  // Disponibilidad (FIX: render defer + menos DOM)
  // -----------------------------
  loadAvailability() {
    this.msg = '';
    this.err = '';
    this.options = [];
    this.selectedOptionId = null;

    const v = this.validateAvailabilityBase();
    if (v) {
      this.err = v;
      this.cdr.detectChanges();
      return;
    }

    const payload: any = {
      date: this.date,
      service_ids: this.selectedServiceIds,
      limit: this.optionsLimit,
      slot_interval_minutes: this.slotIntervalMinutes,
    };

    if (this.hasBarberServices) {
      payload.barber_choice = this.barberChoice;
      payload.barber_id = this.barberChoice === 'SPECIFIC' && this.barberId !== null ? Number(this.barberId) : null;
    }

    // 1) encender loading y forzar pintura
    this.loadingAvailability = true;
    this.cdr.detectChanges();

    this.booking.getAvailabilityOptions(payload).subscribe({
      next: (opts) => {
        // construir lista (rápido) y luego renderizar diferido
        let list = Array.isArray(opts) ? opts : [];

        list = this.filterPastToday(list);

        if (this.hasBarberServices && this.barberChoice === 'SPECIFIC' && this.barberId !== null) {
          const chosen = Number(this.barberId);
          list = list.filter((o) => this.barberWorkerIdForOption(o) === chosen);
        }

        list = list.filter((o) => !!this.optionId(o));

        this.finishAvailabilityRender(list);
      },
      error: (e) => {
        this.zone.run(() => {
          this.loadingAvailability = false;
          const detail = e?.error?.detail;
          this.err = detail || 'No fue posible consultar disponibilidad.';
          this.cdr.detectChanges();
        });
      },
    });
  }

  /**
   * FIX CLAVE:
   * - Apaga loading primero (para que deje de girar ya)
   * - Luego pinta la lista en el siguiente frame (evita “se queda cargando”)
   */
  private finishAvailabilityRender(list: AvailabilityOption[]) {
    // apaga loading ya, para que la UI reaccione inmediatamente
    this.zone.run(() => {
      this.loadingAvailability = false;
      this.cdr.detectChanges();
    });

    // pinta lista en el siguiente frame para no bloquear la pintura del botón
    this.zone.runOutsideAngular(() => {
      requestAnimationFrame(() => {
        this.zone.run(() => {
          this.options = list;

          if (this.options.length === 0) {
            this.err = 'No hay disponibilidad para la fecha seleccionada con los servicios elegidos.';
          } else {
            this.err = '';
          }

          this.cdr.detectChanges();

          if (this.options.length > 0) {
            setTimeout(() => {
              this.slotsEl?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 0);
          }
        });
      });
    });
  }

  private filterPastToday(list: AvailabilityOption[]): AvailabilityOption[] {
    if (!this.date) return list;

    const today = this.todayISO();
    if (this.date !== today) return list;

    const cutoff = this.roundUpToNextInterval(new Date(), this.slotIntervalMinutes);

    return list.filter((opt) => {
      const startIso = this.getOptionStartIso(opt);
      const start = startIso ? new Date(startIso) : null;
      return !!start && start.getTime() >= cutoff.getTime();
    });
  }

  private getOptionStartIso(opt: AvailabilityOption): string | null {
    const anyOpt: any = opt as any;
    const blocks = Array.isArray(anyOpt?.blocks) ? anyOpt.blocks : [];
    if (blocks.length > 0 && blocks[0]?.start) return String(blocks[0].start);
    if (anyOpt?.appointment_start) return String(anyOpt.appointment_start);
    return null;
  }

  private roundUpToNextInterval(d: Date, minutes: number): Date {
    const ms = minutes * 60 * 1000;
    const t = d.getTime();
    return new Date(Math.ceil(t / ms) * ms);
  }

  selectOption(optionId: string) {
    this.selectedOptionId = optionId;
    this.msg = '';
    this.err = '';
    this.cdr.detectChanges();
  }

  // -----------------------------
  // Confirmar reserva (PUBLIC)
  // -----------------------------
  submit() {
    this.msg = '';
    this.err = '';

    const v = this.validateReservationBase();
    if (v) {
      this.err = v;
      this.cdr.detectChanges();
      return;
    }

    const payload: any = {
      option_id: this.selectedOptionId,
      customer: {
        customer_type: this.customerType,
        name: this.name.trim(),
        phone: this.customerType === 'FREQUENT' ? this.phone.trim() : null,
        birth_date: this.customerType === 'FREQUENT' ? this.birth_date.trim() : null,
      },
    };

    this.loading = true;
    this.cdr.detectChanges();

    this.booking.createPublicAppointment(payload).subscribe({
      next: (res: any) => {
        this.zone.run(() => {
          this.loading = false;
          const id = res?.appointment_id || res?.id;
          const label = id ? `Reserva confirmada (ID: ${id}).` : 'Reserva confirmada.';
          this.toast.success(label, 'Reserva creada');
          this.close();
        });
      },
      error: (e) => {
        this.zone.run(() => {
          this.loading = false;
          const detail = e?.error?.detail;
          const msg = detail || 'No fue posible crear la reserva. Verifica disponibilidad o datos.';
          this.err = msg;
          this.toast.error(msg, 'No se pudo reservar');
          this.cdr.detectChanges();
        });
      },
    });
  }

  // -----------------------------
  // Filtros UI (disponibilidad)
  // -----------------------------
  setSlotPeriod(p: SlotPeriod) {
    this.slotPeriod = p;
    this.cdr.detectChanges();
  }

  get filteredOptions(): AvailabilityOption[] {
    let list = [...(this.options || [])];

    if (this.slotPeriod !== 'ALL') {
      list = list.filter((opt) => {
        const startIso = this.getOptionStartIso(opt);
        if (!startIso) return false;
        const d = new Date(startIso);
        const h = d.getHours();
        return this.slotPeriod === 'AM' ? h < 12 : h >= 12;
      });
    }

    const q = (this.slotSearch || '').trim().toLowerCase();
    if (q) {
      list = list.filter((opt) => {
        const range = this.fmtRange(opt).toLowerCase();
        const barber = this.barberNameById(this.barberWorkerIdForOption(opt)).toLowerCase();
        const services = this.optionServicesLabel(opt).toLowerCase();
        return range.includes(q) || barber.includes(q) || services.includes(q);
      });
    }

    return list;
  }

  // -----------------------------
  // Helpers UI de opciones
  // -----------------------------
  fmtTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  fmtRange(opt: AvailabilityOption): string {
    const anyOpt: any = opt as any;
    const start = String(anyOpt?.appointment_start || '');
    const end = String(anyOpt?.appointment_end || '');
    return `${this.fmtTime(start)} - ${this.fmtTime(end)}`;
  }

  getBlocks(opt: AvailabilityOption): any[] {
    const anyOpt: any = opt as any;
    return Array.isArray(anyOpt?.blocks) ? anyOpt.blocks : [];
  }

  optionServicesLabel(opt: AvailabilityOption): string {
    const blocks = this.getBlocks(opt);
    const names: string[] = [];

    for (const b of blocks) {
      const svcs = Array.isArray(b?.services) ? b.services : [];
      for (const s of svcs) {
        const n = s?.name ? String(s.name).trim() : '';
        if (n) names.push(n);
      }
    }

    const seen = new Set<string>();
    const uniq = names.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
    return uniq.join(' · ');
  }

  barberWorkerIdForOption(opt: AvailabilityOption): number | null {
    if (!this.hasBarberServices) return null;

    const blocks = this.getBlocks(opt);
    for (const b of blocks) {
      const ids = Array.isArray(b?.service_ids) ? b.service_ids : [];
      const hasBarber = ids.some((id: any) => this.groupOfServiceId(Number(id)) === 'BARBER');
      if (hasBarber && b?.worker_id) return Number(b.worker_id);
    }
    return null;
  }

  barberNameById(workerId: number | null): string {
    if (!workerId) return '';
    const w = this.barbers.find((x: any) => Number((x as any)?.id) === Number(workerId));
    return w ? String((w as any).display_name || (w as any).name || `#${workerId}`) : `#${workerId}`;
  }

  barberLabel(b: WorkerDTO): string {
    const anyB: any = b as any;
    return String(anyB?.display_name || anyB?.name || `#${anyB?.id || ''}`).trim();
  }

  todayISO(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // -----------------------------
  // reset
  // -----------------------------
  private reset() {
    this.loading = false;
    this.loadingAvailability = false;

    this.msg = '';
    this.err = '';

    this.customerType = 'CASUAL';
    this.name = '';
    this.phone = '';
    this.birth_date = '';

    this.selectedServiceIds = [];

    this.barberChoice = 'NEAREST';
    this.barberId = null;

    this.date = '';
    this.minDate = this.todayISO();

    this.options = [];
    this.selectedOptionId = null;

    this.slotSearch = '';
    this.slotPeriod = 'ALL';

    this.cdr.detectChanges();
  }

  workerId(b: WorkerDTO): number {
    const anyB: any = b as any;
    return Number(anyB?.id ?? 0);
  }

}
