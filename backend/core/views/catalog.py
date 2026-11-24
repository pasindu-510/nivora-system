"""Catalog endpoints: categories, brands, items (spec 6.3)."""
from django.db import transaction
from django.db.models import F
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .. import services
from ..models import Brand, Category, Item, StockLot, StockMovement
from ..permissions import IsCashierOrAbove, IsManagerOrAbove
from ..serializers import (
    BrandSerializer,
    CategorySerializer,
    ItemCreateSerializer,
    ItemDetailSerializer,
    ItemListSerializer,
)
from ..viewsets import TenantModelViewSet


class CategoryViewSet(TenantModelViewSet):
    """Business-scoped category CRUD (manager+; readable by all business roles)."""

    queryset = Category.objects.select_related('business', 'parent').all()
    serializer_class = CategorySerializer
    search_fields = ['name']
    ordering_fields = ['name', 'created_at']

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy'):
            return [IsManagerOrAbove()]
        return [IsCashierOrAbove()]


class BrandViewSet(TenantModelViewSet):
    """Business-scoped brand CRUD."""

    queryset = Brand.objects.select_related('business').all()
    serializer_class = BrandSerializer
    search_fields = ['name']
    ordering_fields = ['name', 'created_at']

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy'):
            return [IsManagerOrAbove()]
        return [IsCashierOrAbove()]


class ItemViewSet(TenantModelViewSet):
    """Business-scoped item CRUD with code uniqueness per tenant.

    List responses use :class:`ItemListSerializer`; the detail view adds
    timestamps.  Managers may write; every business role may read.
    """

    protected_delete_message = (
        'This item has sale or purchase history and cannot be deleted. '
        'Deactivate it instead.'
    )
    queryset = Item.objects.select_related(
        'business', 'category', 'brand'
    ).prefetch_related('lots__branch').all()
    serializer_class = ItemDetailSerializer
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['category', 'brand', 'is_active', 'low_stock_threshold']
    search_fields = ['code', 'name']
    ordering_fields = ['code', 'name', 'cost_price', 'selling_price', 'stock_quantity']

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get('low_stock') == 'true':
            qs = qs.filter(stock_quantity__lte=F('low_stock_threshold'))
        return qs

    def get_serializer_class(self):
        if self.action == 'create':
            return ItemCreateSerializer
        if self.action == 'list':
            return ItemListSerializer
        return ItemDetailSerializer

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy', 'adjust'):
            return [IsManagerOrAbove()]
        return [IsCashierOrAbove()]

    @transaction.atomic
    @action(detail=True, methods=['post'])
    def adjust(self, request, pk=None):
        """Manually correct stock for an item (manager+).

        Payload: ``{"quantity": -3, "note": "damaged", "branch": 1}``.
        A positive quantity opens an ADJUSTMENT FIFO lot; either sign records
        the matching audit movement, so the correction stays traceable.
        """
        item = self.get_object()
        try:
            quantity = int(request.data.get('quantity'))
        except (TypeError, ValueError):
            return Response(
                {'detail': 'quantity must be an integer.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if quantity == 0:
            return Response(
                {'detail': 'quantity cannot be zero.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        reason = request.data.get('note', '')

        # StockLot.branch and StockMovement.branch are NOT NULL, and stock is
        # tracked per branch, so an adjustment must name one explicitly.
        branch_id = request.data.get('branch')
        if branch_id in (None, ''):
            return Response(
                {'branch': 'A branch is required for a stock adjustment.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        branch = item.business.branchs.filter(pk=branch_id).first()
        if branch is None:
            return Response(
                {'branch': 'Unknown branch for this business.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if quantity > 0:
            StockLot.objects.create(
                business=item.business,
                branch=branch,
                item=item,
                quantity_total=quantity,
                quantity_remaining=quantity,
                unit_cost=item.cost_price,
                source=StockLot.ADJUSTMENT,
                reference=reason,
            )
        else:
            # Write-off: remove the units from this branch's FIFO lots so the
            # lots and stock_quantity stay in step (B-08). Refuse to go below
            # zero instead of silently creating negative stock.
            allocations, _cost, ok = services.allocate_fifo(
                item.business, item, -quantity, branch
            )
            if not ok:
                return Response(
                    {'quantity': f'Not enough stock of {item.code} at {branch.name} '
                                 f'to write off {-quantity} units.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            for lot, take in allocations:
                StockLot.objects.filter(pk=lot.pk).update(
                    quantity_remaining=F('quantity_remaining') - take
                )
        Item.objects.filter(pk=item.pk).update(stock_quantity=F('stock_quantity') + quantity)
        item.refresh_from_db(fields=['stock_quantity'])
        StockMovement.objects.create(
            business=item.business,
            branch=branch,
            item=item,
            type=StockMovement.ADJUST,
            quantity=quantity,
            reference=f'ADJ {item.code}',
            note=reason,
            created_by=request.user,
        )
        return Response({'item_id': item.id, 'new_stock': item.stock_quantity})

    @transaction.atomic
    def perform_create(self, serializer):
        """Save the item, then seed its opening FIFO lot atomically."""
        validated = serializer.validated_data
        opening_stock = validated.pop('opening_stock', None)
        opening_branch = validated.pop('opening_branch', None)
        opening_unit_cost = validated.pop('opening_unit_cost', None)
        super().perform_create(serializer)
        if opening_stock is None:
            return
        item = serializer.instance
        StockLot.objects.create(
            business=item.business,
            branch=opening_branch,
            item=item,
            quantity_total=opening_stock,
            quantity_remaining=opening_stock,
            unit_cost=opening_unit_cost or item.cost_price,
            source=StockLot.OPENING,
            reference='OPENING',
        )
        item.stock_quantity = opening_stock
        item.save(update_fields=['stock_quantity'])
        StockMovement.objects.create(
            business=item.business,
            branch=opening_branch,
            item=item,
            type=StockMovement.IN,
            quantity=opening_stock,
            reference='OPENING',
            created_by=self.request.user,
        )
