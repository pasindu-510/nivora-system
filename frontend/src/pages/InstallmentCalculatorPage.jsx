import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { formatLKR } from '../utils/format.js';
import { balanceAfter, installmentPlan, minimumDownPayment } from '../utils/installments.js';
import PageHeader from '../components/PageHeader.jsx';

/** Longest plan compared when the business has no maximum. */
const DEFAULT_ROWS = 12;

/** Table amounts drop the "LKR " prefix so three columns fit a phone. */
const amount = (value) => formatLKR(value).replace(/^LKR\s*/, '');

/**
 * /installments/calculator — quick price quotes for a customer. Nothing is
 * saved; the rules come from Manage Business via /api/auth/me/.
 */
export default function InstallmentCalculatorPage() {
  const { user } = useAuth();
  const [total, setTotal] = useState('');
  // Empty means "use the minimum", so it follows the total (as on New Sale).
  const [downPayment, setDownPayment] = useState('');
  const [months, setMonths] = useState('3');

  useDocumentTitle('Installment Calculator');

  if (user?.business_installments_enabled === false) {
    return <Navigate to="/sales/new" replace />;
  }

  const monthlyRate = Number(user?.business_installment_monthly_interest_rate) || 0;
  const minPercent = Number(user?.business_min_down_payment_percent) || 0;
  const delayRate = Number(user?.business_installment_interest_rate) || 0;
  const guarantors = Number(user?.business_required_guarantors) || 0;
  const maxMonths = user?.business_max_installments ?? null;

  const price = Math.max(0, Number(total) || 0);
  const minDown = minimumDownPayment(price, minPercent);
  const downValue = downPayment === '' ? (price > 0 ? String(minDown) : '') : downPayment;
  const down = Number(downValue) || 0;
  const balance = balanceAfter(price, down);
  const count = Math.max(0, Math.floor(Number(months) || 0));

  let problem = '';
  if (price > 0) {
    if (minDown > 0 && minDown >= price) problem = 'This price is too small for installments.';
    else if (down < 0) problem = 'The down payment cannot be negative.';
    else if (down < minDown) problem = `The minimum down payment is ${formatLKR(minDown)}.`;
    else if (down >= price) problem = 'The down payment must be less than the total price.';
  }
  const overLimit = maxMonths !== null && count > maxMonths;
  const ready = price > 0 && !problem;

  const quote = (n) => installmentPlan({ balance, monthlyRate, count: n });
  const selected = ready && count > 0 && !overLimit ? quote(count) : null;
  const rows = ready
    ? Array.from({ length: maxMonths ?? DEFAULT_ROWS }, (_, i) => ({ n: i + 1, ...quote(i + 1) }))
    : [];

  function reset() {
    setTotal('');
    setDownPayment('');
    setMonths('3');
  }

  const rules = [
    monthlyRate > 0 ? `Interest ${monthlyRate}% per month` : 'No interest',
    minPercent > 0 ? `Minimum down payment ${minPercent}%` : 'No minimum down payment',
    delayRate > 0 ? `Delay payment rate ${delayRate}%` : null,
    guarantors > 0 ? `${guarantors} guarantor(s) needed` : null,
    maxMonths !== null ? `Up to ${maxMonths} installments` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Installment Calculator"
        description="Quote monthly installments for a customer. Nothing is saved."
        actions={
          total || downPayment ? (
            <button type="button" className="btn-secondary" onClick={reset}>
              Clear
            </button>
          ) : null
        }
      />

      <ul className="flex flex-wrap gap-2">
        {rules.map((text) => (
          <li key={text} className="badge">
            {text}
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="calc-total">
                Total price
              </label>
              <input
                id="calc-total"
                className="input text-lg font-semibold"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={total}
                onChange={(event) => setTotal(event.target.value)}
                autoFocus
              />
              <p className="mt-1 text-xs text-slate-500">
                The final price, after any discount and tax.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="calc-down">
                Down payment
              </label>
              <input
                id="calc-down"
                className="input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={downValue}
                onChange={(event) => setDownPayment(event.target.value)}
              />
              {price > 0 && minDown > 0 ? (
                <p className="mt-1 text-xs text-slate-500">Minimum {formatLKR(minDown)}</p>
              ) : null}
            </div>
            <div>
              <label className="label" htmlFor="calc-months">
                Monthly installments
              </label>
              <input
                id="calc-months"
                className="input"
                type="number"
                inputMode="numeric"
                min="1"
                max={maxMonths ?? undefined}
                step="1"
                value={months}
                onChange={(event) => setMonths(event.target.value)}
              />
              {overLimit ? (
                <p className="mt-1 text-xs text-rose-600">The maximum is {maxMonths}.</p>
              ) : null}
            </div>
          </div>
          {problem ? (
            <p
              className="mt-4 rounded-control border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700"
              role="alert"
            >
              {problem}
            </p>
          ) : null}
        </section>

        <section className="card p-5" aria-live="polite">
          {selected ? (
            <>
              <p className="text-sm text-slate-500">
                {count} monthly installment(s){monthlyRate > 0 ? '' : ', about'}
              </p>
              <p className="mt-1 break-words text-3xl font-extrabold tracking-tight text-slate-900">
                {formatLKR(selected.perInstallment)}
              </p>
              <dl className="mt-4 space-y-2 border-t border-slate-200 pt-3 text-sm">
                {[
                  ['Down payment now', down],
                  ['Balance to finance', balance],
                  ['Interest', selected.interest],
                  ['Total to repay in installments', selected.planTotal],
                  ['Customer pays in all', down + selected.planTotal],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="text-right font-semibold text-slate-900">{formatLKR(value)}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p className="py-6 text-center text-sm text-slate-500">
              Enter the total price to see the installments.
            </p>
          )}
        </section>
      </div>

      {rows.length ? (
        <section className="card p-5">
          <h2 className="text-base font-bold text-slate-900">Compare plans</h2>
          <p className="mt-1 text-sm text-slate-500">Amounts in LKR. Tap a row to show its details above.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-1 py-2 sm:px-2 font-semibold">Months</th>
                  <th className="px-1 py-2 sm:px-2 text-right font-semibold">Per month</th>
                  <th className="hidden px-1 py-2 sm:px-2 text-right font-semibold sm:table-cell">
                    Interest
                  </th>
                  <th className="px-1 py-2 sm:px-2 text-right font-semibold">Pays in all</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.n}
                    className={`cursor-pointer border-b border-slate-100 last:border-0 ${
                      row.n === count ? 'bg-slate-100 font-semibold' : 'hover:bg-slate-50'
                    }`}
                    onClick={() => setMonths(String(row.n))}
                  >
                    <td className="py-1 sm:px-2">
                      <button
                        type="button"
                        className="btn-ghost px-2 py-1 text-xs sm:px-3 sm:text-sm"
                        aria-pressed={row.n === count}
                        aria-label={`${row.n} month plan`}
                      >
                        {row.n}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-1 py-1 text-right sm:px-2 text-slate-900">
                      {amount(row.perInstallment)}
                    </td>
                    <td className="hidden whitespace-nowrap px-1 py-1 text-right sm:px-2 text-slate-600 sm:table-cell">
                      {amount(row.interest)}
                    </td>
                    <td className="whitespace-nowrap px-1 py-1 text-right sm:px-2 text-slate-600">
                      {amount(down + row.planTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
