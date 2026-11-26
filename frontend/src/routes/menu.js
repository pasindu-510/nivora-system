import {
  ROLES,
  ADMIN_MANAGER,
  BUSINESS_ADMINS,
  DASHBOARD_VIEWERS,
  STAFF,
  SUPER_ADMINS,
} from '../utils/permissions.js';

/**
 * Sidebar navigation model. `roles` drives menu filtering (spec 7.2) and must
 * stay aligned with the route guards in routes/index.jsx.
 *
 * Icons are 24x24 stroke path strings rendered by <Sidebar />.
 */
export const menuGroups = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', to: '/dashboard', icon: 'grid', roles: DASHBOARD_VIEWERS }],
  },
  {
    label: 'Sales',
    items: [
      { label: 'New Sale', to: '/sales/new', icon: 'cart', roles: STAFF },
      { label: 'Sales', to: '/sales', icon: 'receipt', roles: STAFF },
      { label: 'Installments', to: '/installments', icon: 'clock', roles: STAFF },
      { label: 'Installment Payments', to: '/installments/pay', icon: 'repeat', roles: STAFF },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { label: 'Products', to: '/items', icon: 'box', roles: STAFF },
      { label: 'Categories', to: '/categories', icon: 'folder', roles: ADMIN_MANAGER },
      { label: 'Brands', to: '/brands', icon: 'tag', roles: ADMIN_MANAGER },
    ],
  },
  {
    label: 'Stock',
    items: [
      { label: 'Stock In', to: '/stock/in', icon: 'box', roles: ADMIN_MANAGER },
      { label: 'Purchase Orders', to: '/stock/purchases', icon: 'clipboard', roles: ADMIN_MANAGER },
      { label: 'Receive Delivery', to: '/stock/receive', icon: 'download', roles: ADMIN_MANAGER },
      { label: 'Cost Lots (FIFO)', to: '/stock/lots', icon: 'layers', roles: ADMIN_MANAGER },
      { label: 'Movements', to: '/stock/movements', icon: 'swap', roles: ADMIN_MANAGER },
    ],
  },
  {
    label: 'Parties',
    items: [
      { label: 'Customers', to: '/customers', icon: 'users', roles: STAFF },
      { label: 'Suppliers', to: '/suppliers', icon: 'truck', roles: ADMIN_MANAGER },
      { label: 'Supplier Payments', to: '/suppliers/payments', icon: 'receipt', roles: ADMIN_MANAGER },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Expenses', to: '/expenses', icon: 'receipt', roles: ADMIN_MANAGER },
      { label: 'Recurring Expenses', to: '/expenses/recurring', icon: 'repeat', roles: ADMIN_MANAGER },
      { label: 'Expense Categories', to: '/expenses/categories', icon: 'folder', roles: ADMIN_MANAGER },
      { label: 'Promotions', to: '/promotions', icon: 'percent', roles: ADMIN_MANAGER },
      { label: 'Reports', to: '/reports', icon: 'chart', roles: ADMIN_MANAGER },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Manage Business', to: '/settings/manage-business', icon: 'store', roles: BUSINESS_ADMINS },
      { label: 'Finance Settings', to: '/settings/finance', icon: 'sliders', roles: BUSINESS_ADMINS },
      { label: 'Users & Roles', to: '/users', icon: 'userCog', roles: BUSINESS_ADMINS },
      { label: 'Branches', to: '/branches', icon: 'building', roles: BUSINESS_ADMINS },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Businesses', to: '/admin/businesses', icon: 'building', roles: SUPER_ADMINS },
      { label: 'Users', to: '/admin/users', icon: 'users', roles: SUPER_ADMINS },
    ],
  },
];

/**
 * Does `pathname` belong to this nav item?
 *
 * A plain `pathname === to` test would break nested routes (`/sales/123`
 * would light up nothing), so a segment-boundary prefix counts as a match.
 */
export function matchesMenuItem(pathname, to) {
  if (!pathname || !to) return false;
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * The single nav item that should render as active for `pathname`.
 *
 * `NavLink`'s built-in `isActive` is a segment-prefix match, so sibling routes
 * that share a parent both light up: on `/expenses/recurring` the "Expenses"
 * item and the "Recurring Expenses" item are *both* active. Resolving the
 * longest matching `to` keeps exactly one item highlighted and always picks
 * the most specific one, so `/sales/123` still marks "Sales" while
 * `/sales/new` marks "New Sale".
 */
export function activeMenuPath(groups, pathname) {
  let active = null;
  groups.forEach((group) => {
    group.items.forEach((item) => {
      if (!matchesMenuItem(pathname, item.to)) return;
      if (active === null || item.to.length > active.length) active = item.to;
    });
  });
  return active;
}

export default menuGroups;
