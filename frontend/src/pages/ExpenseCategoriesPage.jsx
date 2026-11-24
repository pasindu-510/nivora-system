import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { expenseCategoriesApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { ROLES } from '../utils/permissions.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';

/**
 * Expense categories (blueprint G-01). Expenses and recurring expenses must
 * name a category, so a new business needs this screen before it can record
 * any expense. API: create/edit/delete is business_admin only; managers read.
 */
const EMPTY_FORM = { name: '', is_active: true };
const LIST_PARAMS = { page_size: 100, ordering: 'name' };

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

export default function ExpenseCategoriesPage() {
  useDocumentTitle('Expense Categories');
  const { user } = useAuth();
  const canEdit = user && user.role === ROLES.BUSINESS_ADMIN;

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  const listQuery = useQuery({
    queryKey: qk.finance.expenseCategories(LIST_PARAMS),
    queryFn: async () => (await expenseCategoriesApi.list(LIST_PARAMS)).data,
  });

  // Category names appear on expense rows, so refresh the whole finance tree.
  const invalidates = [['finance']];
  const createMutation = useApiMutation((data) => expenseCategoriesApi.create(data), { invalidates });
  const editMutation = useApiMutation(({ id, data }) => expenseCategoriesApi.patch(id, data), { invalidates });
  const deleteMutation = useApiMutation(({ id }) => expenseCategoriesApi.remove(id), { invalidates });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const saving = createMutation.isPending || editMutation.isPending;

  function openCreate() {
    setForm(EMPTY_FORM);
    setErrors({});
    setBanner(null);
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(row) {
    setForm({ name: row.name || '', is_active: row.is_active !== false });
    setErrors({});
    setBanner(null);
    setEditing(row);
    setModalOpen(true);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBanner(null);
    if (!form.name.trim()) {
      setErrors({ name: 'Name is required.' });
      return;
    }
    setErrors({});
    const payload = { name: form.name.trim(), is_active: form.is_active };
    try {
      if (editing) await editMutation.mutateAsync({ id: editing.id, data: payload });
      else await createMutation.mutateAsync(payload);
      setModalOpen(false);
      setEditing(null);
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
      key: 'is_active',
      header: 'Status',
      render: (row) =>
        row.is_active ? (
          <span className="badge bg-emerald-50 text-emerald-700">Active</span>
        ) : (
          <span className="badge bg-slate-100 text-slate-600">Inactive</span>
        ),
    },
  ];
  if (canEdit) {
    columns.push({
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => openEdit(row)}>
            Edit
          </button>
          <button
            type="button"
            className="btn-danger px-2.5 py-1.5 text-xs"
            onClick={() => {
              setActionError(null);
              setDeleteTarget(row);
            }}
          >
            Delete
          </button>
        </div>
      ),
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expense Categories"
        description="Group your spending (rent, electricity, salaries, transport…) so every expense and report is categorised."
        actions={
          canEdit ? (
            <button type="button" className="btn-primary" onClick={openCreate}>
              + New Category
            </button>
          ) : null
        }
      />

      {!canEdit ? (
        <p className="rounded-control border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Only the business admin can add or change expense categories.
        </p>
      ) : null}

      {listQuery.isError ? (
        <div className="rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800" role="alert">
          Could not load categories — {apiErrorMessage(listQuery.error)}
        </div>
      ) : null}

      {actionError && !deleteTarget ? (
        <div className="rounded-control border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700" role="alert">
          {actionError}
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Expense categories"
        emptyTitle="No expense categories yet"
        emptyDescription={
          canEdit
            ? 'Create categories such as Rent, Electricity or Salaries — expenses need one before they can be recorded.'
            : 'Ask the business admin to create expense categories.'
        }
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Edit ${editing.name}` : 'New expense category'}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="expense-category-form" className="btn-primary" disabled={saving}>
              {saving ? 'Saving...' : editing ? 'Save changes' : 'Create category'}
            </button>
          </>
        }
      >
        {banner ? (
          <div className="mb-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700" role="alert">
            {banner}
          </div>
        ) : null}
        <form id="expense-category-form" onSubmit={handleSubmit} noValidate className="space-y-4">
          <FormField label="Name" required error={errors.name}>
            <input
              className="input"
              name="name"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="e.g. Electricity"
            />
          </FormField>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(event) => setForm((prev) => ({ ...prev, is_active: event.target.checked }))}
            />
            Active (inactive categories stay on old expenses but are hidden from new ones)
          </label>
        </form>
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete category?"
        description={
          deleteTarget
            ? `${deleteTarget.name} will be removed. If expenses already use it, mark it inactive instead.`
            : ''
        }
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
            <button type="button" className="btn-danger" onClick={handleDeleteConfirm} disabled={deleteMutation.isPending}>
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
