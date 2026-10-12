import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { branchesApi, itemsApi, stockMovementsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDateTime } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import Icon from '../components/Icon.jsx';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import StatCard from '../components/StatCard.jsx';

const LOOKUP_PARAMS = { page_size: 100 };

/** StockMovement.TYPE_CHOICES -> display labels + badge tones. */
const TYPE_LABELS = {
  IN: 'In',
  OUT: 'Out',
  ADJUST: 'Adjust',
  SALE: 'Sale',
};

const TYPE_TONES = {
  IN: 'bg-emerald-50 text-emerald-700',
  OUT: 'bg-rose-50 text-rose-700',
  SALE: 'bg-rose-50 text-rose-700',
  ADJUST: 'bg-amber-50 text-amber-700',
};

/** Quantity colouring mirrors the badge tones: in / out+sale / adjust. */
const TYPE_TEXT = {
  IN: 'text-emerald-600',
  OUT: 'text-rose-600',
  SALE: 'text-rose-600',
  ADJUST: 'text-amber-600',
};

const MovementsIcon = <Icon name="swap" />;
const NetIcon = <Icon name="chart" />;
const InboundIcon = <Icon name="box" />;
const OutboundIcon = <Icon name="cart" />;

/* ---------------------------------- page ---------------------------------- */
export default function StockMovementsPage() {
  useDocumentTitle('Stock Movements');

  const [itemFilter, setItemFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  // Lookups feed the filter bar (and branch-name resolution) — always on,
  // with a generous staleTime so they rarely refetch.
  const itemQuery = useQuery({
    queryKey: qk.items.list(LOOKUP_PARAMS),
    queryFn: async () => (await itemsApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const branchQuery = useQuery({
    queryKey: qk.branches.list(LOOKUP_PARAMS),
    queryFn: async () => (await branchesApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });

  const items = (itemQuery.data && itemQuery.data.results) || [];
  const branches = (branchQuery.data && branchQuery.data.results) || [];

  // Server-side filtering: DjangoFilterBackend exact matches only — the
  // viewset has no SearchFilter, so there is deliberately no text search box.
  const listParams = {
    page_size: 100,
    ordering: '-created_at',
    item: itemFilter || undefined,
    branch: branchFilter || undefined,
    type: typeFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.stock.movements(listParams),
    queryFn: async () => (await stockMovementsApi.list(listParams)).data,
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const hasFilter = Boolean(itemFilter || branchFilter || typeFilter);

  // Summary strip — plain reduce over the loaded rows. In/out split by sign so
  // net always equals inbound − outbound (an ADJUST row can go either way).
  const stats = rows.reduce(
    (acc, row) => {
      const quantity = Number(row.quantity) || 0;
      acc.movements += 1;
      acc.net += quantity;
      if (quantity > 0) acc.inbound += quantity;
      else if (quantity < 0) acc.outbound += -quantity;
      return acc;
    },
    { movements: 0, net: 0, inbound: 0, outbound: 0 },
  );

  const signedNet = stats.net > 0 ? `+${stats.net}` : String(stats.net);

  function clearFilters() {
    setItemFilter('');
    setBranchFilter('');
    setTypeFilter('');
  }

  const columns = [
    {
      key: 'item_code',
      header: 'Item',
      cellClassName: 'font-semibold text-slate-900',
      // Denormalised on the serializer — no item lookup needed for display.
      render: (row) => row.item_code || '—',
    },
    {
      key: 'branch',
      header: 'Branch',
      // Serializer exposes only the FK id — resolve the name client-side.
      render: (row) =>
        branches.find((branch) => branch.id === row.branch)?.name || `Branch #${row.branch}`,
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => (
        <span className={`badge ${TYPE_TONES[row.type] || 'bg-slate-100 text-slate-600'}`}>
          {TYPE_LABELS[row.type] || row.type || '—'}
        </span>
      ),
    },
    {
      key: 'quantity',
      header: 'Quantity',
      align: 'right',
      // Signed on purpose: a negative ADJUST is a legitimate correction.
      render: (row) => {
        const quantity = Number(row.quantity) || 0;
        const signed = quantity > 0 ? `+${quantity}` : String(quantity);
        return (
          <span className={`font-semibold ${TYPE_TEXT[row.type] || 'text-slate-700'}`}>{signed}</span>
        );
      },
    },
    {
      key: 'reference',
      header: 'Reference',
      render: (row) => (
        <span className="block max-w-xs truncate" title={row.reference || ''}>
          {row.reference || '—'}
        </span>
      ),
    },
    {
      key: 'note',
      header: 'Note',
      render: (row) => (
        <span className="block max-w-xs truncate" title={row.note || ''}>
          {row.note || '—'}
        </span>
      ),
    },
    {
      key: 'created_at',
      header: 'Occurred',
      // DateTimeField — formatDateTime guards null/invalid, never "Invalid Date".
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Movements"
        description={
          listQuery.isPending
            ? 'Loading stock movements...'
            : `${count} ${count === 1 ? 'movement' : 'movements'}`
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load stock movements — {apiErrorMessage(listQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => listQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* KPI row — computed from the loaded rows only */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total movements"
          value={stats.movements}
          hint={count > rows.length ? `Loaded ${rows.length} of ${count}` : undefined}
          tone="brand"
          loading={listQuery.isPending}
          icon={MovementsIcon}
        />
        <StatCard
          label="Net unit change"
          value={signedNet}
          tone={stats.net > 0 ? 'positive' : stats.net < 0 ? 'danger' : 'neutral'}
          loading={listQuery.isPending}
          icon={NetIcon}
        />
        <StatCard
          label="Inbound units"
          value={stats.inbound}
          tone="positive"
          loading={listQuery.isPending}
          icon={InboundIcon}
        />
        <StatCard
          label="Outbound units"
          value={stats.outbound}
          tone="danger"
          loading={listQuery.isPending}
          icon={OutboundIcon}
        />
      </div>

      {/* Filter bar: exact-match server-side filters only — this viewset has
          no SearchFilter, so no free-text search is offered. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          className="input w-full sm:max-w-[12rem]"
          value={itemFilter}
          onChange={(event) => setItemFilter(event.target.value)}
          aria-label="Filter by item"
        >
          <option value="">All items</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.code ? `${item.code} — ${item.name}` : item.name}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:max-w-[12rem]"
          value={branchFilter}
          onChange={(event) => setBranchFilter(event.target.value)}
          aria-label="Filter by branch"
        >
          <option value="">All branches</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:max-w-[12rem]"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          aria-label="Filter by movement type"
        >
          <option value="">All movement types</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {hasFilter ? (
          <button type="button" className="btn-secondary" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Read-only audit trail of stock movements by type, quantity, reference, and note"
        emptyTitle={hasFilter ? 'No stock movements match these filters' : 'No stock movements'}
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters.'
            : 'Stock-ins, sales, and adjustments are recorded here automatically with their reference and note.'
        }
      />
    </div>
  );
}
