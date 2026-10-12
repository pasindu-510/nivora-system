"""Customer endpoints (spec 6.4)."""
from django.db.models import Sum
from rest_framework import filters
from rest_framework.decorators import action
from rest_framework.response import Response

from ..models import Customer, Sale
from ..permissions import IsCashierOrAbove
from ..serializers import CustomerSerializer, SaleListSerializer
from ..viewsets import TenantModelViewSet


class CustomerViewSet(TenantModelViewSet):
    """Business-scoped customer CRUD (any business role may manage)."""

    queryset = Customer.objects.select_related('business').all()
    serializer_class = CustomerSerializer
    permission_classes = [IsCashierOrAbove]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'phone', 'nic']
    ordering_fields = ['name', 'created_at']

    @action(detail=True, methods=['get'])
    def history(self, request, pk=None):
        """Customer purchase history + outstanding balance.

        Returns:
        {
          "customer": { <CustomerSerializer data> },
          "total_sales_count": int,
          "total_spent": decimal (sum of total_cost across non-cancelled sales),
          "outstanding": decimal (sum of remaining_cost across OPEN non-cancelled sales),
          "sales": [ <SaleListSerializer rows, latest 20, ordered -created_at> ]
        }
        """
        customer = self.get_object()
        business = request.user.business

        # Non-cancelled sales for this customer
        sales_qs = Sale.objects.filter(
            business=business, customer=customer
        ).exclude(status=Sale.CANCELLED)

        total_sales_count = sales_qs.count()
        total_spent = sales_qs.aggregate(total=Sum('total_cost'))['total'] or 0

        # Outstanding: sum of remaining_cost for OPEN sales
        outstanding = sales_qs.filter(status=Sale.OPEN).aggregate(
            total=Sum('remaining_cost')
        )['total'] or 0

        # Latest 20 sales
        latest_sales = sales_qs.order_by('-created_at')[:20]

        return Response(
            {
                'customer': CustomerSerializer(customer, context={'request': request}).data,
                'total_sales_count': total_sales_count,
                'total_spent': total_spent,
                'outstanding': outstanding,
                'sales': SaleListSerializer(
                    latest_sales, many=True, context={'request': request}
                ).data,
            }
        )