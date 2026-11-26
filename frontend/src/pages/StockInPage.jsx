import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  branchesApi,
  cashAccountsApi,
  itemsApi,
  stockInsApi,
  suppliersApi,
} from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import FormField from '../components/FormField.jsx';
import EntryDateField, { pastDate, useBackdate } from '../components/EntryDateField.jsx';

const LOOKUP = { page_size: 100 };
const PURCHASE = 'PURCHASE';
const OPENING = 'OPENING';

/** First readable message from a DRF error body, including nested line errors. */
function errorText(error) {
  const data = error?.response?.data;
  const find = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      for (const entry of Object.values(value)) {
        const message = find(entry);
        if (message) return message;
      }
    }
    return null;
  };
  return find(data) || apiErrorMessage(error);
}

const rowsOf = (query) => (query.data && query.data.results) || [];

export default function StockInPage() {
  useDocumentTitle('Stock In');
  const { today } = useBackdate();

  const [source, setSource] = useState(PURCHASE);
  const [branchId, setBranchId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [receivedDate, setReceivedDate] = useState('');
  const [note, setNote] = useState('');
  const [paidAmount, setPaidAmount] = useState('');
  const [cashAccountId, setCashAccountId] = useState('');
  const [lines, setLines] = useState([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const branchesQuery = useQuery({
    queryKey: qk.branches.list(LOOKUP),
    queryFn: async () => (await branchesApi.list(LOOKUP)).data,
  });
  const suppliersQuery = useQuery({
    queryKey: qk.suppliers.list(LOOKUP),
    queryFn: async () => (await suppliersApi.list(LOOKUP)).data,
  });
  const cashQuery = useQuery({
    queryKey: qk.finance.cashAccounts(LOOKUP),
    queryFn: async () => (await cashAccountsApi.list(LOOKUP)).data,
  });
  const itemParams = { q: debounced || undefined, is_active: true, page_size: 20 };
  const itemsQuery = useQuery({
    queryKey: qk.items.list(itemParams),
    queryFn: async () => (await itemsApi.list(itemParams)).data,
  });

  const branches = rowsOf(branchesQuery).filter((row) => row.is_active);
  const suppliers = rowsOf(suppliersQuery).filter((row) => row.is_active);
  const accounts = rowsOf(cashQuery).filter((row) => row.is_active);
  const items = rowsOf(itemsQuery);
  const branch = branchId || (branches.length === 1 ? String(branches[0].id) : '');

  const mutation = useApiMutation((data) => stockInsApi.create(data), {
    invalidates: [
      qk.items.root,
      qk.stock.root,
      qk.purchases.root,
      qk.suppliers.root,
      qk.finance.root,
      qk.reports.root,
    ],
  });

  const isPurchase = source === PURCHASE;
  const total = lines.reduce(
    (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitCost) || 0),
    0,
  );

  function addItem(item) {
    setDone('');
    setLines((current) =>
      current.some((line) => line.item.id === item.id)
        ? current
        : [
            ...current,
            {
              item,
              quantity: '1',
              unitCost: Number(item.cost_price) > 0 ? String(item.cost_price) : '',
              sellingPrice: '',
            },
          ],
    );
  }

  const setLine = (id, key) => (event) => {
    const { value } = event.target;
    setLines((current) =>
      current.map((line) => (line.item.id === id ? { ...line, [key]: value } : line)),
    );
  };

  function validate() {
    if (!branch) return 'Choose the branch that receives the stock.';
    if (isPurchase && !supplierId) return 'Choose a supplier.';
    if (!lines.length) return 'Add at least one item.';
    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return `${line.item.code}: quantity must be a whole number above 0.`;
      }
      if (line.unitCost === '' || !(Number(line.unitCost) >= 0)) {
        return `${line.item.code}: enter the unit cost.`;
      }
      if (line.sellingPrice !== '' && !(Number(line.sellingPrice) >= 0)) {
        return `${line.item.code}: the selling price cannot be negative.`;
      }
    }
    if (isPurchase && Number(paidAmount) > 0) {
      if (Number(paidAmount) > total + 0.005) return 'Paid amount is more than the total.';
      if (!cashAccountId) return 'Choose the account the money was paid from.';
    }
    return '';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setDone('');
    const problem = validate();
    setError(problem);
    if (problem) return;

    const paid = isPurchase ? Number(paidAmount) || 0 : 0;
    try {
      const { data } = await mutation.mutateAsync({
        source,
        branch: Number(branch),
        supplier: isPurchase ? Number(supplierId) : null,
        received_date: pastDate(receivedDate, today),
        note: note.trim(),
        paid_amount: paid,
        cash_account: paid > 0 ? Number(cashAccountId) : null,
        lines: lines.map((line) => ({
          item: line.item.id,
          quantity: Number(line.quantity),
          unit_cost: line.unitCost,
          selling_price: line.sellingPrice === '' ? null : line.sellingPrice,
        })),
      });
      setDone(
        `Stock added: ${data.line_count} item(s), total cost ${formatLKR(data.total_cost)}` +
          (data.order_no ? ` (${data.order_no}).` : '.'),
      );
      setLines([]);
      setPaidAmount('');
      setNote('');
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock In"
        description="Record goods that have arrived. Each line becomes its own FIFO cost lot."
      />

      {done ? (
        <div className="rounded-control border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800" role="status">
          {done}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="space-y-6">
        <section className="card space-y-4 p-5">
          <div className="flex flex-wrap gap-4">
            {[
              [PURCHASE, 'Supplier purchase'],
              [OPENING, 'Opening stock'],
            ].map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="source"
                  checked={source === value}
                  onChange={() => setSource(value)}
                />
                {label}
              </label>
            ))}
          </div>
          {!isPurchase ? (
            <p className="text-xs text-slate-500">
              For goods already in your shop. No supplier debt is created. Record the same value as
              owner capital so the balance sheet balances.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Branch" required>
              <select className="input" aria-label="Branch" value={branch} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Select branch</option>
                {branches.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </FormField>
            {isPurchase ? (
              <FormField label="Supplier" required>
                <select className="input" aria-label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Select supplier</option>
                  {suppliers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </FormField>
            ) : null}
            <EntryDateField label="Received date" value={receivedDate} onChange={setReceivedDate} />
            <FormField label="Note">
              <input
                className="input"
                aria-label="Note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. supplier bill number"
              />
            </FormField>
          </div>
        </section>

        <section className="card p-5">
          <label className="label" htmlFor="stock-in-search">
            Add items
          </label>
          <input
            id="stock-in-search"
            className="input"
            type="search"
            autoComplete="off"
            placeholder="Search by item code or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="mt-3 max-h-56 divide-y divide-slate-100 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                <p className="min-w-0 truncate text-sm text-slate-700">
                  <span className="font-semibold text-slate-900">{item.name}</span> · {item.code} ·{' '}
                  {item.stock_quantity} in stock
                </p>
                <button
                  type="button"
                  className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
                  onClick={() => addItem(item)}
                  disabled={lines.some((line) => line.item.id === item.id)}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
          {!itemsQuery.isPending && items.length === 0 ? (
            <p className="py-3 text-center text-sm text-slate-500">
              No items found. Create the item on the Items page first.
            </p>
          ) : null}
        </section>

        <section className="card p-5">
          <h2 className="text-base font-bold text-slate-900">Items received</h2>
          {lines.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">Nothing added yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3 font-semibold">Item</th>
                    <th className="py-2 pr-3 font-semibold">Quantity</th>
                    <th className="py-2 pr-3 font-semibold">Unit cost</th>
                    <th className="py-2 pr-3 font-semibold">New selling price</th>
                    <th className="py-2 pr-3 text-right font-semibold">Amount</th>
                    <th className="py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(({ item, quantity, unitCost, sellingPrice }) => {
                    const price = Number(sellingPrice === '' ? item.selling_price : sellingPrice);
                    const belowCost = unitCost !== '' && price < Number(unitCost);
                    return (
                      <tr key={item.id} className="border-b border-slate-100 align-top last:border-0">
                        <td className="py-2.5 pr-3">
                          <p className="font-medium text-slate-900">{item.name}</p>
                          <p className="text-xs text-slate-500">
                            {item.code} · last cost {formatLKR(item.cost_price)} · selling{' '}
                            {formatLKR(item.selling_price)}
                          </p>
                          {belowCost ? (
                            <p className="text-xs font-medium text-amber-700">
                              Selling price is below this cost.
                            </p>
                          ) : null}
                        </td>
                        <td className="py-2.5 pr-3">
                          <input className="input w-24" type="number" min="1" step="1" value={quantity} onChange={setLine(item.id, 'quantity')} aria-label={`${item.name} quantity`} />
                        </td>
                        <td className="py-2.5 pr-3">
                          <input className="input w-32" type="number" min="0" step="0.01" value={unitCost} onChange={setLine(item.id, 'unitCost')} aria-label={`${item.name} unit cost`} />
                        </td>
                        <td className="py-2.5 pr-3">
                          <input className="input w-32" type="number" min="0" step="0.01" placeholder="No change" value={sellingPrice} onChange={setLine(item.id, 'sellingPrice')} aria-label={`${item.name} new selling price`} />
                        </td>
                        <td className="py-2.5 pr-3 text-right font-semibold text-slate-900">
                          {formatLKR((Number(quantity) || 0) * (Number(unitCost) || 0))}
                        </td>
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            className="btn-ghost px-2 py-1 text-xs text-rose-600"
                            onClick={() => setLines((c) => c.filter((l) => l.item.id !== item.id))}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-4 text-right text-lg font-extrabold text-slate-900">
            Total cost {formatLKR(total)}
          </p>

          {isPurchase ? (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Paid now" hint="The rest is recorded as owed to the supplier.">
                <input
                  className="input"
                  aria-label="Paid now"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={paidAmount}
                  onChange={(e) => setPaidAmount(e.target.value)}
                />
              </FormField>
              {Number(paidAmount) > 0 ? (
                <FormField label="Paid from" required>
                  <select className="input" aria-label="Paid from" value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}>
                    <option value="">Select cash account</option>
                    {accounts.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                </FormField>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className="mt-4 rounded-control border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700" role="alert">
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex justify-end">
            <button type="submit" className="btn-primary" disabled={mutation.isPending || !lines.length}>
              {mutation.isPending ? 'Saving...' : 'Add stock'}
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
