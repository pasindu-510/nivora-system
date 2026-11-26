import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { branchesApi, itemsApi, purchasesApi, suppliersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, formatDate, toDateInputValue } from '../utils/format.js';
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

/** Default for new purchase orders — computed once, sent explicitly on create. */
const today = toDateInputValue(new Date());

const EMPTY_FORM = {
  supplier: '',
  branch: '',
  expected_delivery_date: today,
  notes: '',
};

const EMPTY_LINE_FORM = {
  item: '',
  quantity: '1',
  unit_cost: '',
};

/** quantity - received_quantity — drives the receive UI and line removal. */
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

/** Client-side validation before hitting the API. */
function validatePurchase(values) {
  const errors = {};
  if (!values.supplier) errors.supplier = 'Choose a supplier.';
  if (!values.branch) errors.branch = 'Choose a branch.';
  if (values.notes.trim().length > 5000) errors.notes = 'Keep the notes under 5000 characters.';
  return errors;
}

function validateLine(values) {
  const errors = {};
  if (!values.item) errors.item = 'Choose an item.';
  const quantity = Number(values.quantity);
  if (values.quantity === '' || !Number.isInteger(quantity) || quantity < 1)
    errors.quantity = 'Enter a whole number of 1 or more.';
  const unitCost = Number(values.unit_cost);
  if (!values.unit_cost || !Number.isFinite(unitCost) || unitCost <= 0)
    errors.unit_cost = 'Enter a unit cost greater than zero.';
  return errors;
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
export default function StockPurchasesPage() {
  useDocumentTitle('Purchase Orders');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);

  const [detailId, setDetailId] = useState(null);
  const [lineModalOpen, setLineModalOpen] = useState(false);
  const [lineForm, setLineForm] = useState(EMPTY_LINE_FORM);
  const [lineErrors, setLineErrors] = useState({});
  const [lineBanner, setLineBanner] = useState(null);
  const [itemSearch, setItemSearch] = useState('');
  const [debouncedItemSearch, setDebouncedItemSearch] = useState('');

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveForm, setReceiveForm] = useState({});
  const [receiveAll, setReceiveAll] = useState(true);
  const [receiveNote, setReceiveNote] = useState('');
  const [receiveErrors, setReceiveErrors] = useState({});

  const [confirmAction, setConfirmAction] = useState(null);
  const [confirmError, setConfirmError] = useState(null);

  // Server-side search on order_no / supplier name — debounce keystrokes ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Item picker search for the add-line modal — same ~300ms debounce.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedItemSearch(itemSearch.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [itemSearch]);

  // Lookup lists feed the filter bar and the form selects — always on with a
  // generous staleTime so they rarely refetch.
  const supplierQuery = useQuery({
    queryKey: qk.suppliers.list(LOOKUP_PARAMS),
    queryFn: async () => (await suppliersApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const branchQuery = useQuery({
    queryKey: qk.branches.list(LOOKUP_PARAMS),
    queryFn: async () => (await branchesApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const itemParams = {
    page_size: 100,
    q: debouncedItemSearch || undefined,
    is_active: true,
  };
  const itemQuery = useQuery({
    queryKey: qk.items.list(itemParams),
    queryFn: async () => (await itemsApi.list(itemParams)).data,
    staleTime: 5 * 60 * 1000,
  });

  const suppliers = (supplierQuery.data && supplierQuery.data.results) || [];
  const branches = (branchQuery.data && branchQuery.data.results) || [];
  const itemOptions = (itemQuery.data && itemQuery.data.results) || [];

  const listParams = {
    page_size: 100,
    ordering: '-created_at',
    q: debouncedSearch || undefined,
    status: statusFilter || undefined,
    supplier: supplierFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.purchases.list(listParams),
    queryFn: async () => (await purchasesApi.list(listParams)).data,
  });

  // Detail is fetched only while the detail modal is open, so the list page
  // never fans out one request per row.
  const detailQuery = useQuery({
    queryKey: qk.purchases.detail(detailId),
    queryFn: async () => (await purchasesApi.get(detailId)).data,
    enabled: detailId !== null,
  });

  const createMutation = useApiMutation((data) => purchasesApi.create(data), {
    invalidates: [qk.purchases.root],
  });
  const addLineMutation = useApiMutation(({ id, data }) => purchasesApi.addItem(id, data), {
    invalidates: [qk.purchases.root],
  });
  const removeLineMutation = useApiMutation(({ id, data }) => purchasesApi.removeItem(id, data), {
    invalidates: [qk.purchases.root],
  });
  const placeMutation = useApiMutation(({ id, data }) => purchasesApi.place(id, data), {
    invalidates: [qk.purchases.root],
  });
  const receiveMutation = useApiMutation(({ id, data }) => purchasesApi.receive(id, data), {
    invalidates: [qk.purchases.root],
  });
  const cancelMutation = useApiMutation(({ id, data }) => purchasesApi.cancel(id, data), {
    invalidates: [qk.purchases.root],
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const hasFilter = Boolean(debouncedSearch || statusFilter || supplierFilter);

  const detail = detailQuery.data || null;
  const lines = (detail && detail.items) || [];
  const receipts = (detail && detail.receipts) || [];
  const detailLocked = lineModalOpen || receiveOpen || Boolean(confirmAction);

  const setField = (key) => (event) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const setLineField = (key) => (event) => {
    setLineForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  function clearFilters() {
    setSearch('');
    setStatusFilter('');
    setSupplierFilter('');
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setErrors({});
    setBanner(null);
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
    setErrors({});
    setBanner(null);
  }

  function closeDetail() {
    setDetailId(null);
    setLineModalOpen(false);
    setReceiveOpen(false);
    setConfirmAction(null);
  }

  function openLineModal() {
    setLineForm(EMPTY_LINE_FORM);
    setLineErrors({});
    setLineBanner(null);
    setItemSearch('');
    setDebouncedItemSearch('');
    setLineModalOpen(true);
  }

  function closeLineModal() {
    setLineModalOpen(false);
    setLineErrors({});
    setLineBanner(null);
  }

  function openReceiveModal() {
    const initial = {};
    lines.forEach((line) => {
      initial[line.id] = String(Math.max(0, outstandingOf(line)));
    });
    setReceiveForm(initial);
    setReceiveAll(true);
    setReceiveNote('');
    setReceiveErrors({});
    setReceiveOpen(true);
  }

  function closeReceiveModal() {
    setReceiveOpen(false);
    setReceiveErrors({});
  }

  function openConfirm(kind, purchase, line) {
    setConfirmError(null);
    setConfirmAction({ kind, purchase, line: line || null });
  }

  function closeConfirm() {
    setConfirmAction(null);
    setConfirmError(null);
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

  async function handleCreateSubmit(event) {
    event.preventDefault();
    const clientErrors = validatePurchase(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;

    // `order_no` is generated server-side and `status` is read-only — neither
    // belongs in the payload.
    const payload = {
      supplier: Number(form.supplier),
      branch: Number(form.branch),
      expected_delivery_date: form.expected_delivery_date || null,
      notes: form.notes.trim(),
    };

    try {
      const created = await createMutation.mutateAsync(payload);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      if (created && created.data && created.data.id) setDetailId(created.data.id);
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  async function handleLineSubmit(event) {
    event.preventDefault();
    const clientErrors = validateLine(lineForm);
    setLineErrors(clientErrors);
    setLineBanner(null);
    if (Object.keys(clientErrors).length) return;

    // `item` is a catalogue Item PK (unlike remove_item, which takes the
    // PurchaseItem line id).
    const payload = {
      item: Number(lineForm.item),
      quantity: Number(lineForm.quantity),
      unit_cost: String(lineForm.unit_cost).trim(),
    };

    try {
      await addLineMutation.mutateAsync({ id: detailId, data: payload });
      closeLineModal();
    } catch (error) {
      const parsed = parseServerError(error);
      setLineErrors(parsed.fields);
      setLineBanner(parsed.banner);
    }
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
        id: detailId,
        data: { quantities, note: receiveNote.trim() },
      });
      closeReceiveModal();
    } catch (error) {
      const parsed = parseServerError(error);
      setReceiveErrors({ form: parsed.banner });
    }
  }

  async function handleConfirm() {
    if (!confirmAction) return;
    const { kind, purchase, line } = confirmAction;
    setConfirmError(null);
    try {
      if (kind === 'place') {
        await placeMutation.mutateAsync({ id: purchase.id, data: {} });
      } else if (kind === 'cancel') {
        await cancelMutation.mutateAsync({ id: purchase.id, data: {} });
      } else if (kind === 'remove-line') {
        // `item_id` is the PurchaseItem line id, not the catalogue Item id.
        await removeLineMutation.mutateAsync({ id: purchase.id, data: { item_id: line.id } });
      }
      closeConfirm();
    } catch (error) {
      const parsed = parseServerError(error);
      setConfirmError(parsed.banner);
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
      key: 'created_at',
      header: 'Created',
      render: (row) => formatDate(row.purchase_date || row.created_at),
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
            className="btn-secondary px-2.5 py-1.5 text-xs"
            aria-label={`View purchase order ${row.order_no}`}
            onClick={() => setDetailId(row.id)}
          >
            View
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchase Orders"
        description={
          listQuery.isPending
            ? 'Loading purchase orders...'
            : `${count} ${count === 1 ? 'purchase order' : 'purchase orders'}`
        }
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Purchase Order
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load purchase orders — {apiErrorMessage(listQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => listQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Filter bar: server-side search (`q`), status and supplier filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <input
            className="input pr-9"
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search order no or supplier..."
            aria-label="Search purchase orders"
          />
          {search ? (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="size-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>
        <select
          className="input w-full sm:max-w-[13rem]"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
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
        caption="Purchase orders with supplier, status and total"
        onRowClick={(row) => setDetailId(row.id)}
        emptyTitle={hasFilter ? 'No purchase orders match these filters' : 'No purchase orders'}
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters.'
            : 'Create a purchase order to restock items. Add lines while it is a draft, place the order, then receive deliveries in full or in part.'
        }
      />

      {/* Create modal — header only; there is no edit-header endpoint */}
      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="New purchase order"
        description="Order stock from a supplier. The order number is generated for you; add lines next."
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeCreate}>
              Cancel
            </button>
            <button
              type="submit"
              form="purchase-form"
              className="btn-primary"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating...' : 'Create purchase order'}
            </button>
          </>
        }
      >
        {banner ? (
          <div
            className="mb-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            {banner}
          </div>
        ) : null}
        <form id="purchase-form" onSubmit={handleCreateSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Supplier" required error={errors.supplier}>
              <select
                className="input"
                name="supplier"
                value={form.supplier}
                onChange={setField('supplier')}
              >
                <option value="">Select a supplier</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Branch" required error={errors.branch}>
              <select
                className="input"
                name="branch"
                value={form.branch}
                onChange={setField('branch')}
              >
                <option value="">Select a branch</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Expected delivery"
              error={errors.expected_delivery_date}
              hint="Optional — clear the date if you do not know yet"
            >
              <input
                className="input"
                type="date"
                name="expected_delivery_date"
                value={form.expected_delivery_date}
                onChange={setField('expected_delivery_date')}
              />
            </FormField>
            <div className="sm:col-span-2">
              <FormField label="Notes" error={errors.notes} hint="Optional — up to 5000 characters">
                <textarea
                  className="input"
                  name="notes"
                  value={form.notes}
                  onChange={setField('notes')}
                  placeholder="e.g. Urgent restock for the Galle Road showroom"
                  rows={3}
                />
              </FormField>
            </div>
          </div>
        </form>
      </Modal>

      {/* Detail modal — header, lines, receipts, contextual workflow actions */}
      <Modal
        open={detailId !== null}
        onClose={detailLocked ? undefined : closeDetail}
        title={detail ? `Purchase order ${detail.order_no}` : 'Purchase order'}
        description={
          detail
            ? `${STATUS_LABELS[detail.status] || detail.status} · ${detail.supplier_name || 'Supplier'}`
            : 'Loading order...'
        }
        size="xl"
        footer={
          <button
            type="button"
            className="btn-secondary"
            onClick={closeDetail}
            disabled={detailLocked}
          >
            Close
          </button>
        }
      >
        {detailQuery.isPending ? (
          <div className="flex items-center justify-center py-10">
            <div className="size-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            <span className="sr-only">Loading purchase order...</span>
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
          <>
            {/* Header block */}
            <div className="mb-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Order no
                </p>
                <p className="mt-1 font-mono text-sm font-bold text-slate-900">
                  {detail.order_no}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Status
                </p>
                <p className="mt-1">
                  <StatusBadge status={detail.status} />
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Supplier
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {detail.supplier_name || '—'}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Expected delivery
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  {formatDate(detail.expected_delivery_date)}
                </p>
              </div>
              <div className="col-span-2 sm:col-span-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Notes
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                  {detail.notes || '—'}
                </p>
              </div>
              <div className="col-span-2 text-right sm:col-span-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Total
                </p>
                <p className="mt-1 text-lg font-bold tabular-nums text-slate-900">
                  {formatLKR(detail.total)}
                </p>
              </div>
            </div>

            {/* Lines */}
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Item lines
            </p>
            {lines.length === 0 ? (
              <div className="rounded-control border border-dashed border-slate-300 bg-slate-50/60 px-4 py-6 text-center text-sm text-slate-500">
                No lines yet — use “Add line” to build this order.
              </div>
            ) : (
              <div className="overflow-hidden rounded-control border border-slate-200">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50/80">
                      <tr>
                        <th
                          scope="col"
                          className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                        >
                          Item
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-500"
                        >
                          Ordered
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-500"
                        >
                          Received
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-500"
                        >
                          Outstanding
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-500"
                        >
                          Unit cost
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-500"
                        >
                          Total
                        </th>
                        <th scope="col" className="w-20 px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {lines.map((line) => (
                        <tr key={line.id}>
                          <td className="px-4 py-3">
                            <span className="block font-mono text-xs font-semibold text-slate-500">
                              {line.item_code}
                            </span>
                            <span className="block font-medium text-slate-900">
                              {line.item_name}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                            {line.quantity}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                            {line.received_quantity}
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
                            {outstandingOf(line)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                            {formatLKR(line.unit_cost)}
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
                            {formatLKR(line.total)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {Number(line.received_quantity) === 0 &&
                            detail.status !== 'RECEIVED' &&
                            detail.status !== 'CANCELLED' ? (
                              <button
                                type="button"
                                className="btn-ghost px-2 py-1 text-xs"
                                aria-label={`Remove ${line.item_name} from ${detail.order_no}`}
                                onClick={() => openConfirm('remove-line', detail, line)}
                              >
                                Remove
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Receipts */}
            {receipts.length > 0 ? (
              <div className="mt-5">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Receipts
                </p>
                <div className="space-y-2">
                  {receipts.map((receipt) => (
                    <div
                      key={receipt.id}
                      className="rounded-control border border-slate-200 bg-slate-50/60 px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-mono text-sm font-semibold text-slate-900">
                          {receipt.receipt_no}
                        </p>
                        <p className="text-xs text-slate-500">
                          {formatDate(receipt.created_at)}
                        </p>
                      </div>
                      <p className="mt-1 text-sm text-slate-700">{receipt.note || '—'}</p>
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {(receipt.items || []).map((receiptItem) => (
                          <li
                            key={receiptItem.id}
                            className="badge border border-slate-200 bg-white text-slate-600"
                          >
                            {receiptItem.item_code} × {receiptItem.quantity}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Contextual action bar — driven purely by status */}
            <div className="mt-6 border-t border-slate-200 pt-4">
              {detail.status === 'RECEIVED' || detail.status === 'CANCELLED' ? (
                <p className="text-xs text-slate-500">
                  {detail.status === 'RECEIVED'
                    ? 'Fully received — this order is closed and read-only.'
                    : 'This order was cancelled — it is closed and read-only.'}
                </p>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-slate-500">
                    {detail.status === 'DRAFT'
                      ? 'Draft — add lines, then place the order.'
                      : detail.status === 'ORDERED'
                      ? 'Ordered — record deliveries as stock arrives.'
                      : 'Partially received — record the remaining deliveries.'}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {detail.status === 'DRAFT' ? (
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => openConfirm('place', detail)}
                      >
                        Place order
                      </button>
                    ) : null}
                    {detail.status === 'ORDERED' || detail.status === 'PARTIALLY_RECEIVED' ? (
                      <button type="button" className="btn-primary" onClick={openReceiveModal}>
                        Receive stock
                      </button>
                    ) : null}
                    {detail.status === 'DRAFT' || detail.status === 'ORDERED' ? (
                      <button type="button" className="btn-secondary" onClick={openLineModal}>
                        Add line
                      </button>
                    ) : null}
                    {detail.status === 'DRAFT' || detail.status === 'ORDERED' ? (
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => openConfirm('cancel', detail)}
                      >
                        Cancel order
                      </button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : null}
      </Modal>

      {/* Add-line modal (nested over the detail modal) */}
      <Modal
        open={lineModalOpen}
        onClose={closeLineModal}
        title="Add line"
        description={detail ? `Adding to ${detail.order_no} — the order number stays the same.` : ''}
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeLineModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="purchase-line-form"
              className="btn-primary"
              disabled={addLineMutation.isPending}
            >
              {addLineMutation.isPending ? 'Adding...' : 'Add line'}
            </button>
          </>
        }
      >
        {lineBanner ? (
          <div
            className="mb-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            {lineBanner}
          </div>
        ) : null}
        <form id="purchase-line-form" onSubmit={handleLineSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Item" required error={lineErrors.item} className="sm:col-span-2">
              <input
                className="input mb-2"
                type="text"
                value={itemSearch}
                onChange={(event) => setItemSearch(event.target.value)}
                placeholder="Search by item code or name..."
                aria-label="Search items"
              />
              <select
                className="input"
                name="item"
                value={lineForm.item}
                onChange={setLineField('item')}
              >
                <option value="" disabled={itemQuery.isPending}>
                  {itemQuery.isPending ? 'Loading items...' : 'Select an item'}
                </option>
                {itemOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} — {item.name}
                  </option>
                ))}
              </select>
              {itemQuery.isError ? (
                <p className="mt-1.5 text-xs font-medium text-rose-600" role="alert">
                  Could not load items — {apiErrorMessage(itemQuery.error)}
                </p>
              ) : null}
            </FormField>
            <FormField label="Quantity" required error={lineErrors.quantity}>
              <input
                className="input"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                name="quantity"
                value={lineForm.quantity}
                onChange={setLineField('quantity')}
              />
            </FormField>
            <FormField label="Unit cost" required error={lineErrors.unit_cost} hint="LKR">
              <input
                className="input"
                type="number"
                min="0.01"
                step="0.01"
                name="unit_cost"
                value={lineForm.unit_cost}
                onChange={setLineField('unit_cost')}
                placeholder="0.00"
              />
            </FormField>
          </div>
        </form>
      </Modal>

      {/* Receive modal (nested over the detail modal) */}
      <Modal
        open={receiveOpen}
        onClose={closeReceiveModal}
        title={detail ? `Receive stock — ${detail.order_no}` : 'Receive stock'}
        description={
          detail ? `${detail.supplier_name || 'Supplier'} · part or all of the outstanding lines.` : ''
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeReceiveModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="purchase-receive-form"
              className="btn-primary"
              disabled={receiveMutation.isPending}
            >
              {receiveMutation.isPending ? 'Receiving...' : 'Receive stock'}
            </button>
          </>
        }
      >
        <form id="purchase-receive-form" onSubmit={handleReceiveSubmit} noValidate>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-control border border-slate-200 bg-slate-50/70 px-4 py-3">
            <p className="text-xs text-slate-500">
              Enter what actually arrived — you can receive the rest later.
            </p>
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
                        Ordered {line.quantity} · Received {line.received_quantity} · Outstanding{' '}
                        {outstanding}
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
                placeholder="e.g. Delivery arrived in two crates, both checked"
                rows={2}
              />
            </FormField>
          </div>
        </form>
      </Modal>

      {/* Workflow confirmation — every action names the order number */}
      <Modal
        open={Boolean(confirmAction)}
        onClose={closeConfirm}
        title={
          confirmAction
            ? confirmAction.kind === 'place'
              ? `Place ${confirmAction.purchase.order_no}?`
              : confirmAction.kind === 'cancel'
              ? `Cancel ${confirmAction.purchase.order_no}?`
              : `Remove a line from ${confirmAction.purchase.order_no}?`
            : 'Confirm'
        }
        description={
          confirmAction
            ? confirmAction.kind === 'place'
              ? `${confirmAction.purchase.order_no} moves from Draft to Ordered and can then receive stock.`
              : confirmAction.kind === 'cancel'
              ? `${confirmAction.purchase.order_no} closes for good — it can no longer receive stock. This cannot be undone.`
              : `${confirmAction.line
                  ? `${confirmAction.line.item_code} — ${confirmAction.line.item_name}`
                  : 'This line'} will be removed from ${confirmAction.purchase.order_no}.`
            : ''
        }
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeConfirm}>
              Keep as is
            </button>
            <button
              type="button"
              className={confirmAction && confirmAction.kind === 'place' ? 'btn-primary' : 'btn-danger'}
              onClick={handleConfirm}
              disabled={
                placeMutation.isPending || cancelMutation.isPending || removeLineMutation.isPending
              }
            >
              {placeMutation.isPending || cancelMutation.isPending || removeLineMutation.isPending
                ? 'Working...'
                : confirmAction && confirmAction.kind === 'place'
                ? 'Place order'
                : confirmAction && confirmAction.kind === 'cancel'
                ? 'Cancel order'
                : 'Remove line'}
            </button>
          </>
        }
      >
        {confirmError ? (
          <p className="text-sm font-medium text-rose-600" role="alert">
            {confirmError}
          </p>
        ) : (
          <p className="text-sm text-slate-600">
            Check the order number above before continuing — the workflow cannot step backwards.
          </p>
        )}
      </Modal>
    </div>
  );
}
