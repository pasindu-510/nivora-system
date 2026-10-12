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

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and user.is_active
            and user.role in self.allowed_roles
        )


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
