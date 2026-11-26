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
  cashAccountsApi,
} from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import CustomerPicker from '../components/CustomerPicker.jsx';
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
  const [customer, setCustomer] = useState(null);
  const [guarantors, setGuarantors] = useState([null, null]);
  const [cart, setCart] = useState([]);
  const [discountType, setDiscountType] = useState(DISCOUNT_PERCENT);
  const [discountValue, setDiscountValue] = useState('0');
  const [taxRate, setTaxRate] = useState('');
  const [isSinglePayment, setIsSinglePayment] = useState(true);
  // Empty means "use the minimum", so it follows the cart total.
  const [downPayment, setDownPayment] = useState('');
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

  // ── Queries ───────────────────────────────────────────────────────────────
  const branchesQuery = useQuery({
    queryKey: qk.branches.list({ is_active: true }),
    queryFn: async () => (await branchesApi.list({ is_active: true })).data,
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

  // Same rule as the server: share of the total, rounded UP to the next 100.
  const minPercent = toNumber(user?.business_min_down_payment_percent);
  const totalCents = Math.round(totals.total * 100);
  const minDown = Math.ceil((totalCents * minPercent) / 1000000 - 1e-9) * 100;
  const downValue = downPayment === '' ? String(minDown) : downPayment;
  const tooSmall = minDown > 0 && minDown >= totals.total;

  const installmentsOn = user?.business_installments_enabled !== false;
  const payInFull = isSinglePayment || !installmentsOn;
  const needed = Number(user?.business_required_guarantors) || 0;
  const monthlyRate = toNumber(user?.business_installment_monthly_interest_rate);
  const count = Math.max(0, Math.floor(toNumber(installmentCount)));
  const balance = Math.max(0, Math.round((totals.total - toNumber(downValue)) * 100) / 100);
  // Flat monthly interest, each installment rounded UP to the next 50.
  const months =
    installmentFrequency === 'MONTHLY'
      ? count
      : (count * (toNumber(installmentIntervalDays) || 30)) / 30;
  const perInstallment =
    count === 0
      ? 0
      : monthlyRate > 0
        ? Math.ceil((balance * (1 + (monthlyRate * months) / 100)) / count / 50 - 1e-9) * 50
        : balance / count;
  const planTotal = monthlyRate > 0 ? perInstallment * count : balance;

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(event) {
    event.preventDefault();
    setFormError('');

    if (!branchId) {
      setFormError('Select a branch before saving the sale.');
      return;
    }
    if (cart.length === 0) {
      setFormError('Add at least one product to the cart.');
      return;
    }

    const down = toNumber(downValue);
    const chosen = guarantors.slice(0, needed);
    if (!payInFull) {
      if (!customer) {
        setFormError('Select or create the customer for an installment sale.');
        return;
      }
      if (chosen.some((person) => !person)) {
        setFormError(`Select ${needed} guarantor(s) for an installment sale.`);
        return;
      }
      if (cart.length && tooSmall) {
        setFormError('This order is too small for installments.');
        return;
      }
      if (down < minDown) {
        setFormError(`The minimum down payment is ${formatLKR(minDown)}.`);
        return;
      }
      if (toNumber(installmentCount) < 1) {
        setFormError('Enter how many installments the customer will pay.');
        return;
      }
      if (down < 0 || down >= totals.total) {
        setFormError('Down payment must be less than the total.');
        return;
      }
    }

    const payload = {
      branch: Number(branchId),
      customer: customer ? customer.id : null,
      guarantors: payInFull ? [] : chosen.map((person) => person.id),
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
      is_single_payment: payInFull,
      down_payment: payInFull ? totals.total : down,
      number_of_installments: payInFull ? 0 : count,
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
        description="Search products, build the cart, and record a walk-in or customer sale."
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

<CustomerPicker
                label="Customer"
                required={!payInFull}
                emptyLabel={payInFull ? 'Walk-in customer' : 'Select a customer'}
                value={customer}
                onChange={setCustomer}
                excludeIds={guarantors.slice(0, needed).filter(Boolean).map((g) => g.id)}
              />

              {!payInFull &&
                Array.from({ length: needed }, (_, index) => (
                  <CustomerPicker
                    key={index}
                    label={needed > 1 ? `Guarantor ${index + 1}` : 'Guarantor'}
                    required
                    emptyLabel="Select a guarantor"
                    value={guarantors[index]}
                    onChange={(person) =>
                      setGuarantors((current) =>
                        current.map((g, i) => (i === index ? person : g)),
                      )
                    }
                    excludeIds={[
                      customer?.id,
                      ...guarantors.filter((g, i) => g && i !== index).map((g) => g.id),
                    ].filter(Boolean)}
                  />
                ))}

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
              Search products
            </label>
            <input
              id="sale-search"
              className="input"
              type="search"
              placeholder="Search by product code or name"
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
                    ? 'Loading products...'
                    : debouncedSearch
                      ? `No products match "${debouncedSearch}".`
                      : 'Start typing to search for products.'}
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
              <span className="badge">{cartCount} product(s)</span>
            </div>

            {cart.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">Cart is empty.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-3 font-semibold">Product</th>
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
            {installmentsOn ? (
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
            ) : null}

            {payInFull ? (
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
                    value={downValue}
                    onChange={(event) => setDownPayment(event.target.value)}
                  />
                  {minPercent > 0 && cart.length > 0 ? (
                    <p
                      className={`mt-1 text-xs ${
                        tooSmall || toNumber(downValue) < minDown ? 'text-rose-600' : 'text-slate-500'
                      }`}
                    >
                      {tooSmall
                        ? 'This order is too small for installments.'
                        : `Minimum ${formatLKR(minDown)} (${minPercent}%, rounded up to the next 100).`}
                    </p>
                  ) : null}
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
                <div className="space-y-1 text-xs text-slate-500 sm:col-span-2">
                  <p>
                    Balance after down payment{' '}
                    <strong className="text-slate-700">{formatLKR(balance)}</strong>
                  </p>
                  {monthlyRate > 0 && count > 0 ? (
                    <p>
                      Interest {monthlyRate}% per month, total to repay{' '}
                      <strong className="text-slate-700">{formatLKR(planTotal)}</strong> (interest{' '}
                      {formatLKR(planTotal - balance)})
                    </p>
                  ) : null}
                  {count > 0 ? (
                    <p>
                      <strong className="text-slate-700">{count}</strong> installment(s) of{' '}
                      <strong className="text-slate-700">{formatLKR(perInstallment)}</strong>
                      {monthlyRate > 0 ? ' each' : ' (about)'}
                    </p>
                  ) : null}
                </div>
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
                : `Save sale — ${formatLKR(payInFull ? totals.total : toNumber(downValue))}`}
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
