"""Business logic services (spec section 5).

Contains the mutating rules that must stay consistent across
model boundaries:

* :func:`record_sale` — price computation, FIFO cost allocation,
  stock decrement, installment generation, payment recording.
* :func:`record_purchase_receipt` — stock-in, FIFO lot creation.
* :func:`record_stock_in` — one-step stock entry (purchase or opening stock).
* :func:`check_entry_date` — the per-business back-date limit.
* :func:`record_installment_payment` — installment/payment bookkeeping.
* :func:`next_sequence_number` — ``INV-`` / ``PO-`` / ``RCP-`` numbering.
* :func:`apply_seasonal_discount` — seasonal discount resolution.

All mutating functions run inside ``transaction.atomic``.
"""
from datetime import datetime, time, timedelta
from decimal import ROUND_DOWN, Decimal

from django.db import IntegrityError, transaction
from django.db.models import F, Sum
from django.db.models.functions import Length
from django.utils import timezone

from .models import (
    CashAccount,
    Expense,
    Installment,
    Item,
    LotAllocation,
    Payment,
    Purchase,
    PurchaseItem,
    PurchaseReceipt,
    PurchaseReceiptItem,
    Sale,
    SaleItem,
    SeasonalDiscount,
    StockLot,
    StockMovement,
    SupplierPayment,
)


# ── Back-dating ─────────────────────────────────────────────────────────────

def check_entry_date(business, value):
    """Validate a user-supplied entry date against the business limit.

    Returns the date when it is in the past, or ``None`` when it is omitted or
    today (meaning "now"). Raises ``ValueError`` for future or too-old dates.
    """
    today = timezone.localdate()
    if value is None or value == today:
        return None
    if value > today:
        raise ValueError('The date cannot be in the future.')
    limit = business.backdate_limit_days
    if limit is None:
        return value
    if limit == 0:
        raise ValueError('Back-dating is not enabled for this business.')
    earliest = today - timedelta(days=limit)
    if value < earliest:
        raise ValueError(f'The earliest date allowed is {earliest.isoformat()}.')
    return value


def start_of_day(day):
    """Aware datetime at local midnight of ``day``."""
    return timezone.make_aware(datetime.combine(day, time.min))


# ── Number sequencing ───────────────────────────────────────────────────────

def next_sequence_number(business, prefix, model, field='invoice_no', year=None):
    """Return the next human-facing sequence number for a business.

    Rendered as ``{PREFIX}-{year}-{seq:04d}``, the sequence counting
    documents of the same prefix inside the same calendar year.
    """
    year = year or timezone.now().year
    prefix_base = f'{prefix}-{year}-'
    # Order by length first: plain string ordering puts "…-10000" before
    # "…-9999", which made the sequence repeat after 9999 (B-09).
    last = (
        model.objects.filter(**{f'{field}__startswith': prefix_base})
        .annotate(_num_len=Length(field))
        .order_by('-_num_len', f'-{field}')
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


def _create_numbered(model, field, make_number, fields, attempts=5):
    """Create a row whose ``field`` is a sequence number, retrying on clashes.

    Two requests computing the next number at the same moment would both
    pick the same value; the unique constraint rejects the second insert.
    Each attempt runs in a savepoint so a clash can be retried with a fresh
    number without aborting the surrounding transaction (B-10).
    """
    for attempt in range(attempts):
        try:
            with transaction.atomic():
                return model.objects.create(**{field: make_number()}, **fields)
        except IntegrityError:
            if attempt == attempts - 1:
                raise


# ── FIFO engine (spec 5.1) ──────────────────────────────────────────────────

def _available_lots(business, item, branch=None, as_of=None):
    """Return open stock lots for an item ordered FIFO (oldest first).

    Rows are locked (``SELECT … FOR UPDATE``) so two concurrent sales cannot
    both consume the last units (B-10). When ``branch`` is given only that
    branch's lots are eligible: stock is physically per branch (B-07).
    ``as_of`` (a date) excludes stock that arrived after that day.
    """
    qs = StockLot.objects.select_for_update().filter(
        business=business, item=item, quantity_remaining__gt=0,
    )
    if branch is not None:
        qs = qs.filter(branch=branch)
    if as_of is not None:
        qs = qs.filter(received_at__lt=start_of_day(as_of + timedelta(days=1)))
    return list(qs.order_by('received_at', 'id'))


def allocate_fifo(business, item, quantity, branch=None, as_of=None):
    """Consume ``quantity`` of ``item`` from FIFO lots.

    Returns ``(allocations, unit_cost, ok)`` where ``allocations`` is a list
    of ``(lot, qty)`` and ``unit_cost`` is the weighted-average cost of the
    consumed stock. ``ok`` is False when insufficient stock exists.
    """
    lots = _available_lots(business, item, branch, as_of)
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
                installment_interval_days=30, cash_account=None,
                max_discount_percent=None, sale_date=None):
    """Create a sale with items, FIFO costs, installments and payments.

    ``lines`` is a list of ``{'item': Item, 'quantity': int}``, optionally
    with ``unit_price`` (the price charged, for back-dated sales).

    ``sale_date`` is a past date already validated by
    :func:`check_entry_date`; ``None`` means now.

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
    discount_rows = active_discount_rows(business, sale_date)

    for line in lines:
        item = line['item']
        quantity = int(line['quantity'])
        if quantity <= 0:
            raise ValueError('Quantity must be positive.')

        if line.get('unit_price') is not None:
            unit_price = Decimal(line['unit_price'])
        else:
            unit_price = apply_seasonal_discount(
                business, item, Decimal(item.selling_price), discount_rows,
            )
        line_total = unit_price * quantity
        subtotal += line_total

        allocations, fifo_cost, ok = allocate_fifo(
            business, item, quantity, branch, as_of=sale_date,
        )
        if not ok:
            when = f' on {sale_date.isoformat()}' if sale_date else ''
            raise ValueError(f'Insufficient stock for {item.code} at {branch.name}{when}.')
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

    # Spot-discount cap (cashiers): applies to both percent and flat amounts,
    # measured as a share of the subtotal.
    if max_discount_percent is not None and subtotal > 0:
        cap_amount = (subtotal * Decimal(max_discount_percent) / Decimal(100)).quantize(
            Decimal('0.01')
        )
        if discount_amount > cap_amount:
            raise ValueError(
                f'Discount exceeds the cashier limit of {Decimal(max_discount_percent):.2f}%. '
                'Ask a manager to apply it.'
            )

    taxable_base = subtotal - discount_amount
    tax_amount = (taxable_base * effective_tax_rate / Decimal(100)).quantize(Decimal('0.01'))
    total_cost = (taxable_base + tax_amount).quantize(Decimal('0.01'))

    sale_fields = dict(
        business=business, branch=branch, customer=customer,
        created_by=created_by,
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
    year = sale_date.year if sale_date else None
    sale = _create_numbered(
        Sale, 'invoice_no',
        lambda: next_sequence_number(business, 'INV', Sale, year=year), sale_fields
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
            note=f'Sale back-dated to {sale_date.isoformat()}' if sale_date else '',
        )

    # Financials.
    if is_single_payment:
        sale.down_payment = total_cost
        sale.remaining_cost = Decimal(0)
        sale.status = Sale.CLOSED  # fully paid at the till (B-21)
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
            first_due=sale_date or timezone.localdate(),
            interval_days=installment_interval_days,
        )
        if down > 0:
            Payment.objects.create(
                business=business, sale=sale, amount=down,
                method=Payment.CASH, cash_account=cash_account,
                received_by=created_by,
            )

    sale.save(update_fields=['down_payment', 'remaining_cost', 'status'])
    if sale_date:
        # created_at is auto_now_add, so it can only be moved with update().
        # Reports and bills all read it.
        moment = start_of_day(sale_date)
        Sale.objects.filter(pk=sale.pk).update(created_at=moment)
        Payment.objects.filter(sale=sale).update(created_at=moment)
        sale.created_at = moment
    return sale


def _create_installments(sale, *, remaining, count, first_due, interval_days):
    """Split ``remaining`` into ``count`` installments with cent rounding.

    The rounding remainder is distributed across the earlier installments
    so that the sum of installment amounts exactly equals ``remaining``.
    """
    # Round DOWN so the leftover is never negative; the spare cents are then
    # added to the earliest installments. Rounding half-up could make the
    # schedule sum exceed the balance with no way to correct it (B-15).
    base = (remaining / count).quantize(Decimal('0.01'), rounding=ROUND_DOWN)
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
                               received_by=None, payment_date=None):
    """Record a payment against an installment.

    Rules (blueprint section 5.5):

    a. ``amount`` must be positive.
    b. The selected installment must not already be fully settled
       (``paid_amount >= amount + interest_charged``).
    c. ``amount`` may not exceed the sale's outstanding balance, and the sale
       must not be cancelled.
    d. Allocation: the money goes to the SELECTED installment first, then to
       every other unsettled installment in number order (earlier ones
       included), so no part of a payment is ever left unapplied (B-17).
    e. One-time late interest: if the selected installment is still short of
       its principal after this payment and it has never been charged
       interest before, charge ``shortfall × rate%`` once (B-16).
    f. One ``Payment`` row is written for the whole amount.
    g. ``sale.remaining_cost`` -= amount, += interest. When it reaches 0 the
       sale becomes ``CLOSED`` (B-21).

    The sale and its installments are locked for the duration so concurrent
    payments cannot both pass the balance check (B-10).
    """
    amount = Decimal(amount)
    if amount <= 0:
        raise ValueError('Payment amount must be positive.')

    sale = Sale.objects.select_for_update().get(pk=installment.sale_id)
    if sale.status == Sale.CANCELLED:
        raise ValueError('This sale is cancelled; payments cannot be recorded.')

    all_installs = list(
        Installment.objects.select_for_update()
        .filter(sale=sale).order_by('number')
    )
    selected = next((i for i in all_installs if i.pk == installment.pk), None)
    if selected is None:
        raise ValueError('Installment not found on this sale.')
    if selected.is_paid or selected.paid_amount >= selected.amount + selected.interest_charged:
        raise ValueError('Installment already fully paid.')
    if amount > sale.remaining_cost:
        raise ValueError('Payment exceeds balance due.')

    if payment_date and payment_date < timezone.localdate(sale.created_at):
        raise ValueError('The payment date cannot be before the sale date.')
    paid_on = payment_date or timezone.localdate()
    remaining = amount
    order = [selected] + [i for i in all_installs if i.pk != selected.pk]
    for inst in order:
        if remaining <= 0:
            break
        due = inst.amount + inst.interest_charged - inst.paid_amount
        if due <= 0:
            continue
        take = min(due, remaining)
        inst.paid_amount += take
        remaining -= take
        if inst.paid_amount >= inst.amount + inst.interest_charged:
            inst.is_paid = True
            inst.paid_date = paid_on
        inst.save(update_fields=['paid_amount', 'is_paid', 'paid_date'])

    interest = Decimal('0.00')
    shortfall = selected.amount - selected.paid_amount
    rate = Decimal(business.installment_interest_rate or 0)
    if shortfall > 0 and rate > 0 and selected.interest_charged == 0:
        interest = (shortfall * rate / Decimal(100)).quantize(Decimal('0.01'))
        selected.interest_charged += interest
        selected.is_paid = False
        selected.paid_date = None
        selected.save(update_fields=['interest_charged', 'is_paid', 'paid_date'])

    payment = Payment.objects.create(
        business=business, sale=sale, installment=selected,
        amount=amount, method=method, cash_account=cash_account,
        received_by=received_by,
    )
    if payment_date:
        Payment.objects.filter(pk=payment.pk).update(
            created_at=start_of_day(payment_date)
        )

    sale.remaining_cost = (sale.remaining_cost - amount + interest).quantize(Decimal('0.01'))
    update_fields = ['remaining_cost']
    if sale.remaining_cost <= 0:
        sale.remaining_cost = Decimal('0.00')
        sale.status = Sale.CLOSED
        update_fields.append('status')
    sale.save(update_fields=update_fields)

    # Keep the caller's in-memory objects in sync with the database.
    installment.sale.remaining_cost = sale.remaining_cost
    installment.sale.status = sale.status
    return selected


# ── Purchase receipts (spec 5.4) ────────────────────────────────────────────

@transaction.atomic
def record_purchase_receipt(*, business, branch, purchase, received_by=None,
                            quantities=None, note='', received_date=None):
    """Receive stock for a purchase order.

    ``quantities`` maps ``PurchaseItem.id -> qty``; when omitted the full
    outstanding amount of each line is received. Creates a
    ``PurchaseReceipt`` with per-line ``PurchaseReceiptItem`` rows and FIFO
    stock lots, then updates the purchase status. ``received_date`` back-dates
    the lots; ``None`` means now.
    """
    quantities = quantities or {}
    # Serialize concurrent receipts of the same order (B-10).
    Purchase.objects.select_for_update().filter(pk=purchase.pk).first()
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

    receipt = _create_numbered(
        PurchaseReceipt, 'receipt_no',
        lambda: next_sequence_number(business, 'RCP', PurchaseReceipt, 'receipt_no'),
        dict(business=business, purchase=purchase, received_by=received_by, note=note),
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
            received_at=_received_at(received_date),
        )
        StockMovement.objects.create(
            business=business, branch=branch, item=pi.item,
            type=StockMovement.IN, quantity=qty,
            reference=receipt.receipt_no, created_by=received_by,
            note=_received_note(received_date),
        )
        update_last_cost(pi.item, pi.unit_cost, received_date)

    all_items = list(purchase.items.all())
    if all(pi.received_quantity >= pi.quantity for pi in all_items):
        purchase.status = Purchase.RECEIVED
    else:
        purchase.status = Purchase.PARTIALLY_RECEIVED
    purchase.save(update_fields=['status'])

    return purchase, receipt


# ── Stock in ────────────────────────────────────────────────────────────────

def _received_at(received_date):
    return start_of_day(received_date) if received_date else timezone.now()


def _received_note(received_date):
    return f'Received {received_date.isoformat()}' if received_date else ''


def update_last_cost(item, unit_cost, received_date=None):
    """Keep ``Item.cost_price`` equal to the most recently *received* cost.

    A back-dated entry must not overwrite the cost of stock that arrived later.
    """
    if received_date and StockLot.objects.filter(
        item=item,
        source__in=[StockLot.PURCHASE, StockLot.OPENING],
        received_at__gte=start_of_day(received_date + timedelta(days=1)),
    ).exists():
        return
    Item.objects.filter(pk=item.pk).update(cost_price=unit_cost)


@transaction.atomic
def record_stock_in(*, business, branch, source, lines, created_by,
                    supplier=None, paid_amount=0, cash_account=None,
                    note='', received_date=None):
    """Enter stock in one step.

    ``lines`` is a list of ``{'item', 'quantity', 'unit_cost',
    'selling_price'?}``. A ``PURCHASE`` creates a purchase order and receives it
    in full, so supplier payables stay correct; ``OPENING`` only creates lots.
    Returns ``(purchase, receipt)``, both ``None`` for opening stock.
    """
    total = sum((l['quantity'] * l['unit_cost'] for l in lines), Decimal(0))
    paid_amount = Decimal(paid_amount or 0)
    purchase = receipt = None

    if source == StockLot.PURCHASE:
        if paid_amount > total:
            raise ValueError('The paid amount is more than the total cost.')
        purchase = _create_numbered(
            Purchase, 'order_no',
            lambda: next_sequence_number(business, 'PO', Purchase, 'order_no'),
            dict(
                business=business, branch=branch, supplier=supplier,
                status=Purchase.ORDERED, notes=note, ordered_by=created_by,
                purchase_date=received_date,
            ),
        )
        for line in lines:
            PurchaseItem.objects.create(
                business=business, purchase=purchase, item=line['item'],
                quantity=line['quantity'], unit_cost=line['unit_cost'],
                total=line['quantity'] * line['unit_cost'],
            )
        purchase, receipt = record_purchase_receipt(
            business=business, branch=branch, purchase=purchase,
            received_by=created_by, note=note, received_date=received_date,
        )
        if paid_amount > 0:
            SupplierPayment.objects.create(
                business=business, supplier=supplier, purchase=purchase,
                amount=paid_amount, cash_account=cash_account,
                payment_date=received_date or timezone.localdate(),
                paid_by=created_by,
            )
    else:
        for line in lines:
            item, quantity = line['item'], line['quantity']
            StockLot.objects.create(
                business=business, branch=branch, item=item,
                quantity_total=quantity, quantity_remaining=quantity,
                unit_cost=line['unit_cost'], source=StockLot.OPENING,
                reference='OPENING', received_at=_received_at(received_date),
            )
            Item.objects.filter(pk=item.pk).update(
                stock_quantity=F('stock_quantity') + quantity
            )
            StockMovement.objects.create(
                business=business, branch=branch, item=item,
                type=StockMovement.IN, quantity=quantity,
                reference='OPENING', created_by=created_by,
                note=' · '.join(filter(None, [_received_note(received_date), note])),
            )
            update_last_cost(item, line['unit_cost'], received_date)

    for line in lines:
        if line.get('selling_price') is not None:
            Item.objects.filter(pk=line['item'].pk).update(
                selling_price=line['selling_price']
            )
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

def active_discount_rows(business, on_date=None):
    """Return the active seasonal discount rows for a business.

    Exposed separately so callers that need the discount for *many* items
    (e.g. the POS item list) can fetch the rows once and reuse them via
    :func:`discount_percent_from_rows` instead of re-querying per item.
    """
    if business is None:
        return []
    today = on_date or timezone.localdate()
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


def apply_seasonal_discount(business, item, unit_price, rows=None):
    """Return unit price after seasonal discount (for invoicing)."""
    if rows is None:
        rows = active_discount_rows(business)
    percent, _name = discount_percent_from_rows(rows, item)
    if percent:
        return (unit_price * (Decimal(1) - percent / Decimal(100))).quantize(Decimal('0.01'))
    return unit_price


# ── Cash / capital helpers ──────────────────────────────────────────────────

def account_balances(business):
    """Return each active cash account's current balance.

    balance = opening + sale payments in − expenses out − supplier payments out.
    """
    accounts = list(CashAccount.objects.filter(business=business, is_active=True))
    ids = [acct.id for acct in accounts]

    def _totals(queryset):
        # One grouped query per source instead of one per account (B-22).
        rows = (
            queryset.filter(cash_account_id__in=ids)
            .values('cash_account_id')
            .annotate(total=Sum('amount'))
        )
        return {row['cash_account_id']: row['total'] or Decimal(0) for row in rows}

    inflow = _totals(Payment.objects.filter(business=business))
    outflow = _totals(Expense.objects.filter(business=business))
    supplier_out = _totals(SupplierPayment.objects.all())

    balance_map = {}
    for acct in accounts:
        balance_map[acct.id] = (
            Decimal(acct.opening_balance)
            + inflow.get(acct.id, Decimal(0))
            - outflow.get(acct.id, Decimal(0))
            - supplier_out.get(acct.id, Decimal(0))
        ).quantize(Decimal('0.01'))
    return balance_map