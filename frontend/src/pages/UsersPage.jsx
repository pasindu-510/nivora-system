import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { branchesApi, usersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { initials } from '../utils/format.js';
import { ROLES, roleLabel } from '../utils/permissions.js';
import { useAuth } from '../context/AuthContext.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';
import StatCard from '../components/StatCard.jsx';

/** Roles this screen may hand out — the API rejects `super_admin`. */
const ASSIGNABLE_ROLES = [ROLES.BUSINESS_ADMIN, ROLES.MANAGER, ROLES.CASHIER];

const LOOKUP_PARAMS = { page_size: 100 };
const LIST_PARAMS = { page_size: 100, ordering: 'username' };

/** Sentinel for the "Unassigned" branch filter option (staff with no branch). */
const UNASSIGNED_BRANCH = 'none';

const EMPTY_FORM = {
  username: '',
  password: '',
  full_name: '',
  phone: '',
  email: '',
  role: ROLES.CASHIER,
  branch: '',
  is_active: true,
};

/** Client-side validation before hitting the API (mirrors the backend rules). */
function validateUser(values, { requirePassword }) {
  const errors = {};
  if (!values.username.trim()) errors.username = 'Username is required.';
  if (!values.password) {
    if (requirePassword) errors.password = 'Password is required.';
  } else if (values.password.length < 8) {
    errors.password = 'Password must be at least 8 characters.';
  }
  if (!ASSIGNABLE_ROLES.includes(values.role)) {
    errors.role = 'Choose a role this business can assign.';
  }
  return errors;
}

/**
 * Wire payload. `business` is never sent — the server forces the caller's own
 * tenant — and `password` only goes out when there is one to set (it is
 * required on create, optional on edit).
 */
function buildPayload(values, mode) {
  const payload = {
    username: values.username.trim(),
    full_name: values.full_name.trim(),
    phone: values.phone.trim(),
    email: values.email.trim(),
    role: values.role,
    branch: values.branch ? Number(values.branch) : null,
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

/** Branch filter runs client-side on top of the server's `q` search. */
function matchesBranchFilter(row, filter) {
  if (!filter) return true;
  const assigned = row.branch == null ? '' : String(row.branch);
  return filter === UNASSIGNED_BRANCH ? assigned === '' : assigned === filter;
}

/** Shared create/edit form controls (house style: FormField + input/select). */
function UserFormFields({ form, errors, mode, branches, isSelf, onChange }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FormField label="Username" required error={errors.username}>
        <input
          className="input"
          name="username"
          autoComplete="off"
          value={form.username}
          onChange={onChange('username')}
          placeholder="e.g. kasun"
        />
      </FormField>
      <FormField
        label={mode === 'create' ? 'Password' : 'New password'}
        required={mode === 'create'}
        error={errors.password}
        hint={
          mode === 'create'
            ? 'Minimum 8 characters — this is what they sign in with.'
            : 'Leave blank to keep the current password.'
        }
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
          placeholder="e.g. Kasun Perera"
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
      <FormField label="Email" error={errors.email}>
        <input
          className="input"
          type="email"
          name="email"
          value={form.email}
          onChange={onChange('email')}
          placeholder="kasun@example.lk"
          spellCheck={false}
        />
      </FormField>
      <FormField
        label="Role"
        required
        error={errors.role}
        hint={
          isSelf
            ? 'You cannot change your own role.'
            : 'Cashiers sell, managers add stock and reports, admins manage everything.'
        }
      >
        <select
          className="input"
          name="role"
          value={form.role}
          onChange={onChange('role')}
          disabled={isSelf}
        >
          {ASSIGNABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {roleLabel(role)}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label="Branch"
        error={errors.branch}
        hint="Optional — leave as all branches for staff who work across the business."
      >
        <select
          className="input"
          name="branch"
          value={form.branch}
          onChange={onChange('branch')}
        >
          <option value="">All branches</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label="Status"
        error={errors.is_active}
        hint={isSelf ? 'You cannot deactivate your own account.' : 'Inactive accounts cannot sign in.'}
        className="sm:col-span-2"
      >
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            className="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={form.is_active}
            onChange={onChange('is_active')}
            disabled={isSelf}
          />
          Account is active
        </label>
      </FormField>
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */
export default function UsersPage() {
  useDocumentTitle('Users and Roles');

  const { user: currentUser } = useAuth();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Server-side search on username/full name/phone/email — debounce ~300ms.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const listParams = { ...LIST_PARAMS, q: debouncedSearch || undefined };

  const listQuery = useQuery({
    queryKey: qk.users.list(listParams),
    queryFn: async () => (await usersApi.list(listParams)).data,
  });

  // Branch names for the table column and the form's dropdown — always this
  // business's own branches, so a cross-tenant branch can never be selected.
  const branchQuery = useQuery({
    queryKey: qk.branches.list(LOOKUP_PARAMS),
    queryFn: async () => (await branchesApi.list(LOOKUP_PARAMS)).data,
    staleTime: 5 * 60 * 1000,
  });
  const branches = (branchQuery.data && branchQuery.data.results) || [];
  const branchNameById = useMemo(() => {
    const map = new Map();
    branches.forEach((branch) => map.set(branch.id, branch.name));
    return map;
  }, [branches]);

  const createMutation = useApiMutation((data) => usersApi.create(data), {
    invalidates: [qk.users.root],
  });
  const editMutation = useApiMutation(({ id, data }) => usersApi.patch(id, data), {
    invalidates: [qk.users.root, qk.auth.me],
  });
  const toggleMutation = useApiMutation(
    ({ id, is_active }) => usersApi.patch(id, { is_active }),
    { invalidates: [qk.users.root] }
  );
  const deleteMutation = useApiMutation(({ id }) => usersApi.remove(id), {
    invalidates: [qk.users.root],
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const serverCount = listQuery.data ? listQuery.data.count : rows.length;

  // Seat allowance rides on the same list response: `max_users === null` means
  // the tenant is unlimited, so there is no fraction to show and no cap to hit.
  const hasSeatLimit = Boolean(listQuery.data) && listQuery.data.max_users != null;
  const maxUsers = hasSeatLimit ? listQuery.data.max_users : null;
  const seatsUsed = listQuery.data ? listQuery.data.seats_used : 0;
  const seatsFull = hasSeatLimit && seatsUsed >= maxUsers;
  const seatsFree = hasSeatLimit ? maxUsers - seatsUsed : null;

  const visibleRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          (!roleFilter || row.role === roleFilter) &&
          matchesBranchFilter(row, branchFilter) &&
          (!statusFilter ||
            (statusFilter === 'active' ? row.is_active : !row.is_active))
      ),
    [rows, roleFilter, branchFilter, statusFilter]
  );

  const hasFilters = Boolean(debouncedSearch || roleFilter || branchFilter || statusFilter);
  const shownCount = hasFilters ? visibleRows.length : serverCount;
  const activeCount = rows.filter((row) => row.is_active).length;

  const isSelf = (row) => Boolean(currentUser && row && row.id === currentUser.id);
  const editingSelf = isSelf(editing);

  const setField = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  function clearFilters() {
    setSearch('');
    setDebouncedSearch('');
    setRoleFilter('');
    setBranchFilter('');
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
      username: row.username || '',
      password: '',
      full_name: row.full_name || '',
      phone: row.phone || '',
      email: row.email || '',
      role: ASSIGNABLE_ROLES.includes(row.role) ? row.role : ROLES.CASHIER,
      branch: row.branch || '',
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
    const clientErrors = validateUser(form, { requirePassword: !editing });
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      const payload = buildPayload(form, editing ? 'edit' : 'create');
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

  async function handleActivate(row) {
    setActionError(null);
    try {
      await toggleMutation.mutateAsync({ id: row.id, is_active: true });
    } catch (error) {
      setActionError(apiErrorMessage(error));
    }
  }

  async function handleDeactivateConfirm() {
    if (!deactivateTarget) return;
    setActionError(null);
    try {
      await toggleMutation.mutateAsync({ id: deactivateTarget.id, is_active: false });
      setDeactivateTarget(null);
    } catch (error) {
      setActionError(apiErrorMessage(error));
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
          {initials(row.full_name || row.username)}
        </span>
      ),
    },
    {
      key: 'full_name',
      header: 'Name',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => (
        <span className="flex items-center gap-2">
          <span>{row.full_name || '—'}</span>
          {isSelf(row) ? <span className="badge bg-brand-50 text-brand-700">You</span> : null}
        </span>
      ),
    },
    { key: 'username', header: 'Username', render: (row) => row.username },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        <span
          className={`badge ${
            row.role === ROLES.BUSINESS_ADMIN
              ? 'bg-brand-50 text-brand-700'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          {roleLabel(row.role)}
        </span>
      ),
    },
    {
      key: 'branch',
      header: 'Branch',
      render: (row) => (row.branch ? branchNameById.get(row.branch) || '—' : 'All branches'),
    },
    { key: 'phone', header: 'Phone', render: (row) => row.phone || '—' },
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
      render: (row) => {
        const self = isSelf(row);
        return (
          <div
            className="flex items-center justify-end gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs"
              aria-label={`Edit ${row.username}`}
              onClick={() => openEdit(row)}
            >
              Edit
            </button>
            {row.is_active ? (
              <button
                type="button"
                className="btn-secondary border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-100"
                aria-label={`Deactivate ${row.username}`}
                title={self ? 'You cannot deactivate your own account.' : 'Deactivate'}
                disabled={self || toggleMutation.isPending}
                onClick={() => {
                  setActionError(null);
                  setDeactivateTarget(row);
                }}
              >
                Deactivate
              </button>
            ) : (
              <button
                type="button"
                className="btn-secondary border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700 hover:bg-emerald-100"
                aria-label={`Activate ${row.username}`}
                title="Activate"
                disabled={toggleMutation.isPending}
                onClick={() => handleActivate(row)}
              >
                Activate
              </button>
            )}
            <button
              type="button"
              className="btn-danger px-2.5 py-1.5 text-xs"
              aria-label={`Delete ${row.username}`}
              title={self ? 'You cannot delete your own account.' : 'Delete'}
              disabled={self || deleteMutation.isPending}
              onClick={() => {
                setActionError(null);
                setDeleteTarget(row);
              }}
            >
              Delete
            </button>
          </div>
        );
      },
    },
  ];

  const confirmError = deactivateTarget || deleteTarget ? null : actionError;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users and Roles"
        description={
          listQuery.isPending
            ? 'Loading staff...'
            : `${shownCount} ${shownCount === 1 ? 'staff account' : 'staff accounts'}`
        }
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={openCreate}
            disabled={seatsFull}
            title={
              seatsFull
                ? 'All staff seats are in use — deactivate someone or ask the platform owner to raise your limit.'
                : undefined
            }
          >
            + Add staff
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load staff — {apiErrorMessage(listQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => listQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {confirmError ? (
        <div
          className="rounded-control border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
          role="alert"
        >
          {confirmError}
        </div>
      ) : null}

      {/* Seat allowance — `max_users: null` means the plan is unlimited. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Staff accounts"
          value={serverCount}
          hint="Includes inactive accounts"
          loading={listQuery.isPending}
        />
        <StatCard
          label="Seats used"
          value={hasSeatLimit ? `${seatsUsed} / ${maxUsers}` : 'Unlimited'}
          hint={
            !hasSeatLimit
              ? 'No seat limit on this plan'
              : seatsFull
              ? 'Limit reached — free a seat to add staff'
              : `${seatsFree} ${seatsFree === 1 ? 'seat' : 'seats'} left`}
          tone={seatsFull ? 'warning' : 'neutral'}
          loading={listQuery.isPending}
        />
        <StatCard
          label="Active staff"
          value={activeCount}
          hint="Accounts that can sign in"
          loading={listQuery.isPending}
        />
      </div>

      {seatsFull ? (
        <div
          className="rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="status"
        >
          All {maxUsers} staff seats are in use. Deactivate or delete a staff account to free one,
          or ask the platform owner to raise your limit.
        </div>
      ) : null}

      {/* Filter bar — search hits the server; role/branch/status refine locally. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <input
          className="input w-full sm:max-w-xs"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, username, phone or email..."
          aria-label="Search staff"
        />
        <select
          className="input w-full sm:max-w-48"
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value)}
          aria-label="Filter by role"
        >
          <option value="">All roles</option>
          {ASSIGNABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {roleLabel(role)}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:max-w-48"
          value={branchFilter}
          onChange={(event) => setBranchFilter(event.target.value)}
          aria-label="Filter by branch"
        >
          <option value="">All branches</option>
          <option value={UNASSIGNED_BRANCH}>Unassigned</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:max-w-48"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        {hasFilters ? (
          <button type="button" className="btn-secondary" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={visibleRows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Staff accounts for this business with role, branch and status"
        onRowClick={openEdit}
        emptyTitle={hasFilters ? 'No staff match your search' : 'No staff accounts yet'}
        emptyDescription={
          hasFilters
            ? 'Try a different name, username, role, or branch.'
            : 'Invite your staff and assign roles. Cashiers see sales and customers; managers add reports and stock.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.username}` : 'New staff account'}
        description={
          editing
            ? 'Update the profile, role, branch, and access status.'
            : 'Add a staff member, give them a role, and optionally scope them to one branch.'
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="user-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                ? 'Creating...'
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
        <form id="user-form" onSubmit={handleSubmit} noValidate>
          <UserFormFields
            form={form}
            errors={errors}
            mode={editing ? 'edit' : 'create'}
            branches={branches}
            isSelf={editingSelf}
            onChange={setField}
          />
        </form>
      </Modal>

      {/* Deactivate confirm */}
      <Modal
        open={Boolean(deactivateTarget)}
        onClose={() => setDeactivateTarget(null)}
        title="Deactivate staff account?"
        description={
          deactivateTarget
            ? `${deactivateTarget.full_name || deactivateTarget.username} will no longer be able to sign in. You can reactivate the account at any time.`
            : ''
        }
        size="sm"
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setDeactivateTarget(null)}
            >
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
        {actionError && deactivateTarget ? (
          <p className="text-sm font-medium text-rose-600" role="alert">
            {actionError}
          </p>
        ) : null}
      </Modal>

      {/* Delete confirm — deactivate first; this is for accounts you must remove */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete staff account?"
        description={
          deleteTarget
            ? `“${deleteTarget.full_name || deleteTarget.username}” will be permanently removed. Deactivating instead keeps their history on file. This action cannot be undone.`
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
        {actionError && deleteTarget ? (
          <p className="text-sm font-medium text-rose-600" role="alert">
            {actionError}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
