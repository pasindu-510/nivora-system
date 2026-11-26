import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { categoriesApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';

const EMPTY_FORM = { name: '', parent: '' };
const LIST_PARAMS = { page_size: 100 };

/** Client-side validation before hitting the API. */
function validateCategory(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Name is required.';
  return errors;
}

/** `parent` is a nullable FK: '' in the form -> null on the wire. */
function buildPayload(values) {
  return {
    name: values.name.trim(),
    parent: values.parent === '' ? null : Number(values.parent),
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

/**
 * Build the client-side tree: roots are `parent == null` (orphaned parents are
 * treated as roots), children sorted by name per level, emitted pre-order as a
 * flat list carrying `depth` for indentation. A `seen` guard makes stray
 * cycles harmless instead of infinite.
 */
function buildTreeRows(categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const childrenOf = new Map();
  categories.forEach((c) => {
    if (c.parent == null || !byId.has(c.parent)) return;
    if (!childrenOf.has(c.parent)) childrenOf.set(c.parent, []);
    childrenOf.get(c.parent).push(c);
  });
  const roots = categories
    .filter((c) => c.parent == null || !byId.has(c.parent))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const rows = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    rows.push({ ...node, depth });
    const kids = (childrenOf.get(node.id) || [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    kids.forEach((kid) => walk(kid, depth + 1));
  };
  roots.forEach((root) => walk(root, 0));
  // Anything unreachable (cycle leftovers) still gets listed.
  categories.forEach((c) => {
    if (!seen.has(c.id)) rows.push({ ...c, depth: 0 });
  });
  return rows;
}

/** The category's descendants (not including itself) — used to exclude parent options. */
function collectDescendantIds(categories, rootId) {
  const childrenOf = new Map();
  categories.forEach((c) => {
    if (c.parent == null) return;
    if (!childrenOf.has(c.parent)) childrenOf.set(c.parent, []);
    childrenOf.get(c.parent).push(c.id);
  });
  const out = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    (childrenOf.get(id) || []).forEach((childId) => {
      if (!out.has(childId)) {
        out.add(childId);
        stack.push(childId);
      }
    });
  }
  return out;
}

/* ---------------------------------- page ---------------------------------- */
export default function CategoriesPage() {
  useDocumentTitle('Categories');

  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [actionError, setActionError] = useState(null);

  // Categories are few — fetch everything once; search filters client-side.
  const listQuery = useQuery({
    queryKey: qk.categories.list(LIST_PARAMS),
    queryFn: async () => (await categoriesApi.list(LIST_PARAMS)).data,
  });

  // Deleting/rename a category changes item rows (category_name), so refresh both.
  const categoryInvalidation = [qk.categories.root, qk.items.root];
  const createMutation = useApiMutation((data) => categoriesApi.create(data), {
    invalidates: categoryInvalidation,
  });
  const editMutation = useApiMutation(({ id, data }) => categoriesApi.patch(id, data), {
    invalidates: categoryInvalidation,
  });
  const deleteMutation = useApiMutation(({ id }) => categoriesApi.remove(id), {
    invalidates: categoryInvalidation,
  });

  const allRows = listQuery.data && listQuery.data.results ? listQuery.data.results : [];

  // Structure map: parent id -> children, flattened pre-order with depth.
  const treeRows = useMemo(() => buildTreeRows(allRows), [allRows]);
  const byId = useMemo(() => new Map(allRows.map((c) => [c.id, c])), [allRows]);

  // Client-side filter by name across the full list (keeps each row's depth).
  const query = search.trim().toLowerCase();
  const rows = query
    ? treeRows.filter((row) => row.name.toLowerCase().includes(query))
    : treeRows;
  const count = treeRows.length;

  // Parent options: pre-order list, excluding the edited category + descendants.
  const parentOptions = useMemo(() => {
    if (!editing) return treeRows;
    const excluded = collectDescendantIds(allRows, editing.id);
    excluded.add(editing.id);
    return treeRows.filter((row) => !excluded.has(row.id));
  }, [editing, treeRows, allRows]);

  const setField = (key) => (event) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
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
      parent: row.parent != null ? String(row.parent) : '',
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
    const clientErrors = validateCategory(form);
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
      render: (row) => (
        <span className="inline-block" style={{ paddingLeft: row.depth * 20 }}>
          {row.depth > 0 ? <span className="text-slate-400">└ </span> : null}
          {row.name}
        </span>
      ),
    },
    {
      key: 'parent',
      header: 'Parent',
      render: (row) =>
        row.parent != null && byId.has(row.parent) ? byId.get(row.parent).name : '—',
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
          <button
            type="button"
            className="btn-danger px-2.5 py-1.5 text-xs"
            onClick={() => {
              setActionError(null);
              setDeleteTarget(row);
            }}
            disabled={deleteMutation.isPending}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Categories"
        description="Nested category tree for the catalog — for example Refrigerators, Washing Machines, Cookware."
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Category
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load categories — {apiErrorMessage(listQuery.error)}</span>
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          className="input w-full sm:max-w-xs"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search categories..."
          aria-label="Search categories"
        />
        <p className="shrink-0 text-sm font-medium text-slate-500">
          {listQuery.isPending
            ? 'Loading categories...'
            : query
              ? `${rows.length} of ${count} ${count === 1 ? 'category' : 'categories'}`
              : `${count} ${count === 1 ? 'category' : 'categories'}`}
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Catalog category tree"
        emptyTitle={query ? 'No categories match your search' : 'No categories yet'}
        emptyDescription={
          query
            ? 'Try a different name.'
            : 'Build your category tree to group products for filtering and reporting — use “New Category” above to create the first one.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.name}` : 'New category'}
        description={
          editing
            ? 'Update the name or move this category under a different parent.'
            : 'Group products for filtering, reporting, and seasonal discounts.'
        }
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="category-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                  ? 'Creating...'
                  : 'Create category'}
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
        <form id="category-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4">
            <FormField label="Name" required error={errors.name}>
              <input
                className="input"
                name="name"
                value={form.name}
                onChange={setField('name')}
                placeholder="e.g. Refrigerators"
              />
            </FormField>
            <FormField
              label="Parent"
              error={errors.parent}
              hint={
                editing
                  ? 'Sub-categories of this category cannot be chosen as its parent.'
                  : 'Leave as “None” to keep it at the top level.'
              }
            >
              <select
                className="input"
                name="parent"
                value={form.parent}
                onChange={setField('parent')}
              >
                <option value="">None (top level)</option>
                {parentOptions.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.depth > 0 ? `${'\u00A0\u00A0'.repeat(row.depth)}└ ` : ''}
                    {row.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        </form>
      </Modal>

      {/* Delete confirm — cascade warning is mandatory here */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete category?"
        description={
          deleteTarget
            ? `“${deleteTarget.name}” will be permanently removed. Deleting a category also deletes its sub-categories. Products keep their details but lose the category.`
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
