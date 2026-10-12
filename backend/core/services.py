"""Business logic services (spec section 5).

Contains the mutating rules that must stay consistent across
model boundaries:

* :func:`record_sale` — price computation, FIFO cost allocation,
  stock decrement, installment generation, payment recording.
* :func:`record_purchase_receipt` — stock-in, FIFO lot creation.
* :func:`record_installment_payment` — installment/payment bookkeeping.
* :func:`next_sequence_number` — ``INV-`` / ``PO-`` / ``RCP-`` numbering.
* :func:`apply_seasonal_discount` — seasonal discount resolution.

All mutating functions run inside ``transaction.atomic``.
"""
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from .models import (
    CashAccount,
    Expense,
    Installment,
    LotAllocation,
    Payment,
    Purchase,
    PurchaseReceipt,
    PurchaseReceiptItem,
    Sale,
    SaleItem,
    SeasonalDiscount,
    StockLot,
    StockMovement,
)


# ── Number sequencing ───────────────────────────────────────────────────────

def next_sequence_number(business, prefix, model, field='invoice_no'):
    """Return the next human-facing sequence number for a business.

    Rendered as ``{PREFIX}-{year}-{seq:04d}``, the sequence counting
    documents of the same prefix inside the same calendar year.
    """
    year = timezone.now().year
    prefix_base = f'{prefix}-{year}-'
    last = (
        model.objects.filter(**{f'{field}__startswith': prefix_base})
        .order_by(f'-{field}')
        .first()
    )
    if last is None:
        seq = 1
    else:
        raw = getattr(last, field)
        try:
            seq = int(raw.rsplit('-', 1)[-1]) + 1
        except (ValueError, IndexError):
            seq = 1
    return f'{prefix_base}{seq:04d}'


# ── FIFO engine (spec 5.1) ──────────────────────────────────────────────────

def _available_lots(business, item):
    """Return open stock lots for an item ordered FIFO (oldest first)."""
    return list(
        StockLot.objects.filter(
            business=business, item=item, quantity_remaining__gt=0,
        ).order_by('received_at', 'id')
    )


def allocate_fifo(business, item, quantity):
    """Consume ``quantity`` of ``item`` from FIFO lots.

    Returns ``(allocations, unit_cost, ok)`` where ``allocations`` is a list
    of ``(lot, qty)`` and ``unit_cost`` is the weighted-average cost of the
    consumed stock. ``ok`` is False when insufficient stock exists.
    """
    lots = _available_lots(business, item)
    remaining = quantity
    allocations = []
    total_cost = Decimal(0)
    for lot in lots:
        take = min(lot.quantity_remaining, remaining)
        allocations.append((lot, take))
        total_cost += take * lot.unit_cost
        remaining -= take
        if remaining <= 0:
            break
    if remaining > 0:
        return [], Decimal(0), False
    unit_cost = total_cost / quantity
    return allocations, unit_cost.quantize(Decimal('0.01')), True


# ── Sale recording (spec 5.2) ───────────────────────────────────────────────

@transaction.atomic
def record_sale(*, business, branch, created_by, customer=None, lines,
                discount_type=Sale.PERCENT, discount_value=0,
                tax_rate=None, is_single_payment=True, down_payment=0,
                number_of_installments=0,
                installment_frequency=Sale.MONTHLY,
                installment_interval_days=30, cash_account=None):
    """Create a sale with items, FIFO costs, installments and payments.

    ``lines`` is a list of ``{'item': Item, 'quantity': int}``.

    Pricing (spec 4.4/5.2):

    * ``subtotal`` = Σ (unit_price × quantity), unit price after any
      applicable seasonal discount.
    * ``discount_amount`` — percent applies to subtotal; flat amount is
      clamped to subtotal.
    * ``tax_amount`` = (subtotal − discount_amount) × tax_rate/100.
    * ``total_cost`` = subtotal − discount_amount + tax_amount.

    Single-payment sales record one cash payment immediately. Installment
    sales collect ``down_payment`` and split the remaining balance into
    ``number_of_installments`` equal (rounded) installments.
    """
    effective_tax_rate = (
        Decimal(tax_rate or 0) if tax_rate is not None else Decimal(business.tax_rate)
    )

    subtotal = Decimal(0)
    prepared_lines = []

    for line in lines:
        item = line['item']
        quantity = int(line['quantity'])
        if quantity <= 0:
            raise ValueError('Quantity must be positive.')

        unit_price = apply_seasonal_discount(business, item, Decimal(item.selling_price))
        line_total = unit_price * quantity
        subtotal += line_total

        allocations, fifo_cost, ok = allocate_fifo(business, item, quantity)
        if not ok:
            raise ValueError(f'Insufficient stock for {item.code}.')
        prepared_lines.append({
            'item': item, 'quantity': quantity,
            'unit_price': unit_price, 'line_total': line_total,
            'fifo_cost': fifo_cost, 'allocations': allocations,
        })

    subtotal = subtotal.quantize(Decimal('0.01'))
    discount_value = Decimal(discount_value or 0)
    if discount_type == Sale.PERCENT:
        discount_amount = (subtotal * discount_value / Decimal(100)).quantize(Decimal('0.01'))
    else:
        discount_amount = min(discount_value, subtotal).quantize(Decimal('0.01'))

    taxable_base = subtotal - discount_amount
    tax_amount = (taxable_base * effective_tax_rate / Decimal(100)).quantize(Decimal('0.01'))
    total_cost = (taxable_base + tax_amount).quantize(Decimal('0.01'))

    sale = Sale.objects.create(
        business=business, branch=branch, customer=customer,
        created_by=created_by,
        invoice_no=next_sequence_number(business, 'INV', Sale),
        subtotal=subtotal,
        discount_type=discount_type,
        discount_value=discount_value,
        discount_amount=discount_amount,
        tax_rate=effective_tax_rate,
        tax_amount=tax_amount,
        total_cost=total_cost,
        is_single_payment=is_single_payment,
        down_payment=down_payment,
        number_of_installments=number_of_installments,
        remaining_cost=total_cost,
        installment_frequency=installment_frequency,
        installment_interval_days=installment_interval_days,
    )

    for prep in prepared_lines:
        sale_item = SaleItem.objects.create(
            business=business, sale=sale, item=prep['item'],
            quantity=prep['quantity'],
            unit_price=prep['unit_price'],
            line_total=prep['line_total'],
            fifo_cost=prep['fifo_cost'],
        )
        for lot, qty in prep['allocations']:
            LotAllocation.objects.create(
                business=business, stock_lot=lot, sale_item=sale_item,
                quantity=qty, unit_cost=lot.unit_cost,
            )
            lot.quantity_remaining = F('quantity_remaining') - qty
            lot.save(update_fields=['quantity_remaining'])

        item = prep['item']
        item.stock_quantity = F('stock_quantity') - prep['quantity']
        item.save(update_fields=['stock_quantity'])

        StockMovement.objects.create(
            business=business, branch=branch, item=item,
            type=StockMovement.SALE, quantity=-prep['quantity'],
            reference=sale.invoice_no, created_by=created_by,
        )

    # Financials.
    if is_single_payment:
        sale.down_payment = total_cost
        sale.remaining_cost = Decimal(0)
        Payment.objects.create(
            business=business, sale=sale, amount=total_cost,
            method=Payment.CASH, cash_account=cash_account,
            received_by=created_by,
        )
    else:
        down = Decimal(down_payment or 0)
        if down >= total_cost:
            raise ValueError('Down payment must be lower than total cost.')
        if number_of_installments <= 0:
            raise ValueError('Installment sales need a positive installment count.')
        sale.down_payment = down
        sale.remaining_cost = (total_cost - down).quantize(Decimal('0.01'))

        _create_installments(
            sale,
            remaining=sale.remaining_cost,
            count=number_of_installments,
            first_due=timezone.localdate(),
            interval_days=installment_interval_days,
        )
        if down > 0:
            Payment.objects.create(
                business=business, sale=sale, amount=down,
                method=Payment.CASH, cash_account=cash_account,
                received_by=created_by,
            )

    sale.save(update_fields=['down_payment', 'remaining_cost'])
    return sale


def _create_installments(sale, *, remaining, count, first_due, interval_days):
    """Split ``remaining`` into ``count`` installments with cent rounding.

    The rounding remainder is distributed across the earlier installments
    so that the sum of installment amounts exactly equals ``remaining``.
    """
    base = (remaining / count).quantize(Decimal('0.01'))
    sizes = [base] * count
    leftover = remaining - sum(sizes)
    leftover_cents = int((leftover * 100).to_integral_value())
    for i in range(count):
        if leftover_cents <= 0:
            break
        sizes[i] = (sizes[i] + Decimal('0.01')).quantize(Decimal('0.01'))
        leftover_cents -= 1

    rows = [
        Installment(
            business=sale.business, sale=sale, number=i + 1,
            due_date=first_due + timedelta(days=interval_days * (i + 1)),
            amount=amt,
        )
        for i, amt in enumerate(sizes)
    ]
    Installment.objects.bulk_create(rows)


@transaction.atomic
def record_installment_payment(*, business, installment, amount,
                               method=Payment.CASH, cash_account=None,
                               received_by=None):
    """Record a payment against an installment and re-check its status.

    New behavior:
    - a. amount <= 0 → ValueError('Payment amount must be positive.')
    - b. installment.is_paid → ValueError('Installment already fully paid.')
       (is_paid now means fully settled incl. interest).
    - c. REJECT overpayment beyond the whole sale:
       if amount > sale.remaining_cost → ValueError('Payment exceeds balance due.')
    - d. Roll-forward: apply the payment to installments ordered by number,
       STARTING at the selected installment.  For each installment:
         due = max(0, inst.amount + inst.interest_charged - inst.paid_amount)
         take = min(due, remaining)
         add to inst.paid_amount; set is_paid=True, paid_date when
         paid_amount >= inst.amount + inst.interest_charged;
         subtract from remaining; stop when remaining <= 0.
         Skip installments whose due <= 0.
    - e. One-time interest (ONLY on the SELECTED installment, only if still
       short of principal AFTER this payment):
         shortfall = max(0, installment.amount - installment.paid_amount)
         if shortfall > 0 and business.installment_interest_rate > 0:
           interest = (shortfall * Decimal(business.installment_interest_rate) / Decimal(100))
           .quantize(Decimal('0.01'))
           ; add to installment.interest_charged; this raises total owed.
       An exact full payment of the selected installment → shortfall 0 → NO interest.
    - f. Create ONE Payment row (total amount, method, cash_account, received_by,
       installment=installment, created_at=now).
    - g. sale.remaining_cost = F('remaining_cost') - amount + interest
       (net: payment reduces, interest raises).  USE F() expression and save
       with update_fields.  Keep @transaction.atomic.
    """
    from decimal import Decimal

    amount = Decimal(amount)
    if amount <= 0:
        raise ValueError('Payment amount must be positive.')
    if installment.is_paid:
        raise ValueError('Installment already fully paid.')

    # (c) Reject overpayment beyond the whole sale
    sale = installment.sale
    if hasattr(sale.remaining_cost, 'resolve_expression'):
        # An earlier payment on this same in-memory Sale instance left an
        # F() expression behind; re-read the stored value before comparing.
        sale.refresh_from_db(fields=['remaining_cost'])
    if amount > sale.remaining_cost:
        raise ValueError('Payment exceeds balance due.')

    # (d) Roll-forward: apply payment to installments starting at the selected one
    remaining = amount
    selected_number = installment.number

    # Get all installments for this sale ordered by number
    all_installs = list(
        installment.sale.installments.order_by('number')
    )

    interest = Decimal('0.00')  # track interest for step (g)

    for inst in all_installs:
        # Skip installments whose due <= 0
        due = max(0, inst.amount + inst.interest_charged - inst.paid_amount)
        if due <= 0:
            continue

        # START at the selected installment only
        if inst.number < selected_number:
            continue

        take = min(due, remaining)
        if take <= 0:
            break

        inst.paid_amount += take
        remaining -= take

        if inst.paid_amount >= inst.amount + inst.interest_charged:
            inst.is_paid = True
            inst.paid_date = timezone.localdate()

        inst.save(update_fields=['paid_amount', 'is_paid', 'paid_date'])

        if remaining <= 0:
            break

    # (e) One-time interest ONLY on the SELECTED installment,
    #     only if still short of principal AFTER this payment
    selected_inst = None
    for inst in all_installs:
        if inst.number == selected_number:
            selected_inst = inst
            break

    if selected_inst is not None:
        shortfall = max(0, selected_inst.amount - selected_inst.paid_amount)
        if shortfall > 0 and business.installment_interest_rate > 0:
            interest = (shortfall * Decimal(business.installment_interest_rate) / Decimal(
                100)).quantize(Decimal('0.01'))
            selected_inst.interest_charged += interest
            selected_inst.save(
                update_fields=['interest_charged', 'is_paid', 'paid_date']
            )

    # (f) Create ONE Payment row
    Payment.objects.create(
        business=business, sale=installment.sale, installment=selected_inst
        if selected_inst is not None else installment,
        amount=amount, method=method, cash_account=cash_account,
        received_by=received_by,
    )

    # (g) Update sale.remaining_cost: payment reduces, interest raises
    sale = installment.sale
    sale.remaining_cost = F('remaining_cost') - amount + interest
    sale.save(update_fields=['remaining_cost'])
    # Keep the in-memory value concrete: without this, the instance would
    # still hold the raw F() expression and any follow-up payment (or caller
    # assertion) reading it would see a CombinedExpression, not a number.
    sale.refresh_from_db(fields=['remaining_cost'])

    return selected_inst if selected_inst is not None else installment


# ── Purchase receipts (spec 5.4) ────────────────────────────────────────────

@transaction.atomic
def record_purchase_receipt(*, business, branch, purchase, received_by=None,
                            quantities=None, note=''):
    """Receive stock for a purchase order.

    ``quantities`` maps ``PurchaseItem.id -> qty``; when omitted the full
    outstanding amount of each line is received. Creates a
    ``PurchaseReceipt`` with per-line ``PurchaseReceiptItem`` rows and FIFO
    stock lots, then updates the purchase status.
    """
    quantities = quantities or {}
    outstanding = []
    for pi in purchase.items.all():
        remaining = pi.quantity - pi.received_quantity
        qty = quantities.get(pi.id, remaining)
        qty = min(qty, remaining)
        if qty <= 0:
            continue
        outstanding.append((pi, qty))

    if not outstanding:
        return purchase, None

    receipt = PurchaseReceipt.objects.create(
        business=business, purchase=purchase, received_by=received_by,
        receipt_no=next_sequence_number(
            business, 'RCP', PurchaseReceipt, 'receipt_no'
        ),
        note=note,
    )

    for pi, qty in outstanding:
        PurchaseReceiptItem.objects.create(
            business=business, receipt=receipt,
            purchase_item=pi, quantity=qty,
        )
        pi.received_quantity = F('received_quantity') + qty
        pi.save(update_fields=['received_quantity'])
        # Resolve the F() expression into a concrete int so the status
        # computation below can compare against the ordered quantity.
        pi.refresh_from_db()

        pi.item.stock_quantity = F('stock_quantity') + qty
        pi.item.save(update_fields=['stock_quantity'])
        pi.item.refresh_from_db()

        StockLot.objects.create(
            business=business, branch=branch, item=pi.item,
            quantity_total=qty, quantity_remaining=qty,
            unit_cost=pi.unit_cost, source=StockLot.PURCHASE,
            reference=receipt.receipt_no,
        )
        StockMovement.objects.create(
            business=business, branch=branch, item=pi.item,
            type=StockMovement.IN, quantity=qty,
            reference=receipt.receipt_no, created_by=received_by,
        )

    all_items = list(purchase.items.all())
    if all(pi.received_quantity >= pi.quantity for pi in all_items):
        purchase.status = Purchase.RECEIVED
    else:
        purchase.status = Purchase.PARTIALLY_RECEIVED
    purchase.save(update_fields=['status'])

    return purchase, receipt


# ── Expenses (spec 5.5) ─────────────────────────────────────────────────────

@transaction.atomic
def record_expense(*, business, branch, category, description, amount,
                   expense_date=None, cash_account=None, paid_by=None, note=''):
    """Record a business expense."""
    return Expense.objects.create(
        business=business, branch=branch, category=category,
        description=description, amount=amount,
        expense_date=expense_date or timezone.localdate(),
        cash_account=cash_account, paid_by=paid_by, note=note,
    )


# ── Seasonal discounts (spec 4.5) ───────────────────────────────────────────

def active_discount_rows(business):
    """Return the active seasonal discount rows for a business.

    Exposed separately so callers that need the discount for *many* items
    (e.g. the POS item list) can fetch the rows once and reuse them via
    :func:`discount_percent_from_rows` instead of re-querying per item.
    """
    if business is None:
        return []
    today = timezone.localdate()
    return list(SeasonalDiscount.objects.filter(
        business=business, is_active=True,
        start_date__lte=today, end_date__gte=today,
    ).order_by('id'))


def discount_percent_from_rows(rows, item):
    """Return ``(percent, name)`` for *item* using pre-fetched *rows*.

    Scope precedence follows insertion order: the first matching row wins,
    exactly as :func:`effective_discount_for` does.
    """
    for d in rows:
        if d.scope == SeasonalDiscount.ALL:
            return d.discount_percentage, d.name
        if d.scope == SeasonalDiscount.CATEGORY and d.target_id == item.category_id:
            return d.discount_percentage, d.name
        if d.scope == SeasonalDiscount.BRAND and d.target_id == item.brand_id:
            return d.discount_percentage, d.name
        if d.scope == SeasonalDiscount.ITEM and d.target_id == item.id:
            return d.discount_percentage, d.name
    return Decimal(0), ''


def effective_discount_for(business, item):
    """Return ``(percent, name)`` for an item under an active discount."""
    return discount_percent_from_rows(active_discount_rows(business), item)


def apply_seasonal_discount(business, item, unit_price):
    """Return unit price after seasonal discount (for invoicing)."""
    percent, _name = effective_discount_for(business, item)
    if percent:
        return (unit_price * (Decimal(1) - percent / Decimal(100))).quantize(Decimal('0.01'))
    return unit_price


# ── Cash / capital helpers ──────────────────────────────────────────────────

def account_balances(business):
    """Return each active cash account's current balance.

    balance = opening + sale payments in − expenses out − supplier payments out.
    """
    accounts = CashAccount.objects.filter(business=business, is_active=True)
    balance_map = {}
    for acct in accounts:
        opening = Decimal(acct.opening_balance)
        inflow = (
            Payment.objects.filter(business=business, cash_account=acct)
            .aggregate(total=Sum('amount'))['total']
            or Decimal(0)
        )
        outflow = (
            Expense.objects.filter(business=business, cash_account=acct)
            .aggregate(total=Sum('amount'))['total']
            or Decimal(0)
        )
        supplier_out = (
            acct.supplier_payments.aggregate(total=Sum('amount'))['total']
            or Decimal(0)
        )
        balance_map[acct.id] = (
            opening + inflow - outflow - supplier_out
        ).quantize(Decimal('0.01'))
    return balance_map