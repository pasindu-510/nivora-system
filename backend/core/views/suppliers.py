"""Supplier & purchase order endpoints (spec 6.5)."""
from decimal import Decimal

from django.db import transaction
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .. import services
from ..activity import log_activity
from ..models import ActivityLog, Purchase, PurchaseItem, Supplier, SupplierPayment
from ..permissions import IsManagerOrAbove
from ..serializers import (
    PurchaseCreateSerializer,
    PurchaseDetailSerializer,
    PurchaseListSerializer,
    PurchaseItemCreateSerializer,
    PurchaseReceiptCreateSerializer,
    PurchaseReceiptSerializer as PurchaseReceiptResponseSerializer,
    SupplierPaymentSerializer,
    SupplierSerializer,
    _cents,
)
from ..services import next_sequence_number
from .reports import received_value_of
from ..viewsets import TenantModelViewSet


class SupplierViewSet(TenantModelViewSet):
    """Business-scoped supplier CRUD (manager+)."""

    queryset = Supplier.objects.select_related('business').all()
    serializer_class = SupplierSerializer
    permission_classes = [IsManagerOrAbove]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'contact_person', 'phone', 'email']
    ordering_fields = ['name', 'created_at']

    @action(detail=True, methods=['get'])
    def ledger(self, request, pk=None):
        """Supplier statement: purchase orders, payments, and the balance owed.

        A purchase only becomes a payable once stock has actually been
        received, so ``total_billed`` sums line value proportionally to the
        received quantity. Draft/cancelled orders never contribute.

        Returns:
        {
          "supplier": { <SupplierSerializer data> },
          "purchase_count": int,
          "total_billed": decimal,   # received value across all POs
          "total_paid": decimal,     # sum of SupplierPayment rows
          "balance": decimal,        # total_billed - total_paid
          "purchases": [ { "id", "order_no", "status", "purchase_date",
                            "total", "received_value" } ],  # -created_at
          "payments": [ <SupplierPaymentSerializer rows, -payment_date> ]
        }
        """
        supplier = self.get_object()
        business = request.user.business

        # Non-cancelled orders only; drafts are not yet a commitment.
        purchases = Purchase.objects.filter(
            business=business, supplier=supplier
        ).exclude(status__in=[Purchase.DRAFT, Purchase.CANCELLED]).prefetch_related('items')

        purchase_rows = []
        total_billed = Decimal('0.00')
        for purchase in purchases:
            line_total = sum((i.total for i in purchase.items.all()), Decimal('0.00'))
            # Value the goods actually received, line by line (B-14).
            received_value = _cents(received_value_of(purchase))
            total_billed += received_value
            purchase_rows.append({
                'id': purchase.id,
                'order_no': purchase.order_no,
                'status': purchase.status,
                'expected_delivery_date': purchase.expected_delivery_date,
                'purchase_date': purchase.purchase_date,
                'total': _cents(line_total),
                'received_value': received_value,
                'created_at': purchase.created_at,
            })

        payments = SupplierPayment.objects.filter(
            business=business, supplier=supplier
        ).select_related('cash_account')
        total_paid = sum((p.amount for p in payments), Decimal('0.00'))

        return Response({
            'supplier': SupplierSerializer(supplier, context={'request': request}).data,
            'purchase_count': len(purchase_rows),
            'total_billed': _cents(total_billed),
            'total_paid': _cents(total_paid),
            'balance': _cents(total_billed - total_paid),
            'purchases': purchase_rows,
            'payments': SupplierPaymentSerializer(payments, many=True).data,
        })


class PurchaseViewSet(TenantModelViewSet):
    """Purchase orders with per-item add/remove endpoints (manager+)."""

    queryset = Purchase.objects.select_related(
        'business', 'supplier', 'branch'
    ).prefetch_related('items', 'receipts').all()
    permission_classes = [IsManagerOrAbove]
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['status', 'supplier', 'branch']
    search_fields = ['order_no', 'supplier__name']
    ordering_fields = ['created_at']

    def get_serializer_class(self):
        if self.action == 'list':
            return PurchaseListSerializer
        return PurchaseDetailSerializer

    def destroy(self, request, *args, **kwargs):
        """Only drafts may be deleted; anything placed is history (B-11)."""
        purchase = self.get_object()
        if purchase.status != Purchase.DRAFT:
            return Response(
                {'detail': 'Only draft orders can be deleted. Cancel it instead.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        # Context is required so supplier/branch are scoped to the caller's
        # business (B-02): without it any tenant's ids were accepted.
        ser = PurchaseCreateSerializer(data=request.data, context={'request': request})
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        business = request.user.business
        purchase = services._create_numbered(
            Purchase, 'order_no',
            lambda: next_sequence_number(business, 'PO', Purchase, 'order_no'),
            dict(
                business=business,
                branch=data['branch'],
                supplier=data['supplier'],
                expected_delivery_date=data.get('expected_delivery_date'),
                notes=data.get('notes', ''),
                ordered_by=request.user,
            ),
        )
        return Response(
            PurchaseDetailSerializer(purchase).data, status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=['post'])
    def add_item(self, request, pk=None):
        """Add an item line to a draft/ordered purchase."""
        purchase = self.get_object()
        if purchase.status in (Purchase.RECEIVED, Purchase.CANCELLED):
            return Response(
                {'detail': 'Cannot add products to a received or cancelled order.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        ser = PurchaseItemCreateSerializer(
            data=request.data, context={'request': request}
        )
        ser.is_valid(raise_exception=True)
        d = ser.validated_data
        total = d['quantity'] * d['unit_cost']
        item = PurchaseItem.objects.create(
            business=request.user.business,
            purchase=purchase,
            item=d['item'],
            quantity=d['quantity'],
            unit_cost=d['unit_cost'],
            total=total,
        )
        return Response(
            PurchaseDetailSerializer(purchase, context={'request': request}).data,
            status=status.HTTP_201_CREATED,
        )

    @transaction.atomic
    @action(detail=True, methods=['post'])
    def remove_item(self, request, pk=None):
        """Remove an item line that has not been received yet."""
        purchase = self.get_object()
        item_id = request.data.get('item_id')
        try:
            line = PurchaseItem.objects.get(
                id=item_id, purchase=purchase, received_quantity=0
            )
        except PurchaseItem.DoesNotExist:
            return Response(
                {'detail': 'Line not found or already partially received.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        log_activity(
            request.user, ActivityLog.EDIT, 'PURCHASE',
            record_id=purchase.pk, label=purchase.order_no,
            details=f'line removed: {line.item.code} x {line.quantity} at {line.unit_cost}',
        )
        line.delete()
        return Response(PurchaseDetailSerializer(purchase).data)

    @action(detail=True, methods=['post'])
    def place(self, request, pk=None):
        """Move a purchase from DRAFT to ORDERED."""
        purchase = self.get_object()
        if purchase.status != Purchase.DRAFT:
            return Response(
                {'detail': 'Only draft orders can be placed.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not purchase.items.exists():
            return Response(
                {'detail': 'Order has no product lines.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        purchase.status = Purchase.ORDERED
        purchase.save(update_fields=['status'])
        return Response(PurchaseDetailSerializer(purchase).data)

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        """Cancel a purchase that has not been received."""
        purchase = self.get_object()
        if purchase.status in (Purchase.RECEIVED, Purchase.PARTIALLY_RECEIVED):
            return Response(
                {'detail': 'Cannot cancel an order with received stock.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        purchase.status = Purchase.CANCELLED
        purchase.save(update_fields=['status'])
        log_activity(
            request.user, ActivityLog.CANCEL, 'PURCHASE',
            record_id=purchase.pk, label=purchase.order_no,
            details=f'supplier {purchase.supplier.name}',
        )
        return Response(PurchaseDetailSerializer(purchase).data)

    @transaction.atomic
    @action(detail=True, methods=['post'])
    def receive(self, request, pk=None):
        """Receive stock for this purchase order.

        Payload: ``{"quantities": {"<purchase_item_id>": qty}, "note": "..."}``.
        When ``quantities`` is omitted the full outstanding amount of every
        line is received.  Creates stock lots and movements via
        :func:`core.services.record_purchase_receipt`.
        """
        purchase = self.get_object()
        if purchase.status not in (Purchase.ORDERED, Purchase.PARTIALLY_RECEIVED):
            return Response(
                {'detail': 'Only placed (ordered) purchase orders can be received.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        ser = PurchaseReceiptCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        quantities = ser.validated_data.get('quantities') or {}
        try:
            quantities = {int(k): int(v) for k, v in quantities.items()}
        except (TypeError, ValueError):
            return Response(
                {'quantities': 'Quantities must be whole numbers keyed by line id.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        _, receipt = services.record_purchase_receipt(
            business=request.user.business,
            branch=purchase.branch,
            purchase=purchase,
            received_by=request.user,
            quantities=quantities,
            note=ser.validated_data.get('note', ''),
        )
        if receipt is None:
            return Response(
                {'detail': 'No outstanding line quantities to receive.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            PurchaseReceiptResponseSerializer(receipt).data,
            status=status.HTTP_201_CREATED,
        )