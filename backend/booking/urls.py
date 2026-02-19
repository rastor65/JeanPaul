from django.urls import path

from booking.api.availability import AvailabilityOptionsAPIView
from booking.api.appointments import AppointmentCreateAPIView
from booking.api.agenda import StaffAgendaAPIView, MyAgendaAPIView
from booking.api.public_appointments import PublicAppointmentCreateAPIView
from booking.api_customers_staff import CustomerStaffListCreateAPIView, CustomerStaffDetailAPIView
from booking.views import AppointmentStaffList
from booking.api.reschedule import AppointmentRescheduleAPIView

from booking.api.reschedule import AppointmentRescheduleAPIView
from booking.api.inline_edit import AppointmentInlineEditAPIView


from booking.api.management import (
    CancelAppointmentAPIView,
    MarkAttendedAPIView,
    MarkNoShowAPIView,
    RegisterPaymentAPIView,
)

urlpatterns = [
    # disponibilidad (opciones de turno)
    path("availability/options/", AvailabilityOptionsAPIView.as_view(), name="availability-options"),

    # creación de citas (cliente o recepción, usando option_id)
    path("appointments/", AppointmentCreateAPIView.as_view(), name="appointment-create"),

    # agenda
    path("agenda/staff/", StaffAgendaAPIView.as_view(), name="agenda-staff"),
    path("agenda/my/", MyAgendaAPIView.as_view(), name="agenda-my"),

    # acciones operativas
    path("appointments/<int:pk>/cancel/", CancelAppointmentAPIView.as_view(), name="appointment-cancel"),
    path("appointments/<int:pk>/attend/", MarkAttendedAPIView.as_view(), name="appointment-attend"),
    path("appointments/<int:pk>/no-show/", MarkNoShowAPIView.as_view(), name="appointment-no-show"),
    path("appointments/<int:pk>/payment/", RegisterPaymentAPIView.as_view(), name="appointment-payment"),

    path("public/appointments/", PublicAppointmentCreateAPIView.as_view(), name="public-appointments-create"),
    path("staff/customers/", CustomerStaffListCreateAPIView.as_view(), name="staff-customers"),
    path("staff/customers/<int:pk>/", CustomerStaffDetailAPIView.as_view(), name="staff-customers-detail"),

    path("appointments/staff/", AppointmentStaffList.as_view(), name="appointments-staff"),
    path("staff/appointments/<int:appointment_id>/reschedule/", AppointmentRescheduleAPIView.as_view(), name="appointment-reschedule"),
    path("staff/appointments/<int:appointment_id>/inline-edit/", AppointmentInlineEditAPIView.as_view(), name="appointment-inline-edit"),
]
