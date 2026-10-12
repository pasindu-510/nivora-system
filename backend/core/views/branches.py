"""Branch endpoints (spec 6.2)."""
from rest_framework import filters
from rest_framework.exceptions import PermissionDenied, ValidationError

from ..models import Branch
from ..permissions import IsBusinessAdmin, IsCashierOrAbove
from ..serializers import BranchSerializer
from ..viewsets import TenantModelViewSet


class BranchViewSet(TenantModelViewSet):
    """Business-scoped CRUD for branches."""

    queryset = Branch.objects.select_related('business').all()
    serializer_class = BranchSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'phone', 'address']
    ordering_fields = ['name', 'created_at']

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy'):
            return [IsBusinessAdmin()]
        return [IsCashierOrAbove()]

    def perform_create(self, serializer):
        business = self.request.user.business
        if business is None:
            raise PermissionDenied('No business scope for this request.')
        if (
            business.max_branches is not None
            and business.branchs.count() >= business.max_branches
        ):
            raise ValidationError({
                'detail': (
                    f'Branch limit reached ({business.max_branches}). '
                    'Ask the platform owner to increase it.'
                )
            })
        serializer.save(business=business)