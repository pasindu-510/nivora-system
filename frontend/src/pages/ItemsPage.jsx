import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { itemsApi, categoriesApi, brandsApi, branchesApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';
import PhotoUpload from '../components/PhotoUpload.jsx';
import Icon from '../components/Icon.jsx';

const EMPTY_FORM = {
  code: '',
  name: '',
  category: '',
  brand: '',
  cost_price: '',
  selling_price: '',
  low_stock_threshold: '5',
  is_active: true,
  opening_stock: '',
  opening_branch: '',
  image: null, // File | null — handed to PhotoUpload, sent multipart when set
};

const LOOKUP_PARAMS = { page_size: 100 };

/** Client-side validation before hitting the API. */
function validateItem(values, mode) {
  const errors = {};
  if (!values.code.trim()) errors.code = 'Code is required.';
  if (!values.name.trim()) errors.name = 'Name is required.';

  const costRaw = values.cost_price.trim();
  const cost = costRaw === '' ? NaN : Number(costRaw);
  if (costRaw === '') errors.cost_price = 'Cost price is required.';
  else if (!Number.isFinite(cost) || cost < 0) errors.cost_price = 'Enter a number of 0 or more.';

  const sellingRaw = values.selling_price.trim();
  const selling = sellingRaw === '' ? NaN : Number(sellingRaw);
  if (sellingRaw === '') errors.selling_price = 'Selling price is required.';
  else if (!Number.isFinite(selling) || selling < 0) {
    errors.selling_price = 'Enter a number of 0 or more.';
  }

  if (values.low_stock_threshold.trim() !== '') {
    const threshold = Number(values.low_stock_threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || !Number.isInteger(threshold)) {
      errors.low_stock_threshold = 'Enter a whole number of 0 or more.';
    }
  }

  // Opening stock is create-only; empty or 0 means "start at zero".
  if (mode === 'create' && values.opening_stock.trim() !== '') {
    const opening = Number(values.opening_stock);
    if (!Number.isFinite(opening) || opening < 0 || !Number.isInteger(opening)) {
      errors.opening_stock = 'Enter a whole number of 0 or more.';
    } else if (opening >= 1 && !values.opening_branch) {
      errors.opening_branch = 'Select the branch that receives this opening stock.';
    }
  }
  return errors;
}

/**
 * Build the wire payload. With an image File selected everything is sent as
 * FormData (axios sets multipart); otherwise plain JSON. Nullable FKs go out
 * as null in JSON and as '' in FormData — DRF maps '' to None for allow_null
 * fields on html-shaped input.
 */
function buildPayload(values, mode) {
  const opening =
    mode === 'create' && values.opening_stock.trim() !== '' ? Number(values.opening_stock) : 0;
  const base = {
    code: values.code.trim().toUpperCase(),
    name: values.name.trim(),
    category: values.category === '' ? null : Number(values.category),
    brand: values.brand === '' ? null : Number(values.brand),
    cost_price: Number(values.cost_price),
    selling_price: Number(values.selling_price),
    low_stock_threshold:
      values.low_stock_threshold.trim() === '' ? 5 : Number(values.low_stock_threshold),
    is_active: Boolean(values.is_active),
  };
  if (opening >= 1) {
    base.opening_stock = opening;
    base.opening_branch = Number(values.opening_branch);
  }

  if (!(values.image instanceof File)) return base;

  const fd = new FormData();
  Object.entries(base).forEach(([key, value]) => {
    if (value === null || value === undefined) fd.append(key, '');
    else if (typeof value === 'boolean') fd.append(key, value ? 'true' : 'false');
    else fd.append(key, String(value));
  });
  fd.append('image', values.image);
  return fd;
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

/**
 * Stock cell — the star of the page. Bold total, LOW badge at/below the
 * threshold, muted out-of-stock state, and one neutral chip per branch that
 * holds stock so a cashier can answer "do you have it in Kandy?".
 */
function StockCell({ item }) {
  const total = Number(item.stock_quantity) || 0;
  const threshold = Number(item.low_stock_threshold) || 0;
  const branchStock = Array.isArray(item.branch_stock) ? item.branch_stock : [];
  const isOut = total <= 0;
  const isLow = total <= threshold;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {isOut ? (
          <span className="text-sm font-medium text-slate-400">0</span>
        ) : (
          <span className="text-sm font-bold text-slate-900">{total}</span>
        )}
        {isOut ? <span className="text-xs text-slate-400">Out of stock</span> : null}
        {isLow ? <span className="badge bg-rose-50 text-rose-600">LOW</span> : null}
      </div>
      {branchStock.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {branchStock.map((entry) => (
            <span
              key={entry.branch_id}
              className="badge bg-slate-100 text-slate-600"
            >
              {entry.branch_name} <span className="font-bold">{entry.quantity}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Shared create/edit form controls (house style: FormField + input). */
function ItemFormFields({
  form,
  errors,
  onChange,
  onImageChange,
  mode,
  editing,
  categories,
  brands,
  activeBranches,
  lookupLoading,
}) {
  const openingQty = form.opening_stock.trim() === '' ? 0 : Number(form.opening_stock);
  const openingNeedsBranch = Number.isFinite(openingQty) && openingQty >= 1;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField
          label="Code"
          required
          error={errors.code}
          hint="Uppercase and unique within your business — e.g. AC-001."
        >
          <input
            className="input"
            name="code"
            value={form.code}
            onChange={onChange('code')}
            placeholder="e.g. AC-001"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </FormField>
        <FormField label="Name" required error={errors.name}>
          <input
            className="input"
            name="name"
            value={form.name}
            onChange={onChange('name')}
            placeholder="e.g. LG 1.5T Split AC"
          />
        </FormField>
        <FormField label="Category" error={errors.category}>
          <select
            className="input"
            name="category"
            value={form.category}
            onChange={onChange('category')}
            disabled={lookupLoading}
          >
            <option value="">No category</option>
            {categories.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Brand" error={errors.brand}>
          <select
            className="input"
            name="brand"
            value={form.brand}
            onChange={onChange('brand')}
            disabled={lookupLoading}
          >
            <option value="">No brand</option>
            {brands.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Cost price" required error={errors.cost_price}>
          <input
            className="input"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            name="cost_price"
            value={form.cost_price}
            onChange={onChange('cost_price')}
            placeholder="0.00"
          />
        </FormField>
        <FormField label="Selling price" required error={errors.selling_price}>
          <input
            className="input"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            name="selling_price"
            value={form.selling_price}
            onChange={onChange('selling_price')}
            placeholder="0.00"
          />
        </FormField>
        <FormField
          label="Low stock threshold"
          error={errors.low_stock_threshold}
          hint="Show a LOW badge when stock falls to or below this quantity."
        >
          <input
            className="input"
            type="number"
            step="1"
            min="0"
            name="low_stock_threshold"
            value={form.low_stock_threshold}
            onChange={onChange('low_stock_threshold')}
            placeholder="5"
          />
        </FormField>
        <FormField
          label="Status"
          error={errors.is_active}
          hint="Inactive items are hidden from new sales."
        >
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              checked={form.is_active}
              onChange={onChange('is_active')}
            />
            Item is active
          </label>
        </FormField>
        <div className="sm:col-span-2">
          {editing && editing.image && !form.image ? (
            <div className="mb-3 flex items-center gap-3">
              <img
                src={editing.image}
                alt=""
                className="size-16 rounded-lg border border-slate-200 object-cover"
              />
              <p className="text-xs text-slate-500">
                Current image — choose a replacement to change it.
              </p>
            </div>
          ) : null}
          <PhotoUpload
            label="Image"
            id="item-image-upload"
            value={form.image}
            onChange={onImageChange}
            error={errors.image}
          />
        </div>
      </div>

      {/* Create-only: seed a real FIFO lot so the item is sellable on day one. */}
      {mode === 'create' ? (
        <div className="mt-5 rounded-control border border-slate-200 bg-slate-50/70 p-4">
          <p className="text-sm font-bold text-slate-900">Opening stock</p>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Quantity" error={errors.opening_stock}>
              <input
                className="input"
                type="number"
                step="1"
                min="0"
                name="opening_stock"
                value={form.opening_stock}
                onChange={onChange('opening_stock')}
                placeholder="0"
              />
            </FormField>
            <FormField
              label="Branch"
              required={openingNeedsBranch}
              error={errors.opening_branch}
            >
              <select
                className="input"
                name="opening_branch"
                value={form.opening_branch}
                onChange={onChange('opening_branch')}
                disabled={lookupLoading}
              >
                <option value="">
                  {lookupLoading ? 'Loading branches...' : 'Select branch'}
                </option>
                {activeBranches.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Opening stock creates a real FIFO cost lot on the selected branch, making the item
            immediately sellable.
          </p>
        </div>
      ) : null}
    </>
  );
}

/* ---------------------------------- page ---------------------------------- */
export default function ItemsPage() {
  useDocumentTitle('Items');

  const { user } = useAuth();
  const readOnly = Boolean(user && user.role === 'cashier');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [activeFilter, setActiveFilter] = useState(''); // '' | 'true' | 'false'
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side search on code/name — debounce keystrokes ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const listParams = {
    page_size: 100,
    q: debouncedSearch || undefined,
    category: categoryFilter || undefined,
    brand: brandFilter || undefined,
    is_active: activeFilter || undefined,
    low_stock: lowStockOnly ? true : undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.items.list(listParams),
    queryFn: async () => (await itemsApi.list(listParams)).data,
  });

  // Categories/brands back both the filter bar and the modal — one cached
  // fetch each, refreshed only by their own pages (never invalidated here).
  const categoriesQuery = useQuery({
    queryKey: qk.categories.list(LOOKUP_PARAMS),
    queryFn: async () => (await categoriesApi.list(LOOKUP_PARAMS)).data,
  });
  const brandsQuery = useQuery({
    queryKey: qk.brands.list(LOOKUP_PARAMS),
    queryFn: async () => (await brandsApi.list(LOOKUP_PARAMS)).data,
  });
  // Branches are only needed by the create modal's opening-stock picker.
  const branchesQuery = useQuery({
    queryKey: qk.branches.list(LOOKUP_PARAMS),
    queryFn: async () => (await branchesApi.list(LOOKUP_PARAMS)).data,
    enabled: modalOpen && !editing,
  });

  const createMutation = useApiMutation((data) => itemsApi.create(data), {
    invalidates: [qk.items.root, qk.stock.root],
  });
  const editMutation = useApiMutation(({ id, data }) => itemsApi.patch(id, data), {
    invalidates: [qk.items.root],
  });
  const deleteMutation = useApiMutation(({ id }) => itemsApi.remove(id), {
    invalidates: [qk.items.root, qk.stock.root],
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const categories = (categoriesQuery.data && categoriesQuery.data.results) || [];
  const brands = (brandsQuery.data && brandsQuery.data.results) || [];
  const branches = (branchesQuery.data && branchesQuery.data.results) || [];
  const activeBranches = branches.filter((row) => row.is_active);
  const lookupLoading =
    categoriesQuery.isPending || brandsQuery.isPending || branchesQuery.isPending;

  const hasFilters = Boolean(
    debouncedSearch || categoryFilter || brandFilter || lowStockOnly || activeFilter
  );

  const setField = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  function openCreate() {
    setForm(EMPTY_FORM);
    setErrors({});
    setBanner(null);
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(row) {
    if (readOnly) return;
    setForm({
      code: row.code || '',
      name: row.name || '',
      category: row.category != null ? String(row.category) : '',
      brand: row.brand != null ? String(row.brand) : '',
      cost_price: row.cost_price != null ? String(row.cost_price) : '',
      selling_price: row.selling_price != null ? String(row.selling_price) : '',
      low_stock_threshold:
        row.low_stock_threshold != null ? String(row.low_stock_threshold) : '5',
      is_active: Boolean(row.is_active),
      opening_stock: '',
      opening_branch: '',
      image: null,
    });
    setErrors({});
    setBanner(null);
    setEditing(row);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const mode = editing ? 'edit' : 'create';
    const clientErrors = validateItem(form, mode);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      const payload = buildPayload(form, mode);
      if (editing) await editMutation.mutateAsync({ id: editing.id, data: payload });
      else await createMutation.mutateAsync(payload);
      closeModal();
      setForm(EMPTY_FORM);
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setActionError(null);
    try {
      await deleteMutation.mutateAsync({ id: deleteTarget.id });
      setDeleteTarget(null);
    } catch (error) {
      // 400 "has sale or purchase history..." lands here via data.detail.
      setActionError(apiErrorMessage(error));
    }
  }

  const columns = [
    {
      key: 'image',
      header: '',
      width: '4rem',
      render: (row) =>
        row.image ? (
          <img src={row.image} alt="" className="h-10 w-10 rounded object-cover" />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded bg-slate-100 text-slate-400">
            <Icon name="box" className="size-5" />
          </span>
        ),
    },
    {
      key: 'code',
      header: 'Code',
      render: (row) => <span className="font-mono text-xs font-semibold">{row.code}</span>,
    },
    {
      key: 'name',
      header: 'Name',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => row.name,
    },
    { key: 'category', header: 'Category', render: (row) => row.category_name || '—' },
    { key: 'brand', header: 'Brand', render: (row) => row.brand_name || '—' },
    {
      key: 'selling_price',
      header: 'Selling',
      align: 'right',
      render: (row) => formatLKR(Number(row.selling_price)),
    },
    { key: 'stock', header: 'Stock', render: (row) => <StockCell item={row} /> },
    {
      key: 'is_active',
      header: 'Status',
      render: (row) =>
        row.is_active ? (
          <span className="badge bg-emerald-50 text-emerald-700">Active</span>
        ) : (
          <span className="badge bg-slate-100 text-slate-500">Inactive</span>
        ),
    },
    ...(readOnly
      ? []
      : [
          {
            key: 'cost_price',
            header: 'Cost',
            align: 'right',
            render: (row) => formatLKR(Number(row.cost_price)),
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
                  className="btn-secondary px-2 py-1.5"
                  aria-label={`Edit ${row.name}`}
                  title="Edit"
                  onClick={() => openEdit(row)}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="size-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="btn-danger px-2 py-1.5"
                  aria-label={`Delete ${row.name}`}
                  title="Delete"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    setActionError(null);
                    setDeleteTarget(row);
                  }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="size-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                    />
                  </svg>
                </button>
              </div>
            ),
          },
        ]),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Items"
        description={
          listQuery.isPending
            ? 'Loading items...'
            : `${count} ${count === 1 ? 'item' : 'items'}`
        }
        actions={
          readOnly ? null : (
            <button type="button" className="btn-primary" onClick={openCreate}>
              + New Item
            </button>
          )
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load items — {apiErrorMessage(listQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => listQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {actionError && !deleteTarget ? (
        <div
          className="rounded-control border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
          role="alert"
        >
          {actionError}
        </div>
      ) : null}

      {/* Compact filter bar: search + category + brand + stock + status */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <input
          className="input w-full sm:max-w-xs"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by code or name..."
          aria-label="Search items"
        />
        <select
          className="input w-full sm:w-auto sm:min-w-40"
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categories.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:w-auto sm:min-w-36"
          value={brandFilter}
          onChange={(event) => setBrandFilter(event.target.value)}
          aria-label="Filter by brand"
        >
          <option value="">All brands</option>
          {brands.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:w-auto"
          value={lowStockOnly ? 'low' : ''}
          onChange={(event) => setLowStockOnly(event.target.value === 'low')}
          aria-label="Filter by stock level"
        >
          <option value="">All stock</option>
          <option value="low">Low stock</option>
        </select>
        <select
          className="input w-full sm:w-auto"
          value={activeFilter}
          onChange={(event) => setActiveFilter(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Catalog items with per-branch stock"
        onRowClick={readOnly ? undefined : openEdit}
        emptyTitle={hasFilters ? 'No items match your filters' : 'No items yet'}
        emptyDescription={
          hasFilters
            ? 'Try a different search term or clear some filters.'
            : 'Add your first item to start tracking stock levels, selling prices, and FIFO cost lots.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.name}` : 'New item'}
        description={
          editing
            ? 'Update pricing, classification, image, and status. Stock changes go through purchases, sales, or stock movements.'
            : 'Add a catalog item. Optionally seed opening stock on a branch so it sells immediately.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="item-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                  ? 'Creating...'
                  : 'Create item'}
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
        <form id="item-form" onSubmit={handleSubmit} noValidate>
          <ItemFormFields
            form={form}
            errors={errors}
            onChange={setField}
            onImageChange={(file) => setForm((prev) => ({ ...prev, image: file }))}
            mode={editing ? 'edit' : 'create'}
            editing={editing}
            categories={categories}
            brands={brands}
            activeBranches={activeBranches}
            lookupLoading={lookupLoading}
          />
        </form>
      </Modal>

      {/* Delete confirm — history-protected items surface the 400 detail here */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete item?"
        description={
          deleteTarget
            ? `“${deleteTarget.name}” will be removed from the catalog. Items with sale or purchase history cannot be deleted — deactivate them instead.`
            : ''
        }
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={handleDeleteConfirm}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </button>
          </>
        }
      >
        {actionError ? (
          <p className="text-sm font-medium text-rose-600" role="alert">
            {actionError}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
