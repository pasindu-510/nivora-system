import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApiMutation } from '../hooks/useApiMutation.js';
import {
  salesApi,
  itemsApi,
  branchesApi,
  customersApi,
  cashAccountsApi,
} from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import EntryDateField, { pastDate, useBackdate } from '../components/EntryDateField.jsx';

/** Installment frequency choices mirror `Sale.FREQUENCY_CHOICES` on the backend. */
const FREQUENCY_OPTIONS = [
  { value: 'WEEKLY', label: 'Weekly', days: '7' },
  { value: 'MONTHLY', label: 'Monthly', days: '30' },
  { value: 'CUSTOM', label: 'Custom interval', days: '' },
];

/** Discount type choices mirror `Sale.DISCOUNT_TYPE_CHOICES` on the backend. */
const DISCOUNT_PERCENT = 'PERCENT';
const DISCOUNT_AMOUNT = 'AMOUNT';

/** Decimal-safe numeric coercion for form inputs. */
function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Per-branch available quantity for an item.
 * `branch_stock` is a list of {branch_id, branch_name, quantity} rows (quantity > 0).
 */
function stockForBranch(item, branchId) {
  const rows = item.branch_stock;
  if (branchId && Array.isArray(rows)) {
    const match = rows.find((row) => String(row.branch_id) === String(branchId));
    if (match) return toNumber(match.quantity);
    return 0;
  }
  return toNumber(item.stock_quantity);
}

export default function NewSalePage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  // ── Form state ────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [branchId, setBranchId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [debouncedCustomerSearch, setDebouncedCustomerSearch] = useState('');
  // Keep the chosen customer visible even when a new search no longer matches it.
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [cart, setCart] = useState([]);
  const [discountType, setDiscountType] = useState(DISCOUNT_PERCENT);
  const [discountValue, setDiscountValue] = useState('0');
  const [taxRate, setTaxRate] = useState('');
  const [isSinglePayment, setIsSinglePayment] = useState(true);
  const [downPayment, setDownPayment] = useState('0');
  const [installmentCount, setInstallmentCount] = useState('3');
  const [installmentFrequency, setInstallmentFrequency] = useState('MONTHLY');
  const [installmentIntervalDays, setInstallmentIntervalDays] = useState('30');
  const [cashAccountId, setCashAccountId] = useState('');
  const [formError, setFormError] = useState('');
  const { today, allowed: canBackdate } = useBackdate();
  const [saleDate, setSaleDate] = useState('');
  const backDate = canBackdate ? pastDate(saleDate, today) : undefined;

  useDocumentTitle('New Sale');

  // ── Debounce the item search box ──────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedCustomerSearch(customerSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [customerSearch]);

  // ── Queries ───────────────────────────────────────────────────────────────
  const branchesQuery = useQuery({
    queryKey: qk.branches.list({ is_active: true }),
    queryFn: async () => (await branchesApi.list({ is_active: true })).data,
  });

  const customersQuery = useQuery({
    // Server-side search (name / phone / NIC) so shops with many customers
    // can find anyone, not just the first page.
    queryKey: qk.customers.list({ q: debouncedCustomerSearch, page_size: 100, ordering: 'name' }),
    queryFn: async () =>
      (await customersApi.list({ q: debouncedCustomerSearch, page_size: 100, ordering: 'name' })).data,
  });

  const cashAccountsQuery = useQuery({
    queryKey: qk.finance.cashAccounts({ is_active: true }),
    queryFn: async () => (await cashAccountsApi.list({ is_active: true })).data,
  });

  // A past sale date prices items with the promotions active on that day.
  const itemParams = { q: debouncedSearch, is_active: true, price_date: backDate };
  const itemsQuery = useQuery({
    queryKey: qk.items.list(itemParams),
    queryFn: async () => (await itemsApi.list(itemParams)).data,
  });

  // ── Mutation: create sale ─────────────────────────────────────────────────
  const createSale = useApiMutation((payload) => salesApi.create(payload), {
    invalidates: [
      qk.sales.root,
      qk.items.root,
      qk.stock.root,
      qk.dashboard.summary({}),
      qk.installments.due({}),
    ],
  });

  const branches = useMemo(() => {
    const rows = (branchesQuery.data && branchesQuery.data.results) || [];
    return rows.filter((row) => row.is_active);
  }, [branchesQuery.data]);

  const customers = useMemo(() => {
    const rows = (customersQuery.data && customersQuery.data.results) || [];
    if (selectedCustomer && !rows.some((row) => row.id === selectedCustomer.id)) {
      return [selectedCustomer, ...rows];
    }
    return rows;
  }, [customersQuery.data, selectedCustomer]);
  const customerTotal = (customersQuery.data && customersQuery.data.count) || 0;

  const cashAccounts = useMemo(() => {
    const rows = (cashAccountsQuery.data && cashAccountsQuery.data.results) || [];
    return rows.filter((row) => row.is_active);
  }, [cashAccountsQuery.data]);

  const itemResults = useMemo(() => {
    const rows = (itemsQuery.data && itemsQuery.data.results) || [];
    return rows.filter((row) => row.is_active);
  }, [itemsQuery.data]);

  // Default the branch to the only active branch (or the first) once loaded.
  useEffect(() => {
    if (branchId || branches.length === 0) return;
    setBranchId(String(branches[0].id));
  }, [branches, branchId]);

  // Default the cash account to the first active account once loaded.
  useEffect(() => {
    if (cashAccountId || cashAccounts.length === 0) return;
    setCashAccountId(String(cashAccounts[0].id));
  }, [cashAccounts, cashAccountId]);

  // Pre-fill the tax field with the business default once, so the figure the
  // cashier sees matches what the backend will charge. A ref keeps this from
  // re-filling after the cashier deliberately clears the box.
  const taxDefaultedRef = useRef(false);
  useEffect(() => {
    if (taxDefaultedRef.current || !user) return;
    taxDefaultedRef.current = true;
    const rate = user.business_tax_rate;
    if (rate !== undefined && rate !== null && rate !== '') {
      setTaxRate(String(rate));
    }
  }, [user]);

  // ── Cart operations ───────────────────────────────────────────────────────
  function addToCart(item) {
    setCart((current) => {
      const existing = current.find((line) => line.id === item.id);
      if (existing) {
        return current.map((line) =>
          line.id === item.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...current,
        {
          id: item.id,
          code: item.code,
          name: item.name,
          // `effective_price` is the seasonal-discounted price the backend
          // will actually charge; fall back to the list price if absent.
          price: toNumber(item.effective_price ?? item.selling_price),
          quantity: 1,
        },
      ];
    });
  }

  function changeQuantity(itemId, nextQuantity) {
    setCart((current) =>
      current
        .map((line) => (line.id === itemId ? { ...line, quantity: nextQuantity } : line))
        .filter((line) => line.quantity > 0),
    );
  }

  function clearCart() {
    setCart([]);
  }

  // Prices depend on the date, so changing it starts the cart again.
  function changeSaleDate(value) {
    setSaleDate(value);
    clearCart();
  }

  // Back-dated sales only: record the price actually charged at the time.
  function changePrice(itemId, value) {
    setCart((current) =>
      current.map((line) =>
        line.id === itemId ? { ...line, price: toNumber(value), customPrice: value } : line,
      ),
    );
  }

  // ── Totals (display only; the backend recomputes on save) ────────────────
  // The backend falls back to `business.tax_rate` when a sale omits tax_rate,
  // so an empty field must display that same default, not zero.
  const businessTaxRate =
    user && user.business_tax_rate !== undefined && user.business_tax_rate !== null
      ? toNumber(user.business_tax_rate)
      : 0;

  const totals = useMemo(() => {
    const subtotal = cart.reduce((sum, line) => sum + line.price * line.quantity, 0);
    const rawDiscount = toNumber(discountValue);
    const discountAmount =
      discountType === DISCOUNT_PERCENT
        ? Math.min(subtotal, (subtotal * rawDiscount) / 100)
        : Math.min(subtotal, rawDiscount);
    const taxable = subtotal - discountAmount;
    const rate = taxRate === '' ? businessTaxRate : toNumber(taxRate);
    const taxAmount = rate > 0 ? (taxable * rate) / 100 : 0;
    return {
      subtotal,
      discountAmount,
      taxAmount,
      total: taxable + taxAmount,
    };
  }, [cart, discountType, discountValue, taxRate, businessTaxRate]);

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(event) {
    event.preventDefault();
    setFormError('');

    if (!branchId) {
      setFormError('Select a branch before saving the sale.');
      return;
    }
    if (cart.length === 0) {
      setFormError('Add at least one item to the cart.');
      return;
    }

    const down = toNumber(downPayment);
    if (!isSinglePayment) {
      if (toNumber(installmentCount) < 1) {
        setFormError('Enter how many installments the customer will pay.');
        return;
      }
      if (down < 0 || down >= totals.total) {
        setFormError('Down payment must be more than 0 and less than the total.');
        return;
      }
    }

    const payload = {
      branch: Number(branchId),
      customer: customerId ? Number(customerId) : null,
      lines: cart.map((line) => ({
        item: line.id,
        quantity: line.quantity,
        unit_price:
          backDate && line.customPrice !== undefined && line.customPrice !== ''
            ? line.price
            : undefined,
      })),
      sale_date: backDate,
      discount_type: discountType,
      discount_value: toNumber(discountValue),
      tax_rate: taxRate === '' ? null : toNumber(taxRate),
      is_single_payment: isSinglePayment,
      down_payment: isSinglePayment ? totals.total : down,
      number_of_installments: isSinglePayment ? 0 : toNumber(installmentCount),
      installment_frequency: installmentFrequency,
      installment_interval_days: toNumber(installmentIntervalDays) || 30,
      cash_account: cashAccountId ? Number(cashAccountId) : null,
    };

    try {
      const response = await createSale.mutateAsync(payload);
      const sale = response && response.data ? response.data : response;
      if (sale && sale.id) {
        navigate(`/sales/${sale.id}`);
        return;
      }
      navigate('/sales');
    } catch (error) {
      setFormError(apiErrorMessage(error));
    }
  }

  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const isSubmitting = createSale.isPending;
  const busy = isSubmitting || itemsQuery.isFetching;
  const savedBy = user ? user.username : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Sale"
        description="Search items, build the cart, and record a walk-in or customer sale."
        actions={
          cart.length > 0 ? (
            <button type="button" className="btn-secondary" onClick={clearCart} disabled={busy}>
              Clear cart
            </button>
          ) : null
        }
      />

      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* ── Left column: branch/customer + item search + cart ─────────────── */}
        <div className="space-y-6">
          <section className="card p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="sale-branch">
                  Branch
                </label>
                <select
                  id="sale-branch"
                  className="input"
                  value={branchId}
                  onChange={(event) => setBranchId(event.target.value)}
                  required
                >
                  <option value="">Select branch</option>
                  {branches.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
                {branchesQuery.isError ? (
                  <p className="mt-1 text-xs text-rose-600">
                    {apiErrorMessage(branchesQuery.error)}
                  </p>
                ) : null}
              </div>

<div>
                <label className="label" htmlFor="sale-customer-search">
                  Customer <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <input
                  id="sale-customer-search"
                  type="search"
                  className="input mb-2"
                  placeholder="Search customer by name, phone or NIC"
                  value={customerSearch}
                  onChange={(event) => setCustomerSearch(event.target.value)}
                />
                <select
                  id="sale-customer"
                  className="input"
                  aria-label="Customer"
                  value={customerId}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCustomerId(value);
                    setSelectedCustomer(customers.find((row) => String(row.id) === value) || null);
                  }}
                >
                  <option value="">Walk-in customer</option>
                  {customers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                      {row.phone ? ` — ${row.phone}` : ''}
                      {row.nic ? ` NIC: ${row.nic}` : ''}
                    </option>
                  ))}
                </select>
                {customersQuery.isFetching ? (
                  <p className="mt-1 text-xs text-slate-400">Searching…</p>
                ) : customerTotal > customers.length ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Showing {customers.length} of {customerTotal} customers — type to narrow the list.
                  </p>
                ) : debouncedCustomerSearch && customerTotal === 0 ? (
                  <p className="mt-1 text-xs text-slate-500">No customer matches “{debouncedCustomerSearch}”.</p>
                ) : null}
              </div>

              <EntryDateField label="Sale date" value={saleDate} onChange={changeSaleDate} />
            </div>
            {backDate ? (
              <p className="mt-3 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Back-dated sale: only stock received by this date can be sold, and reports for that
                date will change. Changing the date empties the cart.
              </p>
            ) : null}
          </section>

          <section className="card p-5">
            <label className="label" htmlFor="sale-search">
              Search items
            </label>
            <input
              id="sale-search"
              className="input"
              type="search"
              placeholder="Search by item code or name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoComplete="off"
            />

            <div className="mt-3 max-h-72 overflow-y-auto">
              {itemsQuery.isError ? (
                <p className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {apiErrorMessage(itemsQuery.error)}
                </p>
              ) : null}

              {!itemsQuery.isError && itemResults.length === 0 ? (
                <p className="px-1 py-6 text-center text-sm text-slate-500">
                  {itemsQuery.isPending
                    ? 'Loading items...'
                    : debouncedSearch
                      ? `No items match "${debouncedSearch}".`
                      : 'Start typing to search for items.'}
                </p>
              ) : null}

              <ul className="divide-y divide-slate-100">
                {itemResults.map((item) => {
                  const available = stockForBranch(item, branchId);
                  const soldOut = available <= 0;
                  return (
                    <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{item.name}</p>
                        <p className="truncate text-xs text-slate-500">
                          {item.code} · {formatLKR(item.effective_price ?? item.selling_price)} ·{' '}
                          <span className={soldOut ? 'font-semibold text-rose-600' : ''}>
                            {soldOut ? 'Out of stock' : `${available} in stock`}
                          </span>
                          {Number(item.discount_percent) > 0 ? (
                            <span className="ml-1 font-medium text-emerald-600">
                              ({item.discount_percent}% off)
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
                        onClick={() => addToCart(item)}
                        disabled={soldOut || busy}
                      >
                        Add
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <section className="card p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-900">Cart</h2>
              <span className="badge">{cartCount} item(s)</span>
            </div>

            {cart.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">Cart is empty.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-3 font-semibold">Item</th>
                      <th className="py-2 pr-3 font-semibold">Price</th>
                      <th className="py-2 pr-3 font-semibold">Qty</th>
                      <th className="py-2 pr-3 text-right font-semibold">Amount</th>
                      <th className="py-2 text-right font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((line) => (
                      <tr key={line.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2.5 pr-3">
                          <p className="font-medium text-slate-900">{line.name}</p>
                          <p className="text-xs text-slate-500">{line.code}</p>
                        </td>
                        <td className="py-2.5 pr-3 text-slate-700">
                          {backDate ? (
                            <input
                              className="input w-28 px-2 py-1 text-sm"
                              type="number"
                              min="0"
                              step="0.01"
                              value={line.customPrice ?? line.price}
                              onChange={(event) => changePrice(line.id, event.target.value)}
                              aria-label={`${line.name} unit price`}
                            />
                          ) : (
                            formatLKR(line.price)
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              className="btn-ghost px-2 py-1 text-xs"
                              onClick={() => changeQuantity(line.id, line.quantity - 1)}
                              disabled={busy}
                              aria-label={`Reduce ${line.name} quantity`}
                            >
                              −
                            </button>
                            <input
                              className="input w-16 px-2 py-1 text-center text-sm"
                              type="number"
                              min="1"
                              value={line.quantity}
                              onChange={(event) =>
                                changeQuantity(line.id, Math.max(1, toNumber(event.target.value)))
                              }
                              aria-label={`${line.name} quantity`}
                            />
                            <button
                              type="button"
                              className="btn-ghost px-2 py-1 text-xs"
                              onClick={() => changeQuantity(line.id, line.quantity + 1)}
                              disabled={busy}
                              aria-label={`Increase ${line.name} quantity`}
                            >
                              +
                            </button>
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 text-right font-semibold text-slate-900">
                          {formatLKR(line.price * line.quantity)}
                        </td>
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            className="btn-ghost px-2 py-1 text-xs text-rose-600"
                            onClick={() => changeQuantity(line.id, 0)}
                            disabled={busy}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {/* ── Right column: totals + payment + save ────────────────────────── */}
        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="text-base font-bold text-slate-900">Summary</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Subtotal</dt>
                <dd className="font-medium text-slate-900">{formatLKR(totals.subtotal)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Discount</dt>
                <dd className="font-medium text-slate-900">
                  −{formatLKR(totals.discountAmount)}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Tax</dt>
                <dd className="font-medium text-slate-900">{formatLKR(totals.taxAmount)}</dd>
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 pt-2">
                <dt className="font-semibold text-slate-900">Total</dt>
                <dd className="text-lg font-extrabold text-slate-900">
                  {formatLKR(totals.total)}
                </dd>
              </div>
            </dl>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="sale-discount-type">
                  Discount type
                </label>
                <select
                  id="sale-discount-type"
                  className="input"
                  value={discountType}
                  onChange={(event) => setDiscountType(event.target.value)}
                >
                  <option value={DISCOUNT_PERCENT}>Percent (%)</option>
                  <option value={DISCOUNT_AMOUNT}>Fixed amount</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="sale-discount-value">
                  Discount value
                </label>
                <input
                  id="sale-discount-value"
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={discountValue}
                  onChange={(event) => setDiscountValue(event.target.value)}
                />
              </div>
<div>
                 <label className="label" htmlFor="sale-tax-rate">
                   Tax rate (%)
                 </label>
                 <input
                   id="sale-tax-rate"
                   className="input"
                   type="number"
                   min="0"
                   step="0.01"
                   placeholder="0"
                   value={taxRate}
                   onChange={(event) => setTaxRate(event.target.value)}
                   disabled={user.role === 'cashier'}
                 />
               </div>
              <div>
                <label className="label" htmlFor="sale-cash-account">
                  Cash account
                </label>
                <select
                  id="sale-cash-account"
                  className="input"
                  value={cashAccountId}
                  onChange={(event) => setCashAccountId(event.target.value)}
                >
                  <option value="">No account</option>
                  {cashAccounts.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="card p-5">
            <h2 className="text-base font-bold text-slate-900">Payment</h2>
            <div className="mt-3 flex gap-4">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="payment-mode"
                  value="single"
                  checked={isSinglePayment}
                  onChange={() => setIsSinglePayment(true)}
                />
                Pay in full
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="payment-mode"
                  value="installments"
                  checked={!isSinglePayment}
                  onChange={() => setIsSinglePayment(false)}
                />
                Installments
              </label>
            </div>

            {isSinglePayment ? (
              <p className="mt-3 rounded-control bg-slate-50 px-3 py-2 text-sm text-slate-600">
                The full total of <strong>{formatLKR(totals.total)}</strong> is recorded as paid now.
              </p>
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="sale-down-payment">
                    Down payment
                  </label>
                  <input
                    id="sale-down-payment"
                    className="input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={downPayment}
                    onChange={(event) => setDownPayment(event.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="sale-installment-count">
                    Number of installments
                  </label>
                  <input
                    id="sale-installment-count"
                    className="input"
                    type="number"
                    min="1"
                    step="1"
                    value={installmentCount}
                    onChange={(event) => setInstallmentCount(event.target.value)}
                    max={user.business?.max_installments || undefined}
                  />
                  {user.business?.max_installments && user.role === 'cashier' && Number(installmentCount) > user.business.max_installments && (
                    <p className="mt-2 text-xs text-rose-600">
                      Cannot exceed maximum installments of {user.business.max_installments}
                    </p>
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="sale-frequency">
                    Frequency
                  </label>
                  <select
                    id="sale-frequency"
                    className="input"
                    value={installmentFrequency}
                    onChange={(event) => {
                      const next = event.target.value;
                      setInstallmentFrequency(next);
                      const preset = FREQUENCY_OPTIONS.find(
                        (option) => option.value === next,
                      );
                      if (preset && preset.days) {
                        setInstallmentIntervalDays(preset.days);
                      }
                    }}
                  >
                    {FREQUENCY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="sale-interval-days">
                    Interval (days)
                  </label>
                  <input
                    id="sale-interval-days"
                    className="input"
                    type="number"
                    min="1"
                    step="1"
                    value={installmentIntervalDays}
                    onChange={(event) => setInstallmentIntervalDays(event.target.value)}
                    disabled={installmentFrequency !== 'CUSTOM'}
                  />
                </div>
                <p className="text-xs text-slate-500 sm:col-span-2">
                  Remaining balance{' '}
                  <strong className="text-slate-700">
                    {formatLKR(Math.max(0, totals.total - toNumber(downPayment)))}
                  </strong>{' '}
                  will be split into {toNumber(installmentCount) || 0} installment(s).
                  {installmentFrequency !== 'CUSTOM' && toNumber(installmentCount) > 0 && !isSinglePayment && (
                    <span className="text-slate-700 ml-2">
                      per {installmentFrequency.toLowerCase()} installment: {formatLKR(
                        (Math.max(0, totals.total - toNumber(downPayment))) / toNumber(installmentCount)
                      )}
                    </span>
                  )}
                </p>
              </div>
            )}

            {formError ? (
              <div
                className="mt-4 rounded-control border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700"
                role="alert"
              >
                {formError}
              </div>
            ) : null}

            <button
              type="submit"
              className="btn-primary mt-4 w-full"
              disabled={isSubmitting || cart.length === 0}
            >
              {isSubmitting
                ? 'Saving sale...'
                : `Save sale — ${formatLKR(isSinglePayment ? totals.total : toNumber(downPayment))}`}
            </button>
            {savedBy ? (
              <p className="mt-2 text-center text-xs text-slate-400">
                Recorded by {savedBy}
              </p>
            ) : null}
          </section>
        </div>
      </form>
    </div>
  );
}
