import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { ALL_ROLES, ROLES, roleLabel } from '../utils/permissions.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';

const BUSINESS_ROLES = [ROLES.BUSINESS_ADMIN, ROLES.MANAGER, ROLES.CASHIER];

function isBusinessRole(role) {
  return BUSINESS_ROLES.includes(role);
}

const EMPTY_FORM = {
  username: '',
  password: '',
  full_name: '',
  phone: '',
  email: '',
  role: ROLES.MANAGER,
  business: '',
  is_active: true,
};

/** Client-side validation before hitting the API (mirrors the backend rules). */
function validateUser(values, { requirePassword }) {
  const errors = {};
  if (!values.username.trim()) errors.username = 'Username is required.';
  if (requirePassword) {
    if (!values.password) errors.password = 'Password is required.';
    else if (values.password.length < 8) {
      errors.password = 'Password must be at least 8 characters.';
    }
  } else if (values.password && values.password.length < 8) {
    errors.password = 'Password must be at least 8 characters.';
  }
  if (isBusinessRole(values.role) && !values.business) {
    errors.business = 'A business is required for business roles.';
  }
  return errors;
}

/** Blank password on edit = keep the existing one (the key is omitted). */
function buildUserPayload(values, mode) {
  const payload = {
    username: values.username.trim(),
    full_name: values.full_name.trim(),
    phone: values.phone.trim(),
    email: values.email.trim(),
    role: values.role,
    business: isBusinessRole(values.role) ? Number(values.business) : null,
    is_active: Boolean(values.is_active),
  };
  if (mode === 'create' || values.password) payload.password = values.password;
  return payload;
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

/** Shared create/edit form controls (house style: FormField + input/select). */
function UserFormFields({
  form,
  errors,
  mode,
  businessOptions,
  businessesLoading,
  onChange,
  onRoleChange,
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FormField label="Username" required error={errors.username}>
        <input
          className="input"
          name="username"
          autoComplete="off"
          value={form.username}
          onChange={onChange('username')}
          placeholder="e.g. nimal.manager"
        />
      </FormField>
      <FormField
        label={mode === 'create' ? 'Password' : 'New password'}
        required={mode === 'create'}
        error={errors.password}
        hint={mode === 'create' ? 'Minimum 8 characters.' : 'Leave blank to keep the current password.'}
      >
        <input
          className="input"
          type="password"
          name="password"
          autoComplete="new-password"
          value={form.password}
          onChange={onChange('password')}
          placeholder={mode === 'create' ? 'At least 8 characters' : '••••••••'}
        />
      </FormField>
      <FormField label="Full name" error={errors.full_name}>
        <input
          className="input"
          name="full_name"
          value={form.full_name}
          onChange={onChange('full_name')}
          placeholder="e.g. Nimal Perera"
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
          placeholder="name@example.com"
        />
      </FormField>
      <FormField label="Role" required error={errors.role}>
        <select className="input" name="role" value={form.role} onChange={onRoleChange}>
          {ALL_ROLES.map((role) => (
            <option key={role} value={role}>
              {roleLabel(role)}
            </option>
          ))}
        </select>
      </FormField>
      {isBusinessRole(form.role) ? (
        <FormField label="Business" required error={errors.business}>
          <select
            className="input"
            name="business"
            value={form.business}
            onChange={onChange('business')}
          >
            <option value="" disabled>
              {businessesLoading && !businessOptions.length
                ? 'Loading businesses...'
                : 'Select a business'}
            </option>
            {businessOptions.map((business) => (
              <option key={business.id} value={business.id}>
                {business.name}
              </option>
            ))}
          </select>
        </FormField>
      ) : (
        <FormField label="Business" hint="Super admin accounts are not tied to a business.">
          <select className="input" name="business" value="" disabled>
            <option value="">Not applicable</option>
          </select>
        </FormField>
      )}
      <FormField
        label="Status"
        hint="Inactive accounts cannot sign in."
        className="sm:col-span-2"
      >
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={form.is_active}
            onChange={onChange('is_active')}
          />
          Account is active
        </label>
      </FormField>
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */
export default function AdminUsersPage() {
  useDocumentTitle('Users');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side search on username/full_name/email — debounce keystrokes ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const listQuery = useQuery({
    queryKey: qk.admin.users.list({ q: debouncedSearch || undefined }),
    queryFn: async () =>
      (
        await adminApi.users.list({
          page_size: 100,
          q: debouncedSearch || undefined,
        })
      ).data,
  });

  // Users only carry the business FK id — fetch names to render the column/select.
  const businessesQuery = useQuery({
    queryKey: qk.admin.businesses.list({}),
    queryFn: async () =>
      (await adminApi.businesses.list({ page_size: 100 })).data,
  });
  const businessOptions = (businessesQuery.data && businessesQuery.data.results) || [];
  const businessNameById = useMemo(() => {
    const map = new Map();
    businessOptions.forEach((business) => map.set(business.id, business.name));
    return map;
  }, [businessOptions]);

  const createMutation = useApiMutation((data) => adminApi.users.create(data), {
    invalidates: [qk.admin.users.root],
  });
  const editMutation = useApiMutation(({ id, data }) => adminApi.users.patch(id, data), {
    invalidates: [qk.admin.users.root],
  });
  const resetMutation = useApiMutation(
    ({ id, password }) => adminApi.users.patch(id, { password }),
    { invalidates: [qk.admin.users.root] }
  );
  const toggleMutation = useApiMutation(
    ({ id, is_active }) => adminApi.users.patch(id, { is_active }),
    { invalidates: [qk.admin.users.root] }
  );

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;

  const setField = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleRoleChange = (event) => {
    const role = event.target.value;
    setForm((prev) => ({
      ...prev,
      role,
      // A super admin is never tied to a business — drop the stale selection.
      business: isBusinessRole(role) ? prev.business : '',
    }));
  };

  function openCreate() {
    setForm(EMPTY_FORM);
    setErrors({});
    setBanner(null);
    setCreateOpen(true);
  }

  function openEdit(row) {
    setForm({
      username: row.username || '',
      password: '',
      full_name: row.full_name || '',
      phone: row.phone || '',
      email: row.email || '',
      role: row.role || ROLES.MANAGER,
      business: row.business || '',
      is_active: Boolean(row.is_active),
    });
    setErrors({});
    setBanner(null);
    setEditing(row);
  }

  function openReset(row) {
    setResetPassword('');
    setResetError(null);
    setResetTarget(row);
  }

  async function handleCreate(event) {
    event.preventDefault();
    const clientErrors = validateUser(form, { requirePassword: true });
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      await createMutation.mutateAsync(buildUserPayload(form, 'create'));
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
    const clientErrors = validateUser(form, { requirePassword: false });
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      await editMutation.mutateAsync({ id: editing.id, data: buildUserPayload(form, 'edit') });
      setEditing(null);
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  async function handleResetPassword(event) {
    event.preventDefault();
    if (resetPassword.length < 8) {
      setResetError('Password must be at least 8 characters.');
      return;
    }
    setResetError(null);
    try {
      await resetMutation.mutateAsync({ id: resetTarget.id, password: resetPassword });
      setResetTarget(null);
      setResetPassword('');
    } catch (error) {
      setResetError(apiErrorMessage(error));
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

  async function handleToggleConfirm(nextActive) {
    if (!confirmTarget) return;
    setActionError(null);
    try {
      await toggleMutation.mutateAsync({ id: confirmTarget.id, is_active: nextActive });
      setConfirmTarget(null);
    } catch (error) {
      setActionError(apiErrorMessage(error));
    }
  }

  const columns = [
    {
      key: 'username',
      header: 'Username',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => row.username,
    },
    { key: 'full_name', header: 'Full name', render: (row) => row.full_name || '—' },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        <span
          className={`badge ${
            row.role === ROLES.SUPER_ADMIN
              ? 'bg-brand-50 text-brand-700'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          {roleLabel(row.role)}
        </span>
      ),
    },
    {
      key: 'business',
      header: 'Business',
      render: (row) => (row.business ? businessNameById.get(row.business) || '—' : '—'),
    },
    { key: 'email', header: 'Email', render: (row) => row.email || '—' },
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
          <button
            type="button"
            className="btn-secondary px-2.5 py-1.5 text-xs"
            onClick={() => openReset(row)}
          >
            Reset Password
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
        title="Users"
        description="Every account on the platform: super admins and each business's staff. Create users, reset passwords, and pause access."
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New User
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load users — {apiErrorMessage(listQuery.error)}</span>
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
          placeholder="Search by username, name or email..."
          aria-label="Search users"
        />
        <p className="shrink-0 text-sm font-medium text-slate-500">
          {listQuery.isPending ? 'Loading users...' : `${count} ${count === 1 ? 'user' : 'users'}`}
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Platform users"
        emptyTitle={debouncedSearch ? 'No users match your search' : 'No users yet'}
        emptyDescription={
          debouncedSearch
            ? 'Try a different username, full name, or email address.'
            : 'Create the first account — a super admin, or a staff member for a business.'
        }
      />

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New user"
        description="Business roles (business admin, manager, cashier) must be assigned to a business."
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
              form="create-user-form"
              className="btn-primary"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating...' : 'Create user'}
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
        <form id="create-user-form" onSubmit={handleCreate} noValidate>
          <UserFormFields
            form={form}
            errors={errors}
            mode="create"
            businessOptions={businessOptions}
            businessesLoading={businessesQuery.isPending}
            onChange={setField}
            onRoleChange={handleRoleChange}
          />
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.username}` : 'Edit user'}
        description="Update the account's profile, role, business, and status."
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="edit-user-form"
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
        <form id="edit-user-form" onSubmit={handleEdit} noValidate>
          <UserFormFields
            form={form}
            errors={errors}
            mode="edit"
            businessOptions={businessOptions}
            businessesLoading={businessesQuery.isPending}
            onChange={setField}
            onRoleChange={handleRoleChange}
          />
        </form>
      </Modal>

      {/* Reset password */}
      <Modal
        open={Boolean(resetTarget)}
        onClose={() => setResetTarget(null)}
        title={resetTarget ? `Reset password — ${resetTarget.username}` : 'Reset password'}
        description="Set a new password for this account. They will need it at their next sign-in."
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setResetTarget(null)}>
              Cancel
            </button>
            <button
              type="submit"
              form="reset-password-form"
              className="btn-primary"
              disabled={resetMutation.isPending}
            >
              {resetMutation.isPending ? 'Saving...' : 'Set password'}
            </button>
          </>
        }
      >
        <form id="reset-password-form" onSubmit={handleResetPassword} noValidate>
          <FormField
            label="New password"
            required
            error={resetError}
            hint="Minimum 8 characters."
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
              placeholder="At least 8 characters"
            />
          </FormField>
        </form>
      </Modal>

      {/* Deactivate confirm */}
      <Modal
        open={Boolean(confirmTarget)}
        onClose={() => setConfirmTarget(null)}
        title="Deactivate user?"
        description={
          confirmTarget
            ? `${confirmTarget.username} will no longer be able to sign in. You can reactivate the account at any time.`
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
              onClick={() => handleToggleConfirm(false)}
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
