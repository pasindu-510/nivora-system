import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { salesApi, branchesApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, formatDateTime } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';

const LOOKUP_PARAMS = { page_size: 100 };

/** Invoice status badges — tones lifted from ItemsPage (emerald/slate/rose). */
const STATUS_BADGES = {
  OPEN: { label: 'Open', className: 'bg-emerald-50 text-emerald-700' },
  CLOSED: { label: 'Closed', className: 'bg-slate-100 text-slate-500' },
  CANCELLED: { label: 'Cancelled', className: 'bg-rose-50 text-rose-600' },
};

/* ---------------------------------- page ---------------------------------- */
export default function SalesListPage() {
  useDocumentTitle('Sales');

  const navigate = useNavigate();

  // Filter state — search is debounced before it reaches the query key.
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');

  // Server-side search on invoice no / customer name / phone — ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const listParams = {
    page_size: 100,
    q: debouncedSearch || undefined,
    status: statusFilter || undefined,
    branch: branchFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.sales.list(listParams),
    queryFn: async () => (await salesApi.list(listParams)).data,
  });

  // Branch filter — one cached lookup, shared with other pages via qk.branches.
  const branchesQuery = useQuery({
    queryKey: qk.branches.list(LOOKUP_PARAMS),
    queryFn: async () => (await branchesApi.list(LOOKUP_PARAMS)).data,
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const branches = ((branchesQuery.data && branchesQuery.data.results) || []).filter(
    (row) => row.is_active
  );
  const hasFilters = Boolean(debouncedSearch || statusFilter || branchFilter);

  const columns = [
    {
      key: 'invoice_no',
      header: 'Invoice',
      width: '150px',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => <span className="font-mono font-bold text-slate-900">{row.invoice_no}</span>,
    },
    {
      key: 'created_at',
      header: 'Date',
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      render: (row) => row.customer_name || 'Walk-in',
    },
    {
      key: 'branch_name',
      header: 'Branch',
      render: (row) => row.branch_name || '—',
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => {
        const badge = STATUS_BADGES[row.status] || {
          label: row.status || '—',
          className: 'bg-slate-100 text-slate-500',
        };
        return <span className={`badge ${badge.className}`}>{badge.label}</span>;
      },
    },
    {
      key: 'total_cost',
      header: 'Total',
      align: 'right',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatLKR(row.total_cost),
    },
    {
      key: 'remaining_cost',
      header: 'Balance',
      align: 'right',
      render: (row) =>
        // Settled single-payment invoices carry no meaningful balance.
        row.is_single_payment && Number(row.remaining_cost) === 0
          ? '—'
          : formatLKR(row.remaining_cost),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales"
        description={
          listQuery.isPending
            ? 'Loading invoices...'
            : `${count} ${count === 1 ? 'invoice' : 'invoices'}`
        }
        actions={
          <button type="button" className="btn-primary" onClick={() => navigate('/sales/new')}>
            + New Sale
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load invoices — {apiErrorMessage(listQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => listQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Compact filter bar: search + status + branch */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <input
          className="input w-full sm:max-w-xs"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search invoice no, customer or phone..."
          aria-label="Search invoices"
        />
        <select
          className="input w-full sm:w-auto sm:min-w-36"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All</option>
          <option value="OPEN">Open</option>
          <option value="CLOSED">Closed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select
          className="input w-full sm:w-auto sm:min-w-40"
          value={branchFilter}
          onChange={(event) => setBranchFilter(event.target.value)}
          aria-label="Filter by branch"
          disabled={branchesQuery.isPending}
        >
          <option value="">All branches</option>
          {branches.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Sales invoices"
        onRowClick={(row) => navigate(`/sales/${row.id}`)}
        emptyTitle={hasFilters ? 'No invoices match your filters' : 'No invoices yet'}
        emptyDescription={
          hasFilters
            ? 'Try a different search term or clear some filters.'
            : 'Recorded sales will appear here once you create your first invoice.'
        }
      />
    </div>
  );
}
