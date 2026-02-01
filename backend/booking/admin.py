from django.contrib import admin
from .models import Customer, Appointment, AppointmentBlock, AppointmentServiceLine, AppointmentAudit

admin.site.register(Customer)
admin.site.register(Appointment)
admin.site.register(AppointmentBlock)
admin.site.register(AppointmentServiceLine)
admin.site.register(AppointmentAudit)
