"""Business-scoped user management (business_admin only).

``/api/admin/users/`` is the super-admin surface and can provision any
tenant.  This module is the business-admin equivalent: it may only ever see
and edit staff inside the caller's own business, may never mint a
``super_admin``, and still honours the tenant's ``max_users`` seat limit.
"""
from django.db import transaction
from rest_framework import filters, status, viewsets
from rest_framework.response import Response

from ..activity import ActivityLogMixin
from ..models import Branch, Business, RoleConstants, User
from ..permissions import IsBusinessAdmin
from ..serializers import UserCreateSerializer, UserSerializer

# Roles a business admin is allowed to hand out. `super_admin` is excluded on
# purpose: promoting a staff account would escape tenant isolation entirely.
ASSIGNABLE_ROLES = (RoleConstants.BUSINESS_ADMIN, RoleConstants.MANAGER, RoleConstants.CASHIER)


class BusinessUserViewSet(ActivityLogMixin, viewsets.ModelViewSet):
    """Staff CRUD for the caller's own business (business_admin only).

    The business is never taken from the request body: it is forced to the
    caller's own tenant on create and rejected on update, so a business admin
    cannot read, edit, or move staff belonging to another tenant.
    """

    permission_classes = [IsBusinessAdmin]
    serializer_class = UserSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['username', 'full_name', 'email', 'phone']
    ordering_fields = ['username', 'full_name', 'created_at']

    def get_tenant(self):
        """The caller's business, or None for a super admin (who is rejected)."""
        user = self.request.user
        if user and user.is_authenticated and user.business_id:
            return user.business
        return None

    def get_queryset(self):
        """Rows strictly inside the caller's business."""
        tenant = self.get_tenant()
        if tenant is None:
            return User.objects.none()
        return (
            User.objects.filter(business=tenant)
            .select_related('business', 'branch')
            .order_by('username')
        )

    def get_serializer_class(self):
        if self.action in ('create', 'update', 'partial_update'):
            return UserCreateSerializer
        return UserSerializer

    def _seats_left(self, business):
        """Remaining staff seats, or None when the tenant is unlimited."""
        if business.max_users is None:
            return None
        return max(0, business.max_users - business.users.count())

    def _limit_response(self, business):
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

    def _reject_cross_tenant_write(self, request):
        """Block attempts to write a `business` the caller does not own."""
        if 'business' not in request.data:
            return None
        raw = request.data.get('business')
        if raw in (None, ''):
            return Response(
                {'business': 'Staff must belong to your business.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        tenant = self.get_tenant()
        try:
            target = Business.objects.get(pk=raw)
        except (Business.DoesNotExist, ValueError, TypeError):
            return Response(
                {'business': 'Unknown business.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if tenant is None or target.pk != tenant.pk:
            return Response(
                {'business': 'You may only manage users in your own business.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return None

    def _reject_bad_role(self, request):
        """Block privilege escalation to super_admin."""
        role = request.data.get('role')
        if role is None:
            return None
        if role not in ASSIGNABLE_ROLES:
            return Response(
                {
                    'role': (
                        f'Cannot assign role "{role}". Allowed: '
                        f'{", ".join(ASSIGNABLE_ROLES)}.'
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        return None

    def _reject_foreign_branch(self, request):
        """A staff account may only be scoped to a branch of its own business."""
        raw = request.data.get('branch')
        if raw in (None, ''):
            return None
        tenant = self.get_tenant()
        if tenant is None or not Branch.objects.filter(
            pk=raw, business=tenant
        ).exists():
            return Response(
                {'branch': 'Unknown branch for your business.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return None

    def _guard(self, request):
        """Run every cross-tenant / privilege check, returning the first failure."""
        return (
            self._reject_cross_tenant_write(request)
            or self._reject_bad_role(request)
            or self._reject_foreign_branch(request)
        )

    def list(self, request, *args, **kwargs):
        """List staff, annotating the response with the tenant's seat limit."""
        response = super().list(request, *args, **kwargs)
        tenant = self.get_tenant()
        if isinstance(response.data, dict) and tenant is not None:
            response.data['max_users'] = tenant.max_users
            response.data['seats_used'] = tenant.users.count()
        return response

    @transaction.atomic
    def create(self, request, *args, **kwargs):
        denied = self._guard(request)
        if denied is not None:
            return denied

        tenant = self.get_tenant()
        if tenant is None:
            return Response(
                {'detail': 'No business scope for this request.'},
                status=status.HTTP_403_FORBIDDEN,
            )
        if self._seats_left(tenant) == 0:
            return self._limit_response(tenant)

        # Drop any business the caller tried to smuggle in; force our own.
        payload = {k: v for k, v in request.data.items() if k != 'business'}
        ser = UserCreateSerializer(data=payload)
        ser.is_valid(raise_exception=True)
        user = ser.save(business=tenant)
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)

    @transaction.atomic
    def update(self, request, *args, **kwargs):
        denied = self._guard(request)
        if denied is not None:
            return denied
        denied = self._guard_self_lockout(request, self.get_object())
        if denied is not None:
            return denied
        return super().update(request, *args, **kwargs)

    @transaction.atomic
    def partial_update(self, request, *args, **kwargs):
        denied = self._guard(request)
        if denied is not None:
            return denied
        denied = self._guard_self_lockout(request, self.get_object())
        if denied is not None:
            return denied
        return super().partial_update(request, *args, **kwargs)

    def _guard_self_lockout(self, request, instance):
        """Stop an admin from demoting or disabling their own account.

        A business admin is the only staff role that can manage users, so
        self-lockout would leave the tenant unable to onboard anyone through
        the API. ``super_admin`` can still recover via Django admin.
        """
        if instance.pk != request.user.pk:
            return None
        if request.data.get('is_active') is False:
            return Response(
                {'detail': 'You cannot deactivate your own account.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        role = request.data.get('role')
        if role is not None and role != RoleConstants.BUSINESS_ADMIN:
            return Response(
                {'detail': 'You cannot change your own role.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return None
