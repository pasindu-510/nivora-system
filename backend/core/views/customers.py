"""Customer endpoints (spec 6.4)."""
from django.db.models import Q, Sum
from django.http import FileResponse, Http404
from django.utils import timezone
from rest_framework import filters, status
from rest_framework.permissions import AllowAny
from rest_framework.decorators import action
from rest_framework.response import Response

from ..activity import label_of, log_activity
from ..models import ActivityLog, Customer, Installment, Payment, Sale
from ..permissions import IsCashierOrAbove, IsManagerOrAbove
from ..serializers import CustomerSerializer, SaleListSerializer
from ..storage import check_customer_photo_token
from ..viewsets import TenantModelViewSet


class CustomerViewSet(TenantModelViewSet):
    """Business-scoped customer CRUD (any business role may manage)."""

    queryset = Customer.objects.select_related('business', 'blacklisted_by').all()
    serializer_class = CustomerSerializer
    permission_classes = [IsCashierOrAbove]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'phone', 'nic']
    ordering_fields = ['name', 'created_at']
    protected_delete_message = (
        'This customer is a guarantor on a sale and cannot be deleted.'
    )

    def get_queryset(self):
        qs = super().get_queryset()
        flag = self.request.query_params.get('blacklisted')
        if flag in ('true', 'false'):
            qs = qs.filter(is_blacklisted=flag == 'true')
        return qs

    def destroy(self, request, *args, **kwargs):
        """Keep unpaid buyers (the debt must stay traceable) and blacklisted people."""
        customer = self.get_object()
        if customer.is_blacklisted:
            # Deleting would let the same person be added again with a clean record.
            return Response(
                {'detail': 'This customer is blacklisted and cannot be deleted.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if customer.sales.filter(status=Sale.OPEN).exists():
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

    @action(detail=True, methods=['post'], permission_classes=[IsManagerOrAbove])
    def blacklist(self, request, pk=None):
        """Stop this person buying or guaranteeing on installments."""
        reason = str(request.data.get('reason') or '').strip()
        if not reason or len(reason) > 255:
            return Response(
                {'reason': 'Give a reason (up to 255 characters).'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return self._set_blacklist(True, reason, request.user)

    @action(detail=True, methods=['post'], permission_classes=[IsManagerOrAbove])
    def unblacklist(self, request, pk=None):
        return self._set_blacklist(False, '', None)

    def _set_blacklist(self, flag, reason, user):
        customer = self.get_object()
        old_reason = customer.blacklist_reason
        customer.is_blacklisted = flag
        customer.blacklist_reason = reason
        customer.blacklisted_at = timezone.now() if flag else None
        customer.blacklisted_by = user
        customer.save(update_fields=[
            'is_blacklisted', 'blacklist_reason', 'blacklisted_at', 'blacklisted_by',
        ])
        log_activity(
            self.request.user, ActivityLog.EDIT, 'CUSTOMER',
            record_id=customer.pk, label=label_of(customer),
            details=(f'blacklisted: {reason}' if flag
                     else f'removed from blacklist (was: {old_reason})'),
        )
        return Response(self.get_serializer(customer).data)

    @action(detail=True, methods=['get'])
    def history(self, request, pk=None):
        """Customer purchase history + outstanding balance.

        Returns:
        {
          "customer": { <CustomerSerializer data> },
          "total_sales_count": int,
          "total_spent": decimal (sum of total_cost across non-cancelled sales),
          "outstanding": decimal (sum of remaining_cost across OPEN non-cancelled sales),
          "sales": [ <SaleListSerializer rows, latest 20, ordered -created_at> ],
          "overdue_count": int, "overdue_amount": decimal,
          "total_paid": decimal, "cash_sales_count": int,
          "active_plans": int, "completed_plans": int,
          "last_purchase_at": datetime|null,
          "next_due": {"date", "amount", "sale", "invoice_no"} | null,
          "guaranteed_sales": [ <rows where this person is a guarantor, latest 20> ]
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
        related = ('customer', 'branch', 'created_by', 'guarantor_1', 'guarantor_2')
        latest_sales = sales_qs.select_related(*related).order_by('-created_at')[:20]

        overdue = list(Installment.objects.filter(
            business=business, sale__customer=customer, sale__status=Sale.OPEN,
            is_paid=False, due_date__lt=timezone.localdate(),
        ))
        overdue_amount = sum(
            row.amount + row.interest_charged - row.paid_amount for row in overdue
        )
        total_paid = Payment.objects.filter(
            business=business, sale__in=sales_qs,
        ).aggregate(total=Sum('amount'))['total'] or 0
        plans = sales_qs.filter(is_single_payment=False)
        last_sale = sales_qs.order_by('-created_at').first()
        # Oldest unpaid installment: an overdue one comes before any upcoming one.
        due = (
            Installment.objects.filter(
                business=business, sale__customer=customer,
                sale__status=Sale.OPEN, is_paid=False,
            )
            .select_related('sale')
            .order_by('due_date', 'number')
            .first()
        )
        guaranteed = (
            Sale.objects.filter(
                Q(guarantor_1=customer) | Q(guarantor_2=customer), business=business,
            )
            .exclude(status=Sale.CANCELLED)
            .select_related(*related)
            .order_by('-created_at')[:20]
        )

        return Response(
            {
                'customer': CustomerSerializer(customer, context={'request': request}).data,
                'total_sales_count': total_sales_count,
                'total_spent': total_spent,
                'outstanding': outstanding,
                'sales': SaleListSerializer(
                    latest_sales, many=True, context={'request': request}
                ).data,
                'total_paid': total_paid,
                'cash_sales_count': sales_qs.filter(is_single_payment=True).count(),
                'active_plans': plans.filter(status=Sale.OPEN).count(),
                'completed_plans': plans.filter(status=Sale.CLOSED).count(),
                'last_purchase_at': last_sale.created_at if last_sale else None,
                'next_due': {
                    'date': due.due_date,
                    'amount': due.amount + due.interest_charged - due.paid_amount,
                    'sale': due.sale_id,
                    'invoice_no': due.sale.invoice_no,
                } if due else None,
                'overdue_count': len(overdue),
                'overdue_amount': overdue_amount,
                'guaranteed_sales': SaleListSerializer(
                    guaranteed, many=True, context={'request': request}
                ).data,
            }
        )