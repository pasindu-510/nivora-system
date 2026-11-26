import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import Modal from './Modal.jsx';
import FormField from './FormField.jsx';

const EMPTY = { name: '', phone: '', nic: '', address: '' };
const FIELDS = [
  ['name', 'Name'],
  ['phone', 'Phone'],
  ['nic', 'NIC'],
  ['address', 'Address'],
];

/**
 * Search-and-select a saved customer, or create one without leaving the page.
 * Used for the buyer and for guarantors (who are ordinary customers).
 *
 * value: customer object | null
 * excludeIds: people already chosen elsewhere on the form
 */
export default function CustomerPicker({
  label,
  value,
  onChange,
  required = false,
  emptyLabel = 'Select a customer',
  excludeIds = [],
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Server-side search (name / phone / NIC), not just the first page.
  const params = { q: debounced, page_size: 100, ordering: 'name' };
  const query = useQuery({
    queryKey: qk.customers.list(params),
    queryFn: async () => (await customersApi.list(params)).data,
  });
  const found = (query.data && query.data.results) || [];
  const total = (query.data && query.data.count) || 0;
  // Keep the chosen person visible even when a new search no longer matches.
  const rows = (value && !found.some((row) => row.id === value.id) ? [value, ...found] : found)
    .filter((row) => (value && row.id === value.id) || !excludeIds.includes(row.id));

  const createMutation = useApiMutation((data) => customersApi.create(data), {
    invalidates: [qk.customers.root],
  });

  function openCreate() {
    setDraft(EMPTY);
    setError('');
    setCreating(true);
  }

  async function save() {
    if (!draft.name.trim()) {
      setError('Name is required.');
      return;
    }
    try {
      const payload = Object.fromEntries(
        Object.entries(draft).map(([key, text]) => [key, text.trim()]),
      );
      const { data } = await createMutation.mutateAsync(payload);
      onChange(data);
      setCreating(false);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="label">
          {label}{' '}
          {required ? (
            <span className="text-rose-500">*</span>
          ) : (
            <span className="font-normal text-slate-400">(optional)</span>
          )}
        </span>
        <button type="button" className="text-xs font-semibold text-brand-600" onClick={openCreate}>
          + New customer
        </button>
      </div>
      <input
        type="search"
        className="input mb-2"
        placeholder="Search by name, phone or NIC"
        aria-label={`${label} search`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        // The picker sits inside the sale form; Enter must not save the sale.
        onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}
      />
      <select
        className="input"
        aria-label={label}
        value={value ? String(value.id) : ''}
        onChange={(event) =>
          onChange(rows.find((row) => String(row.id) === event.target.value) || null)
        }
      >
        <option value="">{emptyLabel}</option>
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
            {row.phone ? ` — ${row.phone}` : ''}
            {row.nic ? ` NIC: ${row.nic}` : ''}
          </option>
        ))}
      </select>
      {query.isFetching ? (
        <p className="mt-1 text-xs text-slate-400">Searching…</p>
      ) : total > found.length ? (
        <p className="mt-1 text-xs text-slate-500">
          Showing {found.length} of {total} — type to narrow the list.
        </p>
      ) : debounced && total === 0 ? (
        <p className="mt-1 text-xs text-slate-500">No customer matches “{debounced}”.</p>
      ) : null}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={`New ${label.toLowerCase()}`}
        description="Saved to your customer list."
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={save}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Saving...' : 'Save customer'}
            </button>
          </>
        }
      >
        {error ? (
          <p className="mb-3 text-sm font-medium text-rose-600" role="alert">
            {error}
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FIELDS.map(([key, text]) => (
            <FormField key={key} label={text} required={key === 'name'}>
              <input
                className="input"
                aria-label={`New customer ${text}`}
                value={draft[key]}
                onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    save();
                  }
                }}
              />
            </FormField>
          ))}
        </div>
      </Modal>
    </div>
  );
}
