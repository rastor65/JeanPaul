from django import forms
from staffing.models import WorkerScheduleRule, DAY_OF_WEEK_CHOICES


class WorkerScheduleRuleBulkAdminForm(forms.ModelForm):
    days_of_week = forms.MultipleChoiceField(
        choices=DAY_OF_WEEK_CHOICES,
        widget=forms.CheckboxSelectMultiple,
        required=True,
        label="Días de trabajo",
        help_text="Selecciona los días en que el trabajador atiende con este horario.",
    )

    class Meta:
        model = WorkerScheduleRule
        fields = ["worker", "start_time", "end_time", "active"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        # Si estás editando una regla existente, por defecto marca su día actual
        if self.instance and self.instance.pk:
            self.fields["days_of_week"].initial = [str(self.instance.day_of_week)]
        else:
            # Por defecto: Lunes a Sábado
            self.fields["days_of_week"].initial = [str(d) for d in range(0, 6)]
