"""DRF serializers for the shop API (spec section 6).

Business-level models get queryset scoping through
``core.viewsets.TenantModelViewSet``; serializers handle payload
validation and write the ``business`` FK when saving.
"""
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from rest_framework import serializers

from . import services


def logo_url(business):
    """Public media URL for a business logo (relative to the API origin).

    Returns ``None`` when the business has no logo, matching the backend's
    ``BusinessLogoView`` contract so the frontend can render ``<img src>``
    directly from the serialized payload.
    """
    if not business or not business.logo:
        return None
    return f"{settings.MEDIA_URL.rstrip('/')}/{business.logo.name}"
from .models import (
    Branch,
    Brand,
    Business,
    CapitalEntry,
    CashAccount,
    Category,
    Customer,
    Expense,
    ExpenseCategory,
    Installment,
    Item,
    LotAllocation,
    Payment,
    Purchase,
    PurchaseItem,
    PurchaseReceipt,
    PurchaseReceiptItem,
    RecurringExpense,
    RoleConstants,
    Sale,
    SaleItem,
    SeasonalDiscount,
    StockLot,
    StockMovement,
    Supplier,
    SupplierPayment,
    User,
)


# ── Shared helpers ──────────────────────────────────────────────────────────

def _cents(n):
    """Quantize a numeric to 2 decimal places."""
    return Decimal(n).quantize(Decimal('0.01'))


# ── Simple CRUD serializers ─────────────────────────────────────────────────

class BranchSerializer(serializers.ModelSerializer):
    class Meta:
        model = Branch
        fields = ['id', 'name', 'address', 'phone', 'is_active', 'created_at']


class CategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = Category
        fields = ['id', 'name', 'parent', 'created_at']


class BrandSerializer(serializers.ModelSerializer):
    class Meta:
        model = Brand
        fields = ['id', 'name', 'created_at']


class ItemListSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source='category.name', read_only=True, default='')
    brand_name = serializers.CharField(source='brand.name', read_only=True, default='')
    branch_stock = serializers.SerializerMethodField()
    effective_price = serializers.SerializerMethodField()
    discount_percent = serializers.SerializerMethodField()

    class Meta:
        model = Item
        fields = [
            'id', 'code', 'name', 'category', 'category_name', 'brand',
            'brand_name', 'cost_price', 'selling_price', 'stock_quantity',
            'low_stock_threshold', 'is_active', 'image', 'branch_stock',
            'effective_price', 'discount_percent',
        ]

    def _discount_rows(self):
        """Active seasonal discounts, fetched once per serializer instance.

        Cached on the instance so a list response costs one extra query
        instead of one per item (see ``services.discount_percent_from_rows``).
        """
        cached = getattr(self, '_rows_cache', None)
        if cached is not None:
            return cached
        business = None
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = request.user.business
        self._rows_cache = services.active_discount_rows(business)
        return self._rows_cache

    def get_discount_percent(self, obj):
        percent, _name = services.discount_percent_from_rows(self._discount_rows(), obj)
        return str(percent)

    def get_effective_price(self, obj):
        """Unit price the sale will actually charge (after seasonal discount)."""
        percent, _name = services.discount_percent_from_rows(self._discount_rows(), obj)
        price = Decimal(obj.selling_price)
        if percent:
            price = (price * (Decimal(1) - percent / Decimal(100))).quantize(Decimal('0.01'))
        return str(price)

    def get_branch_stock(self, obj):
        """Aggregate per-branch remaining quantities from FIFO lots.

        Uses the prefetched ``lots``/``branch`` caches on the item
        queryset (see ``ItemViewSet``) so list responses stay N+1-free.
        """
        totals = {}
        for lot in obj.lots.all():
            if lot.branch_id not in totals:
                totals[lot.branch_id] = {
                    'branch_id': lot.branch_id,
                    'branch_name': lot.branch.name,
                    'quantity': 0,
                }
            totals[lot.branch_id]['quantity'] += lot.quantity_remaining
        rows = [row for row in totals.values() if row['quantity'] > 0]
        # Branch.Meta.ordering = ['name'] keeps lot iteration name-sorted,
        # but sort explicitly so aggregation order never leaks through.
        rows.sort(key=lambda row: row['branch_name'])
        return rows

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            if request.user.role == RoleConstants.CASHIER:
                data.pop('cost_price', None)
        return data


class ItemDetailSerializer(ItemListSerializer):
    class Meta(ItemListSerializer.Meta):
        fields = ItemListSerializer.Meta.fields + ['created_at', 'updated_at']

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = getattr(request.user, 'business', None)
            if business is not None:
                self.fields['category'].queryset = Category.objects.for_business(business)
                self.fields['brand'].queryset = Brand.objects.for_business(business)
            else:
                self.fields['category'].queryset = Category.objects.none()
                self.fields['brand'].queryset = Brand.objects.none()

    def validate(self, attrs):
        # Enforce unique (business, code) scoped to requester's business
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = getattr(request.user, 'business', None)
            if business is not None:
                code = attrs.get('code', getattr(self.instance, 'code', None))
                if code is not None:
                    qs = Item.objects.for_business(business).filter(code=code)
                    if self.instance:
                        qs = qs.exclude(pk=self.instance.pk)
                    if qs.exists():
                        raise serializers.ValidationError({
                            'code': 'An item with this code already exists in this business.'
                        })
        return attrs


class ItemCreateSerializer(ItemDetailSerializer):
    """Item creation payload with optional opening-stock lot seeding.

    The three ``opening_*`` fields are write-only: they never appear in
    responses.  ``ItemViewSet.perform_create`` pops them from
    ``validated_data`` before saving the item and uses them to open the
    first FIFO lot inside the same transaction.
    """

    opening_stock = serializers.IntegerField(
        required=False, min_value=1, write_only=True
    )
    opening_branch = serializers.PrimaryKeyRelatedField(
        queryset=Branch.objects.none(), required=False, write_only=True
    )
    opening_unit_cost = serializers.DecimalField(
        max_digits=12, decimal_places=2, required=False, write_only=True
    )

    class Meta(ItemDetailSerializer.Meta):
        fields = ItemDetailSerializer.Meta.fields + [
            'opening_stock', 'opening_branch', 'opening_unit_cost',
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        business = None
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = getattr(request.user, 'business', None)
        if business is None:
            self.fields['opening_branch'].queryset = Branch.objects.none()
        else:
            self.fields['opening_branch'].queryset = Branch.objects.for_business(business)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if attrs.get('opening_stock') is not None and not attrs.get('opening_branch'):
            raise serializers.ValidationError({
                'opening_branch': (
                    'opening_branch is required when opening_stock is provided.'
                ),
            })
        return attrs


class CustomerSerializer(serializers.ModelSerializer):
    class Meta:
        model = Customer
        fields = [
            'id', 'name', 'phone', 'nic', 'address', 'id_card_photo',
            'created_at',
        ]


class SupplierSerializer(serializers.ModelSerializer):
    class Meta:
        model = Supplier
        fields = [
            'id', 'name', 'contact_person', 'phone', 'email', 'address',
            'is_active', 'created_at',
        ]


class CashAccountSerializer(serializers.ModelSerializer):
    balance = serializers.SerializerMethodField()

    class Meta:
        model = CashAccount
        fields = [
            'id', 'name', 'type', 'opening_balance', 'balance',
            'is_active', 'created_at',
        ]

    def get_balance(self, obj):
        return services.account_balances(self.context['request'].user.business).get(obj.id, 0)


class ExpenseCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = ExpenseCategory
        fields = ['id', 'name', 'is_active']


class StockLotSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source='item.code', read_only=True)
    item_name = serializers.CharField(source='item.name', read_only=True)

    class Meta:
        model = StockLot
        fields = [
            'id', 'item', 'item_code', 'item_name', 'branch',
            'quantity_total', 'quantity_remaining', 'unit_cost',
            'source', 'reference', 'received_at',
        ]


class StockMovementSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source='item.code', read_only=True)

    class Meta:
        model = StockMovement
        fields = [
            'id', 'item', 'item_code', 'branch', 'type', 'quantity',
            'reference', 'note', 'created_by', 'created_at',
        ]


# ── Sales (spec 6) ──────────────────────────────────────────────────────────

class SaleItemSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source='item.code', read_only=True)
    item_name = serializers.CharField(source='item.name', read_only=True)

    class Meta:
        model = SaleItem
        fields = [
            'id', 'item', 'item_code', 'item_name', 'quantity',
            'unit_price', 'line_total', 'fifo_cost',
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            if request.user.role == RoleConstants.CASHIER:
                data.pop('fifo_cost', None)
        return data


class InstallmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Installment
        fields = [
            'id', 'number', 'due_date', 'amount', 'paid_amount',
            'is_paid', 'paid_date', 'interest_charged',
        ]


class PaymentSerializer(serializers.ModelSerializer):
    cash_account_name = serializers.CharField(
        source='cash_account.name', read_only=True, default=''
    )
    received_by_name = serializers.CharField(
        source='received_by.username', read_only=True, default=''
    )
    installment_number = serializers.IntegerField(
        source='installment.number', read_only=True, default=None
    )

    class Meta:
        model = Payment
        fields = [
            'id', 'sale', 'installment', 'installment_number', 'amount', 'method',
            'cash_account', 'received_by', 'note', 'created_at',
            'cash_account_name', 'received_by_name',
        ]


class SaleListSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source='customer.name', read_only=True, default='')
    customer_phone = serializers.CharField(source='customer.phone', read_only=True, default='')
    customer_address = serializers.CharField(source='customer.address', read_only=True, default='')
    branch_name = serializers.CharField(source='branch.name', read_only=True, default='')
    created_by_name = serializers.CharField(source='created_by.username', read_only=True, default='')
    is_fully_paid = serializers.SerializerMethodField()

    class Meta:
        model = Sale
        fields = [
            'id', 'invoice_no', 'branch', 'branch_name', 'customer',
            'customer_name', 'customer_phone', 'customer_address',
            'subtotal', 'discount_amount', 'tax_amount', 'tax_rate',
            'total_cost', 'down_payment', 'remaining_cost', 'status',
            'is_single_payment', 'number_of_installments', 'installment_frequency',
            'created_by', 'created_by_name', 'created_at',
            'is_fully_paid',
        ]

    def get_is_fully_paid(self, obj):
        return bool(obj.remaining_cost <= 0) if obj.remaining_cost is not None else False


class SaleDetailSerializer(SaleListSerializer):
    items = SaleItemSerializer(many=True, read_only=True)
    installments = InstallmentSerializer(many=True, read_only=True)
    payments = PaymentSerializer(many=True, read_only=True)

    # A4 bill header — business identity + branch, plus discount wording:
    business_name = serializers.CharField(source='business.name', read_only=True, default='')
    business_address = serializers.CharField(source='business.address', read_only=True, default='')
    business_phone = serializers.CharField(source='business.phone', read_only=True, default='')
    business_logo = serializers.SerializerMethodField()
    branch_address = serializers.CharField(source='branch.address', read_only=True, default='')
    branch_phone = serializers.CharField(source='branch.phone', read_only=True, default='')
    discount_label = serializers.SerializerMethodField()

    class Meta(SaleListSerializer.Meta):
        fields = SaleListSerializer.Meta.fields + [
            'items', 'installments', 'payments',
            'business_name', 'business_address', 'business_phone',
            'branch_address', 'branch_phone', 'discount_label',
            'business_logo',
        ]

    def get_discount_label(self, obj):
        if not obj.discount_amount:
            return ''
        if obj.discount_type == Sale.PERCENT:
            return f'{obj.discount_value}%'
        return f'LKR {obj.discount_value:.2f}'

    def get_business_logo(self, obj):
        return logo_url(obj.business)


class SaleLineSerializer(serializers.Serializer):
    item = serializers.PrimaryKeyRelatedField(queryset=Item.objects.none())
    quantity = serializers.IntegerField(min_value=1)


class SaleCreateSerializer(serializers.Serializer):
    """Payload for creating a sale through :func:`services.record_sale`."""

    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.none())
    customer = serializers.PrimaryKeyRelatedField(
        queryset=Customer.objects.none(), required=False, allow_null=True
    )
    lines = SaleLineSerializer(many=True, allow_empty=False)
    discount_type = serializers.ChoiceField(
        choices=Sale.DISCOUNT_TYPE_CHOICES, default=Sale.PERCENT
    )
    discount_value = serializers.DecimalField(
        max_digits=12, decimal_places=2, default=0
    )
    tax_rate = serializers.DecimalField(
        max_digits=5, decimal_places=2, required=False, allow_null=True
    )
    is_single_payment = serializers.BooleanField(default=True)
    down_payment = serializers.DecimalField(
        max_digits=12, decimal_places=2, default=0
    )
    number_of_installments = serializers.IntegerField(default=0, min_value=0)
    installment_frequency = serializers.ChoiceField(
        choices=Sale.FREQUENCY_CHOICES, default=Sale.MONTHLY
    )
    installment_interval_days = serializers.IntegerField(default=30)
    cash_account = serializers.PrimaryKeyRelatedField(
        queryset=CashAccount.objects.none(), required=False, allow_null=True
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = request.user.business
            if business is None:
                return
            self.fields['branch'].queryset = Branch.objects.for_business(business)
            self.fields['customer'].queryset = Customer.objects.for_business(business)
            self.fields['cash_account'].queryset = CashAccount.objects.for_business(business)
            line_fields = self.fields['lines'].child.fields
            line_fields['item'].queryset = Item.objects.for_business(business)

    def validate(self, attrs):
        """Validate installment count against business maximum limit."""
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = getattr(request.user, 'business', None)
            if business is not None:
                max_installments = business.max_installments
                number_of_installments = attrs.get('number_of_installments', 0)
                # Only enforce limit for installment sales (not single payment)
                if not attrs.get('is_single_payment', True) and max_installments is not None:
                    if number_of_installments > max_installments:
                        raise serializers.ValidationError({
                            'number_of_installments': (
                                f'Cannot exceed maximum installments of {max_installments} '
                                f'for this business. Please contact business admin.'
                            )
                        })
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        request = self.context['request']
        user = request.user
        lines = [{'item': l['item'], 'quantity': l['quantity']}
                 for l in validated_data['lines']]
        sale = services.record_sale(
            business=user.business,
            branch=validated_data['branch'],
            created_by=user,
            customer=validated_data.get('customer'),
            lines=lines,
            discount_type=validated_data.get('discount_type', Sale.PERCENT),
            discount_value=validated_data.get('discount_value', 0),
            tax_rate=validated_data.get('tax_rate'),
            is_single_payment=validated_data.get('is_single_payment', True),
            down_payment=validated_data.get('down_payment', 0),
            number_of_installments=validated_data.get('number_of_installments', 0),
            installment_frequency=validated_data.get(
                'installment_frequency', Sale.MONTHLY
            ),
            installment_interval_days=validated_data.get(
                'installment_interval_days', 30
            ),
            cash_account=validated_data.get('cash_account'),
        )
        return sale


class InstallmentPaymentSerializer(serializers.Serializer):
    """Payload for recording a payment against an installment."""

    installment = serializers.PrimaryKeyRelatedField(queryset=Installment.objects.none())
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal('0.01'))
    method = serializers.ChoiceField(choices=Payment.METHOD_CHOICES, default=Payment.CASH)
    cash_account = serializers.PrimaryKeyRelatedField(
        queryset=CashAccount.objects.none(), required=False, allow_null=True
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = request.user.business
            if business is not None:
                self.fields['installment'].queryset = Installment.objects.for_business(business)
                self.fields['cash_account'].queryset = CashAccount.objects.for_business(business)

    @transaction.atomic
    def create(self, validated_data):
        user = self.context['request'].user
        installment = validated_data['installment']
        try:
            services.record_installment_payment(
                business=user.business,
                installment=installment,
                amount=validated_data['amount'],
                method=validated_data.get('method', Payment.CASH),
                cash_account=validated_data.get('cash_account'),
                received_by=user,
            )
        except ValueError as exc:
            raise serializers.ValidationError({'detail': str(exc)})
        return installment


# ── Purchases (spec 6) ──────────────────────────────────────────────────────

class PurchaseItemSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(source='item.code', read_only=True)
    item_name = serializers.CharField(source='item.name', read_only=True)

    class Meta:
        model = PurchaseItem
        fields = [
            'id', 'item', 'item_code', 'item_name', 'quantity',
            'received_quantity', 'unit_cost', 'total',
        ]


class PurchaseReceiptItemSerializer(serializers.ModelSerializer):
    item_code = serializers.CharField(
        source='purchase_item.item.code', read_only=True
    )

    class Meta:
        model = PurchaseReceiptItem
        fields = ['id', 'purchase_item', 'item_code', 'quantity']


class PurchaseReceiptSerializer(serializers.ModelSerializer):
    items = PurchaseReceiptItemSerializer(many=True, read_only=True)

    class Meta:
        model = PurchaseReceipt
        fields = ['id', 'receipt_no', 'note', 'received_by', 'items', 'created_at']


class PurchaseListSerializer(serializers.ModelSerializer):
    supplier_name = serializers.CharField(source='supplier.name', read_only=True)
    total = serializers.SerializerMethodField()

    class Meta:
        model = Purchase
        fields = [
            'id', 'order_no', 'supplier', 'supplier_name', 'status',
            'expected_delivery_date', 'total', 'created_at',
        ]

    def get_total(self, obj):
        return _cents(sum(i.total for i in obj.items.all()))


class PurchaseDetailSerializer(PurchaseListSerializer):
    items = PurchaseItemSerializer(many=True, read_only=True)
    receipts = PurchaseReceiptSerializer(many=True, read_only=True)

    class Meta(PurchaseListSerializer.Meta):
        fields = PurchaseListSerializer.Meta.fields + ['notes', 'items', 'receipts']


class PurchaseCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Purchase
        fields = [
            'id', 'supplier', 'branch', 'status',
            'expected_delivery_date', 'notes',
        ]
        read_only_fields = ['status']


class PurchaseItemCreateSerializer(serializers.Serializer):
    item = serializers.PrimaryKeyRelatedField(queryset=Item.objects.none())
    quantity = serializers.IntegerField(min_value=1)
    unit_cost = serializers.DecimalField(max_digits=12, decimal_places=2)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = request.user.business
            if business is not None:
                self.fields['item'].queryset = Item.objects.for_business(business)


class PurchaseReceiptCreateSerializer(serializers.Serializer):
    """Payload validator for receiving stock on a purchase order.

    The purchase is resolved from the URL (detail action on
    ``PurchaseViewSet.receive``); this serializer only validates the
    per-line ``quantities`` map and the optional ``note``.
    """

    quantities = serializers.DictField(required=False, allow_empty=True)
    note = serializers.CharField(required=False, allow_blank=True)


# ── Expenses / bookkeeping (spec 6) ─────────────────────────────────────────

class ExpenseSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source='category.name', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True, default='')

    class Meta:
        model = Expense
        fields = [
            'id', 'branch', 'branch_name', 'category', 'category_name',
            'description', 'amount', 'expense_date', 'cash_account',
            'paid_by', 'note', 'created_at',
        ]


class ExpenseCreateSerializer(serializers.Serializer):
    branch = serializers.PrimaryKeyRelatedField(
        queryset=Branch.objects.none(), required=False, allow_null=True
    )
    category = serializers.PrimaryKeyRelatedField(
        queryset=ExpenseCategory.objects.none()
    )
    description = serializers.CharField(max_length=200)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal('0.01'))
    expense_date = serializers.DateField(required=False)
    cash_account = serializers.PrimaryKeyRelatedField(
        queryset=CashAccount.objects.none(), required=False, allow_null=True
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = request.user.business
            if business is not None:
                self.fields['branch'].queryset = Branch.objects.for_business(business)
                self.fields['category'].queryset = ExpenseCategory.objects.for_business(business)
                self.fields['cash_account'].queryset = CashAccount.objects.for_business(business)

    @transaction.atomic
    def create(self, validated_data):
        user = self.context['request'].user
        return services.record_expense(
            business=user.business,
            branch=validated_data.get('branch'),
            category=validated_data['category'],
            description=validated_data['description'],
            amount=validated_data['amount'],
            expense_date=validated_data.get('expense_date'),
            cash_account=validated_data.get('cash_account'),
            paid_by=user,
        )


class CapitalEntrySerializer(serializers.ModelSerializer):
    class Meta:
        model = CapitalEntry
        fields = ['id', 'date', 'type', 'amount', 'note', 'created_at']


class SupplierPaymentSerializer(serializers.ModelSerializer):
    supplier_name = serializers.CharField(source='supplier.name', read_only=True)

    class Meta:
        model = SupplierPayment
        fields = [
            'id', 'supplier', 'supplier_name', 'purchase', 'amount',
            'payment_date', 'cash_account', 'paid_by', 'note', 'created_at',
        ]


class RecurringExpenseSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source='category.name', read_only=True)

    class Meta:
        model = RecurringExpense
        fields = [
            'id', 'branch', 'category', 'category_name', 'description',
            'amount', 'frequency', 'interval_days', 'next_due_date',
            'is_active',
        ]


# ── Admin-facing (spec 6, super_admin scope) ────────────────────────────────

class BusinessSerializer(serializers.ModelSerializer):
    # null/blank means unlimited; 0 rejected, 1+ valid.
    max_users = serializers.IntegerField(
        required=False, allow_null=True, min_value=1
    )
    max_branches = serializers.IntegerField(
        required=False, allow_null=True, min_value=1
    )
    item_count = serializers.IntegerField(read_only=True, default=0)
    category_count = serializers.IntegerField(read_only=True, default=0)
    brand_count = serializers.IntegerField(read_only=True, default=0)
    branch_count = serializers.IntegerField(read_only=True, default=0)
    user_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Business
        fields = [
            'id', 'name', 'address', 'phone', 'email', 'logo',
            'is_active', 'tax_rate', 'cashier_discount_cap',
            'max_users', 'max_branches',
            'item_count', 'category_count', 'brand_count',
            'branch_count', 'user_count',
            'created_at', 'updated_at',
        ]


class UserSerializer(serializers.ModelSerializer):
    """Current user profile.

    ``business_tax_rate`` mirrors ``Business.tax_rate`` so frontends can
    pre-fill the POS tax field instead of guessing 0 (the backend applies
    this default whenever a sale omits ``tax_rate``).
    ``business_installment_interest_rate`` mirrors
    ``Business.installment_interest_rate`` similarly.
    """

    business_tax_rate = serializers.SerializerMethodField()
    business_installment_interest_rate = serializers.SerializerMethodField()
    business_name = serializers.SerializerMethodField()
    business_logo = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'full_name', 'phone', 'role',
            'business', 'branch', 'is_active', 'email', 'business_tax_rate',
            'business_installment_interest_rate', 'business_name', 'business_logo',
        ]

    def get_business_tax_rate(self, obj):
        business = getattr(obj, 'business', None)
        return str(business.tax_rate) if business is not None else '0'

    def get_business_installment_interest_rate(self, obj):
        business = getattr(obj, 'business', None)
        return str(business.installment_interest_rate) if business is not None else '0'

    def get_business_name(self, obj):
        business = getattr(obj, 'business', None)
        return business.name if business is not None else None

    def get_business_logo(self, obj):
        return logo_url(getattr(obj, 'business', None))


class UserCreateSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=8)

    class Meta:
        model = User
        fields = [
            'username', 'password', 'full_name', 'phone', 'role',
            'business', 'branch', 'is_active', 'email',
        ]

    def create(self, validated_data):
        password = validated_data.pop('password')
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        return user

    def update(self, instance, validated_data):
        password = validated_data.pop('password', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        if password:
            instance.set_password(password)
        instance.save()
        return instance


# ── Business finance settings (business_admin scope) ────────────────────────

class BusinessFinanceSettingsSerializer(serializers.ModelSerializer):
    """Singleton payload for the caller's own finance constants.

    Exposes ``tax_rate`` and ``installment_interest_rate`` (percent, 0-100)
    only, so a business admin can never touch ``is_active``, ``max_users``,
    ``logo`` or any other tenant-lifecycle field. No ``business`` field
    either — the tenant comes from the session, never from the payload.
    ``installment_interest_rate`` is the business-wide one-time interest
    charged on an underpaid installment; both fields serialize as strings
    like ``tax_rate``. The model allows 999.99 (``max_digits=5``), hence
    the explicit ``0..100`` cap.
    """

    tax_rate = serializers.DecimalField(
        max_digits=5, decimal_places=2, min_value=0, max_value=100,
    )
    installment_interest_rate = serializers.DecimalField(
        max_digits=5, decimal_places=2, min_value=0, max_value=100,
    )

    class Meta:
        model = Business
        fields = ['tax_rate', 'installment_interest_rate']


# ── Seasonal discounts ──────────────────────────────────────────────────────

class SeasonalDiscountSerializer(serializers.ModelSerializer):
    class Meta:
        model = SeasonalDiscount
        fields = [
            'id', 'name', 'scope', 'target_id', 'discount_percentage',
            'start_date', 'end_date', 'is_active', 'created_at',
        ]


# ── Report helpers ──────────────────────────────────────────────────────────

class ReportSalesSerializer(serializers.Serializer):
    """Daily/period sales summary output."""

    date = serializers.DateField()
    invoice_count = serializers.IntegerField()
    subtotal = serializers.DecimalField(max_digits=14, decimal_places=2)
    discount = serializers.DecimalField(max_digits=14, decimal_places=2)
    tax = serializers.DecimalField(max_digits=14, decimal_places=2)
    total = serializers.DecimalField(max_digits=14, decimal_places=2)
    profit = serializers.DecimalField(max_digits=14, decimal_places=2)


class DashboardSerializer(serializers.Serializer):
    today_sales = serializers.DecimalField(max_digits=14, decimal_places=2)
    month_sales = serializers.DecimalField(max_digits=14, decimal_places=2)
    outstanding = serializers.DecimalField(max_digits=14, decimal_places=2)
    low_stock_count = serializers.IntegerField()
    expense_month = serializers.DecimalField(max_digits=14, decimal_places=2)