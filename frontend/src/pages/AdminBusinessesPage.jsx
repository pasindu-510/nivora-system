import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';
import StatCard from '../components/StatCard.jsx';

const EMPTY_FORM = {
  name: '',
  address: '',
  phone: '',
  email: '',
  tax_rate: '',
  cashier_discount_cap: '',
  max_users: '',
  max_branches: '',
};

/** Client-side validation before hitting the API. */
function validateBusiness(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Name is required.';
  const taxRate = values.tax_rate === '' ? 0 : Number(values.tax_rate);
  if (!Number.isFinite(taxRate) || taxRate < 0) {
    errors.tax_rate = 'Enter a number of 0 or more.';
  }
  const discountCap = values.cashier_discount_cap === '' ? 0 : Number(values.cashier_discount_cap);
  if (!Number.isFinite(discountCap) || discountCap < 0) {
    errors.cashier_discount_cap = 'Enter a number of 0 or more.';
  }
  ['max_users', 'max_branches'].forEach((key) => {
    const raw = (values[key] ?? '').trim();
    if (raw === '') return; // blank = unlimited
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1) {
      errors[key] = 'Enter a whole number of 1 or more.';
    }
  });
  return errors;
}

function buildPayload(values) {
  return {
    name: values.name.trim(),
    address: values.address.trim(),
    phone: values.phone.trim(),
    email: values.email.trim(),
    tax_rate: values.tax_rate === '' ? 0 : Number(values.tax_rate),
    cashier_discount_cap:
      values.cashier_discount_cap === '' ? 0 : Number(values.cashier_discount_cap),
    max_users: values.max_users.trim() === '' ? null : Number(values.max_users),
    max_branches: values.max_branches.trim() === '' ? null : Number(values.max_branches),
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

/** Shared create/edit form controls (house style: FormField + input). */
function BusinessFormFields({ form, errors, onChange }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FormField label="Name" required error={errors.name} className="sm:col-span-2">
        <input
          className="input"
          name="name"
          value={form.name}
          onChange={onChange('name')}
          placeholder="e.g. Acme Appliances"
        />
      </FormField>
      <FormField label="Address" className="sm:col-span-2">
        <input
          className="input"
          name="address"
          value={form.address}
          onChange={onChange('address')}
          placeholder="Street, city"
        />
      </FormField>
      <FormField label="Phone" error={errors.phone}>
        <input
          className="input"
          name="phone"
          value={form.phone}
          onChange={onChange('phone')}
          placeholder="+94 77 123 4567"
        />
      </FormField>
      <FormField label="Email" error={errors.email}>
        <input
          className="input"
          type="email"
          name="email"
          value={form.email}
          onChange={onChange('email')}
          placeholder="owner@example.com"
        />
      </FormField>
      <FormField
        label="Tax rate (%)"
        error={errors.tax_rate}
        hint="Added to sales at checkout."
      >
        <input
          className="input"
          name="tax_rate"
          inputMode="decimal"
          value={form.tax_rate}
          onChange={onChange('tax_rate')}
          placeholder="0"
        />
      </FormField>
      <FormField
        label="Cashier discount cap (%)"
        error={errors.cashier_discount_cap}
        hint="Maximum discount a cashier may apply per sale."
      >
        <input
          className="input"
          name="cashier_discount_cap"
          inputMode="decimal"
          value={form.cashier_discount_cap}
          onChange={onChange('cashier_discount_cap')}
          placeholder="0"
        />
      </FormField>
      <FormField
        label="Max users"
        error={errors.max_users}
        hint="Staff accounts allowed. Leave blank for unlimited."
      >
        <input
          className="input"
          name="max_users"
          inputMode="numeric"
          value={form.max_users}
          onChange={onChange('max_users')}
          placeholder="Unlimited"
        />
      </FormField>
      <FormField
        label="Max branches"
        error={errors.max_branches}
        hint="Store locations allowed. Leave blank for unlimited."
      >
        <input
          className="input"
          name="max_branches"
          inputMode="numeric"
          value={form.max_branches}
          onChange={onChange('max_branches')}
          placeholder="Unlimited"
        />
      </FormField>
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */
export default function AdminBusinessesPage() {
  useDocumentTitle('Businesses');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detailRow, setDetailRow] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side search on name/phone/email — debounce keystrokes ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const listQuery = useQuery({
    queryKey: qk.admin.businesses.list({ q: debouncedSearch || undefined }),
    queryFn: async () =>
      (
        await adminApi.businesses.list({
          page_size: 100,
          q: debouncedSearch || undefined,
        })
      ).data,
  });

  const createMutation = useApiMutation((data) => adminApi.businesses.create(data), {
    invalidates: [qk.admin.businesses.root],
  });
  const editMutation = useApiMutation(
    ({ id, data }) => adminApi.businesses.patch(id, data),
    { invalidates: [qk.admin.businesses.root] }
  );
  const toggleMutation = useApiMutation(
    ({ id, is_active }) => adminApi.businesses.patch(id, { is_active }),
    { invalidates: [qk.admin.businesses.root] }
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
    setCreateOpen(true);
  }

  function openEdit(row) {
    setForm({
      name: row.name || '',
      address: row.address || '',
      phone: row.phone || '',
      email: row.email || '',
      tax_rate:
        row.tax_rate !== null && row.tax_rate !== undefined ? String(row.tax_rate) : '',
      cashier_discount_cap:
        row.cashier_discount_cap !== null && row.cashier_discount_cap !== undefined
          ? String(row.cashier_discount_cap)
          : '',
      max_users: row.max_users !== null && row.max_users !== undefined ? String(row.max_users) : '',
      max_branches:
        row.max_branches !== null && row.max_branches !== undefined
          ? String(row.max_branches)
          : '',
    });
    setErrors({});
    setBanner(null);
    setEditing(row);
  }

  function openDetail(row) {
    setDetailRow(row);
  }

  async function handleCreate(event) {
    event.preventDefault();
    const clientErrors = validateBusiness(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      await createMutation.mutateAsync(buildPayload(form));
      setCreateOpen(false);
      setForm(EMPTY_FORM);
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  async function handleEdit(event) {
    event.preventDefault();
    const clientErrors = validateBusiness(form);
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      await editMutation.mutateAsync({ id: editing.id, data: buildPayload(form) });
      setEditing(null);
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
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
    { key: 'phone', header: 'Phone', render: (row) => row.phone || '—' },
    { key: 'email', header: 'Email', render: (row) => row.email || '—' },
    { key: 'tax_rate', header: 'Tax rate', render: (row) => `${row.tax_rate}%` },
    {
      key: 'cashier_discount_cap',
      header: 'Discount cap',
      render: (row) => `${row.cashier_discount_cap}%`,
    },
    { key: 'item_count', header: 'Items', render: (row) => row.item_count ?? 0 },
    {
      key: 'user_count',
      header: 'Users',
      render: (row) =>
        row.max_users != null ? `${row.user_count ?? 0} / ${row.max_users}` : (row.user_count ?? 0),
    },
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
            onClick={(event) => {
              event.stopPropagation();
              openEdit(row);
            }}
          >
            Edit
          </button>
          {row.is_active ? (
            <button
              type="button"
              className="btn-secondary border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-100"
              onClick={(event) => {
                event.stopPropagation();
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
              onClick={(event) => {
                event.stopPropagation();
                handleActivate(row);
              }}
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
        title="Businesses"
        description="Manage the tenant shops on this platform: create tenants, tune their tax and cashier discount settings, and pause access."
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Business
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load businesses — {apiErrorMessage(listQuery.error)}</span>
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
          placeholder="Search by name, phone or email..."
          aria-label="Search businesses"
        />
        <p className="shrink-0 text-sm font-medium text-slate-500">
          {listQuery.isPending
            ? 'Loading businesses...'
            : `${count} ${count === 1 ? 'business' : 'businesses'}`}
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Tenant businesses"
        onRowClick={openDetail}
        emptyTitle={debouncedSearch ? 'No businesses match your search' : 'No businesses yet'}
        emptyDescription={
          debouncedSearch
            ? 'Try a different name, phone number, or email address.'
            : 'Create the first tenant shop to onboard it onto the platform.'
        }
      />

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New business"
        description="Create a tenant shop. Its business admin can then invite staff and start selling."
        size="lg"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="create-business-form"
              className="btn-primary"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating...' : 'Create business'}
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
        <form id="create-business-form" onSubmit={handleCreate} noValidate>
          <BusinessFormFields form={form} errors={errors} onChange={setField} />
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.name}` : 'Edit business'}
        description="Update the tenant's profile, tax rate, and cashier discount cap."
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="edit-business-form"
              className="btn-primary"
              disabled={editMutation.isPending}
            >
              {editMutation.isPending ? 'Saving...' : 'Save changes'}
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
        <form id="edit-business-form" onSubmit={handleEdit} noValidate>
          <BusinessFormFields form={form} errors={errors} onChange={setField} />
        </form>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={Boolean(detailRow)}
        onClose={() => setDetailRow(null)}
        title={detailRow ? `Business details — ${detailRow.name}` : 'Business details'}
        description={detailRow ? `Created ${formatDate(detailRow.created_at)}` : ''}
        size="lg"
        footer={
          <>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                const row = detailRow;
                setDetailRow(null);
                if (row) openEdit(row);
              }}
            >
              Edit business
            </button>
            <button type="button" className="btn-secondary" onClick={() => setDetailRow(null)}>
              Close
            </button>
          </>
        }
      >
        {detailRow ? (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              {detailRow.is_active ? (
                <span className="badge bg-emerald-50 text-emerald-700">Active</span>
              ) : (
                <span className="badge bg-slate-100 text-slate-500">Inactive</span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard label="Items" value={detailRow.item_count ?? 0} />
              <StatCard label="Categories" value={detailRow.category_count ?? 0} />
              <StatCard label="Brands" value={detailRow.brand_count ?? 0} />
              <StatCard label="Branches" value={detailRow.branch_count ?? 0} />
              <StatCard label="Users" value={detailRow.user_count ?? 0} />
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Limits
              </h3>
              <div className="mt-2 space-y-1.5">
                <p className="text-sm text-slate-700">
                  Max users:{' '}
                  {detailRow.max_users != null && detailRow.max_users !== undefined
                    ? detailRow.max_users
                    : 'Unlimited'}
                </p>
                <p className="text-sm text-slate-700">
                  Max branches:{' '}
                  {detailRow.max_branches != null && detailRow.max_branches !== undefined
                    ? detailRow.max_branches
                    : 'Unlimited'}
                </p>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Profile
              </h3>
              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Address</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {detailRow.address || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Phone</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {detailRow.phone || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Email</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {detailRow.email || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Tax rate</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {detailRow.tax_rate != null ? `${detailRow.tax_rate}%` : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Discount cap</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {detailRow.cashier_discount_cap != null
                      ? `${detailRow.cashier_discount_cap}%`
                      : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Created</dt>
                  <dd className="text-right font-medium text-slate-900">
                    {formatDate(detailRow.created_at)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Deactivate confirm */}
      <Modal
        open={Boolean(confirmTarget)}
        onClose={() => setConfirmTarget(null)}
        title="Deactivate business?"
        description={
          confirmTarget
            ? `${confirmTarget.name} will be paused and its staff will no longer be able to sign in. You can reactivate it at any time.`
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
