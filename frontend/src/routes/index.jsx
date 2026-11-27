import { Navigate, Route, Routes } from 'react-router-dom';
import RequireAuth from '../components/RequireAuth.jsx';
import RoleGuard from '../components/RoleGuard.jsx';
import AppLayout from '../components/AppLayout.jsx';

import LoginPage from '../pages/LoginPage.jsx';
import DashboardPage from '../pages/DashboardPage.jsx';
import NewSalePage from '../pages/NewSalePage.jsx';
import SalesListPage from '../pages/SalesListPage.jsx';
import SaleDetailPage from '../pages/SaleDetailPage.jsx';
import InstallmentsPage from '../pages/InstallmentsPage.jsx';
import InstallmentPaymentsPage from '../pages/InstallmentPaymentsPage.jsx';
import InstallmentCalculatorPage from '../pages/InstallmentCalculatorPage.jsx';
import ActivityLogPage from '../pages/ActivityLogPage.jsx';
import CustomersPage from '../pages/CustomersPage.jsx';
import ItemsPage from '../pages/ItemsPage.jsx';
import CategoriesPage from '../pages/CategoriesPage.jsx';
import BrandsPage from '../pages/BrandsPage.jsx';
import StockPurchasesPage from '../pages/StockPurchasesPage.jsx';
import StockReceivePage from '../pages/StockReceivePage.jsx';
import StockInPage from '../pages/StockInPage.jsx';
import StockLotsPage from '../pages/StockLotsPage.jsx';
import StockMovementsPage from '../pages/StockMovementsPage.jsx';
import SuppliersPage from '../pages/SuppliersPage.jsx';
import SupplierPaymentsPage from '../pages/SupplierPaymentsPage.jsx';
import ExpensesPage from '../pages/ExpensesPage.jsx';
import RecurringExpensesPage from '../pages/RecurringExpensesPage.jsx';
import ExpenseCategoriesPage from '../pages/ExpenseCategoriesPage.jsx';
import FinanceSettingsPage from '../pages/FinanceSettingsPage.jsx';
import PromotionsPage from '../pages/PromotionsPage.jsx';
import ReportsPage from '../pages/ReportsPage.jsx';
import UsersPage from '../pages/UsersPage.jsx';
import BranchesPage from '../pages/BranchesPage.jsx';
import ManageBusinessPage from '../pages/ManageBusinessPage.jsx';
import AdminBusinessesPage from '../pages/AdminBusinessesPage.jsx';
import AdminUsersPage from '../pages/AdminUsersPage.jsx';
import NotFoundPage from '../pages/NotFoundPage.jsx';

import {
  ADMIN_MANAGER,
  BUSINESS_ADMINS,
  DASHBOARD_VIEWERS,
  STAFF,
  SUPER_ADMINS,
} from '../utils/permissions.js';
import { LANDING_PATHS } from './access.js';
import { useAuth } from '../context/AuthContext.jsx';

/** Guarded child route: RoleGuard renders the in-layout 403 page when denied. */
function guarded(roles, element) {
  if (!roles) return element;
  return <RoleGuard roles={roles}>{element}</RoleGuard>;
}

/** Index route: each role lands on the first item of its workspace (see LANDING_PATHS). */
function RoleIndexRedirect() {
  const { user } = useAuth();
  const role = user && user.role;
  return <Navigate to={LANDING_PATHS[role] || '/dashboard'} replace />;
}

/**
 * All routes from spec 7.1.
 * /login is public; everything else sits behind RequireAuth + AppLayout
 * (role-aware sidebar/topbar) with per-route RoleGuard checks.
 */
export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<RoleIndexRedirect />} />

        <Route path="/dashboard" element={guarded(DASHBOARD_VIEWERS, <DashboardPage />)} />

        {/* Sales — all staff roles */}
        <Route path="/sales/new" element={guarded(STAFF, <NewSalePage />)} />
        <Route path="/sales" element={guarded(STAFF, <SalesListPage />)} />
        <Route path="/sales/:id" element={guarded(STAFF, <SaleDetailPage />)} />
        <Route path="/installments" element={guarded(STAFF, <InstallmentsPage />)} />
        <Route path="/installments/pay" element={guarded(STAFF, <InstallmentPaymentsPage />)} />
        <Route path="/installments/calculator" element={guarded(STAFF, <InstallmentCalculatorPage />)} />

        {/* Customers & catalog */}
        <Route path="/customers" element={guarded(STAFF, <CustomersPage />)} />
        <Route path="/items" element={guarded(STAFF, <ItemsPage />)} />
        <Route path="/categories" element={guarded(ADMIN_MANAGER, <CategoriesPage />)} />
        <Route path="/brands" element={guarded(ADMIN_MANAGER, <BrandsPage />)} />

        {/* Stock — admin/manager */}
        <Route path="/stock/in" element={guarded(ADMIN_MANAGER, <StockInPage />)} />
        <Route path="/stock/purchases" element={guarded(ADMIN_MANAGER, <StockPurchasesPage />)} />
        <Route path="/stock/receive" element={guarded(ADMIN_MANAGER, <StockReceivePage />)} />
        <Route path="/stock/lots" element={guarded(ADMIN_MANAGER, <StockLotsPage />)} />
        <Route path="/stock/movements" element={guarded(ADMIN_MANAGER, <StockMovementsPage />)} />
        <Route path="/suppliers" element={guarded(ADMIN_MANAGER, <SuppliersPage />)} />
        <Route path="/suppliers/payments" element={guarded(ADMIN_MANAGER, <SupplierPaymentsPage />)} />

        {/* Finance — admin/manager */}
        <Route path="/expenses" element={guarded(ADMIN_MANAGER, <ExpensesPage />)} />
        <Route path="/expenses/recurring" element={guarded(ADMIN_MANAGER, <RecurringExpensesPage />)} />
        <Route path="/expenses/categories" element={guarded(ADMIN_MANAGER, <ExpenseCategoriesPage />)} />
        <Route path="/promotions" element={guarded(ADMIN_MANAGER, <PromotionsPage />)} />
        <Route path="/reports" element={guarded(ADMIN_MANAGER, <ReportsPage />)} />

        {/* Administration — business admin only */}
        <Route path="/settings/finance" element={guarded(BUSINESS_ADMINS, <FinanceSettingsPage />)} />
        <Route path="/settings/manage-business" element={guarded(BUSINESS_ADMINS, <ManageBusinessPage />)} />
        <Route path="/users" element={guarded(BUSINESS_ADMINS, <UsersPage />)} />
        <Route path="/branches" element={guarded(BUSINESS_ADMINS, <BranchesPage />)} />
        <Route path="/activity-log" element={guarded(BUSINESS_ADMINS, <ActivityLogPage />)} />

        {/* Platform — super admin only */}
        <Route path="/admin/businesses" element={guarded(SUPER_ADMINS, <AdminBusinessesPage />)} />
        <Route path="/admin/users" element={guarded(SUPER_ADMINS, <AdminUsersPage />)} />
        <Route path="/admin" element={<Navigate to="/admin/businesses" replace />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}