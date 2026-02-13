from django.contrib.auth import get_user_model
from rest_framework import serializers

User = get_user_model()


class UserStaffSerializer(serializers.ModelSerializer):
    """
    CRUD para usuarios del sistema (accounts.User).
    - Permite crear/editar user (username/email/phone/is_staff/is_active)
    - Permite setear password si viene.
    """
    password = serializers.CharField(write_only=True, required=False, allow_blank=False)

    class Meta:
        model = User
        fields = [
            "id",
            "username",
            "email",
            "phone",
            "is_staff",
            "is_active",
            "password",
        ]

    def create(self, validated_data):
        password = validated_data.pop("password", None)
        user = User(**validated_data)
        if password:
            user.set_password(password)
        else:
            # si no mandan password, igual debe quedar usable; puedes cambiar esto si quieres forzar password
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
