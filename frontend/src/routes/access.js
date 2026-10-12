import {
  ROLES,
  ADMIN_MANAGER,
  BUSINESS_ADMINS,
  DASHBOARD_VIEWERS,
  STAFF,
  SUPER_ADMINS,
} from '../utils/permissions.js';

/**
 * Route access matrix for all 22 routes (spec 7.1).
 * `roles: null` means any authenticated role.
 * Keys are route paths (with :param placeholders) matching routes/index.jsx.
 */
export const routeAccess = {
  '/login': null, // public
  '/dashboard': DASHBOARD_VIEWERS, // super_admin, business_admin, manager (not cashier)

  '/sales/new': STAFF,
  '/sales': STAFF,
  '/sales/:id': STAFF,
  '/installments': STAFF,
  '/customers': STAFF,
  '/items': STAFF,

  '/categories': ADMIN_MANAGER,
  '/brands': ADMIN_MANAGER,
  '/stock/purchases': ADMIN_MANAGER,
  '/stock/receive': ADMIN_MANAGER,
  '/stock/lots': ADMIN_MANAGER,
  '/stock/movements': ADMIN_MANAGER,
  '/suppliers': ADMIN_MANAGER,
  '/expenses': ADMIN_MANAGER,
  '/expenses/recurring': ADMIN_MANAGER,
  '/promotions': ADMIN_MANAGER,
  '/reports': ADMIN_MANAGER,

  '/settings/finance': BUSINESS_ADMINS,
  '/settings/manage-business': BUSINESS_ADMINS,
  '/users': BUSINESS_ADMINS,
  '/branches': BUSINESS_ADMINS,

  '/admin/businesses': SUPER_ADMINS,
  '/admin/users': SUPER_ADMINS,
};

/**
 * Pure helper: resolve allowed roles for a concrete pathname.
 * Falls back to "authenticated only" for unknown paths (guard still applies).
 * @param {string} pathname
 * @returns {readonly string[]|null}
 */
export function allowedRolesForPath(pathname) {
  if (routeAccess[pathname] !== undefined) return routeAccess[pathname];
  // Segment-wise match: /sales/42 -> /sales/:id
  var pathSegments = pathname.split('/').filter(function (s) {
    return s;
  });
  var match = Object.keys(routeAccess).find(function (pattern) {
    var patternSegments = pattern.split('/').filter(function (s) {
      return s;
    });
    if (patternSegments.length !== pathSegments.length) return false;
    if (!pattern.includes(':')) return false;
    return patternSegments.every(function (segment, index) {
      return segment.startsWith(':') || segment === pathSegments[index];
    });
  });
  return match ? routeAccess[match] : null;
}

/**
 * Role -> post-login landing path.
 *
 * Each entry is the first item of that role's primary workspace (the "first tab
 * of that user's dashboard"):
 * - super_admin    -> /admin/businesses — the first Platform item. /dashboard is
 *                    business-scoped (its summary/branch-sales 403 for a
 *                    business-less super admin, verified against the live API),
 *                    so the first Platform tab is their landing.
 * - business_admin -> /dashboard — first Overview item (manager+ API).
 * - manager        -> /dashboard — first Overview item (manager+ API).
 * - cashier        -> /sales/new — POS-first workspace; /dashboard is manager+
 *                    (403), /sales/new is the first Sales item the role can see.
 * Unknown/missing roles fall back to /dashboard in RoleIndexRedirect.
 */
export var LANDING_PATHS = {
  [ROLES.SUPER_ADMIN]: '/admin/businesses',
  [ROLES.BUSINESS_ADMIN]: '/dashboard',
  [ROLES.MANAGER]: '/dashboard',
  [ROLES.CASHIER]: '/sales/new',
};

export { ROLES };