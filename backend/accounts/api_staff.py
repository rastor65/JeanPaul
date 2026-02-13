from django.contrib.auth import get_user_model
from django.apps import apps

from rest_framework import serializers
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView
from rest_framework.response import Response

from accounts.permissions import IsStaffOrAdmin


User = get_user_model()


# --------------------------
# USERS (accounts.User)
# --------------------------
class UserStaffSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=False, allow_blank=False)

    class Meta:
        model = User
        fields = [
            "id",
            "username",
            "email",
            "phone",
            "first_name",
            "last_name",
            "is_active",
            "is_staff",
            "is_superuser",
            "password",
        ]

    def create(self, validated_data):
        password = validated_data.pop("password", None)
        user = User(**validated_data)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save()
        return user

    def update(self, instance, validated_data):
        password = validated_data.pop("password", None)
        for k, v in validated_data.items():
            setattr(instance, k, v)
        if password:
            instance.set_password(password)
        instance.save()
        return instance


class UserStaffListCreateAPIView(ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = UserStaffSerializer

    def get_queryset(self):
        qs = User.objects.all().order_by("id")
        q = (self.request.query_params.get("q") or "").strip()
        if q:
            qs = qs.filter(
                serializers.Q(username__icontains=q)
                | serializers.Q(email__icontains=q)
                | serializers.Q(phone__icontains=q)
                | serializers.Q(first_name__icontains=q)
                | serializers.Q(last_name__icontains=q)
            )
        return qs


class UserStaffRetrieveUpdateAPIView(RetrieveUpdateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = UserStaffSerializer
    queryset = User.objects.all().order_by("id")


class UserStaffResetPasswordAPIView(APIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]

    def post(self, request, pk: int):
        password = str((request.data or {}).get("password", "")).strip()
        if not password:
            return Response({"detail": "password es requerido."}, status=400)

        try:
            user = User.objects.get(pk=pk)
        except User.DoesNotExist:
            return Response({"detail": "Usuario no existe."}, status=404)

        user.set_password(password)
        user.save()
        return Response({"detail": "OK"}, status=200)


# --------------------------
# CUSTOMERS (booking.Customer)
# --------------------------
def _Customer():
    # Lazy load para no romper imports
    return apps.get_model("booking", "Customer")


class CustomerStaffSerializer(serializers.Serializer):
    id = serializers.IntegerField(read_only=True)
    customer_type = serializers.CharField(required=False, allow_blank=True)
    name = serializers.CharField()
    phone = serializers.CharField(required=False, allow_blank=True, allow_null=True)
    birth_date = serializers.DateField(required=False, allow_null=True)
    active = serializers.BooleanField(required=False)

    def create(self, validated_data):
        Customer = _Customer()
        return Customer.objects.create(**validated_data)

    def update(self, instance, validated_data):
        for k, v in validated_data.items():
            setattr(instance, k, v)
        instance.save()
        return instance


class CustomerStaffListCreateAPIView(ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = CustomerStaffSerializer

    def get_queryset(self):
        Customer = _Customer()
        qs = Customer.objects.all().order_by("-id")

        q = (self.request.query_params.get("q") or "").strip()
        if q:
            # intenta filtrar por campos comunes
            filters = serializers.Q()
            if hasattr(Customer, "name"):
                filters |= serializers.Q(name__icontains=q)
            if hasattr(Customer, "phone"):
                filters |= serializers.Q(phone__icontains=q)
            qs = qs.filter(filters)

        return qs


class CustomerStaffRetrieveUpdateAPIView(RetrieveUpdateAPIView):
    permission_classes = [IsAuthenticated, IsStaffOrAdmin]
    serializer_class = CustomerStaffSerializer

    def get_queryset(self):
        Customer = _Customer()
        return Customer.objects.all().order_by("-id")
