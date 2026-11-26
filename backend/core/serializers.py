"""DRF serializers for the shop API (spec section 6).

Business-level models get queryset scoping through
``core.viewsets.TenantModelViewSet``; serializers handle payload
validation and write the ``business`` FK when saving.
"""
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.urls import reverse
from django.utils.dateparse import parse_date
from rest_framework import serializers

from . import services
from .storage import sign_customer_photo


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


def _past_date(user, value, field):
    """Resolve a user-supplied entry date; ``None`` means "now".

    Back-dating is manager+ and limited per business.
    """
    try:
        day = services.check_entry_date(user.business, value)
    except ValueError as exc:
        raise serializers.ValidationError({field: str(exc)})
    if day is not None and user.role not in (
        RoleConstants.BUSINESS_ADMIN, RoleConstants.MANAGER,
    ):
        raise serializers.ValidationError(
            {field: 'Only managers and admins can use a past date.'}
        )
    return day


def _request_business(serializer):
    """The caller's business from the serializer context, or None."""
    request = serializer.context.get('request') if serializer.context else None
    user = getattr(request, 'user', None)
    if user is None or not getattr(user, 'is_authenticated', False):
        return None
    return getattr(user, 'business', None)


def scope_related_fields(serializer, business):
    """Restrict every writable FK field to rows of ``business`` (B-02).

    DRF's ``PrimaryKeyRelatedField`` defaults to ``Model.objects.all()``,
    which lets a caller reference another tenant's supplier, branch, cash
    account, … by id. Any related model that carries a ``business`` FK is
    narrowed to the caller's tenant; with no tenant the field accepts nothing.
    """
    for field in serializer.fields.values():
        rel = getattr(field, 'child_relation', field)
        if not isinstance(rel, serializers.PrimaryKeyRelatedField) or rel.read_only:
            continue
        queryset = rel.queryset
        if queryset is None:
            continue
        model = queryset.model
        has_business = any(f.name == 'business' for f in model._meta.get_fields())
        if not has_business:
            continue
        rel.queryset = (
            model._default_manager.filter(business=business)
            if business is not None else model._default_manager.none()
        )


class TenantModelSerializer(serializers.ModelSerializer):
    """ModelSerializer whose FK inputs are scoped to the caller's business."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        scope_related_fields(self, _request_business(self))


# ── Simple CRUD serializers ─────────────────────────────────────────────────

class BranchSerializer(TenantModelSerializer):
    class Meta:
        model = Branch
        fields = ['id', 'name', 'address', 'phone', 'is_active', 'created_at']


class CategorySerializer(TenantModelSerializer):
    class Meta:
        model = Category
        fields = ['id', 'name', 'parent', 'created_at']


class BrandSerializer(TenantModelSerializer):
    class Meta:
        model = Brand
        fields = ['id', 'name', 'created_at']


class ItemListSerializer(TenantModelSerializer):
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
        # Stock only changes through opening stock, receipts, sales and
        # adjustments, which keep the FIFO lots in step (B-08).
        read_only_fields = ['stock_quantity']

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
        # ``?price_date=`` previews prices for a back-dated sale.
        raw = request.query_params.get('price_date') if request else None
        try:
            on_date = parse_date(raw) if raw else None
        except ValueError:
            on_date = None
        self._rows_cache = services.active_discount_rows(business, on_date)
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
        """Aggregate per-branch remaining quantities and costs from FIFO lots.

        ``next_cost`` is the unit cost the next sale at that branch will use and
        ``stock_value`` the cost of what is left (both hidden from cashiers).

        Uses the prefetched ``lots``/``branch`` caches on the item
        queryset (see ``ItemViewSet``) so list responses stay N+1-free.
        """
        totals = {}
        # FIFO order, so the first lot with stock gives next_cost.
        for lot in sorted(obj.lots.all(), key=lambda row: (row.received_at, row.id)):
            if lot.quantity_remaining <= 0:
                continue
            if lot.branch_id not in totals:
                totals[lot.branch_id] = {
                    'branch_id': lot.branch_id,
                    'branch_name': lot.branch.name,
                    'quantity': 0,
                    'next_cost': str(lot.unit_cost),
                    'stock_value': Decimal('0.00'),
                }
            totals[lot.branch_id]['quantity'] += lot.quantity_remaining
            totals[lot.branch_id]['stock_value'] += lot.quantity_remaining * lot.unit_cost
        rows = list(totals.values())
        for row in rows:
            row['stock_value'] = str(_cents(row['stock_value']))
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
                for row in data.get('branch_stock', []):
                    row.pop('next_cost', None)
                    row.pop('stock_value', None)
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
        business = _request_business(self)
        if attrs.get('image') and business and not business.item_images_enabled:
            raise serializers.ValidationError(
                {'image': 'Product images are turned off for this business.'}
            )
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
                            'code': 'A product with this code already exists in this business.'
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


class PrivatePhotoField(serializers.ImageField):
    """Accepts an uploaded image; renders a signed, expiring API URL instead
    of a public media path (B-24). Same field name/shape as before (a URL)."""

    def to_representation(self, value):
        if not value:
            return None
        customer = value.instance  # FieldFile knows its model instance
        request = self.context.get('request')
        path = reverse('customer-id-card-photo', kwargs={'pk': customer.pk})
        url = f'{path}?sig={sign_customer_photo(customer)}'
        return request.build_absolute_uri(url) if request else url


class CustomerSerializer(TenantModelSerializer):
    id_card_photo = PrivatePhotoField(required=False, allow_null=True)

    class Meta:
        model = Customer
        fields = [
            'id', 'name', 'phone', 'nic', 'address', 'id_card_photo',
            'created_at',
        ]


class SupplierSerializer(TenantModelSerializer):
    class Meta:
        model = Supplier
        fields = [
            'id', 'name', 'contact_person', 'phone', 'email', 'address',
            'is_active', 'created_at',
        ]


class CashAccountSerializer(TenantModelSerializer):
    balance = serializers.SerializerMethodField()

    class Meta:
        model = CashAccount
        fields = [
            'id', 'name', 'type', 'opening_balance', 'balance',
            'is_active', 'created_at',
        ]

    def get_balance(self, obj):
        # account_balances() computes every account of the business at once;
        # cache it in the (per-request) context so a list of N accounts runs
        # those queries once instead of N times (blueprint B-22).
        balances = self.context.get('_account_balances')
        if balances is None:
            balances = services.account_balances(self.context['request'].user.business)
            self.context['_account_balances'] = balances
        return balances.get(obj.id, 0)


class ExpenseCategorySerializer(TenantModelSerializer):
    class Meta:
        model = ExpenseCategory
        fields = ['id', 'name', 'is_active']


class StockLotSerializer(TenantModelSerializer):
    item_code = serializers.CharField(source='item.code', read_only=True)
    item_name = serializers.CharField(source='item.name', read_only=True)

    class Meta:
        model = StockLot
        fields = [
            'id', 'item', 'item_code', 'item_name', 'branch',
            'quantity_total', 'quantity_remaining', 'unit_cost',
            'source', 'reference', 'received_at',
        ]


class StockMovementSerializer(TenantModelSerializer):
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


class PaymentSerializer(TenantModelSerializer):
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
    guarantors = serializers.SerializerMethodField()

    class Meta(SaleListSerializer.Meta):
        fields = SaleListSerializer.Meta.fields + [
            'items', 'installments', 'payments',
            'business_name', 'business_address', 'business_phone',
            'branch_address', 'branch_phone', 'discount_label',
            'business_logo', 'monthly_interest_rate', 'plan_interest', 'guarantors',
        ]

    def get_guarantors(self, obj):
        return [
            {'id': g.id, 'name': g.name, 'phone': g.phone, 'nic': g.nic,
             'address': g.address}
            for g in (obj.guarantor_1, obj.guarantor_2) if g
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
    # Back-dated sales only: the price charged at the time.
    unit_price = serializers.DecimalField(
        max_digits=12, decimal_places=2, required=False, min_value=Decimal('0')
    )


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
        max_digits=12, decimal_places=2, default=0, min_value=Decimal('0')
    )
    tax_rate = serializers.DecimalField(
        max_digits=5, decimal_places=2, required=False, allow_null=True,
        min_value=Decimal('0'), max_value=Decimal('100'),
    )
    is_single_payment = serializers.BooleanField(default=True)
    down_payment = serializers.DecimalField(
        max_digits=12, decimal_places=2, default=0, min_value=Decimal('0')
    )
    number_of_installments = serializers.IntegerField(default=0, min_value=0)
    installment_frequency = serializers.ChoiceField(
        choices=Sale.FREQUENCY_CHOICES, default=Sale.MONTHLY
    )
    installment_interval_days = serializers.IntegerField(
        default=30, min_value=1, max_value=366
    )
    cash_account = serializers.PrimaryKeyRelatedField(
        queryset=CashAccount.objects.none(), required=False, allow_null=True
    )
    sale_date = serializers.DateField(required=False, allow_null=True)
    guarantors = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=Customer.objects.none()
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
            self.fields['guarantors'].child_relation.queryset = (
                Customer.objects.for_business(business)
            )
            self.fields['cash_account'].queryset = CashAccount.objects.for_business(business)
            line_fields = self.fields['lines'].child.fields
            line_fields['item'].queryset = Item.objects.for_business(business)

    def validate(self, attrs):
        """Validate discount bounds and installment count against business limits."""
        if (
            attrs.get('discount_type', Sale.PERCENT) == Sale.PERCENT
            and attrs.get('discount_value', 0) > 100
        ):
            raise serializers.ValidationError(
                {'discount_value': 'A percentage discount cannot exceed 100%.'}
            )
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = getattr(request.user, 'business', None)
            if business is not None:
                attrs['sale_date'] = _past_date(
                    request.user, attrs.get('sale_date'), 'sale_date'
                )
                if attrs['sale_date'] is None and any(
                    'unit_price' in line for line in attrs.get('lines', [])
                ):
                    raise serializers.ValidationError(
                        {'detail': 'Unit prices can only be set on a back-dated sale.'}
                    )
                self._check_installment_rules(business, attrs)
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

    @staticmethod
    def _check_installment_rules(business, attrs):
        guarantors = attrs.get('guarantors', [])
        if attrs.get('is_single_payment', True):
            if guarantors:
                raise serializers.ValidationError(
                    {'guarantors': 'Guarantors are only used for installment sales.'}
                )
            return
        if not business.installments_enabled:
            raise serializers.ValidationError(
                {'detail': 'Installment sales are turned off for this business.'}
            )
        customer = attrs.get('customer')
        if customer is None:
            raise serializers.ValidationError(
                {'customer': 'An installment sale needs a saved customer.'}
            )
        needed = business.required_guarantors
        if len(guarantors) != needed:
            raise serializers.ValidationError(
                {'guarantors': f'Installment sales need exactly {needed} guarantor(s).'}
            )
        ids = [g.id for g in guarantors]
        if len(set(ids)) != len(ids) or customer.id in ids:
            raise serializers.ValidationError(
                {'guarantors': 'Each guarantor must be a different person from the '
                               'customer and from each other.'}
            )

    @transaction.atomic
    def create(self, validated_data):
        request = self.context['request']
        user = request.user
        lines = [
            {'item': l['item'], 'quantity': l['quantity'],
             'unit_price': l.get('unit_price')}
            for l in validated_data['lines']
        ]
        # Cashiers may only give spot discounts up to the business cap (B-18).
        max_discount_percent = (
            user.business.cashier_discount_cap
            if user.role == RoleConstants.CASHIER else None
        )
        try:
            return self._record(user, lines, validated_data, max_discount_percent)
        except ValueError as exc:
            # Service-level rule violations (insufficient stock, bad down
            # payment, …) are client errors, not server errors (B-12).
            raise serializers.ValidationError({'detail': str(exc)})

    def _record(self, user, lines, validated_data, max_discount_percent):
        sale = services.record_sale(
            max_discount_percent=max_discount_percent,
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
            sale_date=validated_data.get('sale_date'),
            guarantors=validated_data.get('guarantors', []),
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
    payment_date = serializers.DateField(required=False, allow_null=True)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and getattr(request, 'user', None) and request.user.is_authenticated:
            business = request.user.business
            if business is not None:
                self.fields['installment'].queryset = Installment.objects.for_business(business)
                self.fields['cash_account'].queryset = CashAccount.objects.for_business(business)

    def validate(self, attrs):
        user = self.context['request'].user
        attrs['payment_date'] = _past_date(user, attrs.get('payment_date'), 'payment_date')
        return attrs

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
                payment_date=validated_data.get('payment_date'),
            )
        except ValueError as exc:
            raise serializers.ValidationError({'detail': str(exc)})
        return installment


# ── Purchases (spec 6) ──────────────────────────────────────────────────────

class PurchaseItemSerializer(TenantModelSerializer):
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
            'expected_delivery_date', 'purchase_date', 'total', 'created_at',
        ]

    def get_total(self, obj):
        return _cents(sum(i.total for i in obj.items.all()))


class PurchaseDetailSerializer(PurchaseListSerializer):
    items = PurchaseItemSerializer(many=True, read_only=True)
    receipts = PurchaseReceiptSerializer(many=True, read_only=True)

    class Meta(PurchaseListSerializer.Meta):
        fields = PurchaseListSerializer.Meta.fields + ['notes', 'items', 'receipts']


class PurchaseCreateSerializer(TenantModelSerializer):
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


# ── Stock in ────────────────────────────────────────────────────────────────

class StockInLineSerializer(serializers.Serializer):
    item = serializers.PrimaryKeyRelatedField(queryset=Item.objects.none())
    quantity = serializers.IntegerField(min_value=1, max_value=1_000_000)
    unit_cost = serializers.DecimalField(
        max_digits=12, decimal_places=2, min_value=Decimal('0')
    )
    selling_price = serializers.DecimalField(
        max_digits=12, decimal_places=2, required=False, allow_null=True,
        min_value=Decimal('0'),
    )


class StockInSerializer(serializers.Serializer):
    """Payload for one-step stock entry (:func:`services.record_stock_in`)."""

    source = serializers.ChoiceField(choices=[StockLot.PURCHASE, StockLot.OPENING])
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.none())
    supplier = serializers.PrimaryKeyRelatedField(
        queryset=Supplier.objects.none(), required=False, allow_null=True
    )
    lines = StockInLineSerializer(many=True, allow_empty=False)
    paid_amount = serializers.DecimalField(
        max_digits=12, decimal_places=2, required=False, default=Decimal('0'),
        min_value=Decimal('0'),
    )
    cash_account = serializers.PrimaryKeyRelatedField(
        queryset=CashAccount.objects.none(), required=False, allow_null=True
    )
    received_date = serializers.DateField(required=False, allow_null=True)
    note = serializers.CharField(required=False, allow_blank=True, default='')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        business = _request_business(self)
        if business is None:
            return
        self.fields['branch'].queryset = Branch.objects.for_business(business)
        self.fields['supplier'].queryset = Supplier.objects.for_business(business)
        self.fields['cash_account'].queryset = CashAccount.objects.for_business(business)
        self.fields['lines'].child.fields['item'].queryset = (
            Item.objects.for_business(business)
        )

    def validate(self, attrs):
        user = self.context['request'].user
        attrs['received_date'] = _past_date(
            user, attrs.get('received_date'), 'received_date'
        )
        if attrs['source'] == StockLot.PURCHASE:
            if not attrs.get('supplier'):
                raise serializers.ValidationError({'supplier': 'Choose a supplier.'})
            if attrs['paid_amount'] > 0 and not attrs.get('cash_account'):
                raise serializers.ValidationError(
                    {'cash_account': 'Choose the account the money was paid from.'}
                )
        elif attrs['paid_amount'] > 0 or attrs.get('supplier'):
            raise serializers.ValidationError(
                {'detail': 'Opening stock has no supplier or payment.'}
            )
        return attrs

    def create(self, validated_data):
        user = self.context['request'].user
        try:
            return services.record_stock_in(
                business=user.business, created_by=user, **validated_data
            )
        except ValueError as exc:
            raise serializers.ValidationError({'detail': str(exc)})


# ── Expenses / bookkeeping (spec 6) ─────────────────────────────────────────

class ExpenseSerializer(TenantModelSerializer):
    category_name = serializers.CharField(source='category.name', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True, default='')

    class Meta:
        model = Expense
        fields = [
            'id', 'branch', 'branch_name', 'category', 'category_name',
            'description', 'amount', 'expense_date', 'cash_account',
            'paid_by', 'note', 'created_at',
        ]
        read_only_fields = ['paid_by']
        extra_kwargs = {'amount': {'min_value': Decimal('0.01')}}


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


class CapitalEntrySerializer(TenantModelSerializer):
    class Meta:
        model = CapitalEntry
        fields = ['id', 'date', 'type', 'amount', 'note', 'created_at']


class SupplierPaymentSerializer(TenantModelSerializer):
    supplier_name = serializers.CharField(source='supplier.name', read_only=True)

    class Meta:
        model = SupplierPayment
        fields = [
            'id', 'supplier', 'supplier_name', 'purchase', 'amount',
            'payment_date', 'cash_account', 'paid_by', 'note', 'created_at',
        ]
        read_only_fields = ['paid_by']
        extra_kwargs = {'amount': {'min_value': Decimal('0.01')}}

    def validate(self, attrs):
        supplier = attrs.get('supplier', getattr(self.instance, 'supplier', None))
        purchase = attrs.get('purchase', getattr(self.instance, 'purchase', None))
        if purchase is not None and supplier is not None and purchase.supplier_id != supplier.id:
            raise serializers.ValidationError(
                {'purchase': 'This purchase order belongs to a different supplier.'}
            )
        return attrs


class RecurringExpenseSerializer(TenantModelSerializer):
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
    max_categories = serializers.IntegerField(
        required=False, allow_null=True, min_value=1
    )
    max_brands = serializers.IntegerField(
        required=False, allow_null=True, min_value=1
    )
    max_items = serializers.IntegerField(
        required=False, allow_null=True, min_value=1
    )
    # 0 = back-dating off, null = unlimited.
    backdate_limit_days = serializers.IntegerField(
        required=False, allow_null=True, min_value=0, max_value=36500
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
            'max_users', 'max_branches', 'backdate_limit_days',
            'max_categories', 'max_brands', 'max_items', 'item_images_enabled',
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
    business_backdate_limit_days = serializers.SerializerMethodField()
    business_item_images_enabled = serializers.SerializerMethodField()
    business_min_down_payment_percent = serializers.SerializerMethodField()
    business_installments_enabled = serializers.SerializerMethodField()
    business_installment_monthly_interest_rate = serializers.SerializerMethodField()
    business_required_guarantors = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'full_name', 'phone', 'role',
            'business', 'branch', 'is_active', 'email', 'business_tax_rate',
            'business_installment_interest_rate', 'business_name', 'business_logo',
            'business_backdate_limit_days', 'business_item_images_enabled',
            'business_min_down_payment_percent', 'business_installments_enabled',
            'business_installment_monthly_interest_rate', 'business_required_guarantors',
        ]

    def get_business_tax_rate(self, obj):
        business = getattr(obj, 'business', None)
        return str(business.tax_rate) if business is not None else '0'

    def get_business_installment_interest_rate(self, obj):
        business = getattr(obj, 'business', None)
        return str(business.installment_interest_rate) if business is not None else '0'

    def get_business_installments_enabled(self, obj):
        business = getattr(obj, 'business', None)
        return business.installments_enabled if business is not None else False

    def get_business_installment_monthly_interest_rate(self, obj):
        business = getattr(obj, 'business', None)
        return str(business.installment_monthly_interest_rate) if business is not None else '0'

    def get_business_required_guarantors(self, obj):
        business = getattr(obj, 'business', None)
        return business.required_guarantors if business is not None else 0

    def get_business_min_down_payment_percent(self, obj):
        business = getattr(obj, 'business', None)
        return str(business.min_down_payment_percent) if business is not None else '0'

    def get_business_item_images_enabled(self, obj):
        business = getattr(obj, 'business', None)
        return business.item_images_enabled if business is not None else False

    def get_business_backdate_limit_days(self, obj):
        # null means unlimited; users without a business get 0 (off).
        business = getattr(obj, 'business', None)
        return business.backdate_limit_days if business is not None else 0

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

    # 100% would leave nothing to pay in installments.
    min_down_payment_percent = serializers.DecimalField(
        max_digits=5, decimal_places=2, min_value=0, max_value=99,
    )

    installments_enabled = serializers.BooleanField()
    installment_monthly_interest_rate = serializers.DecimalField(
        max_digits=5, decimal_places=2, min_value=0, max_value=100,
    )
    required_guarantors = serializers.IntegerField(min_value=0, max_value=2)

    class Meta:
        model = Business
        fields = [
            'tax_rate', 'installment_interest_rate', 'min_down_payment_percent',
            'installments_enabled', 'installment_monthly_interest_rate',
            'required_guarantors',
        ]


# ── Seasonal discounts ──────────────────────────────────────────────────────

class SeasonalDiscountSerializer(TenantModelSerializer):
    class Meta:
        model = SeasonalDiscount
        fields = [
            'id', 'name', 'scope', 'target_id', 'discount_percentage',
            'start_date', 'end_date', 'is_active', 'created_at',
        ]
        extra_kwargs = {
            'discount_percentage': {'min_value': Decimal('0.01'), 'max_value': Decimal('100')},
        }

    TARGET_MODELS = {
        SeasonalDiscount.CATEGORY: Category,
        SeasonalDiscount.BRAND: Brand,
        SeasonalDiscount.ITEM: Item,
    }

    def validate(self, attrs):
        scope = attrs.get('scope', getattr(self.instance, 'scope', None))
        target_id = attrs.get('target_id', getattr(self.instance, 'target_id', None))
        start = attrs.get('start_date', getattr(self.instance, 'start_date', None))
        end = attrs.get('end_date', getattr(self.instance, 'end_date', None))
        if start and end and end < start:
            raise serializers.ValidationError({'end_date': 'End date must be on or after start date.'})
        model = self.TARGET_MODELS.get(scope)
        if model is not None:
            business = _request_business(self)
            if target_id is None or business is None or not model.objects.filter(
                pk=target_id, business=business
            ).exists():
                raise serializers.ValidationError(
                    {'target_id': f'Choose a valid {scope.lower()} from your business.'}
                )
        return attrs


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