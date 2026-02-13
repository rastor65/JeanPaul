from django.db import models
from django.conf import settings


DAY_OF_WEEK_CHOICES = [
    (0, "Lunes"),
    (1, "Martes"),
    (2, "Miércoles"),
    (3, "Jueves"),
    (4, "Viernes"),
    (5, "Sábado"),
    (6, "Domingo"),
]


class Worker(models.Model):
    ROLE_BARBER = "BARBER"
    ROLE_NAILS = "NAILS"
    ROLE_FACIAL = "FACIAL"

    ROLE_CHOICES = [
        (ROLE_BARBER, "Barber"),
        (ROLE_NAILS, "Nails"),
        (ROLE_FACIAL, "Facial"),
    ]

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="worker_profile",
    )
    display_name = models.CharField(max_length=120)
    role = models.CharField(max_length=20, choices=ROLE_CHOICES)
    active = models.BooleanField(default=True)

    def __str__(self):
        return self.display_name


class WorkerScheduleRule(models.Model):
    worker = models.ForeignKey(Worker, on_delete=models.CASCADE, related_name="schedule_rules")
    day_of_week = models.PositiveSmallIntegerField(choices=DAY_OF_WEEK_CHOICES)  # 0=lunes ... 6=domingo
    start_time = models.TimeField()
    end_time = models.TimeField()
    active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["worker", "day_of_week"], name="uniq_worker_day_schedule"),
        ]
        indexes = [
            models.Index(fields=["worker", "day_of_week", "active"]),
        ]

    def __str__(self):
        day = dict(DAY_OF_WEEK_CHOICES).get(self.day_of_week, self.day_of_week)
        return f"{self.worker} - {day} {self.start_time}-{self.end_time}"


class WorkerBreak(models.Model):
    worker = models.ForeignKey(Worker, on_delete=models.CASCADE, related_name="breaks")
    day_of_week = models.PositiveSmallIntegerField(choices=DAY_OF_WEEK_CHOICES)
    start_time = models.TimeField()
    end_time = models.TimeField()

    class Meta:
        indexes = [
            models.Index(fields=["worker", "day_of_week"]),
        ]

    def __str__(self):
        day = dict(DAY_OF_WEEK_CHOICES).get(self.day_of_week, self.day_of_week)
        return f"{self.worker} - {day} break {self.start_time}-{self.end_time}"


class WorkerException(models.Model):
    TYPE_TIME_OFF = "TIME_OFF"
    TYPE_EXTRA_WORKING = "EXTRA_WORKING"
    TYPE_CHOICES = [
        (TYPE_TIME_OFF, "Time off"),
        (TYPE_EXTRA_WORKING, "Extra working"),
    ]

    worker = models.ForeignKey(Worker, on_delete=models.CASCADE, related_name="exceptions")
    date = models.DateField()
    type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    start_time = models.TimeField(null=True, blank=True)
    end_time = models.TimeField(null=True, blank=True)
    note = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        indexes = [
            models.Index(fields=["worker", "date", "type"]),
        ]

    def __str__(self):
        return f"{self.worker} - {self.date} {self.type}"
