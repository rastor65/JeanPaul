from django.db import models
from django.conf import settings
from django.utils import timezone
from django.core.exceptions import ValidationError


class Customer(models.Model):
    TYPE_CASUAL = "CASUAL"
    TYPE_FREQUENT = "FREQUENT"
    TYPE_CHOICES = [(TYPE_CASUAL, "Casual"), (TYPE_FREQUENT, "Frequent")]

    customer_type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    name = models.CharField(max_length=120)
    phone = models.CharField(max_length=20, null=True, blank=True, unique=True)
    birth_date = models.DateField(null=True, blank=True)

    def clean(self):
        if self.customer_type == self.TYPE_FREQUENT:
            if not self.phone or not self.birth_date:
                raise ValidationError("Cliente frecuente requiere phone y birth_date.")
        if self.customer_type == self.TYPE_CASUAL:
            # recomendado: no guardar datos de frecuente en casual
            if self.phone or self.birth_date:
                raise ValidationError("Cliente casual solo requiere name (sin phone/birth_date).")

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)

    class Meta:
        indexes = [
            models.Index(fields=["customer_type", "phone"]),
        ]

    def __str__(self):
        return self.name

class Appointment(models.Model):
    STATUS_RESERVED = "RESERVED"
    STATUS_CANCELLED = "CANCELLED"
    STATUS_ATTENDED = "ATTENDED"
    STATUS_NO_SHOW = "NO_SHOW"
    STATUS_CHOICES = [
        (STATUS_RESERVED, "Reserved"),
        (STATUS_CANCELLED, "Cancelled"),
        (STATUS_ATTENDED, "Attended"),
        (STATUS_NO_SHOW, "No show"),
    ]

    CHANNEL_CLIENT = "CLIENT"
    CHANNEL_STAFF = "STAFF"
    CHANNEL_CHOICES = [(CHANNEL_CLIENT, "Client"), (CHANNEL_STAFF, "Staff")]

    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="appointments")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_RESERVED)
    start_datetime = models.DateTimeField()
    end_datetime = models.DateTimeField()

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="created_appointments"
    )
    created_channel = models.CharField(max_length=20, choices=CHANNEL_CHOICES, default=CHANNEL_CLIENT)

    # Cobro recomendado (cliente NO lo ve)
    recommended_subtotal = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    recommended_discount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    recommended_total = models.DecimalField(max_digits=10, decimal_places=2, default=0)

    cancel_reason = models.CharField(max_length=255, null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancelled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="cancelled_appointments"
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    PAID_METHOD_CASH = "CASH"
    PAID_METHOD_TRANSFER = "TRANSFER"
    PAID_METHOD_CARD = "CARD"
    PAID_METHOD_CHOICES = [
        (PAID_METHOD_CASH, "Cash"),
        (PAID_METHOD_TRANSFER, "Transfer"),
        (PAID_METHOD_CARD, "Card"),
    ]

    paid_total = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    payment_method = models.CharField(max_length=20, choices=PAID_METHOD_CHOICES, null=True, blank=True)
    paid_at = models.DateTimeField(null=True, blank=True)
    paid_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="payments_recorded"
    )


class AppointmentBlock(models.Model):
    appointment = models.ForeignKey(Appointment, on_delete=models.CASCADE, related_name="blocks")
    sequence = models.PositiveSmallIntegerField()
    worker = models.ForeignKey("staffing.Worker", on_delete=models.PROTECT, related_name="blocks")
    start_datetime = models.DateTimeField()
    end_datetime = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["worker", "start_datetime"],
                name="uniq_worker_start_datetime_block",
            )
        ]
        indexes = [
            models.Index(fields=["worker", "start_datetime"]),
            models.Index(fields=["worker", "end_datetime"]),
        ]


class AppointmentServiceLine(models.Model):
    appointment_block = models.ForeignKey(AppointmentBlock, on_delete=models.CASCADE, related_name="service_lines")
    service = models.ForeignKey("catalog.Service", on_delete=models.PROTECT)

    service_name_snapshot = models.CharField(max_length=120)
    duration_minutes_snapshot = models.PositiveSmallIntegerField()
    buffer_before_snapshot = models.PositiveSmallIntegerField(default=0)
    buffer_after_snapshot = models.PositiveSmallIntegerField(default=0)
    price_snapshot = models.DecimalField(max_digits=10, decimal_places=2)

class AppointmentAudit(models.Model):
    ACTION_CREATE = "CREATE"
    ACTION_RESCHEDULE = "RESCHEDULE"
    ACTION_CANCEL = "CANCEL"
    ACTION_STATUS_CHANGE = "STATUS_CHANGE"
    ACTION_PAYMENT = "PAYMENT_RECORDED"

    ACTION_CHOICES = [
        (ACTION_CREATE, "Create"),
        (ACTION_RESCHEDULE, "Reschedule"),
        (ACTION_CANCEL, "Cancel"),
        (ACTION_STATUS_CHANGE, "Status change"),
        (ACTION_PAYMENT, "Payment recorded"),
    ]

    appointment = models.ForeignKey("booking.Appointment", on_delete=models.CASCADE, related_name="audits")
    action = models.CharField(max_length=30, choices=ACTION_CHOICES)
    performed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="appointment_audits"
    )
    performed_at = models.DateTimeField(default=timezone.now)
    reason = models.CharField(max_length=255, null=True, blank=True)
    detail_json = models.JSONField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["appointment", "performed_at"]),
            models.Index(fields=["action", "performed_at"]),
        ]