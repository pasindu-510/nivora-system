import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { capitalEntriesApi, cashAccountsApi, financeSettingsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, formatDate, toDateInputValue } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';
import StatCard from '../components/StatCard.jsx';

const ACCOUNT_TYPES = [
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK', label: 'Bank' },
];

const CAPITAL_TYPES = [
  { value: 'OWNER_IN', label: 'Owner in' },
  { value: 'OWNER_OUT', label: 'Owner out' },
];

const today = toDateInputValue(new Date());

const EMPTY_ACCOUNT = {
  name: '',
  type: 'CASH',
  opening_balance: '',
  is_active: true,
};

const EMPTY_CAPITAL = {
  date: today,
  type: 'OWNER_IN',
  amount: '',
  note: '',
};

/** Client-side validation before hitting the API. */
function validateCashAccount(values) {
  const errors = {};
  const name = values.name.trim();
  if (!name) errors.name = 'Name is required.';
  else if (name.length > 200) errors.name = 'Keep the name under 200 characters.';
  if (!values.type) errors.type = 'Choose an account type.';
  // Empty opening balance means 0; anything entered must be a number >= 0.
  const raw = String(values.opening_balance).trim();
  if (raw !== '') {
    const amount = Number(raw);
    if (!Number.isFinite(amount)) errors.opening_balance = 'Opening balance must be a number.';
    else if (amount < 0) errors.opening_balance = 'Opening balance cannot be negative.';
  }
  return errors;
}

function validateCapitalEntry(values) {
  const errors = {};
  if (!values.date) errors.date = 'Date is required.';
  if (!values.type) errors.type = 'Choose an entry type.';
  const amount = Number(values.amount);
  if (!values.amount || !Number.isFinite(amount) || amount <= 0)
    errors.amount = 'Enter an amount greater than zero.';
  if (values.note && values.note.length > 5000)
    errors.note = 'Keep the note under 5000 characters.';
  return errors;
}

function validateTaxRate(values) {
  const errors = {};
  const raw = String(values.tax_rate ?? '').trim();
  if (raw === '') errors.tax_rate = 'Tax rate is required.';
  else {
    const rate = Number(raw);
    // Number('') is 0 — empty is already handled above.
    if (!Number.isFinite(rate)) errors.tax_rate = 'Tax rate must be a number.';
    else if (rate < 0 || rate > 100) errors.tax_rate = 'Tax rate must be between 0 and 100.';
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

/* ------------------------------ cash accounts ----------------------------- */
function CashAccountsSection() {
  const [typeFilter, setTypeFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_ACCOUNT);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side filtering: DjangoFilterBackend exact matches only —
  // this endpoint has no `q` search param.
  const listParams = {
    page_size: 100,
    ordering: 'name',
    type: typeFilter || undefined,
    is_active: activeFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.finance.cashAccounts(listParams),
    queryFn: async () => (await cashAccountsApi.list(listParams)).data,
  });

  const createMutation = useApiMutation((data) => cashAccountsApi.create(data), {
    invalidates: [qk.finance.root],
  });
  const editMutation = useApiMutation(({ id, data }) => cashAccountsApi.patch(id, data), {
    invalidates: [qk.finance.root],
  });
  const deleteMutation = useApiMutation(({ id }) => cashAccountsApi.remove(id), {
    invalidates: [qk.finance.root],
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const hasFilter = Boolean(typeFilter || activeFilter);

  // Running totals from the loaded rows — plain reduce, no extra requests.
  const totalBalance = rows.reduce((sum, row) => sum + (Number(row.balance) || 0), 0);
  const cashBalance = rows.reduce(
    (sum, row) => (row.type === 'CASH' ? sum + (Number(row.balance) || 0) : sum),
    0
  );
  const bankBalance = rows.reduce(
    (sum, row) => (row.type === 'BANK' ? sum + (Number(row.balance) || 0) : sum),
    0
  );

  const setField = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  function clearFilters() {
    setTypeFilter('');
    setActiveFilter('');
  }

  function openCreate() {
    setForm(EMPTY_ACCOUNT);
    setErrors({});
    setBanner(null);
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(row) {
    setForm({
      name: row.name || '',
      type: row.type || 'CASH',
      opening_balance: String(row.opening_balance ?? ''),
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
    const clientErrors = validateCashAccount(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      // `balance` is a read-only SerializerMethodField — never sent.
      const payload = {
        name: form.name.trim(),
        type: form.type,
        opening_balance: String(form.opening_balance || '0').trim(),
        is_active: Boolean(form.is_active),
      };
      if (editing) await editMutation.mutateAsync({ id: editing.id, data: payload });
      else await createMutation.mutateAsync(payload);
      closeModal();
      setForm(EMPTY_ACCOUNT);
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
      key: 'name',
      header: 'Name',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => row.name,
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => {
        const label =
          ACCOUNT_TYPES.find((option) => option.value === row.type)?.label || row.type;
        return (
          <span
            className={`badge ${
              row.type === 'CASH'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-brand-50 text-brand-600'
            }`}
          >
            {label}
          </span>
        );
      },
    },
    {
      key: 'opening_balance',
      header: 'Opening balance',
      align: 'right',
      render: (row) => formatLKR(row.opening_balance),
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatLKR(row.balance),
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
            aria-label={`Edit account ${row.name}`}
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
            aria-label={`Delete account ${row.name}`}
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-slate-900">Cash accounts</h2>
          <p className="mt-1 text-sm text-slate-500">
            {listQuery.isPending
              ? 'Loading accounts...'
              : `${count} ${count === 1 ? 'account' : 'accounts'}`}
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={openCreate}>
          + New Account
        </button>
      </div>

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load cash accounts — {apiErrorMessage(listQuery.error)}</span>
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

      {/* Summary strip — running totals computed from the loaded rows. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Total balance"
          value={totalBalance}
          currency
          tone="brand"
          loading={listQuery.isPending}
          hint="Across the accounts listed"
        />
        <StatCard
          label="Cash in hand"
          value={cashBalance}
          currency
          tone="positive"
          loading={listQuery.isPending}
        />
        <StatCard
          label="Bank balance"
          value={bankBalance}
          currency
          tone="neutral"
          loading={listQuery.isPending}
        />
      </div>

      {/* Filter bar: exact-match server-side filters only (no text search). */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          className="input w-full sm:w-auto"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          aria-label="Filter by account type"
        >
          <option value="">All types</option>
          {ACCOUNT_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
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
        caption="Cash and bank accounts with opening balances and live balances"
        onRowClick={openEdit}
        emptyTitle={hasFilter ? 'No accounts match these filters' : 'No cash accounts yet'}
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters.'
            : 'Set up the accounts money moves through — main cash and bank accounts — to power the balance sheet.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.name}` : 'New cash account'}
        description={
          editing
            ? 'Update the name, type, opening balance, and active status.'
            : 'Add an account money moves through — cash drawers and bank accounts.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="cash-account-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                ? 'Saving...'
                : 'Create account'}
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
        <form id="cash-account-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FormField label="Name" required error={errors.name}>
                <input
                  className="input"
                  name="name"
                  value={form.name}
                  onChange={setField('name')}
                  placeholder="e.g. Main cash drawer"
                  maxLength={200}
                  autoFocus
                />
              </FormField>
            </div>
            <FormField label="Type" required error={errors.type}>
              <select className="input" name="type" value={form.type} onChange={setField('type')}>
                {ACCOUNT_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Opening balance"
              error={errors.opening_balance}
              hint="LKR — the live balance is calculated by the system"
            >
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                name="opening_balance"
                value={form.opening_balance}
                onChange={setField('opening_balance')}
                placeholder="0.00"
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
                Active account
              </label>
            </FormField>
          </div>
        </form>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete account?"
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

/* ----------------------------- capital entries ---------------------------- */
function CapitalEntriesSection() {
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_CAPITAL);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side filtering: `type` exact match and `date` exact-day match —
  // this endpoint has no range lookups and no `q` search param.
  const listParams = {
    page_size: 100,
    ordering: '-date',
    type: typeFilter || undefined,
    date: dateFilter || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.finance.capitalEntries(listParams),
    queryFn: async () => (await capitalEntriesApi.list(listParams)).data,
  });

  const createMutation = useApiMutation((data) => capitalEntriesApi.create(data), {
    invalidates: [qk.finance.root],
  });
  const editMutation = useApiMutation(({ id, data }) => capitalEntriesApi.patch(id, data), {
    invalidates: [qk.finance.root],
  });
  const deleteMutation = useApiMutation(({ id }) => capitalEntriesApi.remove(id), {
    invalidates: [qk.finance.root],
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const hasFilter = Boolean(typeFilter || dateFilter);

  // Running totals from the loaded rows — plain reduce, no extra requests.
  const totalIn = rows.reduce(
    (sum, row) => (row.type === 'OWNER_IN' ? sum + (Number(row.amount) || 0) : sum),
    0
  );
  const totalOut = rows.reduce(
    (sum, row) => (row.type === 'OWNER_OUT' ? sum + (Number(row.amount) || 0) : sum),
    0
  );

  const setField = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  function clearFilters() {
    setTypeFilter('');
    setDateFilter('');
  }

  function openCreate() {
    setForm(EMPTY_CAPITAL);
    setErrors({});
    setBanner(null);
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(row) {
    setForm({
      date: toDateInputValue(row.date),
      type: row.type || 'OWNER_IN',
      amount: String(row.amount ?? ''),
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
    const clientErrors = validateCapitalEntry(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      const payload = {
        date: form.date,
        type: form.type,
        amount: String(form.amount).trim(),
        note: form.note.trim(),
      };
      if (editing) await editMutation.mutateAsync({ id: editing.id, data: payload });
      else await createMutation.mutateAsync(payload);
      closeModal();
      setForm(EMPTY_CAPITAL);
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
      key: 'date',
      header: 'Date',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatDate(row.date),
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => {
        const label =
          CAPITAL_TYPES.find((option) => option.value === row.type)?.label || row.type;
        return (
          <span
            className={`badge ${
              row.type === 'OWNER_IN'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-rose-50 text-rose-700'
            }`}
          >
            {label}
          </span>
        );
      },
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cellClassName: 'font-semibold',
      render: (row) => (
        <span className={row.type === 'OWNER_IN' ? 'text-emerald-600' : 'text-rose-600'}>
          {formatLKR(row.amount)}
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
            aria-label={`Edit capital entry on ${formatDate(row.date)}`}
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
            aria-label={`Delete capital entry on ${formatDate(row.date)}`}
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-slate-900">Capital entries</h2>
          <p className="mt-1 text-sm text-slate-500">
            {listQuery.isPending
              ? 'Loading capital entries...'
              : `${count} ${count === 1 ? 'entry' : 'entries'}`}
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={openCreate}>
          + New Entry
        </button>
      </div>

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load capital entries — {apiErrorMessage(listQuery.error)}</span>
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

      {/* Summary strip — running totals computed from the loaded rows. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Owner in"
          value={totalIn}
          currency
          tone="positive"
          loading={listQuery.isPending}
        />
        <StatCard
          label="Owner out"
          value={totalOut}
          currency
          tone="danger"
          loading={listQuery.isPending}
        />
        <StatCard
          label="Net capital"
          value={totalIn - totalOut}
          currency
          tone="brand"
          loading={listQuery.isPending}
          hint="Across the entries listed"
        />
      </div>

      {/* Filter bar: type + exact-day date (the backend filter is exact match). */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          className="input w-full sm:w-auto"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          aria-label="Filter by entry type"
        >
          <option value="">All types</option>
          {CAPITAL_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="capital-date-filter">
            Exact date
          </label>
          <input
            id="capital-date-filter"
            className="input w-full sm:max-w-[12rem]"
            type="date"
            value={dateFilter}
            onChange={(event) => setDateFilter(event.target.value)}
            aria-describedby="capital-date-hint"
          />
          <p className="text-xs text-slate-500" id="capital-date-hint">
            Matches this day only — not a date range.
          </p>
        </div>
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
        caption="Owner capital contributions and drawings"
        onRowClick={openEdit}
        emptyTitle={hasFilter ? 'No entries match these filters' : 'No capital entries yet'}
        emptyDescription={
          hasFilter
            ? 'Try clearing one or more filters.'
            : 'Record owner contributions and drawings so the balance sheet reflects real capital.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? 'Edit capital entry' : 'New capital entry'}
        description={
          editing
            ? 'Update the date, type, amount, and note.'
            : 'Record money the owner puts into — or takes out of — the business.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="capital-entry-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                ? 'Saving...'
                : 'Create entry'}
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
        <form id="capital-entry-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Date" required error={errors.date}>
              <input
                className="input"
                type="date"
                name="date"
                value={form.date}
                onChange={setField('date')}
                autoFocus
              />
            </FormField>
            <FormField label="Type" required error={errors.type}>
              <select className="input" name="type" value={form.type} onChange={setField('type')}>
                {CAPITAL_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
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
            <div className="sm:col-span-2">
              <FormField
                label="Note"
                error={errors.note}
                hint="Optional — up to 5000 characters"
              >
                <textarea
                  className="input"
                  name="note"
                  value={form.note}
                  onChange={setField('note')}
                  placeholder="e.g. Injected for the new showroom lease"
                  rows={3}
                />
              </FormField>
            </div>
          </div>
        </form>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete capital entry?"
        description={
          deleteTarget
            ? `The ${
                CAPITAL_TYPES.find((option) => option.value === deleteTarget.type)?.label ||
                deleteTarget.type
              } entry of ${formatLKR(deleteTarget.amount)} on ${formatDate(
                deleteTarget.date
              )} will be permanently removed. This action cannot be undone.`
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

/* -------------------------------- tax rate -------------------------------- */
function TaxRateSection() {
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);

  const settingsQuery = useQuery({
    queryKey: qk.finance.settings,
    queryFn: async () => (await financeSettingsApi.get()).data,
  });

  const saveMutation = useApiMutation((data) => financeSettingsApi.update(data), {
    // The POS prefill on /sales/new reads the rate from /api/auth/me/
    // (UserSerializer.business_tax_rate), so both caches must refresh.
    invalidates: [qk.finance.settings, qk.auth.me],
  });

  // `tax_rate` arrives as a string ("10.00") — keep it a string until math.
  const serverRate = settingsQuery.data ? String(settingsQuery.data.tax_rate ?? '') : '';
  // Show the saved rate until the user starts editing, then the draft.
  const value = dirty ? draft : serverRate;

  function handleChange(event) {
    setDraft(event.target.value);
    setDirty(true);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const clientErrors = validateTaxRate({ tax_rate: value });
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      const response = await saveMutation.mutateAsync({
        tax_rate: String(value).trim(),
      });
      // Adopt the server's echoed value right away so the field never blinks
      // back to the pre-save cache while the invalidation refetch is in flight.
      const saved = response && response.data ? response.data.tax_rate : null;
      setDraft(saved != null ? String(saved) : String(value).trim());
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  return (
    <div className="space-y-6">
      <div className="min-w-0">
        <h2 className="text-lg font-bold tracking-tight text-slate-900">Tax rate</h2>
        <p className="mt-1 text-sm text-slate-500">
          {settingsQuery.isPending
            ? 'Loading tax rate...'
            : `Current rate: ${serverRate}%`}
        </p>
      </div>

      {settingsQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load the tax rate — {apiErrorMessage(settingsQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => settingsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      <section className="card max-w-xl p-5">
        {banner ? (
          <div
            className="mb-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            {banner}
          </div>
        ) : null}
        <form onSubmit={handleSubmit} noValidate>
          <FormField
            label="Tax rate"
            required
            error={errors.tax_rate}
            hint="The default VAT rate applied to new sales and shown on the VAT report."
          >
            <div className="relative">
              <input
                className="input pr-10"
                type="number"
                min="0"
                max="100"
                step="0.01"
                name="tax_rate"
                value={value}
                onChange={handleChange}
                placeholder="0.00"
                disabled={settingsQuery.isPending || settingsQuery.isError}
              />
              <span
                className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-400"
                aria-hidden="true"
              >
                %
              </span>
            </div>
          </FormField>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              className="btn-primary"
              disabled={
                saveMutation.isPending ||
                settingsQuery.isPending ||
                settingsQuery.isError ||
                !dirty
              }
            >
              {saveMutation.isPending ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */
export default function FinanceSettingsPage() {
  useDocumentTitle('Finance Settings');

  const [section, setSection] = useState('accounts');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance Settings"
        description="Cash and bank accounts with opening balances, owner capital contributions and drawings, and the default VAT tax rate."
      />

      {/* Segmented switcher — only one section is mounted at a time so the
          tables never fight for space. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={section === 'accounts' ? 'btn-primary' : 'btn-secondary'}
          aria-pressed={section === 'accounts'}
          onClick={() => setSection('accounts')}
        >
          Cash accounts
        </button>
        <button
          type="button"
          className={section === 'capital' ? 'btn-primary' : 'btn-secondary'}
          aria-pressed={section === 'capital'}
          onClick={() => setSection('capital')}
        >
          Capital entries
        </button>
        <button
          type="button"
          className={section === 'tax' ? 'btn-primary' : 'btn-secondary'}
          aria-pressed={section === 'tax'}
          onClick={() => setSection('tax')}
        >
          Tax rate
        </button>
      </div>

      {section === 'accounts' ? (
        <CashAccountsSection />
      ) : section === 'capital' ? (
        <CapitalEntriesSection />
      ) : (
        <TaxRateSection />
      )}
    </div>
  );
}
