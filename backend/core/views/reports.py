"""Reporting endpoints (spec 6.9).

- ``GET /api/reports/sales/?from=&to=&branch=&group_by=day|month``
- ``GET /api/reports/cash/?from=&to=``        (cash account balances)
- ``GET /api/reports/profit/?from=&to=``      (gross/net profit)
- ``GET /api/reports/stock/``                 (low-stock alert list)
- ``GET /api/dashboard/``                     (dashboard summary cards)
- ``GET /api/dashboard/summary/``             (dashboard summary for frontend)
- ``GET /api/dashboard/branch-sales/``        (per-branch sales for frontend)
"""
from collections import OrderedDict
from datetime import datetime, timedelta
from decimal import Decimal

from django.db.models import Count, F, Q, Sum
from django.db.models.functions import TruncDay, TruncMonth
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from ..models import (
    CapitalEntry,
    Expense,
    Installment,
    Item,
    Payment,
    Purchase,
    PurchaseItem,
    RecurringExpense,
    Sale,
    SaleItem,
    StockLot,
    Supplier,
    SupplierPayment,
)
from ..permissions import IsCashierOrAbove, IsManagerOrAbove
from ..services import account_balances


def _queryset_period(queryset, from_date, to_date):
    if from_date:
        queryset = queryset.filter(created_at__date__gte=from_date)
    if to_date:
        queryset = queryset.filter(created_at__date__lte=to_date)
    return queryset


class SalesReportView(APIView):
    """Sales summary grouped by day or month (manager+)."""

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        business = request.user.business
        group_by = request.query_params.get('group_by', 'day')

        qs = Sale.objects.filter(
            business=business, status__in=[Sale.CLOSED, Sale.OPEN]
        )
        qs = _queryset_period(
            qs,
            request.query_params.get('from'),
            request.query_params.get('to'),
        )
        branch = request.query_params.get('branch')
        if branch:
            qs = qs.filter(branch_id=branch)

        trunc_cls = TruncDay if group_by == 'day' else TruncMonth
        rows = (
            qs.annotate(period=trunc_cls('created_at'))
            .values('period')
            .annotate(
                invoice_count=Count('id'),
                subtotal=Sum('subtotal'),
                discount=Sum('discount_amount'),
                tax=Sum('tax_amount'),
                total=Sum('total_cost'),
            )
            .order_by('period')
        )

        # Gross profit per row: total cost of goods sold = Σ SaleItem.fifo_cost.
        item_rows = (
            SaleItem.objects.filter(sale__in=qs)
            .annotate(period=trunc_cls('sale__created_at'))
            .values('period')
            .annotate(cogs=Sum(F('fifo_cost') * F('quantity')))
        )
        cogs_by_period = {r['period']: r['cogs'] for r in item_rows}

        result = []
        for r in rows:
            period = r['period']
            cogs = cogs_by_period.get(period, Decimal(0)) or Decimal(0)
            total = r['total'] or Decimal(0)
            net_sales = (r['subtotal'] or Decimal(0)) - (r['discount'] or Decimal(0))
            result.append(
                OrderedDict(
                    date=period.date() if hasattr(period, 'date') else period,
                    invoice_count=r['invoice_count'],
                    subtotal=r['subtotal'],
                    discount=r['discount'],
                    tax=r['tax'],
                    total=total,
                    # Profit = net sales (after discount, before tax) - COGS.
                    profit=round(net_sales - cogs, 2),
                )
            )
        return Response(result)


class CashReportView(APIView):
    """Cash account balances (manager+)."""

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        return Response(account_balances(request.user.business))


class ProfitReportView(APIView):
    """Net profit = sales gross profit − expenses over the period (business_admin)."""

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        business = request.user.business
        from_date = request.query_params.get('from')
        to_date = request.query_params.get('to')

        sales_qs = _queryset_period(
            Sale.objects.filter(
                business=business, status__in=[Sale.OPEN, Sale.CLOSED]
            ),
            from_date, to_date,
        )
        totals = _sales_totals(sales_qs)

        expenses = Expense.objects.filter(business=business)
        if from_date:
            expenses = expenses.filter(expense_date__gte=from_date)
        if to_date:
            expenses = expenses.filter(expense_date__lte=to_date)
        expense_total = expenses.aggregate(total=Sum('amount'))['total'] or Decimal(0)

        gross_profit = totals['revenue'] - totals['cogs']
        return Response(
            OrderedDict(
                gross_sales=round(totals['gross_sales'], 2),
                discounts=round(totals['discounts'], 2),
                revenue=round(totals['revenue'], 2),
                cogs=round(totals['cogs'], 2),
                gross_profit=round(gross_profit, 2),
                interest_income=round(totals['interest'], 2),
                expenses=round(expense_total, 2),
                net_profit=round(gross_profit + totals['interest'] - expense_total, 2),
            )
        )


def _sales_totals(sales_qs):
    """Revenue figures for a set of (non-cancelled) sales.

    revenue  = Σ subtotal − Σ invoice discount   (tax excluded: it is owed to
               the tax authority, not income)
    cogs     = Σ fifo_cost × quantity of the sale lines
    interest = Σ late interest charged on the sales' installments
    (B-13: the old report counted cancelled sales and ignored discounts.)
    """
    agg = sales_qs.aggregate(
        gross=Sum('subtotal'), discounts=Sum('discount_amount'),
        plan=Sum('plan_interest'),
    )
    gross = agg['gross'] or Decimal(0)
    discounts = agg['discounts'] or Decimal(0)
    cogs = SaleItem.objects.filter(sale__in=sales_qs).aggregate(
        total=Sum(F('fifo_cost') * F('quantity'))
    )['total'] or Decimal(0)
    interest = Installment.objects.filter(sale__in=sales_qs).aggregate(
        total=Sum('interest_charged')
    )['total'] or Decimal(0)
    return {
        'gross_sales': gross,
        'discounts': discounts,
        'revenue': gross - discounts,
        'cogs': cogs,
        # Plan interest counts when the sale is made, like the sale itself.
        'interest': interest + (agg['plan'] or Decimal(0)),
    }


class StockReportView(APIView):
    """Items at or below the low-stock threshold (manager+)."""

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        business = request.user.business
        items = Item.objects.filter(
            business=business, is_active=True,
            stock_quantity__lte=F('low_stock_threshold'),
        ).order_by('stock_quantity')
        return Response(
            [
                OrderedDict(
                    id=i.id, code=i.code, name=i.name,
                    stock_quantity=i.stock_quantity,
                    low_stock_threshold=i.low_stock_threshold,
                )
                for i in items
            ]
        )


def received_value_of(purchase):
    """Σ received_quantity × unit_cost over a purchase's lines (B-14)."""
    return sum(
        (Decimal(i.received_quantity) * i.unit_cost for i in purchase.items.all()),
        Decimal(0),
    )


def _supplier_payables(business, as_of=None):
    """Value received from suppliers less payments made to them.

    Only stock actually received counts as a payable; draft and cancelled
    orders are not commitments. Shared by the balance sheet and ledger.
    """
    purchases = Purchase.objects.filter(business=business).exclude(
        status__in=[Purchase.DRAFT, Purchase.CANCELLED]
    ).prefetch_related('items')

    received_value = Decimal(0)
    for purchase in purchases:
        bought_on = purchase.purchase_date or purchase.created_at.date()
        if as_of is not None and bought_on > as_of:
            continue
        received_value += received_value_of(purchase)

    payments = SupplierPayment.objects.filter(business=business)
    if as_of is not None:
        payments = payments.filter(payment_date__lte=as_of)
    paid = payments.aggregate(total=Sum('amount'))['total'] or Decimal(0)
    return received_value - paid


class BalanceSheetReportView(APIView):
    """Assets, liabilities, and equity as of a date (manager+).

    Query param ``as_of`` (YYYY-MM-DD, default today). Everything is derived
    from real transactions, so the two sides are not forced to match: any
    gap shows up as ``difference`` for the owner to investigate.
    """

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        business = request.user.business
        as_of_raw = request.query_params.get('as_of')
        if as_of_raw:
            try:
                as_of = datetime.strptime(as_of_raw, '%Y-%m-%d').date()
            except ValueError:
                return Response(
                    {'detail': 'as_of must be YYYY-MM-DD.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            as_of = timezone.localdate()

        # ── Assets ────────────────────────────────────────────────────────
        cash = sum(account_balances(business).values(), Decimal(0))
        inventory = (
            StockLot.objects.filter(
                business=business, received_at__date__lte=as_of
            ).aggregate(total=Sum(F('quantity_remaining') * F('unit_cost')))['total']
            or Decimal(0)
        )
        receivables = (
            Sale.objects.filter(business=business, status=Sale.OPEN).aggregate(
                total=Sum('remaining_cost')
            )['total'] or Decimal(0)
        )
        total_assets = cash + inventory + receivables

        # ── Liabilities ────────────────────────────────────────────────────
        payables = _supplier_payables(business, as_of=as_of)
        total_liabilities = payables

        # ── Equity ────────────────────────────────────────────────────────
        capital_rows = CapitalEntry.objects.filter(
            business=business, date__lte=as_of
        ).values('type').annotate(total=Sum('amount'))
        owner_in = sum(
            (r['total'] for r in capital_rows if r['type'] == CapitalEntry.OWNER_IN),
            Decimal(0),
        )
        owner_out = sum(
            (r['total'] for r in capital_rows if r['type'] == CapitalEntry.OWNER_OUT),
            Decimal(0),
        )
        capital = owner_in - owner_out

        sales_qs = Sale.objects.filter(
            business=business,
            status__in=[Sale.OPEN, Sale.CLOSED],
            created_at__date__lte=as_of,
        )
        totals = _sales_totals(sales_qs)
        revenue = totals['revenue'] + totals['interest']
        cogs = totals['cogs']
        expenses = (
            Expense.objects.filter(
                business=business, expense_date__lte=as_of
            ).aggregate(total=Sum('amount'))['total'] or Decimal(0)
        )
        retained_earnings = revenue - cogs - expenses
        total_equity = capital + retained_earnings

        return Response(
            OrderedDict(
                as_of=as_of,
                assets=OrderedDict(
                    cash=round(cash, 2),
                    inventory=round(inventory, 2),
                    receivables=round(receivables, 2),
                    total=round(total_assets, 2),
                ),
                liabilities=OrderedDict(
                    supplier_payables=round(payables, 2),
                    total=round(total_liabilities, 2),
                ),
                equity=OrderedDict(
                    owner_capital=round(capital, 2),
                    retained_earnings=round(retained_earnings, 2),
                    total=round(total_equity, 2),
                ),
                total_liabilities_and_equity=round(
                    total_liabilities + total_equity, 2
                ),
                difference=round(total_assets - total_liabilities - total_equity, 2),
            )
        )


class CashFlowReportView(APIView):
    """Weekly cash forecast over the next 13 weeks (manager+).

    Inflows are unpaid installments falling due in each week. Outflows are
    projected occurrences of every active recurring expense. Recurring rows
    are advanced from ``next_due_date`` by their own ``interval_days``, so an
    overdue template still lands in the right future week.
    """

    permission_classes = [IsManagerOrAbove]

    WEEKS = 13

    def get(self, request):
        business = request.user.business
        try:
            weeks = int(request.query_params.get('weeks', self.WEEKS))
        except (TypeError, ValueError):
            weeks = self.WEEKS
        weeks = max(1, min(weeks, 52))

        start = timezone.localdate()
        end = start + timedelta(days=weeks * 7)
        buckets = [
            OrderedDict(
                week_start=start + timedelta(days=7 * i),
                inflows=Decimal(0),
                outflows=Decimal(0),
            )
            for i in range(weeks)
        ]

        def bucket_for(day):
            offset = (day - start).days
            if offset < 0 or offset >= weeks * 7:
                return None
            return buckets[offset // 7]

        # Inflows: installment amounts due inside the window.
        for inst in Installment.objects.filter(
            sale__business=business,
            due_date__gte=start,
            due_date__lt=end,
        ).exclude(sale__status=Sale.CANCELLED).select_related('sale'):
            outstanding = inst.amount + inst.interest_charged - inst.paid_amount
            if outstanding <= 0:
                continue
            bucket = bucket_for(inst.due_date)
            if bucket is not None:
                bucket['inflows'] += outstanding

        # Outflows: project each active recurring template forward.
        for rec in RecurringExpense.objects.filter(
            business=business, is_active=True
        ):
            step = max(1, rec.interval_days or 30)
            due = rec.next_due_date
            guard = 0
            # Skip stale occurrences so a long-overdue template still forecasts.
            while due < start and guard < 500:
                due += timedelta(days=step)
                guard += 1
            while due < end and guard < 1000:
                bucket = bucket_for(due)
                if bucket is not None:
                    bucket['outflows'] += rec.amount
                due += timedelta(days=step)
                guard += 1

        running = Decimal(0)
        for bucket in buckets:
            bucket['net'] = bucket['inflows'] - bucket['outflows']
            running += bucket['net']
            bucket['cumulative'] = running
            for key in ('inflows', 'outflows', 'net', 'cumulative'):
                bucket[key] = round(bucket[key], 2)

        return Response(
            OrderedDict(
                from_date=start,
                to_date=end,
                weeks=weeks,
                opening_balance=round(
                    sum(account_balances(business).values(), Decimal(0)), 2
                ),
                buckets=buckets,
                total_inflows=round(sum((b['inflows'] for b in buckets), Decimal(0)), 2),
                total_outflows=round(sum((b['outflows'] for b in buckets), Decimal(0)), 2),
                closing_balance=round(
                    sum(account_balances(business).values(), Decimal(0))
                    + sum((b['net'] for b in buckets), Decimal(0)),
                    2,
                ),
            )
        )


class TaxReportView(APIView):
    """VAT filing summary for a period (manager+).

    Only output tax is reported: the purchase models carry no VAT field, so
    there is no reliable input credit to net off. ``purchase_value`` is
    included for context only and is deliberately not subtracted.
    """

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        business = request.user.business
        from_date = request.query_params.get('from')
        to_date = request.query_params.get('to')

        sales_qs = _queryset_period(
            Sale.objects.filter(
                business=business, status__in=[Sale.OPEN, Sale.CLOSED]
            ),
            from_date,
            to_date,
        )
        rows = sales_qs.aggregate(
            invoice_count=Count('id'),
            subtotal=Sum('subtotal'),
            discount=Sum('discount_amount'),
            tax=Sum('tax_amount'),
            total=Sum('total_cost'),
        )
        subtotal = rows['subtotal'] or Decimal(0)
        discount = rows['discount'] or Decimal(0)
        tax_collected = rows['tax'] or Decimal(0)
        taxable_sales = subtotal - discount

        # Purchases received in the period — context, not an input credit.
        received_lines = PurchaseItem.objects.filter(
            purchase__business=business,
            received_quantity__gt=0,
        )
        if from_date or to_date:
            purchase_qs = Purchase.objects.filter(business=business)
            if from_date:
                purchase_qs = purchase_qs.filter(
                    Q(purchase_date__gte=from_date)
                    | Q(purchase_date__isnull=True, created_at__date__gte=from_date)
                )
            if to_date:
                purchase_qs = purchase_qs.filter(
                    Q(purchase_date__lte=to_date)
                    | Q(purchase_date__isnull=True, created_at__date__lte=to_date)
                )
            received_lines = received_lines.filter(purchase__in=purchase_qs)
        purchase_value = received_lines.aggregate(
            total=Sum(F('unit_cost') * F('received_quantity'))
        )['total'] or Decimal(0)

        return Response(
            OrderedDict(
                from_date=from_date or '',
                to_date=to_date or '',
                rate=str(business.tax_rate),
                invoice_count=rows['invoice_count'] or 0,
                gross_sales=round(subtotal, 2),
                discounts=round(discount, 2),
                taxable_sales=round(taxable_sales, 2),
                tax_collected=round(tax_collected, 2),
                purchase_value=round(purchase_value, 2),
                payable=round(tax_collected, 2),
            )
        )


class DashboardView(APIView):
    """Dashboard summary cards (all business roles)."""

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        business = request.user.business
        today = timezone.localdate()
        month_start = today.replace(day=1)

        today_sales = (
            Sale.objects.filter(
                business=business, created_at__date=today,
                status__in=[Sale.OPEN, Sale.CLOSED],
            ).aggregate(total=Sum('total_cost'))['total'] or Decimal(0)
        )
        month_sales = (
            Sale.objects.filter(
                business=business, created_at__date__gte=month_start,
                status__in=[Sale.OPEN, Sale.CLOSED],
            ).aggregate(total=Sum('total_cost'))['total'] or Decimal(0)
        )
        outstanding = (
            Sale.objects.filter(
                business=business, status=Sale.OPEN,
            ).aggregate(total=Sum('remaining_cost'))['total'] or Decimal(0)
        )
        low_stock_count = Item.objects.filter(
            business=business, is_active=True,
            stock_quantity__lte=F('low_stock_threshold'),
        ).count()
        expense_month = (
            Expense.objects.filter(
                business=business, expense_date__gte=month_start,
            ).aggregate(total=Sum('amount'))['total'] or Decimal(0)
        )

        return Response(
            OrderedDict(
                today_sales=round(today_sales, 2),
                month_sales=round(month_sales, 2),
                outstanding=round(outstanding, 2),
                low_stock_count=low_stock_count,
                expense_month=round(expense_month, 2),
            )
        )


class DashboardSummaryView(APIView):
    """Dashboard summary for frontend (all business roles).

    Returns OrderedDict with keys matching the frontend consume contract:
    - today_sales: Decimal rounded 2
    - low_stock_count: int
    - low_stock_items: list of OrderedDict {id, code, name, stock_quantity}
    - top_item: string name of best-selling item today by total units, or null
    - due_installments_count: int
    - due_installments_list: list of OrderedDict {id, customer_name, invoice_no, due_amount, due_date} (max 8)
    - open_sales: Decimal rounded 2
    """

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        business = request.user.business
        today = timezone.localdate()
        week_later = today + timedelta(days=7)

        # today_sales: sum of Sale.total_cost where business, created_at date == today, status in [OPEN, CLOSED]
        today_sales = (
            Sale.objects.filter(
                business=business,
                created_at__date=today,
                status__in=[Sale.OPEN, Sale.CLOSED],
            ).aggregate(total=Sum('total_cost'))['total'] or Decimal(0)
        )

        # low_stock_count: active Items where stock_quantity <= low_stock_threshold
        low_stock_items_qs = Item.objects.filter(
            business=business,
            is_active=True,
            stock_quantity__lte=F('low_stock_threshold'),
        ).order_by('stock_quantity')
        low_stock_count = low_stock_items_qs.count()

        # low_stock_items: list of OrderedDict {id, code, name, stock_quantity}
        low_stock_items = [
            OrderedDict(
                id=item.id,
                code=item.code,
                name=item.name,
                stock_quantity=item.stock_quantity,
            )
            for item in low_stock_items_qs
        ]

        # top_item: best-selling item today by total units
        top_item_qs = (
            SaleItem.objects.filter(
                sale__business=business,
                sale__created_at__date=today,
                sale__status__in=[Sale.OPEN, Sale.CLOSED],
            )
            .values('item__name')
            .annotate(total_qty=Sum('quantity'))
            .order_by('-total_qty')
            .first()
        )
        top_item = top_item_qs['item__name'] if top_item_qs else None

        # due_installments: unpaid Installments with due_date <= today + 7 days
        due_installments_qs = (
            Installment.objects.filter(
                sale__business=business,
                is_paid=False,
                due_date__lte=week_later,
            )
            .exclude(sale__status=Sale.CANCELLED)
            .select_related('sale', 'sale__customer')
            .order_by('due_date')
        )
        due_installments_count = due_installments_qs.count()

        # due_installments_list: sliced to 8
        due_installments_list = [
            OrderedDict(
                id=inst.id,
                customer_name=inst.sale.customer.name if inst.sale.customer else inst.sale.invoice_no,
                invoice_no=inst.sale.invoice_no,
                due_amount=round(inst.amount + inst.interest_charged - inst.paid_amount, 2),
                due_date=inst.due_date,
            )
            for inst in due_installments_qs[:8]
        ]

        # open_sales: sum of Sale.remaining_cost where business and status == OPEN
        open_sales = (
            Sale.objects.filter(
                business=business,
                status=Sale.OPEN,
            ).aggregate(total=Sum('remaining_cost'))['total'] or Decimal(0)
        )

        return Response(
            OrderedDict(
                today_sales=round(today_sales, 2),
                low_stock_count=low_stock_count,
                low_stock_items=low_stock_items,
                top_item=top_item,
                due_installments_count=due_installments_count,
                due_installments_list=due_installments_list,
                open_sales=round(open_sales, 2),
            )
        )


class DashboardBranchSalesView(APIView):
    """Per-branch sales for frontend (all business roles).

    Returns a plain JSON array of OrderedDict rows {branch, total}.
    Query params: start (YYYY-MM-DD), end (YYYY-MM-DD) — both optional.
    """

    permission_classes = [IsManagerOrAbove]

    def get(self, request):
        business = request.user.business
        start = request.query_params.get('start')
        end = request.query_params.get('end')

        qs = Sale.objects.filter(
            business=business,
            status__in=[Sale.OPEN, Sale.CLOSED],
        )
        if start:
            qs = qs.filter(created_at__date__gte=start)
        if end:
            qs = qs.filter(created_at__date__lte=end)

        rows = (
            qs.values('branch__name')
            .annotate(total=Sum('total_cost'))
            .order_by('-total')
        )

        result = [
            OrderedDict(
                branch=row['branch__name'],
                total=round(row['total'] or Decimal(0), 2),
            )
            for row in rows
            if row['total'] is not None and row['total'] > 0
        ]
        return Response(result)


class InstallmentDueView(APIView):
    """Overdue + due-soon unpaid installments (all business roles).

    Query param ``days`` (int, default 7): due-soon window.
    Returns installments where:
      - overdue: due_date < today
      - due-soon: today <= due_date <= today + days
    Unpaid filter: not is_paid or paid_amount < amount + interest_charged.
    Business-scoped, ordered by due_date then number.
    Response shape: { "results": [ {id, sale, invoice_no, customer, customer_name,
    customer_phone, due_date, amount, interest_charged, due_amount, is_paid, number} ] }
    """

    permission_classes = [IsCashierOrAbove]

    def get(self, request):
        business = request.user.business
        today = timezone.localdate()
        try:
            days = int(request.query_params.get('days', 7))
        except (TypeError, ValueError):
            days = 7
        window_end = today + timedelta(days=days)

        qs = (
            Installment.objects.filter(
                sale__business=business,
                due_date__lte=window_end,
            )
            .exclude(sale__status=Sale.CANCELLED)
            .select_related('sale', 'sale__customer')
            .order_by('due_date', 'number')
        )

        # Filter to unpaid: not is_paid or paid_amount < amount + interest_charged
        unpaid = []
        for inst in qs:
            if not inst.is_paid or inst.paid_amount < inst.amount + inst.interest_charged:
                unpaid.append(inst)

        results = [
            OrderedDict(
                id=inst.id,
                sale=inst.sale_id,
                invoice_no=inst.sale.invoice_no,
                customer=inst.sale.customer_id,
                customer_name=inst.sale.customer.name if inst.sale.customer else '',
                customer_phone=inst.sale.customer.phone if inst.sale.customer else '',
                due_date=inst.due_date,
                amount=inst.amount,
                interest_charged=inst.interest_charged,
                due_amount=round(inst.amount + inst.interest_charged - inst.paid_amount, 2),
                is_paid=inst.is_paid,
                number=inst.number,
            )
            for inst in unpaid
        ]

        return Response(OrderedDict(results=results))