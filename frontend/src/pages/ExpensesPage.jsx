import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  branchesApi,
  cashAccountsApi,
  expenseCategoriesApi,
  expensesApi,
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
const ACCOUNT_PARAMS = { page_size: 100, is_active: true };

/** Default for new expenses — computed once, sent explicitly on create. */
const today = toDateInputValue(new Date());

const EMPTY_FORM = {
  branch: '',
  category: '',
  description: '',
  amount: '',
  expense_date: today,
  cash_account: '',
  note: '',
};

/** Client-side validation before hitting the API. */
function validateExpense(values) {
  const errors = {};
  if (!values.category) errors.category = 'Choose an expense category.';
  if (!values.description.trim()) errors.description = 'Description is required.';
  else if (values.description.trim().length > 200)
    errors.description = 'Keep the description under 200 characters.';
  const amount = Number(values.amount);
  if (!values.amount || !Number.isFinite(amount) || amount <= 0)
    errors.amount = 'Enter an amount greater than zero.';
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
export default function ExpensesPage() {
  useDocumentTitle('Expenses');

  const [categoryFilter, setCategoryFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
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
  const accountQuery = useQuery({
    queryKey: qk.finance.cashAccounts(ACCOUNT_PARAMS),
    queryFn: async () => (await cashAccountsApi.list(ACCOUNT_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const branchQuery = useQuery({
    queryKey: qk.branches.list(LOOKUP_PARAMS),
    queryFn: async () => (await branchesApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });

  const categories = (categoryQuery.data && categoryQuery.data.results) || [];
  const accounts = (accountQuery.data && accountQuery.data.results) || [];
  const branches = (branchQuery.data && branchQuery.data.results) || [];

  // Server-side filtering: DjangoFilterBackend exact matches only
  // (`expense_date` has no range lookups, and there is no `q` search param).
  const listParams = {
    page_size: 100,
    ordering: '-expense_date',
    category: categoryFilter || undefined,
    branch: branchFilter || undefined,
    cash_account: accountFilter || undefined,
    expense_date: dateFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.finance.expenses(listParams),
    queryFn: async () => (await expensesApi.list(listParams)).data,
  });

  const createMutation = useApiMutation((data) => expensesApi.create(data), {
    invalidates: [qk.finance.root],
  });
  const editMutation = useApiMutation(({ id, data }) => expensesApi.patch(id, data), {
    invalidates: [qk.finance.root],
  });
  const deleteMutation = useApiMutation(({ id }) => expensesApi.remove(id), {
    invalidates: [qk.finance.root],
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const hasFilter = Boolean(categoryFilter || branchFilter || accountFilter || dateFilter);

  const setField = (key) => (event) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  function clearFilters() {
    setCategoryFilter('');
    setBranchFilter('');
    setAccountFilter('');
    setDateFilter('');
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
      expense_date: toDateInputValue(row.expense_date),
      cash_account: row.cash_account || '',
      note: row.note || '',
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
    const clientErrors = validateExpense(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;

    // The create serializer rejects `note`, and takes no read-only fields;
    // the patch serializer (ModelSerializer) accepts `note` alongside these.
    const payload = {
      category: Number(form.category),
      description: form.description.trim(),
      amount: String(form.amount).trim(),
      expense_date: form.expense_date || undefined,
      branch: form.branch ? Number(form.branch) : null,
      cash_account: form.cash_account ? Number(form.cash_account) : null,
      ...(editing ? { note: form.note.trim() || null } : {}),
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
      key: 'expense_date',
      header: 'Date',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatDate(row.expense_date),
    },
    {
      key: 'category_name',
      header: 'Category',
      render: (row) => row.category_name || '—',
    },
    {
      key: 'description',
      header: 'Description',
      render: (row) => (
        <span className="block max-w-sm truncate" title={row.description || ''}>
          {row.description || '—'}
        </span>
      ),
    },
    {
      key: 'branch_name',
      header: 'Branch',
      render: (row) => row.branch_name || 'All branches',
    },
    {
      key: 'cash_account',
      header: 'Cash account',
      // Read serializer returns only the account id — resolve the label here.
      render: (row) =>
        accounts.find((account) => account.id === row.cash_account)?.name || '—',
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatLKR(row.amount),
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
            aria-label={`Edit expense ${row.description}`}
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
            aria-label={`Delete expense ${row.description}`}
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
        title="Expenses"
        description={
          listQuery.isPending
            ? 'Loading expenses...'
            : `${count} ${count === 1 ? 'expense' : 'expenses'}`
        }
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Expense
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load expenses — {apiErrorMessage(listQuery.error)}</span>
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
          this endpoint, and `expense_date` has no range lookups). */}
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
          value={accountFilter}
          onChange={(event) => setAccountFilter(event.target.value)}
          aria-label="Filter by cash account"
        >
          <option value="">All cash accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
        <input
          className="input w-full sm:max-w-[12rem]"
          type="date"
          value={dateFilter}
          onChange={(event) => setDateFilter(event.target.value)}
          aria-label="Filter by expense date — exact day match"
          title="Exact day — matches this date only"
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
        caption="Recorded expenses with category, branch and cash account"
        onRowClick={openEdit}
        emptyTitle={hasFilter ? 'No expenses match these filters' : 'No expenses recorded'}
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters.'
            : 'Record expenses as they happen so the profit and loss report stays accurate.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? 'Edit expense' : 'New expense'}
        description={
          editing
            ? 'Update category, amount, date, branch, cash account, and note.'
            : 'Record money out — rent, salaries, utilities, transport, and more.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="expense-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                ? 'Saving...'
                : 'Record expense'}
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
        <form id="expense-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Category"
              required
              error={errors.category}
              hint={
                categoryQuery.isSuccess && categories.length === 0
                  ? 'No categories yet — create them under Finance → Expense Categories.'
                  : undefined
              }
            >
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
            <FormField label="Branch" error={errors.branch} hint="Optional — leave as all branches for business-wide costs">
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
            <FormField label="Cash account" error={errors.cash_account} hint="Optional — where the money was paid from">
              <select
                className="input"
                name="cash_account"
                value={form.cash_account}
                onChange={setField('cash_account')}
              >
                <option value="">No cash account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Date" error={errors.expense_date} hint="Defaults to today">
              <input
                className="input"
                type="date"
                name="expense_date"
                value={form.expense_date}
                onChange={setField('expense_date')}
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
            <div className="sm:col-span-2">
              <FormField
                label="Note"
                error={errors.note}
                hint="Only editable after the expense is created — the create endpoint does not accept a note."
              >
                <textarea
                  className="input"
                  name="note"
                  value={form.note}
                  onChange={setField('note')}
                  placeholder="Optional internal note"
                  rows={2}
                  disabled={!editing}
                />
              </FormField>
            </div>
          </div>
        </form>
      </Modal>

      {/* Delete confirm — plain confirm, no dependency protection on this backend */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete expense?"
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
