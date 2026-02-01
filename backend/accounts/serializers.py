from rest_framework import serializers
from django.contrib.auth import get_user_model

User = get_user_model()


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=6)
    role = serializers.CharField()

    class Meta:
        model = User
        fields = ["username", "password", "role"]

    def validate_role(self, value):
        value = value.upper()
        if value not in ("ADMIN", "STAFF", "WORKER"):
            raise serializers.ValidationError("Rol inválido.")
        return value

    def create(self, validated_data):
        password = validated_data.pop("password")
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        return user
