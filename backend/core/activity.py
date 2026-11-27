"""Audit trail of edits, deletions and cancellations (ActivityLog).

Only changes to existing records are logged: creations already carry their
author where it matters (sales, payments, stock movements).
"""
from django.db import models, transaction

from .models import (
    ActivityLog,
    Branch,
    Brand,
    CapitalEntry,
    CashAccount,
    Category,
    Customer,
    Expense,
    ExpenseCategory,
    Item,
    Purchase,
    RecurringExpense,
    SeasonalDiscount,
    Supplier,
    SupplierPayment,
    User,
)

#: Which models are audited by :class:`ActivityLogMixin`, and under what name.
RECORD_TYPES = {
    Branch: 'BRANCH',
    Brand: 'BRAND',
    CapitalEntry: 'CAPITAL_ENTRY',
    CashAccount: 'CASH_ACCOUNT',
    Category: 'CATEGORY',
    Customer: 'CUSTOMER',
    Expense: 'EXPENSE',
    ExpenseCategory: 'EXPENSE_CATEGORY',
    Item: 'PRODUCT',
    Purchase: 'PURCHASE',
    RecurringExpense: 'RECURRING_EXPENSE',
    SeasonalDiscount: 'PROMOTION',
    Supplier: 'SUPPLIER',
    SupplierPayment: 'SUPPLIER_PAYMENT',
    User: 'USER',
}

# Never worth reporting as a change.
IGNORED_FIELDS = {'id', 'business', 'created_at', 'updated_at', 'last_login'}


def log_activity(user, action, record_type, *, record_id=None, label='',
                 details='', business=None):
    """Store one entry. ``user`` is the logged-in account doing the change."""
    business = business or user.business
    if business is None:
        return
    ActivityLog.objects.create(
        business=business,
        # A user may delete their own account: keep the name, drop the link.
        user=user if User.objects.filter(pk=user.pk).exists() else None,
        username=user.username,
        role=user.role,
        action=action,
        record_type=record_type,
        record_id=record_id,
        label=str(label)[:200],
        details=details,
    )


def label_of(instance):
    """A name a person recognises even after the record is gone."""
    for attr in ('invoice_no', 'order_no', 'code', 'username', 'name', 'title'):
        value = getattr(instance, attr, None)
        if value:
            name = getattr(instance, 'name', None)
            return f'{value} — {name}' if attr == 'code' and name else str(value)
    amount = getattr(instance, 'amount', None)
    if amount is not None:
        note = getattr(instance, 'description', '') or getattr(instance, 'note', '')
        return f'{amount} {note}'.strip()
    return str(instance)


def snapshot(instance):
    """Readable value of every stored field, to compare before and after."""
    values = {}
    for field in instance._meta.concrete_fields:
        if field.name in IGNORED_FIELDS:
            continue
        value = getattr(instance, field.name)
        if field.name == 'password':
            values['password'] = value
        elif isinstance(field, models.FileField):
            values[field.name] = value.name or ''
        else:
            text = '' if value is None else str(value)
            values[field.name] = text if len(text) <= 80 else f'{text[:77]}...'
    return values


def describe_changes(before, after):
    """``"selling price: 150.00 → 200.00; ..."``; empty when nothing changed."""
    parts = []
    for name, old in before.items():
        new = after.get(name)
        if new == old:
            continue
        title = name.replace('_', ' ')
        if name == 'password':
            parts.append('password changed')
        elif name in ('id_card_photo', 'image', 'logo'):
            parts.append(f'{title} changed')
        else:
            parts.append(f'{title}: {old or "(empty)"} → {new or "(empty)"}')
    return '; '.join(parts)


class ActivityLogMixin:
    """Logs update and delete on any viewset whose model is in RECORD_TYPES."""

    @transaction.atomic
    def perform_update(self, serializer):
        instance = serializer.instance
        record_type = RECORD_TYPES.get(type(instance))
        before = snapshot(instance) if record_type else None
        super().perform_update(serializer)
        if not record_type:
            return
        details = describe_changes(before, snapshot(serializer.instance))
        if details:
            log_activity(
                self.request.user, ActivityLog.EDIT, record_type,
                record_id=instance.pk, label=label_of(serializer.instance),
                details=details,
            )

    @transaction.atomic
    def perform_destroy(self, instance):
        record_type = RECORD_TYPES.get(type(instance))
        # Read these first: Django clears the pk on delete.
        record_id, label = instance.pk, label_of(instance)
        business = instance.business
        super().perform_destroy(instance)
        if record_type:
            log_activity(
                self.request.user, ActivityLog.DELETE, record_type,
                record_id=record_id, label=label, business=business,
            )
