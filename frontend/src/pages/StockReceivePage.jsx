import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { purchasesApi, suppliersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, formatDate } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';

const LOOKUP_PARAMS = { page_size: 100 };

const STATUS_LABELS = {
  DRAFT: 'Draft',
  ORDERED: 'Ordered',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

const STATUS_BADGE_CLASSES = {
  DRAFT: 'bg-slate-100 text-slate-600',
  ORDERED: 'bg-brand-50 text-brand-700',
  PARTIALLY_RECEIVED: 'bg-amber-50 text-amber-700',
  RECEIVED: 'bg-emerald-50 text-emerald-700',
  CANCELLED: 'bg-rose-50 text-rose-700',
};

/** quantity - received_quantity — drives the receive UI. */
function outstandingOf(line) {
  return Number(line.quantity) - Number(line.received_quantity);
}

function StatusBadge({ status }) {
  return (
    <span className={`badge ${STATUS_BADGE_CLASSES[status] || STATUS_BADGE_CLASSES.DRAFT}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

/**
 * Per-line receive validation: whole numbers between 0 and the line's
 * outstanding quantity, plus a form-level guard when nothing is entered
 * (otherwise the backend answers 400 "No outstanding line quantities").
 */
function validateReceive(lines, form) {
  const errors = {};
  let anyPositive = false;
  lines.forEach((line) => {
    const outstanding = outstandingOf(line);
    const raw = form[line.id];
    if (raw === undefined || raw === '') {
      if (outstanding > 0) errors[line.id] = `Enter a quantity up to ${outstanding}.`;
      return;
    }
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty < 0 || qty > outstanding) {
      errors[line.id] = `Enter a whole number between 0 and ${outstanding}.`;
      return;
    }
    if (qty > 0) anyPositive = true;
  });
  if (!anyPositive && Object.keys(errors).length === 0)
    errors.form = 'Enter a quantity on at least one line to receive stock.';
  return errors;
}

/**
 * DRF field errors come back as `{ field: [msg, ...] }` — split them so each
 * message lands on its FormField; anything else becomes a form banner.
 */
function parseServerError(error) {
  const data = error && error.response && error.response.data;
  const fields = {};
  let banner = null;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    Object.entries(data).forEach(([key, value]) => {
      const message = Array.isArray(value) ? value.join(' ') : String(value);
      if (key === 'detail' || key === 'non_field_errors') banner = message;
      else fields[key] = message;
    });
  }
  if (!banner && Object.keys(fields).length === 0) banner = apiErrorMessage(error);
  return { fields, banner };
}

/* ---------------------------------- page ---------------------------------- */
export default function StockReceivePage() {
  useDocumentTitle('Receive Stock');

  const [statusFilter, setStatusFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [receiveTarget, setReceiveTarget] = useState(null);
  const [seededId, setSeededId] = useState(null);
  const [receiveForm, setReceiveForm] = useState({});
  const [receiveAll, setReceiveAll] = useState(true);
  const [receiveNote, setReceiveNote] = useState('');
  const [receiveErrors, setReceiveErrors] = useState({});

  const supplierQuery = useQuery({
    queryKey: qk.suppliers.list(LOOKUP_PARAMS),
    queryFn: async () => (await suppliersApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const suppliers = (supplierQuery.data && supplierQuery.data.results) || [];

  // There is no standalone receive endpoint — only receivable purchase orders
  // exist, so fetch the two receivable statuses separately and concatenate.
  const orderedParams = {
    page_size: 100,
    ordering: '-created_at',
    status: 'ORDERED',
    supplier: supplierFilter || undefined,
  };
  const partialParams = {
    page_size: 100,
    ordering: '-created_at',
    status: 'PARTIALLY_RECEIVED',
    supplier: supplierFilter || undefined,
  };

  const orderedQuery = useQuery({
    queryKey: qk.purchases.list(orderedParams),
    queryFn: async () => (await purchasesApi.list(orderedParams)).data,
  });
  const partialQuery = useQuery({
    queryKey: qk.purchases.list(partialParams),
    queryFn: async () => (await purchasesApi.list(partialParams)).data,
  });

  // Detail for the open receive modal only.
  const detailQuery = useQuery({
    queryKey: qk.purchases.detail(receiveTarget ? receiveTarget.id : null),
    queryFn: async () => (await purchasesApi.get(receiveTarget.id)).data,
    enabled: Boolean(receiveTarget),
  });

  const receiveMutation = useApiMutation(({ id, data }) => purchasesApi.receive(id, data), {
    invalidates: [qk.purchases.root],
  });

  const orderedRows = (orderedQuery.data && orderedQuery.data.results) || [];
  const partialRows = (partialQuery.data && partialQuery.data.results) || [];
  const rows = orderedRows
    .concat(partialRows)
    .filter((row) => !statusFilter || row.status === statusFilter)
    .sort((a, b) => String(a.order_no).localeCompare(String(b.order_no)));

  const listLoading = orderedQuery.isPending || partialQuery.isPending;
  const listError = orderedQuery.isError
    ? orderedQuery.error
    : partialQuery.isError
    ? partialQuery.error
    : null;
  const hasFilter = Boolean(statusFilter || supplierFilter);

  const detail = detailQuery.data || null;
  const lines = (detail && detail.items) || [];

  // Seed the receive inputs once per opened order (the detail arrives async);
  // guarded so a background refetch never wipes what the user has typed.
  useEffect(() => {
    const data = detailQuery.data;
    if (!data || seededId === data.id) return;
    const initial = {};
    (data.items || []).forEach((line) => {
      initial[line.id] = String(Math.max(0, outstandingOf(line)));
    });
    setReceiveForm(initial);
    setReceiveAll(true);
    setReceiveNote('');
    setReceiveErrors({});
    setSeededId(data.id);
  }, [detailQuery.data, seededId]);

  function openReceive(row) {
    setSeededId(null);
    setReceiveTarget(row);
  }

  function closeReceive() {
    setReceiveTarget(null);
    setReceiveErrors({});
  }

  function handleReceiveAllChange(event) {
    const checked = event.target.checked;
    setReceiveAll(checked);
    const next = {};
    lines.forEach((line) => {
      next[line.id] = checked ? String(Math.max(0, outstandingOf(line))) : '0';
    });
    setReceiveForm(next);
  }

  async function handleReceiveSubmit(event) {
    event.preventDefault();
    const clientErrors = validateReceive(lines, receiveForm);
    setReceiveErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;

    // Zero-quantity lines are omitted entirely; the backend fills the rest.
    const quantities = {};
    for (const line of lines) {
      const qty = Number(receiveForm[line.id]);
      if (Number.isInteger(qty) && qty > 0) quantities[String(line.id)] = qty;
    }

    try {
      await receiveMutation.mutateAsync({
        id: receiveTarget.id,
        data: { quantities, note: receiveNote.trim() },
      });
      closeReceive();
    } catch (error) {
      const parsed = parseServerError(error);
      setReceiveErrors({ form: parsed.banner });
    }
  }

  const columns = [
    {
      key: 'order_no',
      header: 'Order no',
      cellClassName: 'font-mono font-semibold text-slate-900',
      render: (row) => row.order_no,
    },
    {
      key: 'supplier_name',
      header: 'Supplier',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => row.supplier_name || '—',
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'expected_delivery_date',
      header: 'Expected delivery',
      render: (row) => formatDate(row.expected_delivery_date),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatLKR(row.total),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div
          className="flex items-center justify-end gap-2"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="btn-primary px-2.5 py-1.5 text-xs"
            aria-label={`Receive stock against ${row.order_no}`}
            onClick={() => openReceive(row)}
          >
            Receive
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Receive Delivery"
        description={
          listLoading
            ? 'Loading open orders...'
            : `${rows.length} ${rows.length === 1 ? 'order' : 'orders'} ready to receive`
        }
      />

      {/* How receiving works — receiving only exists on a purchase order */}
      <div className="card px-5 py-4">
        <div className="flex gap-3">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="mt-0.5 size-5 shrink-0 text-brand-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
            />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">
              Stock is received against a purchase order
            </p>
            <p className="mt-0.5 text-sm text-slate-500">
              Only orders in{' '}
              <span className="font-medium text-slate-700">Ordered</span> or{' '}
              <span className="font-medium text-slate-700">Partially received</span> status can
              receive stock. Open an order below to record what arrived — partial deliveries are
              fine and can be repeated until the order is complete.
            </p>
          </div>
        </div>
      </div>

      {listError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load open orders — {apiErrorMessage(listError)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => {
              orderedQuery.refetch();
              partialQuery.refetch();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Filter bar: receivable statuses only */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          className="input w-full sm:max-w-[14rem]"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All receivable orders</option>
          <option value="ORDERED">{STATUS_LABELS.ORDERED}</option>
          <option value="PARTIALLY_RECEIVED">{STATUS_LABELS.PARTIALLY_RECEIVED}</option>
        </select>
        <select
          className="input w-full sm:max-w-[13rem]"
          value={supplierFilter}
          onChange={(event) => setSupplierFilter(event.target.value)}
          aria-label="Filter by supplier"
        >
          <option value="">All suppliers</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>
        {hasFilter ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setStatusFilter('');
              setSupplierFilter('');
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listLoading}
        caption="Purchase orders awaiting delivery"
        onRowClick={openReceive}
        emptyTitle="Nothing to receive"
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters — only Ordered and Partially received orders can receive stock.'
            : 'Purchase orders must be placed first. Once an order is placed it appears here so you can check in what arrived, in full or in part.'
        }
      />

      {/* Receive console — one modal, per-line quantities against a single PO */}
      <Modal
        open={Boolean(receiveTarget)}
        onClose={closeReceive}
        title={receiveTarget ? `Receive stock — ${receiveTarget.order_no}` : 'Receive stock'}
        description={
          receiveTarget
            ? `${receiveTarget.supplier_name || 'Supplier'} · enter what actually arrived.`
            : ''
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeReceive}>
              Cancel
            </button>
            <button
              type="submit"
              form="receive-form"
              className="btn-primary"
              disabled={receiveMutation.isPending || detailQuery.isPending}
            >
              {receiveMutation.isPending ? 'Receiving...' : 'Receive stock'}
            </button>
          </>
        }
      >
        {detailQuery.isPending ? (
          <div className="flex items-center justify-center py-10">
            <div className="size-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            <span className="sr-only">Loading order lines...</span>
          </div>
        ) : detailQuery.isError ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-control border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            <span>Could not load this order — {apiErrorMessage(detailQuery.error)}</span>
            <button
              type="button"
              className="btn-secondary px-2.5 py-1 text-xs"
              onClick={() => detailQuery.refetch()}
            >
              Retry
            </button>
          </div>
        ) : detail ? (
          <form id="receive-form" onSubmit={handleReceiveSubmit} noValidate>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-control border border-slate-200 bg-slate-50/70 px-4 py-3">
              <div className="min-w-0">
                <p className="font-mono text-sm font-semibold text-slate-900">
                  {detail.order_no}
                </p>
                <p className="text-xs text-slate-500">
                  Expected {formatDate(detail.expected_delivery_date)} ·{' '}
                  {formatLKR(detail.total)}
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  className="size-4 rounded border-slate-300"
                  checked={receiveAll}
                  onChange={handleReceiveAllChange}
                />
                Receive all outstanding
              </label>
            </div>

            {receiveErrors.form ? (
              <div
                className="mb-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
                role="alert"
              >
                {receiveErrors.form}
              </div>
            ) : null}

            <div className="space-y-3">
              {lines.map((line) => {
                const outstanding = outstandingOf(line);
                return (
                  <div key={line.id} className="rounded-control border border-slate-200 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-semibold text-slate-500">
                          {line.item_code}
                        </p>
                        <p className="text-sm font-medium text-slate-900">{line.item_name}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          Ordered {line.quantity} · Received {line.received_quantity} ·
                          Outstanding {outstanding}
                        </p>
                      </div>
                      <div className="w-28 shrink-0">
                        <label className="sr-only" htmlFor={`receive-qty-${line.id}`}>
                          Quantity to receive for {line.item_name}
                        </label>
                        <input
                          id={`receive-qty-${line.id}`}
                          className="input text-right"
                          type="number"
                          min="0"
                          max={outstanding}
                          step="1"
                          inputMode="numeric"
                          disabled={outstanding === 0}
                          value={receiveForm[line.id] ?? ''}
                          onChange={(event) =>
                            setReceiveForm((prev) => ({ ...prev, [line.id]: event.target.value }))
                          }
                        />
                      </div>
                    </div>
                    {receiveErrors[line.id] ? (
                      <p className="mt-1.5 text-xs font-medium text-rose-600" role="alert">
                        {receiveErrors[line.id]}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="mt-4">
              <FormField label="Note" hint="Optional — recorded on the receipt">
                <textarea
                  className="input"
                  name="note"
                  value={receiveNote}
                  onChange={(event) => setReceiveNote(event.target.value)}
                  placeholder="e.g. Delivery note from the supplier"
                  rows={2}
                />
              </FormField>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
