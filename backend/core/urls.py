"""Core URL routes: /api/auth/*, all business routers, reports, dashboard.

Full API map (spec section 6):

    POST  /api/auth/login/            JWT login
    POST  /api/auth/refresh/          JWT refresh
    GET   /api/auth/me/               current user profile
    GET   /api/health/                public liveness probe (offline detection)
    CRUD  /api/branches/              business branches
    CRUD  /api/categories/            product categories
    CRUD  /api/brands/                product brands
    CRUD  /api/items/                 items (code unique per tenant)
    CRUD  /api/customers/             customers
    GET   /api/customers/{id}/history/  purchase history + outstanding
    CRUD  /api/suppliers/             suppliers
    GET   /api/suppliers/{id}/ledger/  supplier statement + balance owed
    CRUD  /api/purchases/             purchase orders
    POST  /api/purchases/{id}/add_item/       add a line
    POST  /api/purchases/{id}/remove_item/    remove a line (unreceived)
    POST  /api/purchases/{id}/place/          DRAFT -> ORDERED
    POST  /api/purchases/{id}/receive/        receive stock (creates lots)
    POST  /api/purchases/{id}/cancel/         cancel (if not received)
    POST  /api/stock-ins/             one-step stock entry (manager+)
    GET   /api/stock-lots/            FIFO lot registry (manager+)
    GET   /api/stock-movements/       stock audit trail (manager+)
    POST  /api/items/{id}/adjust/     manual stock adjustment (manager+)
    CRUD  /api/sales/                 sales (create triggers FIFO + installments)
    POST  /api/sales/{id}/pay_installment/   pay an installment
    POST  /api/sales/{id}/cancel/     cancel sale (admin/manager only)
    GET   /api/payments/              payment registry
    GET   /api/installments/due/      overdue + due-soon installments
    CRUD  /api/cash-accounts/         cash/bank accounts
    CRUD  /api/expense-categories/    expense categories
    CRUD  /api/expenses/              expenses
    CRUD  /api/supplier-payments/     supplier payments
    CRUD  /api/capital-entries/       owner capital in/out
    CRUD  /api/recurring-expenses/    recurring expense schedule
    CRUD  /api/seasonal-discounts/    seasonal discounts
    GET   /api/reports/sales/         sales report (day/month)
    GET   /api/reports/cash/          cash account balances
    GET   /api/reports/profit/        gross/net profit
    GET   /api/reports/profit-loss/   profit & loss (frontend contract)
    GET   /api/reports/balance-sheet/ assets/liabilities/equity as-of date
    GET   /api/reports/cash-flow/     weekly 13-week cash forecast
    GET   /api/reports/tax/           VAT filing summary
    GET   /api/reports/stock/         low-stock alert list
    GET   /api/dashboard/             dashboard summary cards
    GET   /api/dashboard/summary/     dashboard summary (frontend contract)
    GET   /api/dashboard/branch-sales/  per-branch sales (frontend contract)
    GET   /api/finance-settings/      business_admin: own-business tax rate
    PATCH /api/finance-settings/      update tax rate (0-100, own tenant only)
    CRUD  /api/admin/businesses/      super_admin: tenant provisioning
    CRUD  /api/admin/users/           super_admin: user management
    CRUD  /api/users/                 business_admin: own-business staff only
"""
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views.admin import BusinessAdminViewSet, UserAdminViewSet
from .views.auth import LoginView, MeView, RefreshView
from .views.bookkeeping import (
    BusinessFinanceSettingsView,
    CapitalEntryViewSet,
    CashAccountViewSet,
    ExpenseCategoryViewSet,
    ExpenseViewSet,
    RecurringExpenseViewSet,
    SupplierPaymentViewSet,
)
from .views.branches import BranchViewSet
from .views.catalog import BrandViewSet, CategoryViewSet, ItemViewSet
from .views.customers import CustomerViewSet
from .views.discounts import SeasonalDiscountViewSet
from .views.reports import (
    BalanceSheetReportView,
    CashFlowReportView,
    CashReportView,
    DashboardBranchSalesView,
    DashboardSummaryView,
    DashboardView,
    InstallmentDueView,
    ProfitReportView,
    SalesReportView,
    StockReportView,
    TaxReportView,
)
from .views.sales import PaymentViewSet, SaleViewSet
from .views.stock import StockInView, StockLotViewSet, StockMovementViewSet
from .views.suppliers import PurchaseViewSet, SupplierViewSet
from .views.users import BusinessUserViewSet
from .views.business_logo import BusinessLogoView
from .views.health import HealthView

router = DefaultRouter()
router.register('branches', BranchViewSet, basename='branch')
router.register('categories', CategoryViewSet, basename='category')
router.register('brands', BrandViewSet, basename='brand')
router.register('items', ItemViewSet, basename='item')
router.register('customers', CustomerViewSet, basename='customer')
router.register('suppliers', SupplierViewSet, basename='supplier')
router.register('purchases', PurchaseViewSet, basename='purchase')
router.register('stock-lots', StockLotViewSet, basename='stocklot')
router.register('stock-movements', StockMovementViewSet, basename='stockmovement')
router.register('sales', SaleViewSet, basename='sale')
router.register('payments', PaymentViewSet, basename='payment')
router.register('cash-accounts', CashAccountViewSet, basename='cashaccount')
router.register('expense-categories', ExpenseCategoryViewSet, basename='expensecategory')
router.register('expenses', ExpenseViewSet, basename='expense')
router.register('supplier-payments', SupplierPaymentViewSet, basename='supplierpayment')
router.register('capital-entries', CapitalEntryViewSet, basename='capitalentry')
router.register('recurring-expenses', RecurringExpenseViewSet, basename='recurringexpense')
router.register('seasonal-discounts', SeasonalDiscountViewSet, basename='seasonaldiscount')
router.register('users', BusinessUserViewSet, basename='user')

admin_router = DefaultRouter()
admin_router.register('businesses', BusinessAdminViewSet, basename='admin-business')
admin_router.register('users', UserAdminViewSet, basename='admin-user')

auth_urlpatterns = [
    path('login/', LoginView.as_view(), name='api-login'),
    path('refresh/', RefreshView.as_view(), name='api-refresh'),
    path('me/', MeView.as_view(), name='api-me'),
]

report_urlpatterns = [
    path('sales/', SalesReportView.as_view(), name='report-sales'),
    path('cash/', CashReportView.as_view(), name='report-cash'),
    path('profit/', ProfitReportView.as_view(), name='report-profit'),
    path('profit-loss/', ProfitReportView.as_view(), name='report-profit-loss'),
    path('balance-sheet/', BalanceSheetReportView.as_view(), name='report-balance-sheet'),
    path('cash-flow/', CashFlowReportView.as_view(), name='report-cash-flow'),
    path('tax/', TaxReportView.as_view(), name='report-tax'),
    path('stock/', StockReportView.as_view(), name='report-stock'),
]

urlpatterns = [
    path('health/', HealthView.as_view(), name='health'),
    path('stock-ins/', StockInView.as_view(), name='stock-in'),
    path('auth/', include(auth_urlpatterns)),
    path('reports/', include(report_urlpatterns)),
    path('dashboard/', DashboardView.as_view(), name='dashboard'),
    path('dashboard/summary/', DashboardSummaryView.as_view(), name='dashboard-summary'),
    path('dashboard/branch-sales/', DashboardBranchSalesView.as_view(), name='dashboard-branch-sales'),
    path('installments/due/', InstallmentDueView.as_view(), name='installments-due'),
    path('finance-settings/', BusinessFinanceSettingsView.as_view(), name='finance-settings'),
    path('business/logo/', BusinessLogoView.as_view(), name='business-logo'),
    path('admin/', include(admin_router.urls)),
    path('', include(router.urls)),
]