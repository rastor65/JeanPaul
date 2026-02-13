from django.contrib.auth import get_user_model
from rest_framework import serializers

from accounts.permissions import IsStaffOrAdmin
from django.db import IntegrityError
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView, ListCreateAPIView, RetrieveUpdateDestroyAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from accounts.authentication import CookieJWTAuthentication
from accounts.permissions import IsStaffOrAdmin
from staffing.models import Worker, WorkerScheduleRule, WorkerBreak, WorkerException
from staffing.serializers_staff import (
    WorkerManageSerializer,
    WorkerScheduleRuleSerializer,
    WorkerBreakSerializer,
    WorkerExceptionSerializer,
)

User = get_user_model()

class WorkerManageSerializer(serializers.ModelSerializer):
    user_id = serializers.IntegerField(required=False, allow_null=True)
    username = serializers.SerializerMethodField()
    email = serializers.SerializerMethodField()
    phone = serializers.SerializerMethodField()

    class Meta:
        model = Worker
        fields = ["id", "display_name", "role", "active", "user_id", "username", "email", "phone"]

    def get_username(self, obj):
        return getattr(obj.user, "username", None) if obj.user else None

    def get_email(self, obj):
        return getattr(obj.user, "email", None) if obj.user else None

    def get_phone(self, obj):
        return getattr(obj.user, "phone", None) if obj.user else None

    def validate_user_id(self, value):
        if value is None:
            return None
        if not User.objects.filter(id=value).exists():
            raise serializers.ValidationError("user_id no existe.")
        return value

    def create(self, validated_data):
        user_id = validated_data.pop("user_id", None)
        user = User.objects.get(id=user_id) if user_id else None

        if user and Worker.objects.filter(user=user).exists():
            raise serializers.ValidationError({"user_id": "Ese usuario ya está asignado a otro trabajador."})

        worker = Worker.objects.create(user=user, **validated_data)
        return worker

    def update(self, instance, validated_data):
        user_id = validated_data.pop("user_id", None)

        if user_id is not None:
            if user_id is None:
                instance.user = None
            else:
                user = User.objects.get(id=user_id)
                other = Worker.objects.filter(user=user).exclude(id=instance.id).exists()
                if other:
                    raise serializers.ValidationError({"user_id": "Ese usuario ya está asignado a otro trabajador."})
                instance.user = user

        for k, v in validated_data.items():
            setattr(instance, k, v)

        instance.save()
        return instance


class WorkerManageListCreateAPIView(ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerManageSerializer

    def get_queryset(self):
        qs = Worker.objects.select_related("user").all().order_by("id")
        q = (self.request.query_params.get("q") or "").strip().lower()
        if q:
            qs = qs.filter(display_name__icontains=q)
        return qs


class WorkerManageRetrieveUpdateAPIView(RetrieveUpdateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerManageSerializer
    queryset = Worker.objects.select_related("user").all().order_by("id")


class WorkerManageListCreateAPIView(ListCreateAPIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerManageSerializer

    def get_queryset(self):
        qs = Worker.objects.all().select_related("user").order_by("id")
        q = (self.request.query_params.get("q") or "").strip()
        role = (self.request.query_params.get("role") or "").strip().upper()
        active = self.request.query_params.get("active")

        if q:
            qs = qs.filter(display_name__icontains=q)
        if role in ("BARBER", "NAILS", "FACIAL"):
            qs = qs.filter(role=role)
        if active in ("0", "1"):
            qs = qs.filter(active=(active == "1"))
        return qs


class WorkerManageDetailAPIView(RetrieveUpdateDestroyAPIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerManageSerializer
    queryset = Worker.objects.all().select_related("user")

    # “Delete” seguro: lo pasamos a inactivo para no chocar con PROTECT en bloques/citas
    def delete(self, request, *args, **kwargs):
        obj = self.get_object()
        obj.active = False
        obj.save(update_fields=["active"])
        return Response({"detail": "Trabajador desactivado."}, status=200)


class WorkerScheduleRuleListCreateAPIView(ListCreateAPIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerScheduleRuleSerializer

    def get_queryset(self):
        return WorkerScheduleRule.objects.filter(worker_id=self.kwargs["worker_id"]).order_by("day_of_week")

    def perform_create(self, serializer):
        try:
            serializer.save(worker_id=self.kwargs["worker_id"])
        except IntegrityError:
            # uniq_worker_day_schedule
            raise


class WorkerScheduleRuleDetailAPIView(RetrieveUpdateDestroyAPIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerScheduleRuleSerializer

    def get_queryset(self):
        return WorkerScheduleRule.objects.filter(worker_id=self.kwargs["worker_id"])


class WorkerBreakListCreateAPIView(ListCreateAPIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerBreakSerializer

    def get_queryset(self):
        return WorkerBreak.objects.filter(worker_id=self.kwargs["worker_id"]).order_by("day_of_week", "start_time")

    def perform_create(self, serializer):
        serializer.save(worker_id=self.kwargs["worker_id"])


class WorkerBreakDetailAPIView(RetrieveUpdateDestroyAPIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerBreakSerializer

    def get_queryset(self):
        return WorkerBreak.objects.filter(worker_id=self.kwargs["worker_id"])


class WorkerExceptionListCreateAPIView(ListCreateAPIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerExceptionSerializer

    def get_queryset(self):
        return WorkerException.objects.filter(worker_id=self.kwargs["worker_id"]).order_by("-date", "start_time")

    def perform_create(self, serializer):
        serializer.save(worker_id=self.kwargs["worker_id"])


class WorkerExceptionDetailAPIView(RetrieveUpdateDestroyAPIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = WorkerExceptionSerializer

    def get_queryset(self):
        return WorkerException.objects.filter(worker_id=self.kwargs["worker_id"])
