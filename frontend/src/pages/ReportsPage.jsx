import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { reportsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, toDateInputValue } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import PageHeader from '../components/PageHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Icon from '../components/Icon.jsx';

/* --------------------------------- tabs ----------------------------------- */
const TABS = [
  { id: 'profit-loss', label: 'Profit & loss', icon: 'chart' },
  { id: 'balance-sheet', label: 'Balance sheet', icon: 'building' },
  { id: 'cash-flow', label: 'Cash flow', icon: 'layers' },
  { id: 'tax', label: 'VAT / tax', icon: 'percent' },
];

const WEEK_CHOICES = [4, 13, 26];

/* ------------------------------- helpers ---------------------------------- */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** "2026-09-28" -> "28 Sep" without timezone shifting. */
function labelDay(value) {
  if (!value) return '—';
  const raw = String(value);
  const iso = raw.length >= 10 ? raw.slice(0, 10) : raw;
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function compactLkr(value) {
  const n = num(value);
  const abs = Math.abs(n);
  if (abs >= 1000000) return `LKR ${(n / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `LKR ${(n / 1000).toFixed(0)}K`;
  return `LKR ${n.toFixed(0)}`;
}

function amountTone(value) {
  const n = num(value);
  if (n > 0) return 'text-emerald-600';
  if (n < 0) return 'text-rose-600';
  return 'text-slate-600';
}

function percentOf(part, whole) {
  const base = num(whole);
  if (!base) return '—';
  return `${((num(part) / base) * 100).toFixed(1)}%`;
}

function defaultPeriod() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29); // last 30 days including today
  return { from: toDateInputValue(start), to: toDateInputValue(end) };
}

const CHART_TOOLTIP = {
  borderRadius: 10,
  border: '1px solid #e2e8f0',
  fontSize: 13,
  boxShadow: '0 8px 24px -12px rgba(15,23,42,0.25)',
};

/* ------------------------------ shared bits -------------------------------- */
function ErrorBanner({ error, retry }) {
  return (
    <div className="rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
      This report could not be loaded — {apiErrorMessage(error)}{' '}
      {retry ? (
        <button type="button" onClick={retry} className="underline underline-offset-2">
          Retry
        </button>
      ) : null}
    </div>
  );
}

function SkeletonBlock({ rows = 4 }) {
  return (
    <div className="card p-5">
      <div className="h-4 w-1/3 animate-pulse rounded bg-slate-100" aria-hidden="true" />
      <div className="mt-4 space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" aria-hidden="true" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-slate-100" aria-hidden="true" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LineRow({ label, hint, value, tone, strong }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-slate-100 py-2.5 first:border-t-0">
      <span className="min-w-0">
        <span className={strong ? 'block text-sm font-bold text-slate-900' : 'block text-sm text-slate-600'}>
          {label}
        </span>
        {hint ? <span className="mt-0.5 block text-xs text-slate-500">{hint}</span> : null}
      </span>
      <span
        className={`shrink-0 tabular-nums ${
          strong ? 'text-base font-extrabold text-slate-900' : `text-sm font-semibold ${tone || 'text-slate-700'}`
        }`}
      >
        {formatLKR(value)}
      </span>
    </div>
  );
}

function PanelCard({ title, subtitle, children }) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-bold text-slate-900">{title}</h2>
      {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/* ------------------------------ profit & loss ------------------------------ */
function ProfitLossPanel({ data, loading, error, retry, period }) {
  if (loading) return <SkeletonBlock />;
  if (error) return <ErrorBanner error={error} retry={retry} />;
  const report = data || {};
  const net = num(report.net_profit);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Revenue" value={report.revenue} currency tone="brand" hint="Invoiced line totals" />
        <StatCard
          label="Cost of goods sold"
          value={report.cogs}
          currency
          hint={`${percentOf(report.cogs, report.revenue)} of revenue`}
        />
        <StatCard
          label="Gross profit"
          value={report.gross_profit}
          currency
          tone={num(report.gross_profit) >= 0 ? 'positive' : 'danger'}
          hint={`${percentOf(report.gross_profit, report.revenue)} margin`}
        />
        <StatCard
          label="Net profit"
          value={report.net_profit}
          currency
          tone={net >= 0 ? 'positive' : 'danger'}
          hint="After expenses"
        />
      </div>

      <PanelCard
        title="Statement"
        subtitle={`${labelDay(period.from) || 'Start'} to ${labelDay(period.to) || 'today'}`}
      >
        <LineRow label="Revenue" value={report.revenue} />
        <LineRow label="Cost of goods sold (FIFO)" value={report.cogs} />
        <LineRow label="Gross profit" value={report.gross_profit} strong />
        <LineRow label="Expenses" value={report.expenses} />
        <LineRow label="Net profit" value={report.net_profit} tone={amountTone(net)} strong />
        <p className="mt-3 text-xs text-slate-500">
          Cost of goods sold is the FIFO lot cost of every sold line, so gross profit reflects the real
          cost of the units that were sold rather than purchase prices.
        </p>
      </PanelCard>
    </div>
  );
}

/* ------------------------------ balance sheet ------------------------------ */
function BalanceSheetPanel({ data, loading, error, retry, asOf }) {
  if (loading) return <SkeletonBlock rows={6} />;
  if (error) return <ErrorBanner error={error} retry={retry} />;
  const report = data || {};
  const assets = report.assets || {};
  const liabilities = report.liabilities || {};
  const equity = report.equity || {};
  const difference = num(report.difference);
  const balanced = Math.abs(difference) < 0.01;

  return (
    <div className="space-y-6">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-control border px-4 py-3 text-sm font-medium ${
          balanced
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-amber-200 bg-amber-50 text-amber-800'
        }`}
      >
        <span>
          {balanced
            ? 'Assets equal liabilities plus equity.'
            : `Assets and liabilities plus equity differ by ${formatLKR(difference)} — worth investigating.`}
        </span>
        <span className="badge bg-white text-slate-700">As of {labelDay(report.as_of || asOf)}</span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <PanelCard title="Assets" subtitle="What the business owns">
          <LineRow label="Cash" value={assets.cash} />
          <LineRow label="Inventory" value={assets.inventory} hint="Remaining FIFO lot value" />
          <LineRow label="Customer receivables" value={assets.receivables} hint="Open invoices" />
          <LineRow label="Total assets" value={assets.total} strong />
        </PanelCard>

        <PanelCard title="Liabilities" subtitle="What the business owes">
          <LineRow label="Supplier payables" value={liabilities.supplier_payables} hint="Received stock, unpaid" />
          <LineRow label="Total liabilities" value={liabilities.total} strong />
          <p className="mt-3 text-xs text-slate-500">
            Only stock already received counts as a payable. Draft and cancelled purchase orders are
            not commitments.
          </p>
        </PanelCard>

        <PanelCard title="Equity" subtitle="Owner capital and retained profit">
          <LineRow label="Owner capital" value={equity.owner_capital} hint="Contributions less drawings" />
          <LineRow label="Retained earnings" value={equity.retained_earnings} tone={amountTone(equity.retained_earnings)} />
          <LineRow label="Total equity" value={equity.total} strong />
          <div className="mt-3 border-t border-slate-100 pt-2.5">
            <LineRow label="Liabilities + equity" value={report.total_liabilities_and_equity} strong />
          </div>
        </PanelCard>
      </div>
    </div>
  );
}

/* -------------------------------- cash flow -------------------------------- */
function CashFlowPanel({ data, loading, error, retry, weeks, setWeeks }) {
  if (loading) return <SkeletonBlock rows={6} />;
  if (error) return <ErrorBanner error={error} retry={retry} />;
  const report = data || {};
  const buckets = Array.isArray(report.buckets) ? report.buckets : [];
  const chartRows = buckets.map((bucket) => ({
    week: labelDay(bucket.week_start),
    inflows: num(bucket.inflows),
    outflows: num(bucket.outflows),
    net: num(bucket.net),
    cumulative: num(bucket.cumulative),
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Opening balance" value={report.opening_balance} currency tone="brand" hint="Cash on hand today" />
        <StatCard label="Expected inflows" value={report.total_inflows} currency hint="Unpaid installments" />
        <StatCard label="Expected outflows" value={report.total_outflows} currency hint="Recurring expenses" />
        <StatCard
          label="Projected closing"
          value={report.closing_balance}
          currency
          tone={num(report.closing_balance) >= 0 ? 'positive' : 'danger'}
          hint="At the end of the window"
        />
      </div>

      <section className="card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Weekly forecast</h2>
            <p className="text-xs text-slate-500">
              {labelDay(report.from_date)} to {labelDay(report.to_date)} · running balance in blue
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-control bg-slate-100 p-1">
            {WEEK_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setWeeks(choice)}
                aria-pressed={weeks === choice}
                className={
                  weeks === choice
                    ? 'rounded-control bg-white px-3 py-1.5 text-xs font-bold text-slate-900 shadow-sm'
                    : 'rounded-control px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900'
                }
              >
                {choice} weeks
              </button>
            ))}
          </div>
        </div>

        {chartRows.length ? (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartRows} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="week"
                  tick={{ fill: '#64748b', fontSize: 12 }}
                  axisLine={{ stroke: '#e2e8f0' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  width={80}
                  tickFormatter={compactLkr}
                />
                <Tooltip
                  formatter={(value, name) => [formatLKR(value), name]}
                  contentStyle={CHART_TOOLTIP}
                />
                <Bar dataKey="inflows" name="Inflows" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Bar dataKey="outflows" name="Outflows" fill="#f43f5e" radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  name="Running balance"
                  stroke="#1b62ef"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyState
            title="No forecast rows"
            description="Weekly buckets appear once there are unpaid installments or active recurring expenses to project."
            icon={<Icon name="layers" className="size-6" />}
          />
        )}
      </section>

      <PanelCard title="Week by week" subtitle="Installments due in, recurring expenses due out">
        {chartRows.length ? (
          <div className="-mx-5 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-2 font-semibold">Week starting</th>
                  <th className="px-5 py-2 text-right font-semibold">Inflows</th>
                  <th className="px-5 py-2 text-right font-semibold">Outflows</th>
                  <th className="px-5 py-2 text-right font-semibold">Net</th>
                  <th className="px-5 py-2 text-right font-semibold">Running</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {chartRows.map((row, index) => (
                  <tr key={`${row.week}-${index}`}>
                    <td className="px-5 py-3 font-medium text-slate-700">{row.week}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-emerald-600">{formatLKR(row.inflows)}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-rose-600">{formatLKR(row.outflows)}</td>
                    <td className={`px-5 py-3 text-right font-semibold tabular-nums ${amountTone(row.net)}`}>
                      {formatLKR(row.net)}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-900">
                      {formatLKR(row.cumulative)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="Nothing scheduled"
            description="Recurring expenses and installment due dates build this table automatically."
          />
        )}
      </PanelCard>
    </div>
  );
}

/* ---------------------------------- tax ------------------------------------ */
function TaxPanel({ data, loading, error, retry, period }) {
  if (loading) return <SkeletonBlock />;
  if (error) return <ErrorBanner error={error} retry={retry} />;
  const report = data || {};

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Tax rate" value={report.rate ? `${report.rate}%` : '—'} tone="brand" hint="Business VAT rate" />
        <StatCard label="Invoices" value={report.invoice_count ?? '—'} hint="Open and closed sales" />
        <StatCard label="Taxable sales" value={report.taxable_sales} currency hint="After discounts" />
        <StatCard
          label="Tax payable"
          value={report.payable}
          currency
          tone="warning"
          hint="Output VAT collected"
        />
      </div>

      <PanelCard
        title="Filing summary"
        subtitle={`${labelDay(report.from_date || period.from) || 'All time'} to ${
          labelDay(report.to_date || period.to) || 'All time'
        }`}
      >
        <LineRow label="Gross sales" value={report.gross_sales} />
        <LineRow label="Discounts" value={report.discounts} />
        <LineRow label="Taxable sales" value={report.taxable_sales} strong />
        <LineRow label="Tax collected" value={report.tax_collected} strong />
        <LineRow label="Purchase value received" value={report.purchase_value} hint="Context only — not an input credit" />
        <LineRow label="Tax payable" value={report.payable} tone="text-amber-600" strong />
        <p className="mt-3 text-xs text-slate-500">
          Purchase orders carry no VAT field, so there is no reliable input credit to net off. Only the
          VAT charged on your sales is reported; purchase value is shown for comparison.
        </p>
      </PanelCard>
    </div>
  );
}

/* --------------------------------- page ------------------------------------ */
export default function ReportsPage() {
  useDocumentTitle('Reports');
  const [tab, setTab] = useState('profit-loss');
  const [period, setPeriod] = useState(defaultPeriod);
  const [asOf, setAsOf] = useState(() => toDateInputValue(new Date()));
  const [weeks, setWeeks] = useState(13);

  const balanceSheetParams = { as_of: asOf };
  const cashFlowParams = { weeks };

  const profitLossQuery = useQuery({
    queryKey: qk.reports.profitLoss(period),
    queryFn: async () => (await reportsApi.profitLoss(period)).data,
    enabled: tab === 'profit-loss',
    retry: 1,
  });

  const balanceSheetQuery = useQuery({
    queryKey: qk.reports.balanceSheet(balanceSheetParams),
    queryFn: async () => (await reportsApi.balanceSheet(balanceSheetParams)).data,
    enabled: tab === 'balance-sheet',
    retry: 1,
  });

  const cashFlowQuery = useQuery({
    queryKey: qk.reports.cashFlow(cashFlowParams),
    queryFn: async () => (await reportsApi.cashFlow(cashFlowParams)).data,
    enabled: tab === 'cash-flow',
    retry: 1,
  });

  const taxQuery = useQuery({
    queryKey: qk.reports.tax(period),
    queryFn: async () => (await reportsApi.tax(period)).data,
    enabled: tab === 'tax',
    retry: 1,
  });

  const showPeriodFilter = tab === 'profit-loss' || tab === 'tax';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Profit and loss, balance sheet, cash-flow forecast, and VAT summary — computed by the API from real transactions, so FIFO costs and taxes stay exact."
      />

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 rounded-control bg-slate-100 p-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-current={tab === item.id ? 'true' : undefined}
            className={
              tab === item.id
                ? 'flex items-center gap-2 rounded-control bg-white px-3.5 py-2 text-sm font-bold text-slate-900 shadow-sm'
                : 'flex items-center gap-2 rounded-control px-3.5 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900'
            }
          >
            <Icon name={item.icon} className="size-4" />
            {item.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      {showPeriodFilter ? (
        <div className="card flex flex-wrap items-end gap-4 p-5">
          <div>
            <label className="label" htmlFor="report-from">
              From
            </label>
            <input
              id="report-from"
              type="date"
              className="input mt-1"
              value={period.from}
              max={period.to || undefined}
              onChange={(event) => setPeriod((prev) => ({ ...prev, from: event.target.value }))}
            />
          </div>
          <div>
            <label className="label" htmlFor="report-to">
              To
            </label>
            <input
              id="report-to"
              type="date"
              className="input mt-1"
              value={period.to}
              min={period.from || undefined}
              onChange={(event) => setPeriod((prev) => ({ ...prev, to: event.target.value }))}
            />
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPeriod(defaultPeriod())}
          >
            Last 30 days
          </button>
        </div>
      ) : null}

      {tab === 'balance-sheet' ? (
        <div className="card flex flex-wrap items-end gap-4 p-5">
          <div>
            <label className="label" htmlFor="report-as-of">
              As of date
            </label>
            <input
              id="report-as-of"
              type="date"
              className="input mt-1"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
            />
          </div>
          <p className="text-xs text-slate-500">
            Leave empty to use today. Stock lots, receivables, and capital entries are counted up to
            this date.
          </p>
        </div>
      ) : null}

      {/* Panels */}
      {tab === 'profit-loss' ? (
        <ProfitLossPanel
          data={profitLossQuery.data}
          loading={profitLossQuery.isPending}
          error={profitLossQuery.isError ? profitLossQuery.error : null}
          retry={profitLossQuery.refetch}
          period={period}
        />
      ) : null}

      {tab === 'balance-sheet' ? (
        <BalanceSheetPanel
          data={balanceSheetQuery.data}
          loading={balanceSheetQuery.isPending}
          error={balanceSheetQuery.isError ? balanceSheetQuery.error : null}
          retry={balanceSheetQuery.refetch}
          asOf={asOf}
        />
      ) : null}

      {tab === 'cash-flow' ? (
        <CashFlowPanel
          data={cashFlowQuery.data}
          loading={cashFlowQuery.isPending}
          error={cashFlowQuery.isError ? cashFlowQuery.error : null}
          retry={cashFlowQuery.refetch}
          weeks={weeks}
          setWeeks={setWeeks}
        />
      ) : null}

      {tab === 'tax' ? (
        <TaxPanel
          data={taxQuery.data}
          loading={taxQuery.isPending}
          error={taxQuery.isError ? taxQuery.error : null}
          retry={taxQuery.refetch}
          period={period}
        />
      ) : null}
    </div>
  );
}
