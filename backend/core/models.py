"""Data models for the multi-tenant appliances shop system (spec section 4).

All business-level models carry a ``business`` FK and inherit
:class:`BusinessModel`, which adds ``business``, ``created_at`` and
``updated_at`` plus a tenant-scoped default manager (``for_business()``).
"""
from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone

from .storage import private_storage


class RoleConstants:
    """Module-level role enum constants (no DB table, spec 4.1)."""

    SUPER_ADMIN = 'super_admin'
    BUSINESS_ADMIN = 'business_admin'
    MANAGER = 'manager'
    CASHIER = 'cashier'

    BUSINESS_ROLES = (BUSINESS_ADMIN, MANAGER, CASHIER)
    MANAGER_AND_ABOVE = (BUSINESS_ADMIN, MANAGER)

    ROLE_CHOICES = (
        (SUPER_ADMIN, 'Super Admin'),
        (BUSINESS_ADMIN, 'Business Admin'),
        (MANAGER, 'Manager'),
        (CASHIER, 'Cashier'),
    )


class TenantQuerySet(models.QuerySet):
    """QuerySet with tenant scoping helpers."""

    def for_business(self, business):
        if business is None:
            return self.none()
        return self.filter(business=business)


class TenantManager(models.Manager.from_queryset(TenantQuerySet)):
    """Default manager that can scope queries to a single business."""


class BusinessModel(models.Model):
    """Abstract base for every business-level model."""

    business = models.ForeignKey(
        'Business', on_delete=models.CASCADE, related_name='%(class)ss'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = TenantManager()

    class Meta:
        abstract = True


# ── Auth & tenant (spec 4.1) ────────────────────────────────────────────────

class Business(models.Model):
    name = models.CharField(max_length=200)
    address = models.TextField(blank=True)
    phone = models.CharField(max_length=30, blank=True)
    email = models.EmailField(blank=True)
    logo = models.ImageField(upload_to='business_logos/', null=True, blank=True)
    is_active = models.BooleanField(default=True)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    installment_interest_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0
    )
    installments_enabled = models.BooleanField(default=True)
    # Flat interest per month, added to an installment plan when it is sold.
    # (``installment_interest_rate`` above is the separate short-payment charge.)
    installment_monthly_interest_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0
    )
    # Guarantors every installment sale must name: 0, 1 or 2.
    required_guarantors = models.PositiveSmallIntegerField(default=0)
    # Installment sales: minimum down payment as a share of the total (0 = none).
    min_down_payment_percent = models.DecimalField(
        max_digits=5, decimal_places=2, default=0
    )
    cashier_discount_cap = models.DecimalField(
        max_digits=5, decimal_places=2, default=20
    )
    max_installments = models.PositiveIntegerField(
        null=True, blank=True,
        help_text="Maximum number of installments allowed (None=unlimited). Set by business admin."
    )
    # null/blank means unlimited.
    max_users = models.PositiveIntegerField(null=True, blank=True)
    max_branches = models.PositiveIntegerField(null=True, blank=True)
    max_categories = models.PositiveIntegerField(null=True, blank=True)
    max_brands = models.PositiveIntegerField(null=True, blank=True)
    max_items = models.PositiveIntegerField(null=True, blank=True)
    item_images_enabled = models.BooleanField(default=True)
    # How far back stock, sales and installment payments may be dated.
    # 0 = back-dating off, null = unlimited. Set by the super admin.
    backdate_limit_days = models.PositiveIntegerField(null=True, blank=True, default=0)
    created_by = models.ForeignKey(
        'User', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='created_businesses',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = 'Businesses'
        ordering = ['name']

    def __str__(self):
        return self.name


class Branch(BusinessModel):
    name = models.CharField(max_length=200)
    address = models.TextField(blank=True)
    phone = models.CharField(max_length=30, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name_plural = 'Branches'
        ordering = ['name']

    def __str__(self):
        return self.name


class User(AbstractUser):
    full_name = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=30, blank=True)
    role = models.CharField(max_length=20, choices=RoleConstants.ROLE_CHOICES)
    business = models.ForeignKey(
        'Business', null=True, blank=True,
        on_delete=models.CASCADE, related_name='users',
    )
    branch = models.ForeignKey(
        'Branch', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='users',
    )
    is_active = models.BooleanField(default=True)

    REQUIRED_FIELDS = ['role']

    def __str__(self):
        return self.username


# ── Catalog & stock (spec 4.2) ──────────────────────────────────────────────

class Category(BusinessModel):
    name = models.CharField(max_length=200)
    parent = models.ForeignKey(
        'self', null=True, blank=True,
        on_delete=models.CASCADE, related_name='children',
    )

    class Meta:
        verbose_name_plural = 'Categories'
        ordering = ['name']

    def __str__(self):
        return self.name


class Brand(BusinessModel):
    name = models.CharField(max_length=200)

    def __str__(self):
        return self.name


class Item(BusinessModel):
    code = models.CharField(max_length=50)
    name = models.CharField(max_length=200)
    category = models.ForeignKey(
        Category, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='items',
    )
    brand = models.ForeignKey(
        Brand, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='items',
    )
    cost_price = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    selling_price = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    stock_quantity = models.IntegerField(default=0)
    low_stock_threshold = models.IntegerField(default=5)
    is_active = models.BooleanField(default=True)
    image = models.ImageField(upload_to='items/', null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'code'], name='uniq_item_code_per_business'
            ),
        ]
        ordering = ['name']

    def __str__(self):
        return f'{self.code} — {self.name}'


class StockLot(BusinessModel):
    OPENING = 'OPENING'
    PURCHASE = 'PURCHASE'
    ADJUSTMENT = 'ADJUSTMENT'
    RETURN = 'RETURN'
    SOURCE_CHOICES = (
        (OPENING, 'Opening'),
        (PURCHASE, 'Purchase'),
        (ADJUSTMENT, 'Adjustment'),
        (RETURN, 'Return'),
    )

    branch = models.ForeignKey(
        Branch, on_delete=models.CASCADE, related_name='stock_lots'
    )
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name='lots')
    quantity_total = models.IntegerField()
    quantity_remaining = models.IntegerField()
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2)
    source = models.CharField(max_length=20, choices=SOURCE_CHOICES)
    reference = models.CharField(max_length=100, blank=True)
    received_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['received_at', 'id']

    def __str__(self):
        return f'{self.item.code} lot (remaining {self.quantity_remaining})'


class StockMovement(BusinessModel):
    IN = 'IN'
    OUT = 'OUT'
    ADJUST = 'ADJUST'
    SALE = 'SALE'
    TYPE_CHOICES = (
        (IN, 'In'),
        (OUT, 'Out'),
        (ADJUST, 'Adjust'),
        (SALE, 'Sale'),
    )

    branch = models.ForeignKey(
        Branch, on_delete=models.CASCADE, related_name='stock_movements'
    )
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name='movements')
    type = models.CharField(max_length=10, choices=TYPE_CHOICES)
    quantity = models.IntegerField()
    reference = models.CharField(max_length=100, blank=True)
    note = models.TextField(blank=True)
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL
    )

    class Meta:
        ordering = ['-created_at']


class LotAllocation(BusinessModel):
    stock_lot = models.ForeignKey(
        StockLot, on_delete=models.CASCADE, related_name='allocations'
    )
    sale_item = models.ForeignKey(
        'SaleItem', on_delete=models.CASCADE, related_name='allocations'
    )
    quantity = models.IntegerField()
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2)

    def __str__(self):
        return f'{self.quantity} x lot {self.stock_lot_id}'


# ── Customers (spec 4.3) ────────────────────────────────────────────────────

class Customer(BusinessModel):
    name = models.CharField(max_length=200)
    phone = models.CharField(max_length=30, blank=True)
    nic = models.CharField(max_length=20, blank=True)
    address = models.TextField(blank=True)
    # Stored privately (outside public_html) — see core/storage.py, B-24.
    id_card_photo = models.ImageField(
        upload_to='customers/', null=True, blank=True, storage=private_storage
    )
    # Set by a manager or owner for bad payers: no new installment sale may
    # name this person as buyer or guarantor.
    is_blacklisted = models.BooleanField(default=False)
    blacklist_reason = models.CharField(max_length=255, blank=True)
    blacklisted_at = models.DateTimeField(null=True, blank=True)
    blacklisted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+',
    )

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


# ── Sales & installments (spec 4.4) ─────────────────────────────────────────

class Sale(BusinessModel):
    OPEN = 'OPEN'
    CLOSED = 'CLOSED'
    CANCELLED = 'CANCELLED'
    STATUS_CHOICES = (
        (OPEN, 'Open'),
        (CLOSED, 'Closed'),
        (CANCELLED, 'Cancelled'),
    )
    PERCENT = 'PERCENT'
    AMOUNT = 'AMOUNT'
    DISCOUNT_TYPE_CHOICES = (
        (PERCENT, 'Percent'),
        (AMOUNT, 'Amount'),
    )
    WEEKLY = 'WEEKLY'
    MONTHLY = 'MONTHLY'
    CUSTOM = 'CUSTOM'
    FREQUENCY_CHOICES = (
        (WEEKLY, 'Weekly'),
        (MONTHLY, 'Monthly'),
        (CUSTOM, 'Custom'),
    )

    branch = models.ForeignKey(
        Branch, on_delete=models.PROTECT, related_name='sales'
    )
    customer = models.ForeignKey(
        Customer, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='sales',
    )
    invoice_no = models.CharField(max_length=50, unique=True)
    subtotal = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    discount_type = models.CharField(
        max_length=10, choices=DISCOUNT_TYPE_CHOICES,
        default=PERCENT, blank=True,
    )
    discount_value = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    discount_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    total_cost = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    is_single_payment = models.BooleanField(default=True)
    down_payment = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    number_of_installments = models.IntegerField(default=0)
    remaining_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=OPEN)
    installment_frequency = models.CharField(
        max_length=10, choices=FREQUENCY_CHOICES, default=MONTHLY
    )
    installment_interval_days = models.IntegerField(default=30)
    # Rate used and interest added to the plan (not part of total_cost).
    monthly_interest_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    plan_interest = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    guarantor_1 = models.ForeignKey(
        Customer, null=True, blank=True,
        on_delete=models.PROTECT, related_name='guaranteed_first',
    )
    guarantor_2 = models.ForeignKey(
        Customer, null=True, blank=True,
        on_delete=models.PROTECT, related_name='guaranteed_second',
    )
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='sales'
    )

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.invoice_no


class SaleItem(BusinessModel):
    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name='items')
    item = models.ForeignKey(Item, on_delete=models.PROTECT)
    quantity = models.IntegerField()
    unit_price = models.DecimalField(max_digits=12, decimal_places=2)
    line_total = models.DecimalField(max_digits=12, decimal_places=2)
    fifo_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    def __str__(self):
        return f'{self.item.code} x{self.quantity}'


class Installment(BusinessModel):
    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name='installments')
    number = models.IntegerField()
    due_date = models.DateField()
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    paid_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    is_paid = models.BooleanField(default=False)
    paid_date = models.DateField(null=True, blank=True)
    interest_charged = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    class Meta:
        ordering = ['number']
        constraints = [
            models.UniqueConstraint(
                fields=['sale', 'number'], name='uniq_installment_number_per_sale'
            ),
        ]

    def __str__(self):
        return f'{self.sale.invoice_no} #{self.number}'


class Payment(BusinessModel):
    CASH = 'CASH'
    CARD = 'CARD'
    TRANSFER = 'TRANSFER'
    METHOD_CHOICES = (
        (CASH, 'Cash'),
        (CARD, 'Card'),
        (TRANSFER, 'Transfer'),
    )

    sale = models.ForeignKey(
        Sale, null=True, blank=True, on_delete=models.CASCADE, related_name='payments'
    )
    installment = models.ForeignKey(
        Installment, null=True, blank=True,
        on_delete=models.CASCADE, related_name='payments',
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    method = models.CharField(max_length=10, choices=METHOD_CHOICES, default=CASH)
    cash_account = models.ForeignKey(
        'CashAccount', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='payments',
    )
    received_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL
    )
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.amount} ({self.method})'


# ── Discounts (spec 4.5) ────────────────────────────────────────────────────

class SeasonalDiscount(BusinessModel):
    ALL = 'ALL'
    CATEGORY = 'CATEGORY'
    BRAND = 'BRAND'
    ITEM = 'ITEM'
    SCOPE_CHOICES = (
        (ALL, 'All'),
        (CATEGORY, 'Category'),
        (BRAND, 'Brand'),
        (ITEM, 'Item'),
    )

    name = models.CharField(max_length=200)
    scope = models.CharField(max_length=10, choices=SCOPE_CHOICES)
    target_id = models.PositiveIntegerField(null=True, blank=True)
    discount_percentage = models.DecimalField(max_digits=5, decimal_places=2)
    start_date = models.DateField()
    end_date = models.DateField()
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return f'{self.name} ({self.discount_percentage}%)'


# ── Suppliers & purchase orders (spec 4.6) ──────────────────────────────────

class Supplier(BusinessModel):
    name = models.CharField(max_length=200)
    contact_person = models.CharField(max_length=200, blank=True)
    phone = models.CharField(max_length=30, blank=True)
    email = models.EmailField(blank=True)
    address = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return self.name


class Purchase(BusinessModel):
    DRAFT = 'DRAFT'
    ORDERED = 'ORDERED'
    PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED'
    RECEIVED = 'RECEIVED'
    CANCELLED = 'CANCELLED'
    STATUS_CHOICES = (
        (DRAFT, 'Draft'),
        (ORDERED, 'Ordered'),
        (PARTIALLY_RECEIVED, 'Partially received'),
        (RECEIVED, 'Received'),
        (CANCELLED, 'Cancelled'),
    )

    branch = models.ForeignKey(
        Branch, on_delete=models.PROTECT, related_name='purchases'
    )
    supplier = models.ForeignKey(
        Supplier, on_delete=models.PROTECT, related_name='purchases'
    )
    order_no = models.CharField(max_length=50, unique=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=DRAFT)
    expected_delivery_date = models.DateField(null=True, blank=True)
    # Set when stock was entered with a past date; otherwise created_at applies.
    purchase_date = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True)
    ordered_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name='purchases'
    )

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.order_no


class PurchaseItem(BusinessModel):
    purchase = models.ForeignKey(
        Purchase, on_delete=models.CASCADE, related_name='items'
    )
    item = models.ForeignKey(Item, on_delete=models.PROTECT)
    quantity = models.IntegerField()
    received_quantity = models.IntegerField(default=0)
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2)
    total = models.DecimalField(max_digits=12, decimal_places=2)

    def __str__(self):
        return f'{self.item.code} x{self.quantity}'


class PurchaseReceipt(BusinessModel):
    purchase = models.ForeignKey(
        Purchase, on_delete=models.CASCADE, related_name='receipts'
    )
    receipt_no = models.CharField(max_length=50, unique=True)
    received_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL
    )
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.receipt_no


class PurchaseReceiptItem(BusinessModel):
    receipt = models.ForeignKey(
        PurchaseReceipt, on_delete=models.CASCADE, related_name='items'
    )
    purchase_item = models.ForeignKey(
        PurchaseItem, on_delete=models.CASCADE, related_name='receipt_items'
    )
    quantity = models.IntegerField()

    def __str__(self):
        return f'{self.quantity} of {self.purchase_item}'


# ── Bookkeeping — money out, cash & capital (spec 4.7) ──────────────────────

class CashAccount(BusinessModel):
    CASH = 'CASH'
    BANK = 'BANK'
    TYPE_CHOICES = (
        (CASH, 'Cash'),
        (BANK, 'Bank'),
    )

    name = models.CharField(max_length=200)
    type = models.CharField(max_length=10, choices=TYPE_CHOICES, default=CASH)
    opening_balance = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return self.name


class ExpenseCategory(BusinessModel):
    name = models.CharField(max_length=200)
    is_active = models.BooleanField(default=True)

    class Meta:
        verbose_name_plural = 'Expense categories'

    def __str__(self):
        return self.name


class Expense(BusinessModel):
    branch = models.ForeignKey(
        Branch, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='expenses',
    )
    category = models.ForeignKey(
        ExpenseCategory, on_delete=models.PROTECT, related_name='expenses'
    )
    description = models.CharField(max_length=200)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    expense_date = models.DateField()
    cash_account = models.ForeignKey(
        CashAccount, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='expenses',
    )
    paid_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL
    )
    note = models.TextField(blank=True)

    class Meta:
        ordering = ['-expense_date']

    def __str__(self):
        return self.description


class SupplierPayment(BusinessModel):
    supplier = models.ForeignKey(
        Supplier, on_delete=models.CASCADE, related_name='payments'
    )
    purchase = models.ForeignKey(
        Purchase, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='payments',
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    payment_date = models.DateField()
    cash_account = models.ForeignKey(
        CashAccount, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='supplier_payments',
    )
    paid_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL
    )
    note = models.TextField(blank=True)

    class Meta:
        ordering = ['-payment_date']

    def __str__(self):
        return f'{self.supplier.name} {self.amount}'


class CapitalEntry(BusinessModel):
    OWNER_IN = 'OWNER_IN'
    OWNER_OUT = 'OWNER_OUT'
    TYPE_CHOICES = (
        (OWNER_IN, 'Owner in'),
        (OWNER_OUT, 'Owner out'),
    )

    date = models.DateField()
    type = models.CharField(max_length=10, choices=TYPE_CHOICES)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    note = models.TextField(blank=True)

    class Meta:
        verbose_name_plural = 'Capital entries'
        ordering = ['date']

    def __str__(self):
        return f'{self.type} {self.amount}'


class RecurringExpense(BusinessModel):
    MONTHLY = 'MONTHLY'
    WEEKLY = 'WEEKLY'
    CUSTOM = 'CUSTOM'
    FREQUENCY_CHOICES = (
        (MONTHLY, 'Monthly'),
        (WEEKLY, 'Weekly'),
        (CUSTOM, 'Custom days'),
    )

    branch = models.ForeignKey(
        Branch, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='recurring_expenses',
    )
    category = models.ForeignKey(
        ExpenseCategory, on_delete=models.PROTECT, related_name='recurring_expenses'
    )
    description = models.CharField(max_length=200)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    frequency = models.CharField(max_length=10, choices=FREQUENCY_CHOICES)
    interval_days = models.IntegerField(default=30)
    next_due_date = models.DateField()
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['next_due_date']

    def __str__(self):
        return self.description


class Promotion(BusinessModel):
    """Seasonal promotions and discounts."""
    NAME = 'NAME'
    PERCENTAGE = 'PERCENTAGE'
    AMOUNT = 'AMOUNT'
    TYPE_CHOICES = (
        (NAME, 'Name-based'),
        (PERCENTAGE, 'Percentage'),
        (AMOUNT, 'Amount'),
    )

    name = models.CharField(max_length=200)
    type = models.CharField(max_length=20, choices=TYPE_CHOICES, default=PERCENTAGE)
    value = models.DecimalField(max_digits=10, decimal_places=2)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()

    class Meta:
        ordering = ['-starts_at']

    def __str__(self):
        return f'{self.name} ({self.value})'


class Report(BusinessModel):
    """System reports configuration and history."""
    REVENUE = 'REVENUE'
    EXPENSE = 'EXPENSE'
    PROFIT = 'PROFIT'
    CASH_FLOW = 'CASH_FLOW'
    TAX = 'TAX'
    TYPE_CHOICES = (
        (REVENUE, 'Revenue'),
        (EXPENSE, 'Expense'),
        (PROFIT, 'Profit'),
        (CASH_FLOW, 'Cash Flow'),
        (TAX, 'Tax'),
    )

    name = models.CharField(max_length=200)
    report_type = models.CharField(max_length=20, choices=TYPE_CHOICES, default=REVENUE)
    is_generated = models.BooleanField(default=False)
    generated_at = models.DateTimeField(null=True, blank=True)
    data_summary = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['-generated_at']

    def __str__(self):
        return f'{self.name} ({self.report_type})'


# ── Audit trail ─────────────────────────────────────────────────────────────

class ActivityLog(BusinessModel):
    """Who edited, deleted or cancelled what, and when. Never edited."""

    EDIT = 'EDIT'
    DELETE = 'DELETE'
    CANCEL = 'CANCEL'
    ACTION_CHOICES = ((EDIT, 'Edit'), (DELETE, 'Delete'), (CANCEL, 'Cancel'))

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+',
    )
    # Copied so the entry still names the person after the account is removed.
    username = models.CharField(max_length=150)
    role = models.CharField(max_length=20, blank=True)
    action = models.CharField(max_length=10, choices=ACTION_CHOICES)
    record_type = models.CharField(max_length=30)
    record_id = models.PositiveBigIntegerField(null=True, blank=True)
    label = models.CharField(max_length=200, blank=True)
    details = models.TextField(blank=True)

    class Meta:
        ordering = ['-created_at', '-id']
        indexes = [
            models.Index(fields=['business', '-created_at']),
            models.Index(fields=['business', 'record_type', 'record_id']),
        ]
