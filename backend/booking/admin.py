from __future__ import annotations

from datetime import datetime, time, timedelta
from decimal import Decimal

from django.contrib import admin, messages
from django.db import transaction
from django.db.models import Prefetch, Sum
from django.utils import timezone

from booking.models import (
    Appointment,
    Customer,
    AppointmentBlock,
    AppointmentServiceLine,
    AppointmentAudit,
)

# ---- Helpers ---------------------------------------------------------------

def _recommended_total_for_appointment(obj: Appointment) -> Decimal:
    """
    Total recomendado sumando price_snapshot (snapshot de precio al reservar).
    """
    try:
        # Si blocks están prefetched, sumar desde memoria (más rápido)
        blocks = getattr(obj, "_prefetched_objects_cache", {}).get("blocks")
        if blocks is not None:
            total = Decimal("0")
            for b in blocks:
                lines = getattr(b, "_prefetched_objects_cache", {}).get("service_lines")
                if lines is None:
                    lines = AppointmentServiceLine.objects.filter(appointment_block=b).only("price_snapshot")
                for ln in lines:
                    total += (ln.price_snapshot or Decimal("0"))
            return total

        # Fallback: sumar directo en DB
        agg = (
            AppointmentServiceLine.objects
            .filter(appointment_block__appointment=obj)
            .aggregate(total=Sum("price_snapshot"))
        )
        return agg["total"] or Decimal("0")

    except Exception:
        return Decimal("0")


def _workers_display(obj: Appointment) -> str:
    """
    Lista de workers a partir de AppointmentBlock.
    """
    try:
        blocks = getattr(obj, "_prefetched_objects_cache", {}).get("blocks")
        if blocks is None:
            blocks = AppointmentBlock.objects.filter(appointment=obj).select_related("worker")

        names: list[str] = []
        for b in blocks:
            w = getattr(b, "worker", None)
            if not w:
                continue
            name = getattr(w, "display_name", None) or str(w)
            if name and name not in names:
                names.append(name)
        return ", ".join(names) if names else "-"
    except Exception:
        return "-"

def _audit(appointment: Appointment, *, action: str, performed_by, reason: str = "", detail_json=None) -> None:
    try:
        AppointmentAudit.objects.create(
            appointment=appointment,
            action=action,
            performed_by=performed_by,
            performed_at=timezone.now(),
            reason=reason,
            detail_json=detail_json,
        )
    except Exception:
        return

class DateRangeFilter(admin.SimpleListFilter):
    """
    Filtro por fecha usando rangos (evita funciones de TZ pesadas).
    """
    title = "Día"
    parameter_name = "day"

    def lookups(self, request, model_admin):
        return [
            ("today", "Hoy"),
            ("tomorrow", "Mañana"),
            ("next7", "Próximos 7 días"),
        ]

    def queryset(self, request, queryset):
        val = self.value()
        if not val:
            return queryset

        tz = timezone.get_current_timezone()
        today = timezone.localdate()

        def _range_for_date(d):
            start_local = timezone.make_aware(datetime.combine(d, time.min), tz)
            end_local = start_local + timedelta(days=1)
            return start_local, end_local

        if val == "today":
            start, end = _range_for_date(today)
            return queryset.filter(start_datetime__gte=start, start_datetime__lt=end)

        if val == "tomorrow":
            d = today + timedelta(days=1)
            start, end = _range_for_date(d)
            return queryset.filter(start_datetime__gte=start, start_datetime__lt=end)

        if val == "next7":
            start_local = timezone.make_aware(datetime.combine(today, time.min), tz)
            end_local = start_local + timedelta(days=7)
            return queryset.filter(start_datetime__gte=start_local, start_datetime__lt=end_local)

        return queryset


# ---- Inlines ---------------------------------------------------------------

class AppointmentBlockInline(admin.TabularInline):
    model = AppointmentBlock
    extra = 0
    can_delete = False

    fields = ("sequence", "worker", "start_datetime", "end_datetime", "services_summary")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False

    def services_summary(self, obj: AppointmentBlock) -> str:
        """
        Muestra servicios asociados a este bloque.
        """
        try:
            lines = getattr(obj, "_prefetched_objects_cache", {}).get("service_lines")
            if lines is None:
                lines = AppointmentServiceLine.objects.filter(appointment_block=obj).select_related("service")

            names = []
            for ln in lines:
                nm = getattr(ln, "service_name_snapshot", None)
                if not nm and getattr(ln, "service", None):
                    nm = getattr(ln.service, "name", None)
                if nm:
                    names.append(str(nm))
            return ", ".join(names) if names else "-"
        except Exception:
            return "-"

    services_summary.short_description = "Servicios"

class AppointmentAuditInline(admin.TabularInline):
    model = AppointmentAudit
    extra = 0
    can_delete = False

    fields = ("action", "performed_by", "performed_at", "reason", "detail_json")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False

# ---- Admins ----------------------------------------------------------------

@admin.register(Customer)
class CustomerAdmin(admin.ModelAdmin):
    list_display = ("id", "name", "phone", "customer_type", "birth_date")
    search_fields = ("name", "phone")
    list_filter = ("customer_type",)


@admin.register(Appointment)
class AppointmentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "status",
        "start_datetime",
        "end_datetime",
        "customer_name",
        "workers",
        "recommended_total",
        "paid_total",
        "paid_at",
        "paid_by",
        "payment_method",
    )
    search_fields = ("id", "customer__name", "customer__phone")
    list_filter = ("status", DateRangeFilter)
    ordering = ("-start_datetime",)

    readonly_fields = ("recommended_total",)
    actions = ("action_mark_attended", "action_mark_no_show", "action_cancel_admin")

    inlines = [AppointmentBlockInline, AppointmentAuditInline]

    def get_queryset(self, request):
        qs = (
            super()
            .get_queryset(request)
            .select_related("customer", "paid_by")
            .prefetch_related(
                Prefetch(
                    "blocks",
                    queryset=AppointmentBlock.objects.select_related("worker").prefetch_related(
                        Prefetch(
                            "service_lines",
                            queryset=AppointmentServiceLine.objects.select_related("service"),
                        )
                    ),
                ),
                "audits",
            )
        )
        return qs

    def customer_name(self, obj: Appointment) -> str:
        c = getattr(obj, "customer", None)
        return getattr(c, "name", "-") if c else "-"

    customer_name.short_description = "Cliente"

    def workers(self, obj: Appointment) -> str:
        return _workers_display(obj)

    workers.short_description = "Trabajadores"

    def recommended_total(self, obj: Appointment) -> Decimal:
        return _recommended_total_for_appointment(obj)

    recommended_total.short_description = "Recomendado"

    # ---- Admin actions ------------------------------------------------------

    @admin.action(description="Marcar como atendida")
    def action_mark_attended(self, request, queryset):
        with transaction.atomic():
            count = queryset.update(status="ATTENDED")
            for appt in queryset:
                _audit(appt, action="ATTEND", performed_by=request.user, note="Atendida (admin)")
        self.message_user(request, f"{count} turno(s) marcados como atendidos.", level=messages.SUCCESS)

    @admin.action(description="Marcar como no-show")
    def action_mark_no_show(self, request, queryset):
        with transaction.atomic():
            count = queryset.update(status="NO_SHOW")
            for appt in queryset:
                _audit(appt, action="NO_SHOW", performed_by=request.user, note="No show (admin)")
        self.message_user(request, f"{count} turno(s) marcados como no-show.", level=messages.WARNING)

    @admin.action(description="Cancelar (admin)")
    def action_cancel_admin(self, request, queryset):
        with transaction.atomic():
            count = queryset.update(status="CANCELLED")
            for appt in queryset:
                _audit(appt, action="CANCEL", performed_by=request.user, note="Cancelado (admin)")
        self.message_user(request, f"{count} turno(s) cancelados.", level=messages.ERROR)
