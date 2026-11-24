import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, formatDate, formatDateTime, initials } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';
import PhotoUpload from '../components/PhotoUpload.jsx';
import Icon from '../components/Icon.jsx';

const EMPTY_FORM = {
  name: '',
  phone: '',
  nic: '',
  address: '',
  id_card_photo: null, // File | null — handed to PhotoUpload, sent multipart when set
};

const LOOKUP_PARAMS = { page_size: 100 };

/** Client-side validation before hitting the API. */
function validateCustomer(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Name is required.';
  return errors;
}

/**
 * Build the wire payload. With an id_card_photo File selected everything is sent as
 * FormData (axios sets multipart); otherwise plain JSON. Nullable fields go out
 * as null in JSON and as '' in FormData — DRF maps '' to None for allow_null
 * fields on html-shaped input.
 */
function buildPayload(values) {
  const base = {
    name: values.name.trim(),
    phone: values.phone.trim() || null,
    nic: values.nic.trim() || null,
    address: values.address.trim() || null,
  };

  if (!(values.id_card_photo instanceof File)) return base;

  const fd = new FormData();
  Object.entries(base).forEach(([key, value]) => {
    if (value === null || value === undefined) fd.append(key, '');
    else fd.append(key, String(value));
  });
  fd.append('id_card_photo', values.id_card_photo);
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

/** Shared create/edit form controls (house style: FormField + input). */
function CustomerFormFields({
  form,
  errors,
  onChange,
  onImageChange,
  mode,
  editing,
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Name" required error={errors.name}>
          <input
            className="input"
            name="name"
            value={form.name}
            onChange={onChange('name')}
            placeholder="e.g. Amal Perera"
            autoFocus
          />
        </FormField>
        <FormField label="Phone" error={errors.phone} hint="Sri Lankan format, e.g. 077 123 4567">
          <input
            className="input"
            type="tel"
            name="phone"
            value={form.phone}
            onChange={onChange('phone')}
            placeholder="077 123 4567"
            inputMode="tel"
          />
        </FormField>
        <FormField label="NIC" error={errors.nic} hint="National Identity Card number (old or new format)">
          <input
            className="input"
            name="nic"
            value={form.nic}
            onChange={onChange('nic')}
            placeholder="e.g. 199012345678 or 901234567V"
            spellCheck={false}
          />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Address" error={errors.address} hint="Full mailing address">
            <textarea
              className="input"
              name="address"
              value={form.address}
              onChange={onChange('address')}
              placeholder="No. 12, Galle Road, Colombo 03"
              rows={3}
            />
          </FormField>
        </div>
        <div className="sm:col-span-2">
          {editing && editing.id_card_photo && !form.id_card_photo ? (
            <div className="mb-3 flex items-center gap-3">
              <img
                src={editing.id_card_photo}
                alt=""
                className="size-16 rounded-lg border border-slate-200 object-cover"
              />
              <p className="text-xs text-slate-500">
                Current ID card photo — choose a replacement to change it.
              </p>
            </div>
          ) : null}
          <PhotoUpload
            label="ID card photo"
            id="customer-id-card-upload"
            value={form.id_card_photo}
            onChange={onImageChange}
            error={errors.id_card_photo}
            hint="JPG or PNG. Compressed to about 200 KB before upload."
          />
        </div>
      </div>
    </>
  );
}

/* ---------------------------------- page ---------------------------------- */
export default function CustomersPage() {
  useDocumentTitle('Customers');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [historyTarget, setHistoryTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side search on name/phone/nic — debounce keystrokes ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const listParams = {
    page_size: 100,
    q: debouncedSearch || undefined,
  };

  const listQuery = useQuery({
    queryKey: qk.customers.list(listParams),
    queryFn: async () => (await customersApi.list(listParams)).data,
  });

  // History query — enabled only when history modal is open
  const historyQuery = useQuery({
    queryKey: qk.customers.history(historyTarget?.id),
    queryFn: async () => (await customersApi.history(historyTarget.id)).data,
    enabled: Boolean(historyTarget),
  });

  const createMutation = useApiMutation((data) => customersApi.create(data), {
    invalidates: [qk.customers.root],
  });
  const editMutation = useApiMutation(({ id, data }) => customersApi.patch(id, data), {
    invalidates: [qk.customers.root],
  });
  const deleteMutation = useApiMutation(({ id }) => customersApi.remove(id), {
    invalidates: [qk.customers.root],
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
      phone: row.phone || '',
      nic: row.nic || '',
      address: row.address || '',
      id_card_photo: null,
    });
    setErrors({});
    setBanner(null);
    setEditing(row);
    setModalOpen(true);
  }

  function openHistory(row, event) {
    event.stopPropagation();
    setHistoryTarget(row);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
  }

  function closeHistoryModal() {
    setHistoryTarget(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const mode = editing ? 'edit' : 'create';
    const clientErrors = validateCustomer(form);
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
      key: 'photo',
      header: '',
      width: '3rem',
      render: (row) =>
        row.id_card_photo ? (
          <img src={row.id_card_photo} alt="" className="h-10 w-10 rounded-full object-cover" />
        ) : (
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
    { key: 'phone', header: 'Phone', render: (row) => row.phone || '—' },
    { key: 'nic', header: 'NIC', render: (row) => row.nic || '—' },
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
          <button
            type="button"
            className="btn-secondary px-2 py-1.5 text-xs"
            aria-label={`View history for ${row.name}`}
            title="History"
            onClick={(event) => openHistory(row, event)}
          >
            History
          </button>
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
        title="Customers"
        description={
          listQuery.isPending
            ? 'Loading customers...'
            : `${count} ${count === 1 ? 'customer' : 'customers'}`
        }
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Customer
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load customers — {apiErrorMessage(listQuery.error)}</span>
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
          placeholder="Search by name, phone or NIC..."
          aria-label="Search customers"
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Customer directory with purchase history"
        onRowClick={openEdit}
        emptyTitle={debouncedSearch ? 'No customers match your search' : 'No customers yet'}
        emptyDescription={
          debouncedSearch
            ? 'Try a different search term.'
            : 'Add your first customer to start tracking purchases and outstanding balances.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.name}` : 'New customer'}
        description={
          editing
            ? 'Update name, contact details, address, and ID card photo.'
            : 'Add a new customer. An ID card photo is optional but recommended for verification.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="customer-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                ? 'Creating...'
                : 'Create customer'}
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
        <form id="customer-form" onSubmit={handleSubmit} noValidate>
          <CustomerFormFields
            form={form}
            errors={errors}
            onChange={setField}
            onImageChange={(file) => setForm((prev) => ({ ...prev, id_card_photo: file }))}
            mode={editing ? 'edit' : 'create'}
            editing={editing}
          />
        </form>
      </Modal>

      {/* History modal — read-only view of customer purchase history */}
      <Modal
        open={Boolean(historyTarget)}
        onClose={closeHistoryModal}
        title={`Customer history — ${historyTarget?.name || ''}`}
        description="Recent sales, total spent, and outstanding balance."
        size="lg"
        footer={
          <button type="button" className="btn-secondary" onClick={closeHistoryModal}>
            Close
          </button>
        }
      >
        {historyQuery.isPending ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-brand-600 border-t-transparent" />
            <span className="sr-only">Loading history...</span>
          </div>
        ) : historyQuery.isError ? (
          <div
            className="rounded-control border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            Could not load history — {apiErrorMessage(historyQuery.error)}
            <button
              type="button"
              className="btn-secondary px-2.5 py-1 text-xs ml-3"
              onClick={() => historyQuery.refetch()}
            >
              Retry
            </button>
          </div>
        ) : historyQuery.data ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-6">
              <div className="rounded-control border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Total spent</p>
                <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                  {formatLKR(historyQuery.data.total_spent)}
                </p>
              </div>
              <div className="rounded-control border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Outstanding</p>
                <p className="mt-1 text-2xl font-bold text-rose-600 tabular-nums">
                  {formatLKR(historyQuery.data.outstanding)}
                </p>
              </div>
              <div className="rounded-control border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Total sales</p>
                <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                  {historyQuery.data.total_sales_count}
                </p>
              </div>
            </div>

            <div className="rounded-control border border-slate-200 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50/80">
                  <tr>
                    <th scope="col" className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
                      Invoice
                    </th>
                    <th scope="col" className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
                      Date
                    </th>
                    <th scope="col" className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 text-right">
                      Total
                    </th>
                    <th scope="col" className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 text-left">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {(historyQuery.data.sales || []).slice(0, 20).map((sale) => (
                    <tr key={sale.id}>
                      <td className="px-5 py-3.5 text-slate-700 font-mono text-xs font-semibold">
                        {sale.invoice_no}
                      </td>
                      <td className="px-5 py-3.5 text-slate-700">
                        {formatDateTime(sale.created_at)}
                      </td>
                      <td className="px-5 py-3.5 text-slate-700 text-right tabular-nums">
                        {formatLKR(sale.total_cost)}
                      </td>
                      <td className="px-5 py-3.5 text-slate-700">
                        <span
                          className={`badge ${
                            sale.status === 'completed'
                              ? 'bg-emerald-50 text-emerald-700'
                              : sale.status === 'pending'
                              ? 'bg-amber-50 text-amber-700'
                              : sale.status === 'cancelled'
                              ? 'bg-rose-50 text-rose-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {sale.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {(historyQuery.data.sales || []).length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-5 py-8 text-center text-slate-500">
                        No sales recorded for this customer.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Modal>

      {/* Delete confirm — plain confirm, no history protection on this backend */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete customer?"
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
