from django.contrib.auth import get_user_model
from rest_framework import serializers
from accounts.models import User
from staffing.models import Worker, WorkerScheduleRule, WorkerBreak, WorkerException

User = get_user_model()


class UserTinySerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "email", "phone", "is_active", "is_staff"]


class WorkerStaffSerializer(serializers.ModelSerializer):
    """
    Serializer completo para administrar Workers desde panel staff/admin.
    - user: read_only (objeto)
    - user_id: write_only (para asociar)
    """
    user = UserTinySerializer(read_only=True)
    user_id = serializers.IntegerField(required=False, allow_null=True, write_only=True)

    class Meta:
        model = Worker
        fields = ["id", "display_name", "role", "active", "user", "user_id"]

    def validate_user_id(self, value):
        if value is None:
            return value

        try:
            u = User.objects.get(id=value)
        except User.DoesNotExist:
            raise serializers.ValidationError("El usuario indicado no existe.")

        # evitar que un User se asocie a 2 workers
        qs = Worker.objects.filter(user_id=value)
        if self.instance:
            qs = qs.exclude(id=self.instance.id)
        if qs.exists():
            raise serializers.ValidationError("Este usuario ya está asociado a otro trabajador.")

        return value

    def create(self, validated_data):
        user_id = validated_data.pop("user_id", None)
        worker = Worker(**validated_data)
        if user_id is not None:
            worker.user_id = user_id
        worker.save()
        return worker

    def update(self, instance, validated_data):
        # si viene user_id, se cambia asociación; si no viene, se deja igual
        if "user_id" in validated_data:
            user_id = validated_data.pop("user_id")
            instance.user_id = user_id  # puede ser None para desvincular

        for k, v in validated_data.items():
            setattr(instance, k, v)

        instance.save()
        return instance

class WorkerManageSerializer(serializers.ModelSerializer):
    user_id = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(),
        source="user",
        required=False,
        allow_null=True
    )
    username = serializers.CharField(source="user.username", read_only=True)
    email = serializers.CharField(source="user.email", read_only=True)
    phone = serializers.CharField(source="user.phone", read_only=True)

    class Meta:
        model = Worker
        fields = ["id", "display_name", "role", "active", "user_id", "username", "email", "phone"]


class WorkerScheduleRuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkerScheduleRule
        fields = ["id", "worker", "day_of_week", "start_time", "end_time", "active"]
        read_only_fields = ["worker"]

    def validate(self, attrs):
        st = attrs.get("start_time") or getattr(self.instance, "start_time", None)
        en = attrs.get("end_time") or getattr(self.instance, "end_time", None)
        if st and en and en <= st:
            raise serializers.ValidationError("end_time debe ser mayor que start_time.")
        return attrs


class WorkerBreakSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkerBreak
        fields = ["id", "worker", "day_of_week", "start_time", "end_time"]
        read_only_fields = ["worker"]

    def validate(self, attrs):
        st = attrs.get("start_time") or getattr(self.instance, "start_time", None)
        en = attrs.get("end_time") or getattr(self.instance, "end_time", None)
        if st and en and en <= st:
            raise serializers.ValidationError("end_time debe ser mayor que start_time.")
        return attrs


class WorkerExceptionSerializer(serializers.ModelSerializer):
    class Meta:
        model = WorkerException
        fields = ["id", "worker", "date", "type", "start_time", "end_time", "note"]
        read_only_fields = ["worker"]

    def validate(self, attrs):
        t = attrs.get("type") or getattr(self.instance, "type", None)
        st = attrs.get("start_time") if "start_time" in attrs else getattr(self.instance, "start_time", None)
        en = attrs.get("end_time") if "end_time" in attrs else getattr(self.instance, "end_time", None)

        if t == WorkerException.TYPE_EXTRA_WORKING:
            if not st or not en:
                raise serializers.ValidationError("EXTRA_WORKING requiere start_time y end_time.")
        if st and en and en <= st:
            raise serializers.ValidationError("end_time debe ser mayor que start_time.")
        return attrs
