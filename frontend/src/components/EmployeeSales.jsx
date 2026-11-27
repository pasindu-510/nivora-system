import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, toDateInputValue } from '../utils/format.js';
import { roleLabel } from '../utils/permissions.js';

const PERIODS = [
  ['today', 'Today'],
  ['month', 'This month'],
  ['30d', 'Last 30 days'],
];

function periodRange(period) {
  const end = new Date();
  const start = new Date();
  if (period === 'month') start.setDate(1);
  if (period === '30d') start.setDate(start.getDate() - 29);
  return { start: toDateInputValue(start), end: toDateInputValue(end) };
}

/** Dashboard card: how much each logged-in employee sold. */
export default function EmployeeSales() {
  const [period, setPeriod] = useState('today');
  const range = periodRange(period);

  const query = useQuery({
    queryKey: qk.dashboard.employeeSales(range),
    queryFn: async () => (await dashboardApi.employeeSales(range)).data,
    retry: 1,
  });
  const rows = query.data || [];

  const salesLink = (row) =>
    `/sales?${new URLSearchParams({
      seller: row.user_id,
      name: row.full_name || row.username,
      from: range.start,
      to: range.end,
    })}`;

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">Sales by employee</h2>
          <p className="text-xs text-slate-500">Tap a name to see those sales.</p>
        </div>
        <select
          className="input w-auto"
          aria-label="Period for sales by employee"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
        >
          {PERIODS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {query.isPending ? (
        <p className="py-6 text-center text-sm text-slate-500">Loading...</p>
      ) : query.isError ? (
        <p className="mt-4 text-sm text-rose-600" role="alert">
          Could not load employee sales — {apiErrorMessage(query.error)}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.user_id}>
              <Link
                to={salesLink(row)}
                className="flex items-center justify-between gap-3 px-1 py-2.5 text-sm hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-slate-900">
                    {row.full_name || row.username}
                  </span>
                  <span className="block text-xs text-slate-500">{roleLabel(row.role)}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular-nums text-slate-900">
                    {formatLKR(row.total)}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {row.sales_count} sale(s)
                    {row.installment_count > 0 ? ` · ${row.installment_count} installment` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
