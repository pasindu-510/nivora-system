import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { activityLogsApi } from '../api/endpoints.js';
import { apiErrorMessage } from '../api/client.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { formatDateTime } from '../utils/format.js';
import { roleLabel } from '../utils/permissions.js';
import PageHeader from '../components/PageHeader.jsx';

const PAGE_SIZE = 25;

const ACTIONS = {
  EDIT: ['Edited', 'bg-amber-50 text-amber-700'],
  DELETE: ['Deleted', 'bg-rose-50 text-rose-600'],
  CANCEL: ['Cancelled', 'bg-rose-50 text-rose-600'],
};

const RECORD_TYPES = {
  SALE: 'Sale',
  PRODUCT: 'Product',
  CATEGORY: 'Category',
  BRAND: 'Brand',
  CUSTOMER: 'Customer',
  SUPPLIER: 'Supplier',
  PURCHASE: 'Purchase order',
  SUPPLIER_PAYMENT: 'Supplier payment',
  EXPENSE: 'Expense',
  RECURRING_EXPENSE: 'Recurring expense',
  EXPENSE_CATEGORY: 'Expense category',
  CASH_ACCOUNT: 'Cash account',
  CAPITAL_ENTRY: 'Capital entry',
  PROMOTION: 'Promotion',
  USER: 'User',
  BRANCH: 'Branch',
  SETTINGS: 'Settings',
};

/** /activity-log — who edited, deleted or cancelled what (business admin). */
export default function ActivityLogPage() {
  useDocumentTitle('Activity Log');

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [action, setAction] = useState('');
  const [recordType, setRecordType] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params = {
    page,
    page_size: PAGE_SIZE,
    q: debounced || undefined,
    action: action || undefined,
    record_type: recordType || undefined,
  };
  const query = useQuery({
    queryKey: ['activity-logs', params],
    queryFn: async () => (await activityLogsApi.list(params)).data,
    // Entries are written by other screens and other users.
    staleTime: 0,
  });

  const rows = query.data?.results || [];
  const count = query.data?.count || 0;
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  const filterBy = (setter) => (event) => {
    setter(event.target.value);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity Log"
        description="Edits, deletions and cancellations: who did them and when."
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <input
          className="input w-full sm:max-w-xs"
          type="search"
          placeholder="Search person, invoice, name..."
          aria-label="Search activity"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="input w-full sm:w-auto"
          aria-label="Filter by activity"
          value={action}
          onChange={filterBy(setAction)}
        >
          <option value="">All activities</option>
          {Object.entries(ACTIONS).map(([value, [label]]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:w-auto"
          aria-label="Filter by record type"
          value={recordType}
          onChange={filterBy(setRecordType)}
        >
          <option value="">All record types</option>
          {Object.entries(RECORD_TYPES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {query.isPending ? (
        <p className="card p-6 text-center text-sm text-slate-500">Loading activity...</p>
      ) : query.isError ? (
        <p className="card p-6 text-sm text-rose-600" role="alert">
          Could not load the activity log — {apiErrorMessage(query.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="card p-6 text-center text-sm text-slate-500">No activity recorded.</p>
      ) : (
        <ul className="card divide-y divide-slate-100">
          {rows.map((row) => {
            const [verb, tone] = ACTIONS[row.action] || [row.action, 'bg-slate-100'];
            const type = RECORD_TYPES[row.record_type] || row.record_type;
            return (
              <li key={row.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 break-words text-slate-900">
                    <span className={`badge mr-2 ${tone}`}>{verb}</span>
                    {type}{' '}
                    {row.record_type === 'SALE' && row.record_id ? (
                      <Link className="font-semibold text-brand-600" to={`/sales/${row.record_id}`}>
                        {row.label}
                      </Link>
                    ) : (
                      <strong>{row.label}</strong>
                    )}
                    {row.record_id ? (
                      <span className="text-xs text-slate-400"> (ID {row.record_id})</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-slate-500">{formatDateTime(row.created_at)}</p>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  By <strong>{row.username}</strong> ({roleLabel(row.role)})
                </p>
                {row.details ? (
                  <p className="mt-1 break-words text-xs text-slate-500">{row.details}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 ? (
        <div className="flex items-center justify-between gap-3 text-sm text-slate-600">
          <button
            type="button"
            className="btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Newer
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Older
          </button>
        </div>
      ) : null}
    </div>
  );
}
