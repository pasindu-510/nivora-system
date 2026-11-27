import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { customersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, formatDate } from '../utils/format.js';
import BlacklistControl from './BlacklistControl.jsx';

const STATUS = {
  OPEN: ['Open', 'bg-emerald-50 text-emerald-700'],
  CLOSED: ['Closed', 'bg-slate-100 text-slate-500'],
  CANCELLED: ['Cancelled', 'bg-rose-50 text-rose-600'],
};

function SaleRows({ sales, empty, showBuyer = false }) {
  if (!sales.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-control border border-slate-200">
      {sales.map((sale) => {
        const [label, tone] = STATUS[sale.status] || [sale.status, 'bg-slate-100'];
        return (
          <li key={sale.id}>
            <Link
              to={`/sales/${sale.id}`}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50"
            >
              <span className="min-w-0">
                <span className="block font-mono text-xs font-bold text-slate-900">
                  {sale.invoice_no}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {showBuyer ? `${sale.customer_name} · ` : ''}
                  {formatDate(sale.created_at)} ·{' '}
                  {sale.is_single_payment ? 'Paid in full' : 'Installments'}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-semibold text-slate-900">
                  {formatLKR(sale.total_cost)}
                </span>
                {Number(sale.remaining_cost) > 0 ? (
                  <span className="block text-xs text-rose-600">
                    {formatLKR(sale.remaining_cost)} due
                  </span>
                ) : (
                  <span className={`badge ${tone}`}>{label}</span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Everything about one customer: details, money summary, sales and blacklist. */
export default function CustomerSummary({ customerId }) {
  const query = useQuery({
    queryKey: qk.customers.history(customerId),
    queryFn: async () => (await customersApi.history(customerId)).data,
  });

  if (query.isPending) {
    return <p className="py-8 text-center text-sm text-slate-500">Loading summary...</p>;
  }
  if (query.isError) {
    return (
      <p className="text-sm font-medium text-rose-600" role="alert">
        Could not load the customer — {apiErrorMessage(query.error)}{' '}
        <button type="button" className="underline" onClick={() => query.refetch()}>
          Retry
        </button>
      </p>
    );
  }

  const data = query.data;
  const customer = data.customer;
  const overdue = data.overdue_count > 0;
  const stats = [
    ['Total sales', data.total_sales_count],
    ['Total bought', formatLKR(data.total_spent)],
    ['Total paid', formatLKR(data.total_paid)],
    ['Outstanding', formatLKR(data.outstanding), Number(data.outstanding) > 0],
    [
      'Overdue',
      overdue ? `${formatLKR(data.overdue_amount)} (${data.overdue_count})` : 'None',
      overdue,
    ],
    ['Installment plans', `${data.active_plans} open · ${data.completed_plans} done`],
    ['Paid-in-full sales', data.cash_sales_count],
    ['Last purchase', data.last_purchase_at ? formatDate(data.last_purchase_at) : '—'],
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-4">
        {customer.id_card_photo ? (
          <a href={customer.id_card_photo} target="_blank" rel="noreferrer">
            <img
              src={customer.id_card_photo}
              alt={`ID card of ${customer.name}`}
              className="h-20 w-28 rounded-lg border border-slate-200 object-cover"
            />
          </a>
        ) : null}
        <div className="min-w-0 flex-1 text-sm text-slate-600">
          <p>
            Phone:{' '}
            {customer.phone ? (
              <a className="font-semibold text-brand-600" href={`tel:${customer.phone}`}>
                {customer.phone}
              </a>
            ) : (
              '—'
            )}
          </p>
          <p>NIC: {customer.nic || '—'}</p>
          <p className="break-words">Address: {customer.address || '—'}</p>
          <BlacklistControl person={customer} />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value, warn]) => (
          <div key={label} className="rounded-control border border-slate-200 bg-slate-50/70 p-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {label}
            </dt>
            <dd
              className={`mt-1 break-words text-sm font-bold tabular-nums ${
                warn ? 'text-rose-600' : 'text-slate-900'
              }`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {data.next_due ? (
        <p className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Next payment: <strong>{formatLKR(data.next_due.amount)}</strong>{' '}
          {overdue ? 'was due on' : 'due on'} {formatDate(data.next_due.date)} (
          <Link className="font-semibold underline" to={`/sales/${data.next_due.sale}`}>
            {data.next_due.invoice_no}
          </Link>
          )
        </p>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-bold text-slate-900">Purchases</h3>
        <SaleRows sales={data.sales || []} empty="No sales recorded for this customer." />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-bold text-slate-900">Guarantor for</h3>
        <SaleRows
          sales={data.guaranteed_sales || []}
          empty="Not a guarantor on any sale."
          showBuyer
        />
      </div>
    </div>
  );
}
