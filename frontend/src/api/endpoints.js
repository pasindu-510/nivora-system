import { api } from './client.js';

/**
 * Typed endpoint helpers for every resource in system-spec.md section 6.
 * Each helper returns the Axios promise; callers (usually React Query
 * hooks) consume `response.data`.
 *
 * Naming mirrors the REST map: helper `sales.cancel(id)` -> POST /api/sales/<id>/cancel/
 */

/* ---------------------------------- Auth ---------------------------------- */
export const authApi = {
  /** POST /api/auth/login/ — returns { access, refresh } */
  login: (username, password) => api.post('/auth/login/', { username, password }),
  /** POST /api/auth/refresh/ */
  refresh: (refresh) => api.post('/auth/refresh/', { refresh }),
  /** GET /api/auth/me/ — user + business + branch + role */
  me: () => api.get('/auth/me/'),
};

/* -------------------------------- Dashboard -------------------------------- */
export const dashboardApi = {
  /** GET /api/dashboard/summary/ — today's sales, low stock, due installments, top items */
  summary: (params) => api.get('/dashboard/summary/', { params }),
  /** GET /api/dashboard/branch-sales/ — sales per branch for a date range */
  branchSales: (params) => api.get('/dashboard/branch-sales/', { params }),
  /** GET /api/dashboard/employee-sales/ — sales per seller for a date range */
  employeeSales: (params) => api.get('/dashboard/employee-sales/', { params }),
};

/* ------------------------------ Activity log ------------------------------ */
export const activityLogsApi = {
  /** GET /api/activity-logs/ — business admin only */
  list: (params) => api.get('/activity-logs/', { params }),
};

/* ------------------------------ Installments ------------------------------ */
export const installmentsApi = {
  /** GET /api/installments/due/ — overdue + due soon */
  due: (params) => api.get('/installments/due/', { params }),
};

/* -------------------------------- Branches -------------------------------- */
export const branchesApi = {
  list: (params) => api.get('/branches/', { params }),
  create: (data) => api.post('/branches/', data),
  update: (id, data) => api.put(`/branches/${id}/`, data),
  patch: (id, data) => api.patch(`/branches/${id}/`, data),
  remove: (id) => api.delete(`/branches/${id}/`),
};

/* ---------------------------------- Users --------------------------------- */
export const usersApi = {
  list: (params) => api.get('/users/', { params }),
  create: (data) => api.post('/users/', data),
  update: (id, data) => api.put(`/users/${id}/`, data),
  patch: (id, data) => api.patch(`/users/${id}/`, data),
  remove: (id) => api.delete(`/users/${id}/`),
};

/* ------------------------- Platform (super admin) ------------------------- */
export const adminApi = {
  businesses: {
    list: (params) => api.get('/admin/businesses/', { params }),
    create: (data) => api.post('/admin/businesses/', data),
    patch: (id, data) => api.patch(`/admin/businesses/${id}/`, data),
  },
  users: {
    list: (params) => api.get('/admin/users/', { params }),
    create: (data) => api.post('/admin/users/', data),
    patch: (id, data) => api.patch(`/admin/users/${id}/`, data),
  },
};

/* --------------------------------- Catalog -------------------------------- */
export const categoriesApi = {
  list: (params) => api.get('/categories/', { params }),
  create: (data) => api.post('/categories/', data),
  update: (id, data) => api.put(`/categories/${id}/`, data),
  patch: (id, data) => api.patch(`/categories/${id}/`, data),
  remove: (id) => api.delete(`/categories/${id}/`),
};

export const brandsApi = {
  list: (params) => api.get('/brands/', { params }),
  create: (data) => api.post('/brands/', data),
  update: (id, data) => api.put(`/brands/${id}/`, data),
  patch: (id, data) => api.patch(`/brands/${id}/`, data),
  remove: (id) => api.delete(`/brands/${id}/`),
};

export const itemsApi = {
  /** GET /api/items/ — filters: q, category, brand, low_stock */
  list: (params) => api.get('/items/', { params }),
  get: (id) => api.get(`/items/${id}/`),
  create: (data) => api.post('/items/', data),
  update: (id, data) => api.put(`/items/${id}/`, data),
  patch: (id, data) => api.patch(`/items/${id}/`, data),
  remove: (id) => api.delete(`/items/${id}/`),
};

/* ---------------------------------- Stock --------------------------------- */
export const stockMovementsApi = {
  /** GET /api/stock-movements/ — read-only audit trail */
  list: (params) => api.get('/stock-movements/', { params }),
  /** POST /api/items/<id>/adjust/ — signed-quantity manual correction (manager+) */
  create: (itemId, data) => api.post(`/items/${itemId}/adjust/`, data),
};

export const stockInsApi = {
  /** POST /api/stock-ins/ — one-step stock entry (manager+) */
  create: (data) => api.post('/stock-ins/', data),
};

export const stockLotsApi = {
  /** GET /api/stock-lots/ — qty remaining per cost lot, lot age */
  list: (params) => api.get('/stock-lots/', { params }),
};

/* -------------------------------- Suppliers ------------------------------- */
export const suppliersApi = {
  list: (params) => api.get('/suppliers/', { params }),
  get: (id) => api.get(`/suppliers/${id}/`),
  create: (data) => api.post('/suppliers/', data),
  update: (id, data) => api.put(`/suppliers/${id}/`, data),
  patch: (id, data) => api.patch(`/suppliers/${id}/`, data),
  remove: (id) => api.delete(`/suppliers/${id}/`),
  /** GET /api/suppliers/<id>/ledger/ — POs + payments + balance */
  ledger: (id) => api.get(`/suppliers/${id}/ledger/`),
};

/* ---------------------------- Purchase orders ---------------------------- */
export const purchasesApi = {
  /** GET /api/purchases/ — filter by status */
  list: (params) => api.get('/purchases/', { params }),
  get: (id) => api.get(`/purchases/${id}/`),
  create: (data) => api.post('/purchases/', data),
  update: (id, data) => api.put(`/purchases/${id}/`, data),
  patch: (id, data) => api.patch(`/purchases/${id}/`, data),
  remove: (id) => api.delete(`/purchases/${id}/`),
  /** POST /api/purchases/<id>/add_item/ — add a line to a draft/ordered PO */
  addItem: (id, data) => api.post(`/purchases/${id}/add_item/`, data),
  /** POST /api/purchases/<id>/remove_item/ — drop a not-yet-received line */
  removeItem: (id, data) => api.post(`/purchases/${id}/remove_item/`, data),
  /** POST /api/purchases/<id>/place/ — DRAFT -> ORDERED */
  place: (id, data) => api.post(`/purchases/${id}/place/`, data),
  /** POST /api/purchases/<id>/receive/ — partial/full delivery -> lots + stock IN */
  receive: (id, data) => api.post(`/purchases/${id}/receive/`, data),
  /** POST /api/purchases/<id>/cancel/ — before fully received */
  cancel: (id, data) => api.post(`/purchases/${id}/cancel/`, data),
};

/* -------------------------------- Customers ------------------------------- */
export const customersApi = {
  list: (params) => api.get('/customers/', { params }),
  get: (id) => api.get(`/customers/${id}/`),
  /** POST/PUT with multipart/form-data when a photo is attached */
  create: (data) => api.post('/customers/', data),
  update: (id, data) => api.put(`/customers/${id}/`, data),
  patch: (id, data) => api.patch(`/customers/${id}/`, data),
  remove: (id) => api.delete(`/customers/${id}/`),
  /** GET /api/customers/<id>/history/ — purchases + outstanding */
  history: (id) => api.get(`/customers/${id}/history/`),
  /** Manager and above: {reason} */
  blacklist: (id, data) => api.post(`/customers/${id}/blacklist/`, data),
  unblacklist: (id) => api.post(`/customers/${id}/unblacklist/`),
};

/* ---------------------------------- Sales --------------------------------- */
export const salesApi = {
  /** GET /api/sales/ — filters: branch, date, status */
  list: (params) => api.get('/sales/', { params }),
  /** POST /api/sales/ — items[], customer, discount, installment config */
  create: (data) => api.post('/sales/', data),
  /** GET /api/sales/<id>/ — items (incl. fifo_cost), installments, allocations */
  get: (id) => api.get(`/sales/${id}/`),
  /** POST /api/sales/<id>/pay_installment/ — record payment */
  payInstallment: (id, data) => api.post(`/sales/${id}/pay_installment/`, data),
  /** POST /api/sales/<id>/cancel/ — reverses lots, closes sale */
  cancel: (id, data) => api.post(`/sales/${id}/cancel/`, data),
};

export const paymentsApi = {
  /** GET /api/payments/ — money-in ledger */
  list: (params) => api.get('/payments/', { params }),
};

/* ------------------------- Discounts & promotions ------------------------ */
export const seasonalDiscountsApi = {
  list: (params) => api.get('/seasonal-discounts/', { params }),
  create: (data) => api.post('/seasonal-discounts/', data),
  update: (id, data) => api.put(`/seasonal-discounts/${id}/`, data),
  patch: (id, data) => api.patch(`/seasonal-discounts/${id}/`, data),
  remove: (id) => api.delete(`/seasonal-discounts/${id}/`),
};

/* --------------------- Bookkeeping: cash, capital, expenses --------------- */
export const cashAccountsApi = {
  list: (params) => api.get('/cash-accounts/', { params }),
  create: (data) => api.post('/cash-accounts/', data),
  update: (id, data) => api.put(`/cash-accounts/${id}/`, data),
  patch: (id, data) => api.patch(`/cash-accounts/${id}/`, data),
  remove: (id) => api.delete(`/cash-accounts/${id}/`),
};

export const capitalEntriesApi = {
  list: (params) => api.get('/capital-entries/', { params }),
  create: (data) => api.post('/capital-entries/', data),
  update: (id, data) => api.put(`/capital-entries/${id}/`, data),
  patch: (id, data) => api.patch(`/capital-entries/${id}/`, data),
  remove: (id) => api.delete(`/capital-entries/${id}/`),
};

export const expenseCategoriesApi = {
  list: (params) => api.get('/expense-categories/', { params }),
  create: (data) => api.post('/expense-categories/', data),
  update: (id, data) => api.put(`/expense-categories/${id}/`, data),
  patch: (id, data) => api.patch(`/expense-categories/${id}/`, data),
  remove: (id) => api.delete(`/expense-categories/${id}/`),
};

export const expensesApi = {
  /** GET /api/expenses/ — filters: branch, category, date range */
  list: (params) => api.get('/expenses/', { params }),
  create: (data) => api.post('/expenses/', data),
  update: (id, data) => api.put(`/expenses/${id}/`, data),
  patch: (id, data) => api.patch(`/expenses/${id}/`, data),
  remove: (id) => api.delete(`/expenses/${id}/`),
};

export const recurringExpensesApi = {
  list: (params) => api.get('/recurring-expenses/', { params }),
  create: (data) => api.post('/recurring-expenses/', data),
  update: (id, data) => api.put(`/recurring-expenses/${id}/`, data),
  patch: (id, data) => api.patch(`/recurring-expenses/${id}/`, data),
  remove: (id) => api.delete(`/recurring-expenses/${id}/`),
};

export const supplierPaymentsApi = {
  list: (params) => api.get('/supplier-payments/', { params }),
  create: (data) => api.post('/supplier-payments/', data),
  update: (id, data) => api.put(`/supplier-payments/${id}/`, data),
  patch: (id, data) => api.patch(`/supplier-payments/${id}/`, data),
  remove: (id) => api.delete(`/supplier-payments/${id}/`),
};

export const financeSettingsApi = {
  /** GET /api/finance-settings/ — { tax_rate: "10.00" } (tax_rate is a string) */
  get: () => api.get('/finance-settings/'),
  /** PATCH /api/finance-settings/ — e.g. { tax_rate: "15.00" }, 400 on out-of-range */
  update: (data) => api.patch('/finance-settings/', data),
};

/** /settings/manage-business: business identity (logo upload). */
export const businessApi = {
  /** GET /api/business/logo/ — { url, filename } or { none: true } */
  getLogo: () => api.get('/business/logo/'),
  /** POST /api/business/logo/ — multipart FormData { logo: File } */
  uploadLogo: (formData) => api.post('/business/logo/', formData),
  /** DELETE /api/business/logo/ */
  removeLogo: () => api.delete('/business/logo/'),
};

/* --------------------------------- Reports -------------------------------- */
export const reportsApi = {
  /** GET /api/reports/profit-loss/ — Revenue, FIFO COGS, Gross, Expenses, Net */
  profitLoss: (params) => api.get('/reports/profit-loss/', { params }),
  /** GET /api/reports/balance-sheet/ — as-of date */
  balanceSheet: (params) => api.get('/reports/balance-sheet/', { params }),
  /** GET /api/reports/cash-flow/ — 30/60/90d weekly buckets */
  cashFlow: (params) => api.get('/reports/cash-flow/', { params }),
  /** GET /api/reports/tax/ — VAT filing summary */
  tax: (params) => api.get('/reports/tax/', { params }),
};

export default {
  authApi,
  dashboardApi,
  installmentsApi,
  branchesApi,
  usersApi,
  adminApi,
  categoriesApi,
  brandsApi,
  itemsApi,
  stockMovementsApi,
  stockInsApi,
  stockLotsApi,
  suppliersApi,
  purchasesApi,
  customersApi,
  salesApi,
  paymentsApi,
  seasonalDiscountsApi,
  cashAccountsApi,
  capitalEntriesApi,
  expenseCategoriesApi,
  expensesApi,
  recurringExpensesApi,
  supplierPaymentsApi,
  financeSettingsApi,
  reportsApi,
};
