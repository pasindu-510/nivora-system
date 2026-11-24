import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { suppliersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate, initials } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';

const EMPTY_FORM = {
  name: '',
  contact_person: '',
  phone: '',
  email: '',
  address: '',
  is_active: true,
};

/** Client-side validation before hitting the API. */
function validateSupplier(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Name is required.';
  return errors;
}

/** Build the wire payload — trimmed strings, null for empty optional text fields. */
function buildPayload(values) {
  return {
    name: values.name.trim(),
    contact_person: values.contact_person.trim() || null,
    phone: values.phone.trim() || null,
    email: values.email.trim() || null,
    address: values.address.trim() || null,
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
export default function SuppliersPage() {
  useDocumentTitle('Suppliers');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side search on name/contact person/phone/email — debounce keystrokes ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const listParams = {
    page_size: 100,
    q: debouncedSearch || undefined,
    ordering: 'name',
  };

  const listQuery = useQuery({
    queryKey: qk.suppliers.list(listParams),
    queryFn: async () => (await suppliersApi.list(listParams)).data,
  });

  const createMutation = useApiMutation((data) => suppliersApi.create(data), {
    invalidates: [qk.suppliers.root],
  });
  const editMutation = useApiMutation(({ id, data }) => suppliersApi.patch(id, data), {
    invalidates: [qk.suppliers.root],
  });
  const deleteMutation = useApiMutation(({ id }) => suppliersApi.remove(id), {
    invalidates: [qk.suppliers.root],
  });

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
      contact_person: row.contact_person || '',
      phone: row.phone || '',
      email: row.email || '',
      address: row.address || '',
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
    const clientErrors = validateSupplier(form);
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

  const columns = [
    {
      key: 'avatar',
      header: '',
      width: '3rem',
      render: (row) => (
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600 text-xs font-semibold">
          {initials(row.name)}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => row.name,
    },
    {
      key: 'contact_person',
      header: 'Contact person',
      render: (row) => row.contact_person || '—',
    },
    { key: 'phone', header: 'Phone', render: (row) => row.phone || '—' },
    { key: 'email', header: 'Email', render: (row) => row.email || '—' },
    {
      key: 'address',
      header: 'Address',
      render: (row) => (
        <span className="truncate block max-w-xs" title={row.address || ''}>
          {row.address || '—'}
        </span>
      ),
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
      key: 'created_at',
      header: 'Created',
      render: (row) => formatDate(row.created_at),
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
          <Link
            to={`/suppliers/payments?supplier=${row.id}`}
            className="btn-secondary whitespace-nowrap px-2.5 py-1.5 text-xs"
            title="Balance owed and payments"
          >
            Payments &amp; balance
          </Link>
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
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description={
          listQuery.isPending
            ? 'Loading suppliers...'
            : `${count} ${count === 1 ? 'supplier' : 'suppliers'}`
        }
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Supplier
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load suppliers — {apiErrorMessage(listQuery.error)}</span>
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

      {/* Filter bar: search only */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <input
          className="input w-full sm:max-w-xs"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, contact, phone or email..."
          aria-label="Search suppliers"
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Supplier directory with contact details"
        onRowClick={openEdit}
        emptyTitle={debouncedSearch ? 'No suppliers match your search' : 'No suppliers yet'}
        emptyDescription={
          debouncedSearch
            ? 'Try a different search term.'
            : 'Add the suppliers you order appliances from to raise purchase orders and track what you owe.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.name}` : 'New supplier'}
        description={
          editing
            ? 'Update contact details, address, and active status.'
            : 'Add a supplier you order appliances from to raise purchase orders and track balances.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="supplier-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                ? 'Creating...'
                : 'Create supplier'}
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
        <form id="supplier-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Name" required error={errors.name}>
              <input
                className="input"
                name="name"
                value={form.name}
                onChange={setField('name')}
                placeholder="e.g. Singer Sri Lanka"
                autoFocus
              />
            </FormField>
            <FormField label="Contact person" error={errors.contact_person}>
              <input
                className="input"
                name="contact_person"
                value={form.contact_person}
                onChange={setField('contact_person')}
                placeholder="e.g. Kamal Silva"
              />
            </FormField>
            <FormField label="Phone" error={errors.phone} hint="Sri Lankan format, e.g. 077 123 4567">
              <input
                className="input"
                type="tel"
                name="phone"
                value={form.phone}
                onChange={setField('phone')}
                placeholder="077 123 4567"
                inputMode="tel"
              />
            </FormField>
            <FormField label="Email" error={errors.email}>
              <input
                className="input"
                type="email"
                name="email"
                value={form.email}
                onChange={setField('email')}
                placeholder="purchases@example.lk"
                spellCheck={false}
              />
            </FormField>
            <div className="sm:col-span-2">
              <FormField label="Address" error={errors.address} hint="Full mailing address">
                <textarea
                  className="input"
                  name="address"
                  value={form.address}
                  onChange={setField('address')}
                  placeholder="No. 12, Galle Road, Colombo 03"
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
                  onChange={setField('is_active')}
                />
                Active supplier
              </label>
            </FormField>
          </div>
        </form>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete supplier?"
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
