from django.contrib import admin
from .models import Worker, WorkerScheduleRule, WorkerBreak, WorkerException

admin.site.register(Worker)
admin.site.register(WorkerScheduleRule)
admin.site.register(WorkerBreak)
admin.site.register(WorkerException)
