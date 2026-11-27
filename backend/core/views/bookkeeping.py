"""Bookkeeping endpoints: cash accounts, expenses, capital (spec 6.7-6.8)."""
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters, status, viewsets
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from ..activity import describe_changes, log_activity, snapshot
from ..models import (
    ActivityLog,
    CapitalEntry,
    CashAccount,
    Expense,
    ExpenseCategory,
    RecurringExpense,
    SupplierPayment,
)
from ..permissions import (
    IsBusinessAdmin,
    IsCashierOrAbove,
    IsManagerOrAbove,
)
from ..serializers import (
    BusinessFinanceSettingsSerializer,
    CapitalEntrySerializer,
    CashAccountSerializer,
    ExpenseCategorySerializer,
    ExpenseCreateSerializer,
    ExpenseSerializer,
    RecurringExpenseSerializer,
    SupplierPaymentSerializer,
)
from ..viewsets import TenantModelViewSet


class CashAccountViewSet(TenantModelViewSet):
    """Cash & bank account CRUD (business_admin manages; all roles read)."""

    queryset = CashAccount.objects.select_related('business').all()
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['type', 'is_active']
    ordering_fields = ['name']

    def get_serializer_class(self):
        return CashAccountSerializer

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy'):
            return [IsBusinessAdmin()]
        return [IsCashierOrAbove()]


class ExpenseCategoryViewSet(TenantModelViewSet):
    """Expense category CRUD (business_admin; readable by manager+)."""

    queryset = ExpenseCategory.objects.select_related('business').all()
    serializer_class = ExpenseCategorySerializer
    filter_backends = [filters.SearchFilter]
    search_fields = ['name']

    def get_permissions(self):
        if self.action in ('create', 'update', 'partial_update', 'destroy'):
            return [IsBusinessAdmin()]
        return [IsManagerOrAbove()]


class ExpenseViewSet(TenantModelViewSet):
    """Expense recording/listing (manager+; cashier cannot record)."""

    queryset = Expense.objects.select_related(
        'business', 'branch', 'category', 'cash_account', 'paid_by'
    ).all()
    permission_classes = [IsManagerOrAbove]
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['branch', 'category', 'expense_date', 'cash_account']
    ordering_fields = ['expense_date', 'amount']

    def get_serializer_class(self):
        if self.action in ('create',):
            return ExpenseCreateSerializer
        return ExpenseSerializer

    def create(self, request, *args, **kwargs):
        ser = ExpenseCreateSerializer(
            data=request.data, context={'request': request}
        )
        ser.is_valid(raise_exception=True)
        expense = ser.save()
        return Response(
            ExpenseSerializer(expense).data, status=status.HTTP_201_CREATED
        )


class SupplierPaymentViewSet(TenantModelViewSet):
    """Payments made to suppliers (manager+)."""

    queryset = SupplierPayment.objects.select_related(
        'business', 'supplier', 'purchase', 'cash_account', 'paid_by'
    ).all()
    serializer_class = SupplierPaymentSerializer
    permission_classes = [IsManagerOrAbove]
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['supplier', 'purchase', 'cash_account', 'payment_date']
    ordering_fields = ['payment_date', 'amount']

    def perform_create(self, serializer):
        """Record who paid (server-set; never taken from the payload)."""
        tenant = self.get_tenant()
        if tenant is None:
            raise PermissionDenied('No business scope for this request.')
        serializer.save(business=tenant, paid_by=self.request.user)


class CapitalEntryViewSet(TenantModelViewSet):
    """Owner capital in/out ledger (business_admin only)."""

    queryset = CapitalEntry.objects.select_related('business').all()
    serializer_class = CapitalEntrySerializer
    permission_classes = [IsBusinessAdmin]
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['type', 'date']
    ordering_fields = ['date']


class RecurringExpenseViewSet(TenantModelViewSet):
    """Recurring expense schedule (manager+, matching /expenses)."""

    queryset = RecurringExpense.objects.select_related(
        'business', 'branch', 'category'
    ).all()
    serializer_class = RecurringExpenseSerializer
    permission_classes = [IsManagerOrAbove]
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['branch', 'category', 'frequency', 'is_active']
    ordering_fields = ['next_due_date']


class BusinessFinanceSettingsView(APIView):
    """Read/update the caller's own ``Business.tax_rate`` (business_admin).

    Tenant scoping decision: the business is resolved exclusively from
    ``request.user.business`` — never from the URL, a query param, or the
    request body. This endpoint is a singleton keyed on the session, so a
    client-supplied ``business`` id has nowhere to land: the serializer
    declares only ``tax_rate`` and saving always targets the caller's own
    instance, which keeps a business admin from reading or writing another
    tenant's tax rate. Super admins hold no business and are rejected by
    ``IsBusinessAdmin`` (no bypass, matching the permission module).
    """

    permission_classes = [IsBusinessAdmin]

    def _get_business(self, request):
        """Caller's tenant as ``(business, None)``, or ``(None, 400)``."""
        business = getattr(request.user, 'business', None)
        if business is None:
            return None, Response(
                {'detail': 'Your account is not linked to a business.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return business, None

    def get(self, request):
        business, error = self._get_business(request)
        if error is not None:
            return error
        return Response(BusinessFinanceSettingsSerializer(business).data)

    def patch(self, request):
        business, error = self._get_business(request)
        if error is not None:
            return error
        serializer = BusinessFinanceSettingsSerializer(
            business, data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        before = snapshot(business)
        serializer.save()
        details = describe_changes(before, snapshot(business))
        if details:
            log_activity(
                request.user, ActivityLog.EDIT, 'SETTINGS',
                label='Business settings', details=details, business=business,
            )
        return Response(serializer.data)