from django.urls import path
from staffing.api import PublicBarberListAPIView
from staffing.api_workers import WorkerStaffListAPIView
from staffing.api_manage import (
    WorkerManageListCreateAPIView,
    WorkerManageDetailAPIView,
    WorkerScheduleRuleListCreateAPIView,
    WorkerScheduleRuleDetailAPIView,
    WorkerBreakListCreateAPIView,
    WorkerBreakDetailAPIView,
    WorkerExceptionListCreateAPIView,
    WorkerExceptionDetailAPIView,
)

urlpatterns = [
    # público
    path("public/workers/barbers/", PublicBarberListAPIView.as_view(), name="public-barbers"),

    # staff simple (tiny)
    path("staff/workers/", WorkerStaffListAPIView.as_view(), name="staff-workers"),

    # staff manage (CRUD)
    path("staff/workers/manage/", WorkerManageListCreateAPIView.as_view(), name="staff-workers-manage"),
    path("staff/workers/manage/<int:pk>/", WorkerManageDetailAPIView.as_view(), name="staff-workers-manage-detail"),

    path("staff/workers/manage/<int:worker_id>/schedule-rules/", WorkerScheduleRuleListCreateAPIView.as_view(), name="staff-worker-rules"),
    path("staff/workers/manage/<int:worker_id>/schedule-rules/<int:pk>/", WorkerScheduleRuleDetailAPIView.as_view(), name="staff-worker-rules-detail"),

    path("staff/workers/manage/<int:worker_id>/breaks/", WorkerBreakListCreateAPIView.as_view(), name="staff-worker-breaks"),
    path("staff/workers/manage/<int:worker_id>/breaks/<int:pk>/", WorkerBreakDetailAPIView.as_view(), name="staff-worker-breaks-detail"),

    path("staff/workers/manage/<int:worker_id>/exceptions/", WorkerExceptionListCreateAPIView.as_view(), name="staff-worker-exceptions"),
    path("staff/workers/manage/<int:worker_id>/exceptions/<int:pk>/", WorkerExceptionDetailAPIView.as_view(), name="staff-worker-exceptions-detail"),
]
