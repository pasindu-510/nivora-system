"""Sales, installments and payment endpoints (spec 6.4)."""
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from ..models import (
    Installment,
    LotAllocation,
    Payment,
    RoleConstants,
    Sale,
    SaleItem,
    StockLot,
    StockMovement,
)
from ..permissions import IsCashierOrAbove
from ..serializers import (
    InstallmentPaymentSerializer,
    PaymentSerializer,
    SaleCreateSerializer,
    SaleDetailSerializer,
    SaleListSerializer,
)
from ..viewsets import TenantModelViewSet


class SaleViewSet(TenantModelViewSet):
    """Sales with itemized lines, FIFO costing and installment split.

    - ``POST /api/sales/`` — create via :class:`SaleCreateSerializer`
      (calls :func:`core.services.record_sale`).
    - ``GET  /api/sales/{id}/`` — detail with items/installments/payments.
    """

    queryset = Sale.objects.select_related(
        'business', 'branch', 'customer', 'created_by'
    ).prefetch_related('items', 'installments', 'payments').all()
    permission_classes = [IsCashierOrAbove]
    filter_backends = [
        DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter,
    ]
    filterset_fields = ['status', 'branch', 'customer', 'is_single_payment']
    search_fields = ['invoice_no', 'customer__name', 'customer__phone']
    ordering_fields = ['created_at', 'invoice_no']

    def get_queryset(self):
        qs = super().get_queryset()
        # Granular list filters (each ignored when absent or invalid)
        qp = self.request.query_params
        customer_name = qp.get('customer_name')
        if customer_name:
            qs = qs.filter(customer__name__icontains=customer_name)
        customer_phone = qp.get('customer_phone')
        if customer_phone:
            qs = qs.filter(customer__phone__icontains=customer_phone)
        customer_nic = qp.get('customer_nic')
        if customer_nic:
            qs = qs.filter(customer__nic__icontains=customer_nic)
        date_from = qp.get('date_from')
        if date_from:
            try:
                from django.utils.dateparse import parse_date
                parsed = parse_date(date_from)
                if parsed is not None:
                    qs = qs.filter(created_at__date__gte=parsed)
            except Exception:
                pass
        date_to = qp.get('date_to')
        if date_to:
            try:
                from django.utils.dateparse import parse_date
                parsed = parse_date(date_to)
                if parsed is not None:
                    qs = qs.filter(created_at__date__lte=parsed)
            except Exception:
                pass
        paid_status = qp.get('paid_status')
        if paid_status == 'fully_paid':
            qs = qs.filter(remaining_cost__lte=0)
        elif paid_status == 'outstanding':
            qs = qs.filter(remaining_cost__gt=0)
        # any other value: ignore (no filter)
        return qs

    def get_serializer_class(self):
        if self.action == 'list':
            return SaleListSerializer
        return SaleDetailSerializer

    def create(self, request, *args, **kwargs):
        ser = SaleCreateSerializer(
            data=request.data, context={'request': request}
        )
        ser.is_valid(raise_exception=True)
        sale = ser.save()
        return Response(
            SaleDetailSerializer(sale, context={'request': request}).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=['post'])
    def pay_installment(self, request, pk=None):
        """Record a payment against one of the sale's installments."""
        sale = self.get_object()
        installment_id = request.data.get('installment')
        try:
            installment = Installment.objects.get(
                id=installment_id, sale=sale, business=request.user.business
            )
        except Installment.DoesNotExist:
            return Response(
                {'detail': 'Installment not found on this sale.'},
                status=status.HTTP_404_NOT_FOUND,
            )
        ser = InstallmentPaymentSerializer(
            data=request.data, context={'request': request}
        )
        ser.is_valid(raise_exception=True)
        ser.save()
        # self.get_object() returned a pre-payment snapshot; fetch the current
        # row so the response reflects the recorded payment.
        sale.refresh_from_db()
        sale._prefetched_objects_cache = {}
        return Response(
            SaleDetailSerializer(sale, context={'request': request}).data
        )

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        """Cancel a sale: reverse FIFO lot allocations, restore stock, create reversing movements.

        Only business_admin and manager may cancel; cashier receives 403.
        If sale is already cancelled, returns 400.
        Response mirrors pay_installment: refreshed SaleDetailSerializer.
        """
        sale = self.get_object()

        # Role gate: only business_admin and manager
        user_role = request.user.role
        if user_role not in (RoleConstants.BUSINESS_ADMIN, RoleConstants.MANAGER):
            return Response(
                {'detail': 'Only managers and admins can cancel sales.'},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Already cancelled?
        if sale.status == Sale.CANCELLED:
            return Response(
                {'detail': 'Sale is already cancelled.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Reverse FIFO allocations for each sale item
        for sale_item in sale.items.all():
            # Restore lot quantities
            for allocation in sale_item.allocations.all():
                lot = allocation.stock_lot
                lot.quantity_remaining += allocation.quantity
                lot.save(update_fields=['quantity_remaining'])

            # Restore item stock_quantity
            sale_item.item.stock_quantity += sale_item.quantity
            sale_item.item.save(update_fields=['stock_quantity'])

            # Create reversing StockMovement (type ADJUST with positive quantity)
            StockMovement.objects.create(
                business=sale.business,
                branch=sale.branch,
                item=sale_item.item,
                type=StockMovement.ADJUST,
                quantity=sale_item.quantity,
                reference=sale.invoice_no,
                note=f'Cancelled sale {sale.invoice_no}',
                created_by=request.user,
            )

        # Update sale status and remaining_cost
        sale.status = Sale.CANCELLED
        sale.remaining_cost = 0
        sale.save(update_fields=['status', 'remaining_cost'])

        # Return refreshed sale detail (mirror pay_installment)
        sale.refresh_from_db()
        sale._prefetched_objects_cache = {}
        return Response(
            SaleDetailSerializer(sale, context={'request': request}).data
        )


class PaymentViewSet(TenantModelViewSet):
    """Read-only payment registry (all business roles may read)."""

    queryset = Payment.objects.select_related(
        'business', 'sale', 'installment', 'cash_account', 'received_by'
    ).all()
    serializer_class = PaymentSerializer
    permission_classes = [IsCashierOrAbove]
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['sale', 'installment', 'method', 'cash_account']
    ordering_fields = ['created_at']
    http_method_names = ['get']