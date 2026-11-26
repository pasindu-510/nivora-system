import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { brandsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';

const EMPTY_FORM = { name: '' };

/** Client-side validation before hitting the API. */
function validateBrand(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Name is required.';
  return errors;
}

function buildPayload(values) {
  return { name: values.name.trim() };
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
export default function BrandsPage() {
  useDocumentTitle('Brands');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
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
    queryKey: qk.brands.list({ q: debouncedSearch || undefined, page_size: 100 }),
    queryFn: async () =>
      (
        await brandsApi.list({
          page_size: 100,
          q: debouncedSearch || undefined,
        })
      ).data,
  });

  // Item rows display `brand_name`, so every brand mutation refreshes items too.
  const brandInvalidation = [qk.brands.root, qk.items.root];
  const createMutation = useApiMutation((data) => brandsApi.create(data), {
    invalidates: brandInvalidation,
  });
  const editMutation = useApiMutation(({ id, data }) => brandsApi.patch(id, data), {
    invalidates: brandInvalidation,
  });
  const deleteMutation = useApiMutation(({ id }) => brandsApi.remove(id), {
    invalidates: brandInvalidation,
  });

  const allRows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : allRows.length;

  // The `search` param is sent for DRF SearchFilter, but this endpoint does
  // not activate it — mirror the filter client-side so the box still works
  // (page_size 100 means we hold the full list anyway).
  const query = debouncedSearch.toLowerCase();
  const rows = query
    ? allRows.filter((row) => row.name.toLowerCase().includes(query))
    : allRows;

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
    setForm({ name: row.name || '' });
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
    const clientErrors = validateBrand(form);
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
      render: (row) => row.name,
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
        title="Brands"
        description="The manufacturers and labels you carry, used for catalog filtering and brand-scoped promotions."
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + New Brand
          </button>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load brands — {apiErrorMessage(listQuery.error)}</span>
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
          placeholder="Search brands..."
          aria-label="Search brands"
        />
        <p className="shrink-0 text-sm font-medium text-slate-500">
          {listQuery.isPending
            ? 'Loading brands...'
            : query
              ? `${rows.length} of ${count} ${count === 1 ? 'brand' : 'brands'}`
              : `${count} ${count === 1 ? 'brand' : 'brands'}`}
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Product brands"
        emptyTitle={debouncedSearch ? 'No brands match your search' : 'No brands yet'}
        emptyDescription={
          debouncedSearch
            ? 'Try a different name.'
            : 'Add brands such as Samsung, LG, or Philips so products can be grouped by manufacturer — use “New Brand” above to create one.'
        }
      />

      {/* Create / edit modal — one form for both modes */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit ${editing.name}` : 'New brand'}
        description={
          editing
            ? 'Update the brand name. Products already using it stay linked.'
            : 'Add a manufacturer or label so products can be grouped and filtered.'
        }
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="brand-form"
              className="btn-primary"
              disabled={createMutation.isPending || editMutation.isPending}
            >
              {editing
                ? editMutation.isPending
                  ? 'Saving...'
                  : 'Save changes'
                : createMutation.isPending
                  ? 'Creating...'
                  : 'Create brand'}
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
        <form id="brand-form" onSubmit={handleSubmit} noValidate>
          <FormField label="Name" required error={errors.name}>
            <input
              className="input"
              name="name"
              value={form.name}
              onChange={setField('name')}
              placeholder="e.g. Samsung"
            />
          </FormField>
        </form>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete brand?"
        description={
          deleteTarget
            ? `${deleteTarget.name} will be permanently removed. Products that use it keep their details but lose the brand.`
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
