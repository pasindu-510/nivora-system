import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  branchesApi,
  expenseCategoriesApi,
  recurringExpensesApi,
} from '../api/endpoints.js';
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

/** Default for new templates — computed once, sent explicitly on create. */
const today = toDateInputValue(new Date());

/** Exactly the three choices from RecurringExpense.FREQUENCY_CHOICES. */
const FREQUENCY_OPTIONS = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'CUSTOM', label: 'Custom days' },
];

const EMPTY_FORM = {
  branch: '',
  category: '',
  description: '',
  amount: '',
  frequency: 'MONTHLY',
  interval_days: '30',
  next_due_date: today,
  is_active: true,
};

/** MONTHLY / WEEKLY / CUSTOM -> human label for badges and selects. */
function frequencyLabel(value) {
  const option = FREQUENCY_OPTIONS.find((item) => item.value === value);
  return option ? option.label : value || '—';
}

/** Client-side validation before hitting the API. */
function validateRecurringExpense(values) {
  const errors = {};
  if (!values.category) errors.category = 'Choose an expense category.';
  if (!values.description.trim()) errors.description = 'Description is required.';
  else if (values.description.trim().length > 200)
    errors.description = 'Keep the description under 200 characters.';
  const amount = Number(values.amount);
  if (!values.amount || !Number.isFinite(amount) || amount <= 0)
    errors.amount = 'Enter an amount greater than zero.';
  if (!values.next_due_date) errors.next_due_date = 'Pick the next due date.';
  if (values.frequency === 'CUSTOM') {
    const days = Number(values.interval_days);
    if (!values.interval_days || !Number.isInteger(days) || days < 1)
      errors.interval_days = 'Enter a whole number of days, 1 or more.';
  }
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
export default function RecurringExpensesPage() {
  useDocumentTitle('Recurring Expenses');

  const [categoryFilter, setCategoryFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [frequencyFilter, setFrequencyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Lookup lists feed both the filter bar and the form selects — always on
  // (not gated on the modal) with a generous staleTime so they rarely refetch.
  const categoryQuery = useQuery({
    queryKey: qk.finance.expenseCategories(LOOKUP_PARAMS),
    queryFn: async () => (await expenseCategoriesApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const branchQuery = useQuery({
    queryKey: qk.branches.list(LOOKUP_PARAMS),
    queryFn: async () => (await branchesApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });

  const categories = (categoryQuery.data && categoryQuery.data.results) || [];
  const branches = (branchQuery.data && branchQuery.data.results) || [];

  // Server-side filtering: DjangoFilterBackend exact matches only — the
  // endpoint exposes branch, category, frequency and is_active (no `q` search).
  const listParams = {
    page_size: 100,
    ordering: 'next_due_date',
    category: categoryFilter || undefined,
    branch: branchFilter || undefined,
    frequency: frequencyFilter || undefined,
    is_active: statusFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.finance.recurringExpenses(listParams),
    queryFn: async () => (await recurringExpensesApi.list(listParams)).data,
  });

  const createMutation = useApiMutation((data) => recurringExpensesApi.create(data), {
    invalidates: [qk.finance.root],
  });
  const editMutation = useApiMutation(({ id, data }) => recurringExpensesApi.patch(id, data), {
    invalidates: [qk.finance.root],
  });
  const deleteMutation = useApiMutation(({ id }) => recurringExpensesApi.remove(id), {
    invalidates: [qk.finance.root],
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const hasFilter = Boolean(categoryFilter || branchFilter || frequencyFilter || statusFilter);

  const setField = (key) => (event) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  // Frequency drives interval_days: weekly is 7, monthly is 30, custom is the
  // user's own whole-day interval (kept as-is when switching into custom).
  function setFrequency(value) {
    setForm((prev) => ({
      ...prev,
      frequency: value,
      interval_days:
        value === 'WEEKLY' ? '7' : value === 'MONTHLY' ? '30' : prev.interval_days,
    }));
  }

  function clearFilters() {
    setCategoryFilter('');
    setBranchFilter('');
    setFrequencyFilter('');
    setStatusFilter('');
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setErrors({});
    setBanner(null);
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(row) {
    setForm({
      branch: row.branch || '',
      category: row.category || '',
      description: row.description || '',
      amount: String(row.amount ?? ''),
      frequency: row.frequency || 'MONTHLY',
      interval_days: String(row.interval_days ?? 30),
      next_due_date: toDateInputValue(row.next_due_date),
      is_active: Boolean(row.is_active),
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
    const clientErrors = validateRecurringExpense(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;

    // Plain ModelSerializer — create and patch take the exact same fields.
    const payload = {
      branch: form.branch ? Number(form.branch) : null,
      category: Number(form.category),
      description: form.description.trim(),
      amount: String(form.amount).trim(),
      frequency: form.frequency,
      interval_days: Number(form.interval_days) || 30,
      next_due_date: form.next_due_date || undefined,
      is_active: Boolean(form.is_active),
    };

    try {
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

  const columns = [
    {
      key: 'description',
      header: 'Description',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => (
        <span className="block max-w-sm truncate" title={row.description || ''}>
          {row.description || '—'}
        </span>
      ),
    },
    {
      key: 'category_name',
      header: 'Category',
      render: (row) => row.category_name || '—',
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatLKR(row.amount),
    },
    {
      key: 'frequency',
      header: 'Frequency',
      render: (row) => (
        <span className="badge bg-brand-50 text-brand-700">{frequencyLabel(row.frequency)}</span>
      ),
    },
    {
      key: 'next_due_date',
      header: 'Next due',
      render: (row) => formatDate(row.next_due_date),
    },
    {
      key: 'branch_name',
      header: 'Branch',
      // Read serializer returns only the branch id — resolve the label here.
      render: (row) => branches.find((branch) => branch.id === row.branch)?.name || 'All branches',
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
            aria-label={`Edit recurring expense ${row.description}`}
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
            aria-label={`Delete recurring expense ${row.description}`}
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
        title="Recurring Expenses"
        description={
          listQuery.isPending
            ? 'Loading recurring expenses...'
            : `${count} ${count === 1 ? 'template' : 'templates'}`
        }
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Recurring Expense
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load recurring expenses — {apiErrorMessage(listQuery.error)}</span>
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

      {/* Filter bar: exact-match server-side filters only (no text search on
          this endpoint). */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
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
          value={frequencyFilter}
          onChange={(event) => setFrequencyFilter(event.target.value)}
          aria-label="Filter by frequency"
        >
          <option value="">All frequencies</option>
          {FREQUENCY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:max-w-[12rem]"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
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
        caption="Recurring expense templates with next due dates"
        onRowClick={openEdit}
        emptyTitle={hasFilter ? 'No recurring expenses match these filters' : 'No recurring expenses'}
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters.'
            : 'Define repeating costs with their next due date so future cash outflows are planned, not surprises.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? 'Edit recurring expense' : 'New recurring expense'}
        description={
          editing
            ? 'Update category, amount, frequency, next due date, and branch.'
            : 'Define a repeating cost — rent, salaries, utilities — for the cash-flow forecast.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="recurring-expense-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                ? 'Saving...'
                : 'Create template'}
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
        <form id="recurring-expense-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Category" required error={errors.category}>
              <select
                className="input"
                name="category"
                value={form.category}
                onChange={setField('category')}
              >
                <option value="">Select a category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Amount" required error={errors.amount} hint="LKR">
              <input
                className="input"
                type="number"
                min="0.01"
                step="0.01"
                name="amount"
                value={form.amount}
                onChange={setField('amount')}
                placeholder="0.00"
              />
            </FormField>
            <FormField
              label="Branch"
              error={errors.branch}
              hint="Optional — leave as all branches for business-wide costs"
            >
              <select
                className="input"
                name="branch"
                value={form.branch}
                onChange={setField('branch')}
              >
                <option value="">All branches</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Frequency" required error={errors.frequency}>
              <select
                className="input"
                name="frequency"
                value={form.frequency}
                onChange={(event) => setFrequency(event.target.value)}
              >
                {FREQUENCY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Interval days"
              error={errors.interval_days}
              hint="Weekly is every 7 days, monthly every 30. Edit only for Custom days."
            >
              <input
                className="input"
                type="number"
                min="1"
                step="1"
                name="interval_days"
                value={form.interval_days}
                onChange={setField('interval_days')}
                disabled={form.frequency !== 'CUSTOM'}
              />
            </FormField>
            <FormField label="Next due date" required error={errors.next_due_date}>
              <input
                className="input"
                type="date"
                name="next_due_date"
                value={form.next_due_date}
                onChange={setField('next_due_date')}
              />
            </FormField>
            <div className="sm:col-span-2">
              <FormField label="Description" required error={errors.description}>
                <textarea
                  className="input"
                  name="description"
                  value={form.description}
                  onChange={setField('description')}
                  placeholder="e.g. Monthly shop electricity bill"
                  rows={3}
                />
              </FormField>
            </div>
            <FormField label="Status" error={errors.is_active}>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="size-4 rounded border-slate-300"
                  checked={form.is_active}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, is_active: event.target.checked }))
                  }
                />
                Active template
              </label>
            </FormField>
          </div>
        </form>
      </Modal>

      {/* Delete confirm — plain confirm, no dependency protection on this backend */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete recurring expense?"
        description={
          deleteTarget
            ? `“${deleteTarget.description}” will be permanently removed. This action cannot be undone.`
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
