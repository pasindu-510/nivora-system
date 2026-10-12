import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { branchesApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';

const EMPTY_FORM = {
  name: '',
  address: '',
  phone: '',
  is_active: true,
};

/** Client-side validation before hitting the API. */
function validateBranch(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Name is required.';
  return errors;
}

function buildPayload(values) {
  return {
    name: values.name.trim(),
    address: values.address.trim(),
    phone: values.phone.trim(),
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
export default function BranchesPage() {
  useDocumentTitle('Branches');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side search on the DRF `search` param — debounce keystrokes ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const listQuery = useQuery({
    queryKey: qk.branches.list({ q: debouncedSearch || undefined, page_size: 100 }),
    queryFn: async () =>
      (
        await branchesApi.list({
          page_size: 100,
          q: debouncedSearch || undefined,
        })
      ).data,
  });

  const createMutation = useApiMutation((data) => branchesApi.create(data), {
    invalidates: [qk.branches.root],
  });
  const editMutation = useApiMutation(({ id, data }) => branchesApi.patch(id, data), {
    invalidates: [qk.branches.root],
  });
  const toggleMutation = useApiMutation(
    ({ id, is_active }) => branchesApi.patch(id, { is_active }),
    { invalidates: [qk.branches.root] }
  );

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;

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
    setForm({
      name: row.name || '',
      address: row.address || '',
      phone: row.phone || '',
      is_active: Boolean(row.is_active),
    });
    setErrors({});
    setBanner(null);
    setEditing(row);
    setModalOpen(true);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const clientErrors = validateBranch(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      if (editing) {
        await editMutation.mutateAsync({ id: editing.id, data: buildPayload(form) });
      } else {
        await createMutation.mutateAsync(buildPayload(form));
      }
      setModalOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
  }

  async function handleActivate(row) {
    setActionError(null);
    try {
      await toggleMutation.mutateAsync({ id: row.id, is_active: true });
    } catch (error) {
      setActionError(apiErrorMessage(error));
    }
  }

  async function handleDeactivateConfirm() {
    if (!confirmTarget) return;
    setActionError(null);
    try {
      await toggleMutation.mutateAsync({ id: confirmTarget.id, is_active: false });
      setConfirmTarget(null);
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
    { key: 'address', header: 'Address', render: (row) => row.address || '—' },
    { key: 'phone', header: 'Phone', render: (row) => row.phone || '—' },
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
    { key: 'created_at', header: 'Created', render: (row) => formatDate(row.created_at) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="btn-secondary px-2.5 py-1.5 text-xs"
            onClick={() => openEdit(row)}
          >
            Edit
          </button>
          {row.is_active ? (
            <button
              type="button"
              className="btn-secondary border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-100"
              onClick={() => {
                setActionError(null);
                setConfirmTarget(row);
              }}
              disabled={toggleMutation.isPending}
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700 hover:bg-emerald-100"
              onClick={() => handleActivate(row)}
              disabled={toggleMutation.isPending}
            >
              Activate
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Branches"
        description="Your shop locations. Stock, sales, staff, and reports are all routed through branches."
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Branch
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load branches — {apiErrorMessage(listQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => listQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {actionError && !confirmTarget ? (
        <div
          className="rounded-control border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
          role="alert"
        >
          {actionError}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          className="input w-full sm:max-w-xs"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, address or phone..."
          aria-label="Search branches"
        />
        <p className="shrink-0 text-sm font-medium text-slate-500">
          {listQuery.isPending
            ? 'Loading branches...'
            : `${count} ${count === 1 ? 'branch' : 'branches'}`}
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Shop branches"
        emptyTitle={debouncedSearch ? 'No branches match your search' : 'No branches yet'}
        emptyDescription={
          debouncedSearch
            ? 'Try a different name, address, or phone number.'
            : 'Add each physical outlet so stock and sales are tracked per location — use “New Branch” above to create one.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.name}` : 'New branch'}
        description={
          editing
            ? 'Update the branch details or toggle its active status.'
            : 'Add a physical outlet so stock and sales are tracked per location.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="branch-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                  ? 'Creating...'
                  : 'Create branch'}
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
        <form id="branch-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Name" required error={errors.name} className="sm:col-span-2">
              <input
                className="input"
                name="name"
                value={form.name}
                onChange={setField('name')}
                placeholder="e.g. Nivora Main Showroom"
              />
            </FormField>
            <FormField label="Address" className="sm:col-span-2">
              <input
                className="input"
                name="address"
                value={form.address}
                onChange={setField('address')}
                placeholder="Street, city"
              />
            </FormField>
            <FormField label="Phone" error={errors.phone}>
              <input
                className="input"
                name="phone"
                value={form.phone}
                onChange={setField('phone')}
                placeholder="+94 77 123 4567"
              />
            </FormField>
            <FormField
              label="Status"
              error={errors.is_active}
              hint="Inactive branches are hidden from sales and stock pickers."
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  checked={form.is_active}
                  onChange={setField('is_active')}
                />
                Branch is active
              </label>
            </FormField>
          </div>
        </form>
      </Modal>

      {/* Deactivate confirm — branches are never deleted, only paused */}
      <Modal
        open={Boolean(confirmTarget)}
        onClose={() => setConfirmTarget(null)}
        title="Deactivate branch?"
        description={
          confirmTarget
            ? `${confirmTarget.name} will be paused and hidden from sales and stock pickers. Sales and purchases that already reference it are unaffected. You can reactivate it at any time.`
            : ''
        }
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirmTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={handleDeactivateConfirm}
              disabled={toggleMutation.isPending}
            >
              {toggleMutation.isPending ? 'Deactivating...' : 'Deactivate'}
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
