import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  OnChanges,
  SimpleChanges,
  inject,
  OnDestroy,
  AfterViewInit,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

type ThemeMode = 'light' | 'dark' | 'system';
type PayMethodKey = 'CASH' | 'TRANSFER' | 'CARD';
type ReminderMode = 'NONE' | 'WHATSAPP';

type AppSettings = {
  business: {
    name: string;
    phone: string;
    address: string;
    timezone: string;
    currency: string; // "COP"
  };
  booking: {
    slotMinutes: number;         // tamaño de bloque en agenda
    bufferMinutes: number;       // colchón entre citas
    allowWalkinNameOnly: boolean; // cliente casual: solo nombre
    requirePhoneFrequent: boolean;
    requireBirthFrequent: boolean;
    birthdayDiscountPercent: number; // 0-100
    cancelPolicyHours: number;       // ventana para cancelar sin problema
    allowOverbooking: boolean;
  };
  payments: {
    enabled: Record<PayMethodKey, boolean>;
    requireMethodWhenCollected: boolean;
    allowPartialPayments: boolean;
    defaultMethod: PayMethodKey;
    taxPercent: number; // IVA
    rounding: 0 | 50 | 100; // redondeo COP
    receiptFooter: string;
    showTaxInReceipt: boolean;
  };
  notifications: {
    reminderMode: ReminderMode;
    reminderHoursBefore: number; // horas antes
    sendAfterCare: boolean;
    includeMapLink: boolean;
    templates: {
      confirm: string;
      reminder: string;
      afterCare: string;
    };
  };
  staff: {
    autoAssignNearest: boolean;
    allowChooseWorker: boolean;
    allowEditPastAppointments: boolean;
    requirePinForDelete: boolean;
    deletePin: string;
    commissions: {
      BARBER: number; // %
      NAILS: number;  // %
      FACIAL: number; // %
    };
  };
  security: {
    sessionTimeoutMinutes: number;
    maskPhoneInLists: boolean;
    allowCsvExport: boolean;
    auditRetentionDays: number;
  };
  appearance: {
    theme: ThemeMode;
    compactMode: boolean;
    reduceMotion: boolean;
  };
  advanced: {
    syncBackend: boolean;      // si luego creas endpoint
    apiBaseOverride: string;   // opcional
    debug: boolean;
  };
};

const STORAGE_KEY = 'jp_settings_v1';

const DEFAULT_SETTINGS: AppSettings = {
  business: {
    name: 'Barbería Jean Paul',
    phone: '',
    address: '',
    timezone: 'America/Bogota',
    currency: 'COP',
  },
  booking: {
    slotMinutes: 15,
    bufferMinutes: 5,
    allowWalkinNameOnly: true,
    requirePhoneFrequent: true,
    requireBirthFrequent: true,
    birthdayDiscountPercent: 10,
    cancelPolicyHours: 2,
    allowOverbooking: false,
  },
  payments: {
    enabled: { CASH: true, TRANSFER: true, CARD: true },
    requireMethodWhenCollected: true,
    allowPartialPayments: false,
    defaultMethod: 'CASH',
    taxPercent: 0,
    rounding: 0,
    receiptFooter: 'Gracias por tu visita.',
    showTaxInReceipt: false,
  },
  notifications: {
    reminderMode: 'NONE',
    reminderHoursBefore: 2,
    sendAfterCare: false,
    includeMapLink: false,
    templates: {
      confirm:
        'Hola {{cliente}}, tu turno está confirmado para {{fecha}} a las {{hora}}. Servicios: {{servicios}}. Te atiende: {{trabajador}}.',
      reminder:
        'Recordatorio: {{cliente}}, tu turno es hoy {{fecha}} a las {{hora}}. Servicios: {{servicios}}.',
      afterCare:
        'Gracias por venir, {{cliente}}. Si deseas agendar de nuevo, responde a este mensaje.',
    },
  },
  staff: {
    autoAssignNearest: true,
    allowChooseWorker: true,
    allowEditPastAppointments: false,
    requirePinForDelete: true,
    deletePin: '1234',
    commissions: { BARBER: 40, NAILS: 35, FACIAL: 35 },
  },
  security: {
    sessionTimeoutMinutes: 240,
    maskPhoneInLists: true,
    allowCsvExport: true,
    auditRetentionDays: 90,
  },
  appearance: {
    theme: 'system',
    compactMode: false,
    reduceMotion: false,
  },
  advanced: {
    syncBackend: false,
    apiBaseOverride: '',
    debug: false,
  },
};

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './settings-modal.html',
  styleUrls: ['./settings-modal.scss'],
})
export class SettingsModalComponent implements OnChanges, AfterViewInit, OnDestroy {
  private fb = inject(FormBuilder);

  @Input() open = false;
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<AppSettings>();

  tab: 'general' | 'agenda' | 'payments' | 'notifications' | 'staff' | 'security' | 'appearance' | 'advanced' = 'general';

  saving = false;
  dirtyLoaded = false;

  form = this.fb.group({
    business: this.fb.group({
      name: ['', [Validators.required, Validators.maxLength(80)]],
      phone: [''],
      address: [''],
      timezone: ['America/Bogota', [Validators.required]],
      currency: ['COP', [Validators.required]],
    }),

    booking: this.fb.group({
      slotMinutes: [15, [Validators.required, Validators.min(5), Validators.max(60)]],
      bufferMinutes: [5, [Validators.required, Validators.min(0), Validators.max(60)]],
      allowWalkinNameOnly: [true],
      requirePhoneFrequent: [true],
      requireBirthFrequent: [true],
      birthdayDiscountPercent: [10, [Validators.required, Validators.min(0), Validators.max(100)]],
      cancelPolicyHours: [2, [Validators.required, Validators.min(0), Validators.max(72)]],
      allowOverbooking: [false],
    }),

    payments: this.fb.group({
      enabled: this.fb.group({
        CASH: [true],
        TRANSFER: [true],
        CARD: [true],
      }),
      requireMethodWhenCollected: [true],
      allowPartialPayments: [false],
      defaultMethod: ['CASH' as PayMethodKey, [Validators.required]],
      taxPercent: [0, [Validators.required, Validators.min(0), Validators.max(30)]],
      rounding: [0 as 0 | 50 | 100, [Validators.required]],
      receiptFooter: ['Gracias por tu visita.', [Validators.maxLength(140)]],
      showTaxInReceipt: [false],
    }),

    notifications: this.fb.group({
      reminderMode: ['NONE' as ReminderMode, [Validators.required]],
      reminderHoursBefore: [2, [Validators.required, Validators.min(1), Validators.max(72)]],
      sendAfterCare: [false],
      includeMapLink: [false],
      templates: this.fb.group({
        confirm: ['', [Validators.required, Validators.maxLength(400)]],
        reminder: ['', [Validators.required, Validators.maxLength(400)]],
        afterCare: ['', [Validators.required, Validators.maxLength(400)]],
      }),
    }),

    staff: this.fb.group({
      autoAssignNearest: [true],
      allowChooseWorker: [true],
      allowEditPastAppointments: [false],
      requirePinForDelete: [true],
      deletePin: ['1234', [Validators.minLength(4), Validators.maxLength(12)]],
      commissions: this.fb.group({
        BARBER: [40, [Validators.required, Validators.min(0), Validators.max(100)]],
        NAILS: [35, [Validators.required, Validators.min(0), Validators.max(100)]],
        FACIAL: [35, [Validators.required, Validators.min(0), Validators.max(100)]],
      }),
    }),

    security: this.fb.group({
      sessionTimeoutMinutes: [240, [Validators.required, Validators.min(15), Validators.max(1440)]],
      maskPhoneInLists: [true],
      allowCsvExport: [true],
      auditRetentionDays: [90, [Validators.required, Validators.min(7), Validators.max(3650)]],
    }),

    appearance: this.fb.group({
      theme: ['system' as ThemeMode, [Validators.required]],
      compactMode: [false],
      reduceMotion: [false],
    }),

    advanced: this.fb.group({
      syncBackend: [false],
      apiBaseOverride: [''],
      debug: [false],
    }),
  });

  private escHandler = (e: KeyboardEvent) => {
    if (!this.open) return;
    if (e.key === 'Escape') this.close();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.save();
    }
  };

  ngAfterViewInit(): void {
    window.addEventListener('keydown', this.escHandler);
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.escHandler);
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['open'] && this.open) {
      this.tab = 'general';
      this.load();
      // foco suave
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>('.jp-modal .card input, .jp-modal .card select, .jp-modal .card textarea');
        el?.focus?.();
      }, 0);
    }
  }

  close(): void {
    this.closed.emit();
  }

  setTab(t: typeof this.tab) {
    this.tab = t;
  }

  restoreDefaults() {
    this.form.reset(DEFAULT_SETTINGS as any);
    this.form.markAsDirty();
  }

  private load() {
    const raw = this.readStorage();
    this.form.reset(raw as any);
    this.form.markAsPristine();
    this.dirtyLoaded = true;
  }

  async save() {
    if (this.saving) return;

    // validaciones extra
    const v = this.form.getRawValue() as any;

    if (v.staff?.requirePinForDelete) {
      const pin = String(v.staff?.deletePin || '').trim();
      if (pin.length < 4) {
        this.form.get('staff.deletePin')?.setErrors({ minlength: true });
        this.form.get('staff.deletePin')?.markAsTouched();
        return;
      }
    }

    this.saving = true;
    try {
      const settings = this.sanitize(v);
      this.writeStorage(settings);
      this.form.markAsPristine();
      this.saved.emit(settings);
      // no cierro automáticamente: el usuario decide
    } finally {
      this.saving = false;
    }
  }

  // Helpers para mostrar placeholders disponibles
  placeholders() {
    return ['{{cliente}}', '{{fecha}}', '{{hora}}', '{{servicios}}', '{{trabajador}}', '{{total}}'];
  }

  private sanitize(v: any): AppSettings {
    const s: AppSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

    // merge simple
    const merge = (target: any, src: any) => {
      for (const k of Object.keys(src || {})) {
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) merge(target[k], src[k]);
        else target[k] = src[k];
      }
    };
    merge(s, v);

    // normalizar números
    s.booking.slotMinutes = this.num(s.booking.slotMinutes, 15);
    s.booking.bufferMinutes = this.num(s.booking.bufferMinutes, 5);
    s.booking.birthdayDiscountPercent = this.num(s.booking.birthdayDiscountPercent, 0);
    s.booking.cancelPolicyHours = this.num(s.booking.cancelPolicyHours, 0);

    s.payments.taxPercent = this.num(s.payments.taxPercent, 0);
    s.security.sessionTimeoutMinutes = this.num(s.security.sessionTimeoutMinutes, 240);
    s.security.auditRetentionDays = this.num(s.security.auditRetentionDays, 90);

    // rounding permitido
    s.payments.rounding = (s.payments.rounding === 50 || s.payments.rounding === 100) ? s.payments.rounding : 0;

    // métodos: al menos uno
    const anyEnabled = Object.values(s.payments.enabled).some(Boolean);
    if (!anyEnabled) s.payments.enabled.CASH = true;

    // defaultMethod debe estar habilitado
    if (!s.payments.enabled[s.payments.defaultMethod]) {
      const first = (Object.keys(s.payments.enabled) as PayMethodKey[]).find((k) => s.payments.enabled[k]) || 'CASH';
      s.payments.defaultMethod = first;
    }

    // PIN si no requiere
    if (!s.staff.requirePinForDelete) s.staff.deletePin = '';

    // strings
    s.business.name = String(s.business.name || '').trim() || DEFAULT_SETTINGS.business.name;
    s.business.phone = String(s.business.phone || '').trim();
    s.business.address = String(s.business.address || '').trim();
    s.payments.receiptFooter = String(s.payments.receiptFooter || '').trim().slice(0, 140);

    return s;
  }

  private num(v: any, fallback: number) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private readStorage(): AppSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_SETTINGS;
      const obj = JSON.parse(raw);
      // merge con defaults para evitar settings incompletos
      return this.sanitize({ ...DEFAULT_SETTINGS, ...obj });
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private writeStorage(s: AppSettings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {}
  }
}
