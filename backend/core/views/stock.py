"""Stock endpoints: lots & movements (spec 6.6)."""
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters

from ..models import StockLot, StockMovement
from ..permissions import IsManagerOrAbove
from ..serializers import StockLotSerializer, StockMovementSerializer
from ..viewsets import TenantModelViewSet


class StockLotViewSet(TenantModelViewSet):
    """Read-only FIFO lot registry (manager+)."""

    queryset = StockLot.objects.select_related(
        'business', 'item', 'branch'
    ).all()
    serializer_class = StockLotSerializer
    permission_classes = [IsManagerOrAbove]
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['item', 'branch', 'source', 'item__category']
    ordering_fields = ['received_at', 'quantity_remaining']
    # Lots change only through sales, receipts and adjustments (B-03).
    http_method_names = ['get', 'head', 'options']

    def get_queryset(self):
        qs = super().get_queryset()
        # Filter lots of inactive items out of the default list.
        return qs


class StockMovementViewSet(TenantModelViewSet):
    """Read-only audit trail of stock movements (manager+)."""

    queryset = StockMovement.objects.select_related(
        'business', 'item', 'branch', 'created_by'
    ).all()
    serializer_class = StockMovementSerializer
    permission_classes = [IsManagerOrAbove]
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['item', 'branch', 'type']
    ordering_fields = ['created_at']
    # Audit trail: never writable through the API (B-03).
    http_method_names = ['get', 'head', 'options']