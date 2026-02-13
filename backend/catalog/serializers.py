from rest_framework import serializers
from catalog.models import Service, ServiceCategory

# Import opcional para fixed_worker
try:
    from staffing.models import Worker
except Exception:
    Worker = None


# --------------------------
# CATEGORIES
# --------------------------
class ServiceCategoryPublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = ServiceCategory
        fields = ["id", "name"]


class ServiceCategoryStaffSerializer(serializers.ModelSerializer):
    default_fixed_worker_label = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = ServiceCategory
        fields = ["id", "name", "active", "default_fixed_worker", "default_fixed_worker_label"]

    def get_default_fixed_worker_label(self, obj):
        w = getattr(obj, "default_fixed_worker", None)
        return str(w) if w else None


# --------------------------
# SERVICES
# --------------------------
class ServicePublicSerializer(serializers.ModelSerializer):
    category = ServiceCategoryPublicSerializer(read_only=True)

    class Meta:
        model = Service
        fields = [
            "id",
            "name",
            "category",
            "duration_minutes",
            "buffer_before_minutes",
            "buffer_after_minutes",
            "description",
            "requirements",
            "active",
        ]


class ServiceStaffSerializer(serializers.ModelSerializer):
    # Lectura
    category = ServiceCategoryPublicSerializer(read_only=True)
    fixed_worker_label = serializers.SerializerMethodField(read_only=True)

    # Escritura
    category_id = serializers.PrimaryKeyRelatedField(
        source="category",
        queryset=ServiceCategory.objects.all(),
        write_only=True,
        required=True,
    )

    if Worker is not None:
        fixed_worker_id = serializers.PrimaryKeyRelatedField(
            source="fixed_worker",
            queryset=Worker.objects.all(),
            write_only=True,
            required=False,
            allow_null=True,
        )
    else:
        fixed_worker_id = serializers.IntegerField(write_only=True, required=False, allow_null=True)

    class Meta:
        model = Service
        fields = [
            "id",
            "name",
            "category",
            "category_id",
            "duration_minutes",
            "buffer_before_minutes",
            "buffer_after_minutes",
            "price",
            "description",
            "requirements",
            "active",
            "assignment_type",
            "fixed_worker",
            "fixed_worker_id",
            "fixed_worker_label",
        ]
        extra_kwargs = {
            # fixed_worker es FK: en lectura queremos id; en escritura usamos fixed_worker_id
            "fixed_worker": {"read_only": True},
        }

    def get_fixed_worker_label(self, obj):
        w = getattr(obj, "fixed_worker", None)
        return str(w) if w else None

    def validate(self, attrs):
        # Tomar valores actuales si es PATCH
        assignment_type = attrs.get(
            "assignment_type",
            getattr(self.instance, "assignment_type", Service.ASSIGNMENT_ROLE_BASED),
        )

        fixed_worker = attrs.get(
            "fixed_worker",
            getattr(self.instance, "fixed_worker", None),
        )

        # Si viene fixed_worker_id se asigna a "fixed_worker" via source
        # (en attrs ya estará como fixed_worker si DRF resolvió bien)
        if assignment_type == Service.ASSIGNMENT_FIXED_WORKER:
            if not fixed_worker:
                raise serializers.ValidationError(
                    {"fixed_worker_id": "Requerido cuando assignment_type = FIXED_WORKER."}
                )
        else:
            # ROLE_BASED => limpiamos fixed_worker
            attrs["fixed_worker"] = None

        return attrs
