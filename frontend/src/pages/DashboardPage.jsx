import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { dashboardApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, toDateInputValue } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import PageHeader from '../components/PageHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';

/* --------------------------------- icons --------------------------------- */
const IconCurrency = (
  <svg xmlns="http://www.w3.org/2000/svg" className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33" />
  </svg>
);
const IconAlert = (
  <svg xmlns="http://www.w3.org/2000/svg" className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
  </svg>
);
const IconCalendar = (
  <svg xmlns="http://www.w3.org/2000/svg" className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
  </svg>
);
const IconStar = (
  <svg xmlns="http://www.w3.org/2000/svg" className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
  </svg>
);

/* ------------------------------ date helpers ------------------------------ */
function isoDay(date) {
  return toDateInputValue(date);
}

function defaultRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29); // last 30 days incl. today
  return { start: isoDay(start), end: isoDay(end) };
}

/* --------------------------- summary normalizers -------------------------- */
function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null);
}

function normalizeSummary(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return {
    todaySales: firstDefined(raw.today_sales, raw.todaySales, raw.sales_today),
    lowStockCount: firstDefined(raw.low_stock_count, raw.lowStockCount, raw.low_stock),
    dueInstallments: firstDefined(
      raw.due_installments_count,
      raw.due_installments,
      raw.installments_due
    ),
    topItem: firstDefined(raw.top_item, raw.top_items?.[0]?.name, raw.top_item_name),
    lowStockItems: raw.low_stock_items || raw.low_stock_list || [],
    dueInstallmentsList: raw.due_installments_list || raw.upcoming_installments || [],
    openSales: firstDefined(raw.open_sales, raw.open_sales_count, raw.receivables),
  };
}

/* -------------------------- branch-sales normalizer ----------------------- */
function normalizeBranchSales(raw) {
  const list = Array.isArray(raw) ? raw : raw && (raw.results || raw.branches || raw.data);
  if (!Array.isArray(list)) return [];
  return list.map((row, index) => ({
    branch: firstDefined(row.branch, row.branch_name, row.name, row.branch__name, `Branch ${index + 1}`),
    total: Number(firstDefined(row.total, row.sales_total, row.total_sales, row.amount, row.sum, 0)) || 0,
  }));
}

/* --------------------------------- chart ---------------------------------- */
function BranchSalesChart({ rows, loading, error }) {
  if (loading) {
    return (
      <div className="flex h-72 items-center justify-center">
        <div className="h-full w-full animate-pulse rounded-lg bg-slate-100" aria-hidden="true" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-72 items-center justify-center px-6">
        <p className="text-center text-sm text-slate-500">
          Could not load branch sales. {apiErrorMessage(error)}
        </p>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="flex h-72 items-center justify-center">
        <EmptyState
          title="No branch sales in this period"
          description="Sales completed inside the selected date range will be charted per branch here."
        />
      </div>
    );
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="branch"
            tick={{ fill: '#64748b', fontSize: 12 }}
            axisLine={{ stroke: '#e2e8f0' }}
            tickLine={false}
            interval={0}
          />
          <YAxis
            tick={{ fill: '#64748b', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            width={80}
          />
          <Tooltip
            formatter={(value) => [formatLKR(value), 'Sales']}
            contentStyle={{
              borderRadius: 10,
              border: '1px solid #e2e8f0',
              fontSize: 13,
              boxShadow: '0 8px 24px -12px rgba(15,23,42,0.25)',
            }}
          />
          <Bar dataKey="total" fill="#1b62ef" radius={[6, 6, 0, 0]} maxBarSize={56} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* --------------------------------- page ----------------------------------- */
export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const range = defaultRange();

  const summaryQuery = useQuery({
    queryKey: qk.dashboard.summary({}),
    queryFn: async () => normalizeSummary((await dashboardApi.summary()).data),
    retry: 1,
  });

  const branchSalesQuery = useQuery({
    queryKey: qk.dashboard.branchSales(range),
    queryFn: async () => normalizeBranchSales((await dashboardApi.branchSales(range)).data),
    retry: 1,
  });

  const summary = summaryQuery.data || {};
  const loading = summaryQuery.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Today at a glance: sales, stock health, and installment follow-ups."
      />

      {summaryQuery.isError ? (
        <div className="rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          Live figures are unavailable right now — {apiErrorMessage(summaryQuery.error)} Dashboard
          will fill in as soon as the API responds.
        </div>
      ) : null}

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Sales today"
          value={summary.todaySales ?? '—'}
          currency
          tone="brand"
          loading={loading}
          icon={IconCurrency}
          hint="Across your visible branches"
        />
        <StatCard
          label="Low stock products"
          value={summary.lowStockCount ?? '—'}
          tone={Number(summary.lowStockCount) > 0 ? 'warning' : 'neutral'}
          loading={loading}
          icon={IconAlert}
          hint="At or below reorder threshold"
        />
        <StatCard
          label="Installments due"
          value={summary.dueInstallments ?? '—'}
          tone={Number(summary.dueInstallments) > 0 ? 'danger' : 'neutral'}
          loading={loading}
          icon={IconCalendar}
          hint="Overdue and due within 7 days"
        />
        <StatCard
          label="Top product"
          value={summary.topItem ?? '—'}
          tone="positive"
          loading={loading}
          icon={IconStar}
          hint="Best seller today"
        />
      </div>

      {/* Chart + side column */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">Sales by branch</h2>
              <p className="text-xs text-slate-500">
                {formatDateLabel(range.start)} to {formatDateLabel(range.end)}
              </p>
            </div>
            <span className="badge bg-brand-50 text-brand-700">Last 30 days</span>
          </div>
          <BranchSalesChart
            rows={branchSalesQuery.data || []}
            loading={branchSalesQuery.isPending}
            error={branchSalesQuery.isError ? branchSalesQuery.error : null}
          />
        </section>

        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="text-base font-bold text-slate-900">Low stock</h2>
            <p className="text-xs text-slate-500">Products at or below their reorder level</p>
            {loading ? (
              <div className="mt-4 space-y-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
                <div className="h-4 w-1/2 animate-pulse rounded bg-slate-100" />
                <div className="h-4 w-3/5 animate-pulse rounded bg-slate-100" />
              </div>
            ) : summary.lowStockItems && summary.lowStockItems.length ? (
              <ul className="mt-4 divide-y divide-slate-100">
                {summary.lowStockItems.slice(0, 6).map((item, index) => (
                  <li key={item.id ?? item.code ?? index} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="truncate font-medium text-slate-700">{item.name ?? item.code ?? 'Product'}</span>
                    <span className="badge shrink-0 bg-amber-50 text-amber-700">
                      {firstDefined(item.quantity, item.stock_quantity, item.qty, 0)} left
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Stock levels look healthy"
                description="Products that fall to their low-stock threshold will be flagged here."
              />
            )}
          </section>

          <section className="card p-5">
            <h2 className="text-base font-bold text-slate-900">Installment follow-ups</h2>
            <p className="text-xs text-slate-500">Overdue and upcoming customer payments</p>
            {loading ? (
              <div className="mt-4 space-y-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
                <div className="h-4 w-1/2 animate-pulse rounded bg-slate-100" />
              </div>
            ) : summary.dueInstallmentsList && summary.dueInstallmentsList.length ? (
              <ul className="mt-4 divide-y divide-slate-100">
                {summary.dueInstallmentsList.slice(0, 6).map((row, index) => (
                  <li key={row.id ?? index} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="truncate font-medium text-slate-700">
                      {row.customer_name ?? row.customer ?? row.invoice_no ?? 'Installment'}
                    </span>
                    <span className="shrink-0 font-semibold text-slate-900">
                      {formatLKR(firstDefined(row.amount, row.due_amount, 0))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Nothing due"
                description="Installments that are overdue or due soon will be listed here for collection."
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function formatDateLabel(iso) {
  if (!iso) return '';
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
