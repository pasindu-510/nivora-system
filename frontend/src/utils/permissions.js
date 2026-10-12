/**
 * Role constants and pure access-control helpers (spec 3.2 + 7.2).
 *
 * Everything in this module is pure and unit-testable — no React, no I/O.
 * Route guards and sidebar menu filtering both go through `canAccess`.
 */

export const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  BUSINESS_ADMIN: 'business_admin',
  MANAGER: 'manager',
  CASHIER: 'cashier',
});

export const ALL_ROLES = Object.freeze([
  ROLES.SUPER_ADMIN,
  ROLES.BUSINESS_ADMIN,
  ROLES.MANAGER,
  ROLES.CASHIER,
]);

/** Roles that manage catalog, stock, suppliers, sales, expenses, reports. */
export const ADMIN_MANAGER = Object.freeze([ROLES.BUSINESS_ADMIN, ROLES.MANAGER]);

/** Roles that work with sales/customers daily (excludes super_admin). */
export const STAFF = Object.freeze([ROLES.BUSINESS_ADMIN, ROLES.MANAGER, ROLES.CASHIER]);

/** Only the business owner role: users, branches, finance settings. */
export const BUSINESS_ADMINS = Object.freeze([ROLES.BUSINESS_ADMIN]);

/** Platform-level role: tenant businesses + all users (routes/menu under /admin). */
export const SUPER_ADMINS = Object.freeze([ROLES.SUPER_ADMIN]);

/** Roles that may open the dashboard (cashier gets a POS-first workspace). */
export const DASHBOARD_VIEWERS = Object.freeze([
  ROLES.SUPER_ADMIN,
  ROLES.BUSINESS_ADMIN,
  ROLES.MANAGER,
]);

export const ROLE_LABELS = Object.freeze({
  super_admin: 'Super Admin',
  business_admin: 'Business Admin',
  manager: 'Manager',
  cashier: 'Cashier',
});

export function roleLabel(role) {
  return ROLE_LABELS[role] || role || 'Unknown';
}

/**
 * Can `role` access a route/menu whose allowed roles are `allowedRoles`?
 * - empty/missing allow-list => any authenticated role
 * - missing role (no session) => denied
 * @param {readonly string[]|null|undefined} allowedRoles
 * @param {string|null|undefined} role
 * @returns {boolean}
 */
export function canAccess(allowedRoles, role) {
  if (!allowedRoles || allowedRoles.length === 0) return Boolean(role);
  if (!role) return false;
  return allowedRoles.includes(role);
}

/**
 * Filter sidebar menu groups down to items the role may see.
 * Empty groups are dropped entirely.
 * @template {{ items?: Array<{ roles?: readonly string[]|null|undefined }> }} T
 * @param {readonly T[]} menuGroups
 * @param {string|null|undefined} role
 * @returns {T[]}
 */
export function filterMenu(menuGroups, role) {
  if (!menuGroups) return [];
  return menuGroups
    .map((group) => ({
      ...group,
      items: (group.items || []).filter((item) => canAccess(item.roles, role)),
    }))
    .filter((group) => group.items.length > 0);
}
