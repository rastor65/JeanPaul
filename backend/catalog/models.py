from django.db import models


class ServiceCategory(models.Model):
    name = models.CharField(max_length=50, unique=True)
    active = models.BooleanField(default=True)

    # opcional: si quieres fijar trabajador por categoría (uñas/facial) en vez de por servicio
    default_fixed_worker = models.ForeignKey(
        "staffing.Worker",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="default_categories",
    )

    def __str__(self):
        return self.name


class Service(models.Model):
    ASSIGNMENT_ROLE_BASED = "ROLE_BASED"
    ASSIGNMENT_FIXED_WORKER = "FIXED_WORKER"

    ASSIGNMENT_CHOICES = [
        (ASSIGNMENT_ROLE_BASED, "Role based"),
        (ASSIGNMENT_FIXED_WORKER, "Fixed worker"),
    ]

    name = models.CharField(max_length=120)
    category = models.ForeignKey(ServiceCategory, on_delete=models.PROTECT, related_name="services")

    duration_minutes = models.PositiveSmallIntegerField()
    buffer_before_minutes = models.PositiveSmallIntegerField(default=0)
    buffer_after_minutes = models.PositiveSmallIntegerField(default=0)

    price = models.DecimalField(max_digits=10, decimal_places=2)
    active = models.BooleanField(default=True)

    description = models.TextField(blank=True, default="")
    requirements = models.TextField(blank=True, default="")

    assignment_type = models.CharField(
        max_length=20, choices=ASSIGNMENT_CHOICES, default=ASSIGNMENT_ROLE_BASED
    )
    fixed_worker = models.ForeignKey(
        "staffing.Worker",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="fixed_services",
    )

    class Meta:
        indexes = [
            models.Index(fields=["active", "category"]),
        ]

    def __str__(self):
        return self.name
