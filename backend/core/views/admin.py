"""Super-admin endpoints: business & user management (spec 6.11).

These endpoints are only reachable by ``super_admin`` accounts; they are
the API surface complementing Django Admin for tenant provisioning.
"""
from django.db import transaction
from django.db.models import Count
from drf_spectacular.utils import extend_schema
from rest_framework import filters, status, viewsets
from rest_framework.response import Response

from ..models import Branch, Business, RoleConstants, User
from ..permissions import IsSuperAdmin
from ..serializers import BusinessSerializer, UserCreateSerializer, UserSerializer


class BusinessAdminViewSet(viewsets.ModelViewSet):
    """Provision/manage tenant businesses (super_admin only)."""

    queryset = (
        Business.objects
        .select_related('created_by')
        .annotate(
            item_count=Count('items', distinct=True),
            category_count=Count('categorys', distinct=True),
            brand_count=Count('brands', distinct=True),
            branch_count=Count('branchs', distinct=True),
            user_count=Count('users', distinct=True),
        )
        # Django's .ordered is False for GROUP BY queries with only a
        # Meta.ordering, which would make pagination inconsistent.
        .order_by('name')
        .all()
    )
    serializer_class = BusinessSerializer
    permission_classes = [IsSuperAdmin]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'phone', 'email']
    ordering_fields = ['name', 'created_at']
    http_method_names = ['get', 'post', 'patch', 'delete']

    @transaction.atomic
    def perform_create(self, serializer):
        business = serializer.save(created_by=self.request.user)
        Branch.objects.create(
            business=business,
            name='Main Branch',
            address=business.address or '',
            phone=business.phone or '',
            is_active=True,
        )


class UserAdminViewSet(viewsets.ModelViewSet):
    """Manage users across all businesses (super_admin only).

    - ``POST`` accepts ``username/password/role/business``.
    - ``PATCH`` updates profile fields or resets the password.
    """

    queryset = User.objects.select_related('business', 'branch').all()
    permission_classes = [IsSuperAdmin]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['username', 'full_name', 'email']
    ordering_fields = ['username', 'created_at']

    def get_serializer_class(self):
        if self.action in ('create', 'update', 'partial_update'):
            return UserCreateSerializer
        return UserSerializer

    @staticmethod
    def _user_limit_response(business):
        return Response(
            {
                'detail': (
                    f'This business has reached its user limit '
                    f'({business.max_users}). Ask the platform owner to '
                    f'increase it.'
                )
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    @transaction.atomic
    def create(self, request, *args, **kwargs):
        role = request.data.get('role')
        business_id = request.data.get('business')
        if role in RoleConstants.BUSINESS_ROLES and not business_id:
            return Response(
                {'business': 'A business is required for business roles.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if business_id:
            try:
                business = Business.objects.get(pk=business_id)
            except Business.DoesNotExist:
                business = None
            if (
                business is not None
                and business.max_users is not None
                and business.users.count() >= business.max_users
            ):
                return self._user_limit_response(business)
        ser = UserCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = ser.save()
        return Response(
            UserSerializer(user).data, status=status.HTTP_201_CREATED
        )

    @transaction.atomic
    def update(self, request, *args, **kwargs):
        denied = self._check_move_to_full_business(request, kwargs.get('pk'))
        if denied is not None:
            return denied
        return super().update(request, *args, **kwargs)

    @transaction.atomic
    def partial_update(self, request, *args, **kwargs):
        denied = self._check_move_to_full_business(request, kwargs.get('pk'))
        if denied is not None:
            return denied
        return super().partial_update(request, *args, **kwargs)

    def _check_move_to_full_business(self, request, pk):
        """Block moving a user into a business that is at its user limit."""
        business_id = request.data.get('business')
        if business_id is None:
            return None
        try:
            target_id = int(business_id)
        except (TypeError, ValueError):
            return None  # invalid id — serializer will reject it below.
        instance = self.get_object()
        if instance.business_id == target_id:
            return None  # not a move.
        try:
            business = Business.objects.get(pk=target_id)
        except Business.DoesNotExist:
            return None
        if business.max_users is not None and business.users.count() >= business.max_users:
            return self._user_limit_response(business)
        return None