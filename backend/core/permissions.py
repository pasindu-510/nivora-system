"""Role-based permission classes (spec section 6).

Roles are checked against ``RoleConstants`` on the authenticated user.
Super admins are intentionally excluded from business API permissions:
they manage businesses exclusively through Django Admin.
"""
from rest_framework.permissions import BasePermission

from .models import RoleConstants


class HasRole(BasePermission):
    """Allow access only to users whose role is in ``allowed_roles``."""

    allowed_roles = ()
    message = 'You do not have permission to perform this action.'

    def has_permission(self, request, view):
        user = request.user
        if not (
            user
            and user.is_authenticated
            and user.is_active
            and user.role in self.allowed_roles
        ):
            return False
        # A deactivated business locks out all of its staff, including
        # sessions that were already logged in (B-19).
        business = getattr(user, 'business', None)
        if business is not None and not business.is_active:
            self.message = 'This business account is deactivated.'
            return False
        return True


class IsSuperAdmin(HasRole):
    """Global super admin (Django Admin scope)."""

    allowed_roles = (RoleConstants.SUPER_ADMIN,)


class IsBusinessAdmin(HasRole):
    """business_admin only: users, branches, finance settings."""

    allowed_roles = (RoleConstants.BUSINESS_ADMIN,)


class IsManagerOrAbove(HasRole):
    """business_admin or manager: catalog, stock, suppliers, POs, reports."""

    allowed_roles = RoleConstants.MANAGER_AND_ABOVE


class IsCashierOrAbove(HasRole):
    """Any business role: sales, customers, installment collection."""

    allowed_roles = RoleConstants.BUSINESS_ROLES
