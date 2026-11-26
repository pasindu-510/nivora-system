import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  brandsApi,
  categoriesApi,
  itemsApi,
  seasonalDiscountsApi,
} from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate, toDateInputValue } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';

const LOOKUP_PARAMS = { page_size: 100 };

/** Scope choices — mirrors SeasonalDiscount.SCOPE_CHOICES on the backend. */
const SCOPES = [
  { value: 'ALL', label: 'All' },
  { value: 'CATEGORY', label: 'Category' },
  { value: 'BRAND', label: 'Brand' },
  { value: 'ITEM', label: 'Product' },
];

/** Default for new discounts — computed once, sent explicitly on create. */
const today = toDateInputValue(new Date());

const EMPTY_FORM = {
  name: '',
  scope: 'ALL',
  target_id: '',
  discount_percentage: '',
  start_date: today,
  end_date: today,
  is_active: true,
};

/** Client-side validation before hitting the API. */
function validateDiscount(values) {
  const errors = {};
  const name = values.name.trim();
  if (!name) errors.name = 'Name is required.';
  else if (name.length > 200) errors.name = 'Keep the name under 200 characters.';

  const percentage = Number(values.discount_percentage);
  if (!values.discount_percentage || !Number.isFinite(percentage))
    errors.discount_percentage = 'Enter a discount percentage.';
  else if (percentage <= 0) errors.discount_percentage = 'Discount must be greater than zero.';
  else if (percentage > 100) errors.discount_percentage = 'Discount cannot exceed 100%.';

  if (!values.start_date) errors.start_date = 'Start date is required.';
  if (!values.end_date) errors.end_date = 'End date is required.';
  else if (values.start_date && values.end_date < values.start_date)
    errors.end_date = 'End date cannot be before the start date.';

  // target_id only matters for CATEGORY / BRAND / ITEM — ALL sends null.
  if (values.scope !== 'ALL' && !values.target_id) {
    const label = SCOPES.find((scope) => scope.value === values.scope)?.label || values.scope;
    errors.target_id = `Choose a ${label.toLowerCase()} for this discount.`;
  }
  return errors;
}

/**
 * One payload for create and patch (plain ModelSerializer on this endpoint).
 * Never sends `id` or `created_at`; ALL scope always sends `target_id: null`.
 */
function buildPayload(values) {
  return {
    name: values.name.trim(),
    scope: values.scope,
    target_id: values.scope === 'ALL' || !values.target_id ? null : Number(values.target_id),
    discount_percentage: String(values.discount_percentage).trim(),
    start_date: values.start_date,
    end_date: values.end_date,
    is_active: Boolean(values.is_active),
  };
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
export default function PromotionsPage() {
  useDocumentTitle('Promotions');

  const [scopeFilter, setScopeFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [startDateFilter, setStartDateFilter] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [debouncedItemSearch, setDebouncedItemSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // The item picker search — item catalogs are large, debounce keystrokes ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedItemSearch(itemSearch.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [itemSearch]);

  // Lookup lists feed the target pickers, the filter bar, and the table's
  // resolved target labels — always on with a generous staleTime.
  const categoryQuery = useQuery({
    queryKey: qk.categories.list(LOOKUP_PARAMS),
    queryFn: async () => (await categoriesApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const brandQuery = useQuery({
    queryKey: qk.brands.list(LOOKUP_PARAMS),
    queryFn: async () => (await brandsApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const itemParams = { page_size: 100, q: debouncedItemSearch || undefined };
  const itemQuery = useQuery({
    queryKey: qk.items.list(itemParams),
    queryFn: async () => (await itemsApi.list(itemParams)).data,
    staleTime: 5 * 60 * 1000,
  });

  const categories = (categoryQuery.data && categoryQuery.data.results) || [];
  const brands = (brandQuery.data && brandQuery.data.results) || [];
  const items = (itemQuery.data && itemQuery.data.results) || [];

  // Server-side filtering: DjangoFilterBackend exact matches only —
  // there is no `q` search param on this endpoint.
  const listParams = {
    page_size: 100,
    ordering: '-start_date',
    scope: scopeFilter || undefined,
    is_active: activeFilter || undefined,
    start_date: startDateFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.promotions.list(listParams),
    queryFn: async () => (await seasonalDiscountsApi.list(listParams)).data,
  });

  const createMutation = useApiMutation((data) => seasonalDiscountsApi.create(data), {
    invalidates: [qk.promotions.root],
  });
  const editMutation = useApiMutation(({ id, data }) => seasonalDiscountsApi.patch(id, data), {
    invalidates: [qk.promotions.root],
  });
  const deleteMutation = useApiMutation(({ id }) => seasonalDiscountsApi.remove(id), {
    invalidates: [qk.promotions.root],
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const hasFilter = Boolean(scopeFilter || activeFilter || startDateFilter);

  const setField = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Switching scope drops the chosen target — a category id must never be
  // submitted as a brand id, and ALL ignores any stale target entirely.
  function handleScopeChange(event) {
    const scope = event.target.value;
    setForm((prev) => ({ ...prev, scope, target_id: '' }));
    setItemSearch('');
  }

  function clearFilters() {
    setScopeFilter('');
    setActiveFilter('');
    setStartDateFilter('');
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setErrors({});
    setBanner(null);
    setEditing(null);
    setItemSearch('');
    setModalOpen(true);
  }

  function openEdit(row) {
    setForm({
      name: row.name || '',
      scope: row.scope || 'ALL',
      target_id: row.target_id ? String(row.target_id) : '',
      discount_percentage: String(row.discount_percentage ?? ''),
      start_date: toDateInputValue(row.start_date),
      end_date: toDateInputValue(row.end_date),
      is_active: Boolean(row.is_active),
    });
    setErrors({});
    setBanner(null);
    setEditing(row);
    setItemSearch('');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const clientErrors = validateDiscount(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      const payload = buildPayload(form);
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
      setActionError(apiErrorMessage(error));
    }
  }

  /** Resolve the target id to a readable label, falling back to `#<id>`. */
  function resolveTarget(row) {
    if (!row.scope || row.scope === 'ALL') return 'All products';
    if (!row.target_id) return '—';
    const pool = row.scope === 'CATEGORY' ? categories : row.scope === 'BRAND' ? brands : items;
    const match = pool.find((entry) => entry.id === row.target_id);
    return match ? match.name : `#${row.target_id}`;
  }

  const columns = [
    {
      key: 'name',
      header: 'Name',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => row.name,
    },
    {
      key: 'target',
      header: 'Applies to',
      render: (row) => resolveTarget(row),
    },
    {
      key: 'discount_percentage',
      header: 'Discount',
      cellClassName: 'font-semibold text-slate-900',
      // Raw percentage — never run through formatLKR.
      render: (row) =>
        row.discount_percentage === null || row.discount_percentage === undefined
          ? '—'
          : `${row.discount_percentage}%`,
    },
    {
      key: 'date_range',
      header: 'Runs',
      render: (row) => `${formatDate(row.start_date)} → ${formatDate(row.end_date)}`,
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (row) => (
        <span
          className={`badge ${
            row.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {row.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
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
            aria-label={`Edit discount ${row.name}`}
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
            aria-label={`Delete discount ${row.name}`}
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
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Promotions"
        description={
          listQuery.isPending
            ? 'Loading discounts...'
            : `${count} ${count === 1 ? 'seasonal discount' : 'seasonal discounts'}`
        }
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Discount
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load discounts — {apiErrorMessage(listQuery.error)}</span>
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

      {/* Filter bar: exact-match server-side filters only — no text search on
          this endpoint (`q` is not a filter here). */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          className="input w-full sm:w-auto"
          value={scopeFilter}
          onChange={(event) => setScopeFilter(event.target.value)}
          aria-label="Filter by scope"
        >
          <option value="">All scopes</option>
          {SCOPES.map((scope) => (
            <option key={scope.value} value={scope.value}>
              {scope.label}
            </option>
          ))}
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
        <input
          className="input w-full sm:max-w-[12rem]"
          type="date"
          value={startDateFilter}
          onChange={(event) => setStartDateFilter(event.target.value)}
          aria-label="Filter by start date"
          title="Exact day — matches this start date only"
        />
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
        caption="Seasonal discounts scoped to everything, a category, a brand, or a product"
        onRowClick={openEdit}
        emptyTitle={hasFilter ? 'No discounts match these filters' : 'No seasonal discounts yet'}
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters.'
            : 'Create a seasonal discount and it will be applied automatically to matching products at the counter.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.name}` : 'New seasonal discount'}
        description={
          editing
            ? 'Update the scope, percentage, dates, and active status.'
            : 'Discount matching products automatically for a date range — everything, a category, a brand, or a single product.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="promotion-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                ? 'Saving...'
                : 'Create discount'}
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
        <form id="promotion-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FormField label="Name" required error={errors.name}>
                <input
                  className="input"
                  name="name"
                  value={form.name}
                  onChange={setField('name')}
                  placeholder="e.g. Avurudu sale"
                  maxLength={200}
                  autoFocus
                />
              </FormField>
            </div>
            <FormField label="Scope" required error={errors.scope}>
              <select
                className="input"
                name="scope"
                value={form.scope}
                onChange={handleScopeChange}
              >
                {SCOPES.map((scope) => (
                  <option key={scope.value} value={scope.value}>
                    {scope.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Discount %"
              required
              error={errors.discount_percentage}
              hint="Percentage off — up to 100"
            >
              <input
                className="input"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                name="discount_percentage"
                value={form.discount_percentage}
                onChange={setField('discount_percentage')}
                placeholder="15.00"
              />
            </FormField>

            {/* Conditional target picker — nothing renders for ALL scope. */}
            {form.scope === 'CATEGORY' ? (
              <div className="sm:col-span-2">
                <FormField label="Category" required error={errors.target_id}>
                  <select
                    className="input"
                    name="target_id"
                    value={form.target_id}
                    onChange={setField('target_id')}
                  >
                    <option value="">Select a category</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                    {form.target_id &&
                    !categories.some((category) => String(category.id) === String(form.target_id)) ? (
                      <option value={form.target_id}>{`#${form.target_id}`}</option>
                    ) : null}
                  </select>
                </FormField>
              </div>
            ) : null}
            {form.scope === 'BRAND' ? (
              <div className="sm:col-span-2">
                <FormField label="Brand" required error={errors.target_id}>
                  <select
                    className="input"
                    name="target_id"
                    value={form.target_id}
                    onChange={setField('target_id')}
                  >
                    <option value="">Select a brand</option>
                    {brands.map((brand) => (
                      <option key={brand.id} value={brand.id}>
                        {brand.name}
                      </option>
                    ))}
                    {form.target_id &&
                    !brands.some((brand) => String(brand.id) === String(form.target_id)) ? (
                      <option value={form.target_id}>{`#${form.target_id}`}</option>
                    ) : null}
                  </select>
                </FormField>
              </div>
            ) : null}
            {form.scope === 'ITEM' ? (
              <div className="sm:col-span-2">
                <FormField
                  label="Product"
                  required
                  error={errors.target_id}
                  hint="Search the catalog, then pick the product this discount applies to"
                >
                  <div className="space-y-2">
                    <input
                      className="input"
                      type="search"
                      value={itemSearch}
                      onChange={(event) => setItemSearch(event.target.value)}
                      placeholder="Search products by name or code..."
                      aria-label="Search products"
                    />
                    <select
                      className="input"
                      name="target_id"
                      value={form.target_id}
                      onChange={setField('target_id')}
                    >
                      <option value="">Select a product</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                      {form.target_id &&
                      !items.some((item) => String(item.id) === String(form.target_id)) ? (
                        <option value={form.target_id}>{`#${form.target_id}`}</option>
                      ) : null}
                    </select>
                  </div>
                </FormField>
              </div>
            ) : null}

            <FormField label="Start date" required error={errors.start_date}>
              <input
                className="input"
                type="date"
                name="start_date"
                value={form.start_date}
                onChange={setField('start_date')}
              />
            </FormField>
            <FormField label="End date" required error={errors.end_date}>
              <input
                className="input"
                type="date"
                name="end_date"
                value={form.end_date}
                onChange={setField('end_date')}
              />
            </FormField>
            <FormField label="Status" error={errors.is_active}>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="size-4 rounded border-slate-300"
                  checked={form.is_active}
                  onChange={setField('is_active')}
                />
                Active discount
              </label>
            </FormField>
          </div>
        </form>
      </Modal>

      {/* Delete confirm — plain confirm, no dependency protection on this backend */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete discount?"
        description={
          deleteTarget
            ? `“${deleteTarget.name}” will be permanently removed. This action cannot be undone.`
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
