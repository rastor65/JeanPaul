from django.contrib import admin
from staffing.models import Worker, WorkerScheduleRule, WorkerBreak, WorkerException
from staffing.forms import WorkerScheduleRuleBulkAdminForm


@admin.register(Worker)
class WorkerAdmin(admin.ModelAdmin):
    list_display = ("id", "display_name", "role", "active")
    list_filter = ("role", "active")
    search_fields = ("display_name",)


@admin.register(WorkerScheduleRule)
class WorkerScheduleRuleAdmin(admin.ModelAdmin):
    """
    Admin con selección múltiple de días:
    - En un solo guardado crea/actualiza reglas para los días seleccionados.
    - Por diseño: 1 regla por (worker, day_of_week).
    """
    form = WorkerScheduleRuleBulkAdminForm
    list_display = ("worker", "day_of_week", "start_time", "end_time", "active")
    list_filter = ("active", "day_of_week")
    search_fields = ("worker__display_name",)

    fields = ("worker", "days_of_week", "start_time", "end_time", "active")

    def save_model(self, request, obj, form, change):
        worker = form.cleaned_data["worker"]
        start_time = form.cleaned_data["start_time"]
        end_time = form.cleaned_data["end_time"]
        active = form.cleaned_data["active"]

        # viene como strings por el MultipleChoiceField
        days = [int(d) for d in form.cleaned_data["days_of_week"]]
        days = sorted(set(days))

        # Guardar/actualizar cada día (1 por día gracias al unique constraint)
        first_rule_pk = None
        for d in days:
            rule, _created = WorkerScheduleRule.objects.update_or_create(
                worker=worker,
                day_of_week=d,
                defaults={
                    "start_time": start_time,
                    "end_time": end_time,
                    "active": active,
                },
            )
            if first_rule_pk is None:
                first_rule_pk = rule.pk

        # Para que Django Admin quede “parado” en un objeto válido tras guardar,
        # aseguramos que obj tenga PK.
        if first_rule_pk:
            obj.pk = first_rule_pk


@admin.register(WorkerBreak)
class WorkerBreakAdmin(admin.ModelAdmin):
    list_display = ("worker", "day_of_week", "start_time", "end_time")
    list_filter = ("day_of_week",)
    search_fields = ("worker__display_name",)


@admin.register(WorkerException)
class WorkerExceptionAdmin(admin.ModelAdmin):
    list_display = ("worker", "date", "type", "start_time", "end_time")
    list_filter = ("type", "date")
    search_fields = ("worker__display_name",)
