from rest_framework import serializers
from booking.models import Customer


class CustomerStaffSerializer(serializers.ModelSerializer):
    class Meta:
        model = Customer
        fields = ["id", "customer_type", "name", "phone", "birth_date"]
