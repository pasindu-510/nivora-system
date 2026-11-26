import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  branchesApi,
  categoriesApi,
  itemsApi,
  stockLotsApi,
} from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDateTime, formatLKR } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import Icon from '../components/Icon.jsx';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import StatCard from '../components/StatCard.jsx';

const LOOKUP_PARAMS = { page_size: 100 };

/** StockLot.SOURCE_CHOICES -> display labels + badge tones. */
const SOURCE_LABELS = {
  OPENING: 'Opening',
  PURCHASE: 'Purchase',
  ADJUSTMENT: 'Adjustment',
  RETURN: 'Return',
};

const SOURCE_TONES = {
  OPENING: 'bg-slate-100 text-slate-600',
  PURCHASE: 'bg-brand-50 text-brand-600',
  ADJUSTMENT: 'bg-amber-50 text-amber-700',
  RETURN: 'bg-emerald-50 text-emerald-700',
};

/** Remaining share of a lot as a clamped 0–100 integer percent. */
function remainingPercent(row) {
  const remaining = Number(row.quantity_remaining);
  const total = Number(row.quantity_total);
  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((remaining / total) * 100)));
}

/** Remaining value of a lot: quantity_remaining × unit_cost (NaN-safe). */
function remainingValue(row) {
  const remaining = Number(row.quantity_remaining) || 0;
  const unitCost = Number(row.unit_cost) || 0;
  return remaining * unitCost;
}

const LotsIcon = <Icon name="layers" />;
const UnitsIcon = <Icon name="box" />;
const ValueIcon = <Icon name="tag" />;
const ConsumedIcon = <Icon name="clipboard" />;

/* ---------------------------------- page ---------------------------------- */
export default function StockLotsPage() {
  useDocumentTitle('Cost Lots (FIFO)');

  const [itemFilter, setItemFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

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
  const categoryQuery = useQuery({
    queryKey: qk.categories.list(LOOKUP_PARAMS),
    queryFn: async () => (await categoriesApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });

  const items = (itemQuery.data && itemQuery.data.results) || [];
  const branches = (branchQuery.data && branchQuery.data.results) || [];
  const categories = (categoryQuery.data && categoryQuery.data.results) || [];

  // Server-side filtering: DjangoFilterBackend exact matches only — the
  // viewset has no SearchFilter, so there is deliberately no text search box.
  const listParams = {
    page_size: 100,
    ordering: '-received_at',
    item: itemFilter || undefined,
    branch: branchFilter || undefined,
    source: sourceFilter || undefined,
    item__category: categoryFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.stock.lots(listParams),
    queryFn: async () => (await stockLotsApi.list(listParams)).data,
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const hasFilter = Boolean(itemFilter || branchFilter || sourceFilter || categoryFilter);

  // Summary strip — plain reduce over the loaded rows.
  const stats = rows.reduce(
    (acc, row) => {
      const remaining = Number(row.quantity_remaining) || 0;
      acc.lots += 1;
      acc.units += remaining;
      acc.value += remainingValue(row);
      if (remaining === 0) acc.consumed += 1;
      return acc;
    },
    { lots: 0, units: 0, value: 0, consumed: 0 },
  );

  function clearFilters() {
    setItemFilter('');
    setBranchFilter('');
    setSourceFilter('');
    setCategoryFilter('');
  }

  const columns = [
    {
      key: 'item',
      header: 'Product',
      // `item_code` / `item_name` are denormalised on the serializer — no lookup.
      render: (row) => (
        <div className="min-w-0">
          <span className="block font-semibold text-slate-900">{row.item_code || '—'}</span>
          <span className="block truncate text-xs text-slate-500" title={row.item_name || ''}>
            {row.item_name || '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'branch',
      header: 'Branch',
      // Serializer exposes only the FK id — resolve the name client-side.
      render: (row) =>
        branches.find((branch) => branch.id === row.branch)?.name || `Branch #${row.branch}`,
    },
    {
      key: 'source',
      header: 'Source',
      render: (row) => (
        <span className={`badge ${SOURCE_TONES[row.source] || 'bg-slate-100 text-slate-600'}`}>
          {SOURCE_LABELS[row.source] || row.source || '—'}
        </span>
      ),
    },
    {
      key: 'remaining',
      header: 'Remaining',
      render: (row) => {
        const remaining = Number(row.quantity_remaining) || 0;
        const total = Number(row.quantity_total) || 0;
        const pct = remainingPercent(row);
        const depleted = remaining === 0;
        return (
          <div className="w-36">
            <p className={`text-sm font-semibold ${depleted ? 'text-slate-400' : 'text-slate-900'}`}>
              {remaining}
              <span className="ml-1 text-xs font-normal text-slate-400">of {total}</span>
            </p>
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
              aria-hidden="true"
            >
              <div
                className={`h-full rounded-full ${depleted ? 'bg-slate-300' : 'bg-emerald-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {depleted ? (
              <span className="mt-1 block text-xs font-medium text-slate-400">Fully consumed</span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'unit_cost',
      header: 'Unit cost',
      align: 'right',
      render: (row) => formatLKR(row.unit_cost),
    },
    {
      key: 'remaining_value',
      header: 'Remaining value',
      align: 'right',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatLKR(remainingValue(row)),
    },
    {
      key: 'received_at',
      header: 'Received',
      // DateTimeField — formatDateTime guards null/invalid, never "Invalid Date".
      render: (row) => formatDateTime(row.received_at),
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
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cost Lots (FIFO)"
        description={
          listQuery.isPending
            ? 'Loading stock lots...'
            : `${count} ${count === 1 ? 'stock lot' : 'stock lots'}`
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load stock lots — {apiErrorMessage(listQuery.error)}</span>
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
          label="Total lots"
          value={stats.lots}
          hint={count > rows.length ? `Loaded ${rows.length} of ${count}` : undefined}
          tone="brand"
          loading={listQuery.isPending}
          icon={LotsIcon}
        />
        <StatCard
          label="Remaining units"
          value={stats.units}
          tone="neutral"
          loading={listQuery.isPending}
          icon={UnitsIcon}
        />
        <StatCard
          label="Remaining value"
          value={formatLKR(stats.value)}
          tone="positive"
          loading={listQuery.isPending}
          icon={ValueIcon}
        />
        <StatCard
          label="Fully consumed lots"
          value={stats.consumed}
          tone="warning"
          loading={listQuery.isPending}
          icon={ConsumedIcon}
        />
      </div>

      {/* Filter bar: exact-match server-side filters only — this viewset has
          no SearchFilter, so no free-text search is offered. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          className="input w-full sm:max-w-[12rem]"
          value={itemFilter}
          onChange={(event) => setItemFilter(event.target.value)}
          aria-label="Filter by product"
        >
          <option value="">All products</option>
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
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value)}
          aria-label="Filter by source"
        >
          <option value="">All sources</option>
          {Object.entries(SOURCE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:max-w-[12rem]"
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
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
        caption="Read-only FIFO cost lots with remaining quantity, unit cost, source, and received date"
        emptyTitle={hasFilter ? 'No stock lots match these filters' : 'No stock lots'}
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters.'
            : 'Every stock-in creates a cost lot — lots with their remaining quantities and unit costs will appear here.'
        }
      />
    </div>
  );
}
