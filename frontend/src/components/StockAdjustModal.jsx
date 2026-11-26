import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { itemsApi, stockMovementsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import Modal from './Modal.jsx';
import FormField from './FormField.jsx';

/**
 * Manual stock correction (blueprint G-02) → POST /api/items/<id>/adjust/.
 * "Add" opens a new FIFO lot at the given unit cost, or the item's last cost
 * (found stock, returns to shelf); "Remove" writes units off the branch's oldest lots (damaged,
 * lost). The server refuses to remove more than the branch holds.
 */
const EMPTY = { direction: 'remove', quantity: '', note: '', unitCost: '' };

export default function StockAdjustModal({ open, onClose, branches }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [itemId, setItemId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setItemId('');
    setForm(EMPTY);
    setErrors({});
    setBanner(null);
    setDone(null);
    setBranchId(branches.length === 1 ? String(branches[0].id) : '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const itemsParams = { q: debounced || undefined, page_size: 50 };
  const itemsQuery = useQuery({
    queryKey: qk.items.list(itemsParams),
    queryFn: async () => (await itemsApi.list(itemsParams)).data,
    enabled: open,
  });
  const items = (itemsQuery.data && itemsQuery.data.results) || [];
  const selected = items.find((row) => String(row.id) === itemId);

  const mutation = useApiMutation(({ id, data }) => stockMovementsApi.create(id, data), {
    invalidates: [qk.stock.root, qk.items.root],
  });

  async function handleSubmit(event) {
    event.preventDefault();
    setBanner(null);
    const quantity = parseInt(form.quantity, 10);
    const clientErrors = {};
    if (!itemId) clientErrors.item = 'Choose an item.';
    if (!branchId) clientErrors.branch = 'Choose a branch.';
    if (!(quantity > 0)) clientErrors.quantity = 'Enter a whole number above 0.';
    if (!form.note.trim()) clientErrors.note = 'Give a reason so the change can be traced later.';
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;
    try {
      const response = await mutation.mutateAsync({
        id: itemId,
        data: {
          branch: Number(branchId),
          quantity: form.direction === 'remove' ? -quantity : quantity,
          note: form.note.trim(),
          unit_cost: form.direction === 'add' && form.unitCost !== '' ? form.unitCost : undefined,
        },
      });
      setDone(
        `${selected ? selected.name : 'Item'}: ${form.direction === 'remove' ? 'removed' : 'added'} ${quantity}. ` +
          `New total stock: ${response.data.new_stock}.`,
      );
      setForm(EMPTY);
    } catch (error) {
      const data = error && error.response && error.response.data;
      if (data && (data.quantity || data.branch || data.unit_cost)) {
        setErrors({ quantity: data.quantity, branch: data.branch, unitCost: data.unit_cost });
      } else {
        setBanner(apiErrorMessage(error));
      }
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Adjust stock"
      description="Correct stock for damaged, lost or found units. Every change is recorded in Stock Movements."
      size="lg"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" form="stock-adjust-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving...' : 'Save adjustment'}
          </button>
        </>
      }
    >
      {done ? (
        <div className="mb-4 rounded-control border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm font-medium text-emerald-800" role="status">
          {done}
        </div>
      ) : null}
      {banner ? (
        <div className="mb-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700" role="alert">
          {banner}
        </div>
      ) : null}
      <form id="stock-adjust-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <FormField label="Item" required error={errors.item}>
          <input
            type="search"
            className="input mb-2"
            placeholder="Search by item code or name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select className="input" value={itemId} onChange={(event) => setItemId(event.target.value)} aria-label="Item">
            <option value="">{itemsQuery.isFetching ? 'Searching…' : 'Select an item'}</option>
            {items.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} — {row.name} ({row.stock_quantity} in stock)
              </option>
            ))}
          </select>
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Branch" required error={errors.branch}>
            <select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">Select a branch</option>
              {branches.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Change" required>
            <select
              className="input"
              value={form.direction}
              onChange={(event) => setForm((prev) => ({ ...prev, direction: event.target.value }))}
            >
              <option value="remove">Remove units (damaged / lost)</option>
              <option value="add">Add units (found / returned)</option>
            </select>
          </FormField>
          <FormField label="Quantity" required error={errors.quantity}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={form.quantity}
              onChange={(event) => setForm((prev) => ({ ...prev, quantity: event.target.value }))}
              placeholder="e.g. 2"
            />
          </FormField>
          <FormField label="Reason" required error={errors.note}>
            <input
              className="input"
              value={form.note}
              onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
              placeholder="e.g. Damaged in delivery"
            />
          </FormField>
        </div>
        {form.direction === 'add' ? (
          <FormField
            label="Unit cost"
            error={errors.unitCost}
            hint="Used for profit calculations. Leave blank to use the item's last cost."
          >
            <input
              className="input"
              aria-label="Unit cost"
              type="number"
              min="0"
              step="0.01"
              value={form.unitCost}
              onChange={(event) => setForm((prev) => ({ ...prev, unitCost: event.target.value }))}
              placeholder={selected ? String(selected.cost_price) : '0.00'}
            />
          </FormField>
        ) : null}
      </form>
    </Modal>
  );
}
