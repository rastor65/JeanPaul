from django.urls import path
from booking.api.availability import AvailabilityOptionsAPIView
from booking.api.appointments import AppointmentCreateAPIView
from booking.api.agenda import StaffAgendaAPIView, MyAgendaAPIView

urlpatterns = [
    path("availability/options/", AvailabilityOptionsAPIView.as_view()),
    path("appointments/", AppointmentCreateAPIView.as_view()),
    path("agenda/staff/", StaffAgendaAPIView.as_view(), name="agenda-staff"),
    path("agenda/me/", MyAgendaAPIView.as_view(), name="agenda-me"),
]
