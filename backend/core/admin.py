"""Django Admin configuration (spec section 8).

Uses a custom ``AdminSite`` instance (``admin_site``) instead of replacing
``django.contrib.admin`` so the API root stays clean and the site name is
meaningful for super admins.
"""
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.utils import timezone
from django.utils.html import format_html

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
    Promotion,
    Report,
)


class AdminSite(admin.AdminSite):
    site_header = 'Shop System Administration'
    site_title = 'Shop Admin'
    index_title = 'Tenant & Business Overview'


admin_site = AdminSite(name='shop_admin')


# ── User & Business (tenant management) ─────────────────────────────────────

@admin.register(User, site=admin_site)
class UserAdmin(BaseUserAdmin):
    """Extend Django's UserAdmin with shop roles and tenant scoping."""

    list_display = (
        'username', 'full_name', 'role', 'business', 'branch',
        'is_active', 'last_login',
    )
    list_filter = ('role', 'business', 'is_active')
    search_fields = ('username', 'full_name', 'email', 'phone')
    fieldsets = BaseUserAdmin.fieldsets + (
        ('Shop Profile', {
            'fields': ('full_name', 'phone', 'role', 'business', 'branch'),
        }),
    )
    add_fieldsets = BaseUserAdmin.add_fieldsets + (
        ('Shop Profile', {
            'fields': ('full_name', 'phone', 'role', 'business', 'branch'),
        }),
    )


@admin.register(Business, site=admin_site)
class BusinessAdmin(admin.ModelAdmin):
    """Manage tenant businesses and their tax/default settings."""

    list_display = (
        'name', 'phone', 'email', 'is_active', 'tax_rate',
        'cashier_discount_cap', 'created_at',
    )
    list_filter = ('is_active',)
    search_fields = ('name', 'email', 'phone')
    fieldsets = (
        ('Business', {
            'fields': (
                'name', 'address', 'phone', 'email', 'logo', 'is_active',
            ),
        }),
        ('Financial defaults', {
            'fields': ('tax_rate', 'cashier_discount_cap'),
        }),
        ('Licensing', {
            'fields': ('max_users', 'max_branches'),
        }),
    )


# ── Organization ─────────────────────────────────────────────────────────────

@admin.register(Branch, site=admin_site)
class BranchAdmin(admin.ModelAdmin):
    list_display = ('name', 'business', 'phone', 'is_active')
    list_filter = ('business', 'is_active')
    search_fields = ('name', 'phone')


@admin.register(Category, site=admin_site)
class CategoryAdmin(admin.ModelAdmin):
    list_display = ('name', 'business', 'parent')
    list_filter = ('business',)
    search_fields = ('name',)


@admin.register(Brand, site=admin_site)
class BrandAdmin(admin.ModelAdmin):
    list_display = ('name', 'business')
    list_filter = ('business',)
    search_fields = ('name',)


@admin.register(Item, site=admin_site)
class ItemAdmin(admin.ModelAdmin):
    list_display = (
        'code', 'name', 'business', 'category', 'brand',
        'cost_price', 'selling_price', 'stock_quantity',
        'low_stock_threshold', 'is_active',
    )
    list_filter = ('business', 'category', 'brand', 'is_active')
    search_fields = ('code', 'name')
    readonly_fields = ('stock_quantity',)


@admin.register(StockLot, site=admin_site)
class StockLotAdmin(admin.ModelAdmin):
    list_display = (
        'item', 'branch', 'business', 'quantity_remaining',
        'unit_cost', 'source', 'received_at',
    )
    list_filter = ('business', 'branch', 'source')
    search_fields = ('item__code', 'item__name')


@admin.register(StockMovement, site=admin_site)
class StockMovementAdmin(admin.ModelAdmin):
    list_display = (
        'item', 'branch', 'business', 'type', 'quantity',
        'reference', 'created_by', 'created_at',
    )
    list_filter = ('business', 'branch', 'type')
    search_fields = ('item__code', 'reference')


@admin.register(LotAllocation, site=admin_site)
class LotAllocationAdmin(admin.ModelAdmin):
    list_display = ('stock_lot', 'sale_item', 'quantity', 'unit_cost')
    list_filter = ('business',)


# ── Customers ────────────────────────────────────────────────────────────────

@admin.register(Customer, site=admin_site)
class CustomerAdmin(admin.ModelAdmin):
    list_display = ('name', 'business', 'phone', 'nic')
    list_filter = ('business',)
    search_fields = ('name', 'phone', 'nic')


# ── Sales & payments ─────────────────────────────────────────────────────────

class SaleItemInline(admin.TabularInline):
    model = SaleItem
    extra = 0
    readonly_fields = ('fifo_cost',)


class InstallmentInline(admin.TabularInline):
    model = Installment
    extra = 0


class PaymentInline(admin.TabularInline):
    model = Payment
    extra = 0


@admin.register(Sale, site=admin_site)
class SaleAdmin(admin.ModelAdmin):
    list_display = (
        'invoice_no', 'business', 'branch', 'customer', 'total_cost',
        'down_payment', 'remaining_cost', 'status', 'created_at',
    )
    list_filter = ('business', 'branch', 'status', 'is_single_payment')
    search_fields = ('invoice_no', 'customer__name', 'customer__phone')
    inlines = (SaleItemInline, InstallmentInline, PaymentInline)
    readonly_fields = (
        'invoice_no', 'subtotal', 'discount_amount', 'tax_amount',
        'total_cost', 'remaining_cost',
    )


@admin.register(Installment, site=admin_site)
class InstallmentAdmin(admin.ModelAdmin):
    list_display = (
        'sale', 'number', 'due_date', 'amount', 'paid_amount',
        'is_paid', 'paid_date',
    )
    list_filter = ('business', 'is_paid')


@admin.register(Payment, site=admin_site)
class PaymentAdmin(admin.ModelAdmin):
    list_display = (
        'sale', 'installment', 'amount', 'method', 'cash_account',
        'received_by', 'created_at',
    )
    list_filter = ('business', 'method')


@admin.register(SeasonalDiscount, site=admin_site)
class SeasonalDiscountAdmin(admin.ModelAdmin):
    list_display = (
        'name', 'business', 'scope', 'discount_percentage',
        'start_date', 'end_date', 'is_active',
    )
    list_filter = ('business', 'scope', 'is_active')

    def is_active(self, obj):
        now = timezone.localdate()
        active = obj.start_date <= now <= obj.end_date and obj.is_active
        color = 'green' if active else 'red'
        return format_html('<span style="color:{0};">{1}</span>', color, active)

    is_active.short_description = 'Active today'


# ── Procurement ──────────────────────────────────────────────────────────────

@admin.register(Supplier, site=admin_site)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ('name', 'business', 'contact_person', 'phone', 'is_active')
    list_filter = ('business', 'is_active')
    search_fields = ('name', 'contact_person', 'phone')


class PurchaseItemInline(admin.TabularInline):
    model = PurchaseItem
    extra = 0


class PurchaseReceiptInline(admin.TabularInline):
    model = PurchaseReceipt
    extra = 0


@admin.register(Purchase, site=admin_site)
class PurchaseAdmin(admin.ModelAdmin):
    list_display = (
        'order_no', 'business', 'supplier', 'branch', 'status',
        'expected_delivery_date', 'created_at',
    )
    list_filter = ('business', 'branch', 'status')
    search_fields = ('order_no', 'supplier__name')
    inlines = (PurchaseItemInline, PurchaseReceiptInline)


@admin.register(PurchaseItem, site=admin_site)
class PurchaseItemAdmin(admin.ModelAdmin):
    list_display = (
        'purchase', 'item', 'quantity', 'received_quantity',
        'unit_cost', 'total',
    )
    list_filter = ('business',)


@admin.register(PurchaseReceipt, site=admin_site)
class PurchaseReceiptAdmin(admin.ModelAdmin):
    list_display = ('receipt_no', 'purchase', 'received_by', 'created_at')
    search_fields = ('receipt_no',)


# ── Bookkeeping ──────────────────────────────────────────────────────────────

@admin.register(CashAccount, site=admin_site)
class CashAccountAdmin(admin.ModelAdmin):
    list_display = ('name', 'business', 'type', 'opening_balance', 'is_active')
    list_filter = ('business', 'type', 'is_active')


@admin.register(ExpenseCategory, site=admin_site)
class ExpenseCategoryAdmin(admin.ModelAdmin):
    list_display = ('name', 'business', 'is_active')
    list_filter = ('business',)


@admin.register(Expense, site=admin_site)
class ExpenseAdmin(admin.ModelAdmin):
    list_display = (
        'description', 'business', 'category', 'amount',
        'expense_date', 'branch', 'paid_by',
    )
    list_filter = ('business', 'category', 'expense_date')
    search_fields = ('description',)


@admin.register(SupplierPayment, site=admin_site)
class SupplierPaymentAdmin(admin.ModelAdmin):
    list_display = (
        'supplier', 'business', 'amount', 'payment_date',
        'cash_account', 'paid_by',
    )
    list_filter = ('business', 'payment_date')


@admin.register(CapitalEntry, site=admin_site)
class CapitalEntryAdmin(admin.ModelAdmin):
    list_display = ('date', 'business', 'type', 'amount', 'note')
    list_filter = ('business', 'type', 'date')


@admin.register(RecurringExpense, site=admin_site)
class RecurringExpenseAdmin(admin.ModelAdmin):
    list_display = (
        'description', 'business', 'amount', 'frequency',
        'next_due_date', 'is_active',
    )
    list_filter = ('business', 'frequency', 'is_active')

@admin.register(Promotion, site=admin_site)
class PromotionAdmin(admin.ModelAdmin):
    list_display = ('name', 'type', 'value', 'is_active', 'starts_at', 'ends_at')
    search_fields = ('name', 'type')

@admin.register(Report, site=admin_site)
class ReportAdmin(admin.ModelAdmin):
    list_display = ('name', 'report_type', 'is_generated', 'is_active')
    search_fields = ('name', 'type')