"""Customer endpoints (spec 6.4)."""
from django.db.models import Sum
from django.http import FileResponse, Http404
from rest_framework import filters, status
from rest_framework.permissions import AllowAny
from rest_framework.decorators import action
from rest_framework.response import Response

from ..models import Customer, Sale
from ..permissions import IsCashierOrAbove
from ..serializers import CustomerSerializer, SaleListSerializer
from ..storage import check_customer_photo_token
from ..viewsets import TenantModelViewSet


class CustomerViewSet(TenantModelViewSet):
    """Business-scoped customer CRUD (any business role may manage)."""

    queryset = Customer.objects.select_related('business').all()
    serializer_class = CustomerSerializer
    permission_classes = [IsCashierOrAbove]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'phone', 'nic']
    ordering_fields = ['name', 'created_at']
    protected_delete_message = (
        'This customer is a guarantor on a sale and cannot be deleted.'
    )

    def destroy(self, request, *args, **kwargs):
        """Keep the buyer of an unpaid sale: the debt must stay traceable."""
        if self.get_object().sales.filter(status=Sale.OPEN).exists():
            return Response(
                {'detail': 'This customer still owes money and cannot be deleted.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)

    @action(
        detail=True, methods=['get'], url_path='id-card-photo', url_name='id-card-photo',
        permission_classes=[AllowAny], authentication_classes=[],
    )
    def id_card_photo(self, request, pk=None):
        """Serve a customer's ID-card photo from private storage (B-24).

        No JWT (an <img> tag cannot send one); access is granted by the
        `sig` query parameter that CustomerSerializer issues to authenticated,
        tenant-scoped callers. The token is bound to this customer and file
        name and expires after PRIVATE_MEDIA_URL_MAX_AGE seconds.
        """
        customer = Customer.objects.filter(pk=pk).first()
        token = request.query_params.get('sig', '')
        if (
            customer is None
            or not customer.id_card_photo
            or not check_customer_photo_token(customer, token)
        ):
            raise Http404
        try:
            handle = customer.id_card_photo.open('rb')
        except FileNotFoundError:
            raise Http404
        response = FileResponse(handle)
        response['Cache-Control'] = 'private, max-age=300'
        response['X-Content-Type-Options'] = 'nosniff'
        return response

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