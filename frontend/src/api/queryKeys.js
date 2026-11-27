/**
 * Central React Query keys. Mutations invalidate these after writes so every
 * dependent list/detail view refreshes consistently.
 *
 * Pattern: root key per domain, detail keys nested under it, so
 * `invalidateQueries({ queryKey: qk.sales.root })` clears list + detail.
 */
export const qk = {
  auth: {
    me: ['auth', 'me'],
  },
  dashboard: {
    summary: (params) => ['dashboard', 'summary', params ?? {}],
    branchSales: (params) => ['dashboard', 'branch-sales', params ?? {}],
    employeeSales: (params) => ['dashboard', 'employee-sales', params ?? {}],
  },
  installments: {
    due: (params) => ['installments', 'due', params ?? {}],
  },
  branches: {
    root: ['branches'],
    list: (params) => ['branches', 'list', params ?? {}],
    detail: (id) => ['branches', 'detail', id],
  },
  users: {
    root: ['users'],
    list: (params) => ['users', 'list', params ?? {}],
    detail: (id) => ['users', 'detail', id],
  },
  categories: {
    root: ['categories'],
    list: (params) => ['categories', 'list', params ?? {}],
  },
  brands: {
    root: ['brands'],
    list: (params) => ['brands', 'list', params ?? {}],
  },
  items: {
    root: ['items'],
    list: (params) => ['items', 'list', params ?? {}],
    detail: (id) => ['items', 'detail', id],
  },
  stock: {
    movements: (params) => ['stock', 'movements', params ?? {}],
    lots: (params) => ['stock', 'lots', params ?? {}],
    root: ['stock'],
  },
  suppliers: {
    root: ['suppliers'],
    list: (params) => ['suppliers', 'list', params ?? {}],
    detail: (id) => ['suppliers', 'detail', id],
    ledger: (id) => ['suppliers', 'ledger', id],
  },
  purchases: {
    root: ['purchases'],
    list: (params) => ['purchases', 'list', params ?? {}],
    detail: (id) => ['purchases', 'detail', id],
  },
  customers: {
    root: ['customers'],
    list: (params) => ['customers', 'list', params ?? {}],
    detail: (id) => ['customers', 'detail', id],
    history: (id) => ['customers', 'history', id],
  },
  sales: {
    root: ['sales'],
    list: (params) => ['sales', 'list', params ?? {}],
    detail: (id) => ['sales', 'detail', id],
  },
  payments: {
    list: (params) => ['payments', 'list', params ?? {}],
  },
  promotions: {
    root: ['promotions'],
    list: (params) => ['promotions', 'list', params ?? {}],
  },
  finance: {
    cashAccounts: (params) => ['finance', 'cash-accounts', params ?? {}],
    capitalEntries: (params) => ['finance', 'capital-entries', params ?? {}],
    expenseCategories: (params) => ['finance', 'expense-categories', params ?? {}],
    expenses: (params) => ['finance', 'expenses', params ?? {}],
    recurringExpenses: (params) => ['finance', 'recurring-expenses', params ?? {}],
    supplierPayments: (params) => ['finance', 'supplier-payments', params ?? {}],
    settings: ['finance', 'settings'],
    root: ['finance'],
  },
  reports: {
    profitLoss: (params) => ['reports', 'profit-loss', params ?? {}],
    balanceSheet: (params) => ['reports', 'balance-sheet', params ?? {}],
    cashFlow: (params) => ['reports', 'cash-flow', params ?? {}],
    tax: (params) => ['reports', 'tax', params ?? {}],
    root: ['reports'],
  },
  admin: {
    businesses: {
      root: ['admin', 'businesses'],
      list: (params) => ['admin', 'businesses', 'list', params ?? {}],
    },
    users: {
      root: ['admin', 'users'],
      list: (params) => ['admin', 'users', 'list', params ?? {}],
    },
  },
};

export default qk;
