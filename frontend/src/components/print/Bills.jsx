import { formatDate, formatDateTime, formatLKR } from '../../utils/format.js';

/**
 * A4 print documents for the sale detail page.
 *
 * Two flows share these components:
 *   - The bill preview modal shows VISIBLE copies inside `.bill-preview-sheet`
 *     blocks (210mm A4 sheet with screen shadow) so the user can review the
 *     exact paper output and export it as a PDF (html2canvas-pro capture).
 *   - `hidden print:block` copies (wrapped in `.print-sheet`) are what
 *     actually reach paper via `window.print()`; the print CSS hides every
 *     other page element and only these containers print on A4.
 *
 * Exports used by SaleDetailPage:
 *   - SaleInvoiceBill        — A4 invoice (single payment or installment plan)
 *   - InstallmentReceiptBill — A4 installment payment receipt
 *   - paymentMethodLabel     — CASH/CARD/TRANSFER -> Cash/Card/Bank Transfer
 */

/** CASH/CARD/TRANSFER -> human label used on screen and on paper. */
export function paymentMethodLabel(method) {
  if (!method) return '—';
  const key = String(method).toUpperCase();
  if (key === 'CASH') return 'Cash';
  if (key === 'CARD') return 'Card';
  if (key === 'TRANSFER') return 'Bank Transfer';
  const text = String(method).replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ------------------------------ shared chrome ----------------------------- */

function MetaCell({ label, value }) {
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-500">{label}</p>
      <p className="mt-0.5 text-xs font-semibold text-slate-900">{value}</p>
    </div>
  );
}

/** Brand block — 56px logo square (uploaded logo, else bolt mark) + identity lines. */
function BrandBlock({ sale }) {
  const logoUrl = sale.business_logo || null;
  return (
    <div className="border-b-2 border-slate-900 pb-2.5">
      <div className="flex items-center gap-3.5">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-600">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={sale.business_name || 'Business logo'}
              className="h-full w-full object-cover"
            />
          ) : (
            <svg width="30" height="30" viewBox="0 0 32 32" fill="#ffffff" aria-hidden="true">
              <path d="M18.4 4 8 18.2h6.1L12.8 28 24 13.4h-6.6L18.4 4z" />
            </svg>
          )}
        </div>
        <div className="min-w-0 text-[11px] leading-snug text-slate-700">
          <p className="text-[22px] font-extrabold leading-tight tracking-tight text-slate-900">
            {sale.business_name || 'YourShop'}
          </p>
          {sale.business_address ? <p className="mt-0.5">{sale.business_address}</p> : null}
          {sale.business_phone ? <p>Tel: {sale.business_phone}</p> : null}
          {sale.branch_name || sale.branch_address || sale.branch_phone ? (
            <p className="text-slate-600">
              {[sale.branch_name, sale.branch_address, sale.branch_phone ? `Tel: ${sale.branch_phone}` : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Optional centered document title (receipt only — invoices carry no title). */
function BillHeader({ sale, title }) {
  return (
    <div>
      <BrandBlock sale={sale} />
      {title ? (
        <p className="mt-3 text-center text-sm font-extrabold uppercase tracking-[0.35em] text-slate-900">
          {title}
        </p>
      ) : null}
    </div>
  );
}

function BillFooter({ sale, kind = 'invoice' }) {
  const businessName = sale.business_name || 'us';
  const retention =
    kind === 'receipt' || sale.is_single_payment
      ? 'Goods once sold cannot be returned without the original invoice.'
      : `The goods remain the property of ${businessName} until all installments are fully settled.`;
  return (
    <div className="mt-5 border-t border-slate-300 pt-2 text-center text-[9.5px] leading-relaxed text-slate-500">
      <p>
        Thank you for shopping with {businessName}. Please keep this {kind} for your records.
      </p>
      <p className="mt-0.5">{retention}</p>
    </div>
  );
}

function ScheduleTable({ installments, highlightNumber = null }) {
  const hasHighlight = highlightNumber !== null && highlightNumber !== undefined;
  return (
    <table className="w-full border-collapse text-left text-[11px]">
      <caption className="mb-2 text-left text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">
        Installment schedule
      </caption>
      <thead>
        <tr className="border-y border-slate-900 text-[9px] font-semibold uppercase tracking-wide text-slate-600">
          <th className="w-12 py-1.5 pr-2">No</th>
          <th className="py-1.5 pr-2">Due date</th>
          <th className="w-32 py-1.5 pr-2 text-right">Amount</th>
          <th className="w-32 py-1.5 pr-2 text-right">Paid</th>
          <th className="w-32 py-1.5 pr-2 text-right">Balance</th>
          <th className="w-16 py-1.5 text-right">Status</th>
        </tr>
      </thead>
      <tbody>
        {installments.map((row) => {
          const amount = Number(row.amount) || 0;
          const paidAmount = Number(row.paid_amount) || 0;
          const outstanding = Math.max(0, amount - paidAmount);
          const isPaid = Boolean(row.is_paid);
          const highlighted = hasHighlight && Number(row.number) === Number(highlightNumber);
          return (
            <tr key={row.number} className="border-b border-slate-200">
              <td className="py-1.5 pr-2 text-slate-600">#{row.number}</td>
              <td className="py-1.5 pr-2">{formatDate(row.due_date)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{formatLKR(row.amount)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{formatLKR(row.paid_amount)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{formatLKR(outstanding)}</td>
              <td className={`py-1.5 text-right ${highlighted ? 'font-bold' : ''}`}>
                {isPaid ? '✓' : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* --------------------------- A4 sale invoice ------------------------------ */

/** "28" -> "28th" (ordinal suffix for payment-terms wording). */
function ordinalDay(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getDate();
  const suffix =
    day % 10 === 1 && day % 100 !== 11
      ? 'st'
      : day % 10 === 2 && day % 100 !== 12
        ? 'nd'
        : day % 10 === 3 && day % 100 !== 13
          ? 'rd'
          : 'th';
  return `${day}${suffix}`;
}

/** Weekday name for weekly plans ("Monday"); null when unparsable. */
function weekdayName(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { weekday: 'long' });
}

/**
 * Payment terms box (installment invoices only) — replaces the old schedule
 * table. Mirrors the approved copy: due-day/month phrasing, commencement and
 * final due dates, and a late-payment interest note. Weekly plans reword the
 * "28th of every month" phrase to "every {weekday}".
 */
function PaymentTermsBox({ sale }) {
  const installments = Array.isArray(sale.installments) ? sale.installments : [];
  const count = Number(sale.number_of_installments) || installments.length || 0;
  const isWeekly = String(sale.installment_frequency || 'MONTHLY').toUpperCase() === 'WEEKLY';
  const periodLabel = isWeekly ? 'weekly' : 'monthly';
  const balance = Number(sale.remaining_cost) || 0;
  const perInstallment =
    installments.length > 0 ? Number(installments[0].amount) || 0 : count > 0 ? balance / count : 0;
  const first = installments[0];
  const last = installments[installments.length - 1];

  const lastWord = installments[0] ? weekdayName(first.due_date) : null;
  const lastDoM = installments[0] ? ordinalDay(first.due_date) : null;
  const startDate = installments[0] ? formatDate(first.due_date) : null;
  const endDate = installments.length > 0 ? formatDate(last.due_date) : null;

  const duePhrase = isWeekly
    ? lastWord
      ? `every ${lastWord.toLowerCase()}`
      : 'its due date'
    : `the ${lastDoM || 'due date'} of every month`;

  const closingPhrase = isWeekly
    ? 'on or before its due date'
    : `on or before the ${lastDoM || 'due date'} of the month`;

  return (
    <div className="mb-4 break-inside-avoid rounded-lg border border-slate-400 bg-white px-3.5 py-3">
      <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">
        Payment terms
      </p>
      <p className="text-[11px] leading-relaxed text-slate-700">
        The balance of <strong className="font-semibold text-slate-900">{formatLKR(balance)}</strong>{' '}
        shall be settled in{' '}
        <strong className="font-semibold text-slate-900">
          {count} {periodLabel} installments
        </strong>{' '}
        of <strong className="font-semibold text-slate-900">{formatLKR(perInstallment)}</strong>{' '}
        each.
        {installments[0] ? (
          <>
            {' '}
            Each installment is due on{' '}
            <strong className="font-semibold text-slate-900">{duePhrase}</strong>, commencing{' '}
            <strong className="font-semibold text-slate-900">{startDate}</strong>
            {installments.length > 0 ? (
              <>
                , with the final installment due on{' '}
                <strong className="font-semibold text-slate-900">{endDate}</strong>
              </>
            ) : null}
            .
          </>
        ) : null}
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-700">
        Interest will be added to any installment not settled by its due date. Please ensure each
        installment is paid {closingPhrase} to avoid additional charges.
      </p>
    </div>
  );
}

export function SaleInvoiceBill({ sale }) {
  const items = Array.isArray(sale.items) ? sale.items : [];
  const payments = Array.isArray(sale.payments) ? sale.payments : [];
  const hasDiscount = Number(sale.discount_amount) > 0 || Boolean(sale.discount_label);
  const hasTax = Number(sale.tax_amount) > 0 || Number(sale.tax_rate) > 0;
  const methods = [
    ...new Set(
      payments
        .map((payment) => paymentMethodLabel(payment.method))
        .filter((label) => label && label !== '—')
    ),
  ];
  const isInstallment = !sale.is_single_payment;
  const count = Number(sale.number_of_installments) || 0;
  const isWeekly = String(sale.installment_frequency || 'MONTHLY').toUpperCase() === 'WEEKLY';
  const planText = count ? `${count} ${isWeekly ? 'weekly' : 'monthly'} installments` : '—';

  return (
    <div className="bill-root text-slate-900">
      {/* Business identity — no document title (invoices carry no "Tax Invoice" banner) */}
      <BillHeader sale={sale} />

      {/* Invoice meta — 28px top margin above the row, 16px below (approved layout) */}
      <div className="mt-7 mb-4 grid grid-cols-3 gap-3">
        <MetaCell label="Invoice no." value={sale.invoice_no || '—'} />
        <MetaCell label="Date & time" value={formatDateTime(sale.created_at)} />
        <MetaCell label="Cashier" value={sale.created_by_name || '—'} />
      </div>

      {/* Bill to */}
      <div className="mb-3.5 border-t border-slate-200 pt-2.5 text-[11px]">
        <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">Bill to</p>
        <p className="mt-0.5 text-xs font-semibold text-slate-900">
          {sale.customer_name || 'Walk-in customer'}
        </p>
        {sale.customer_phone ? <p className="text-slate-600">{sale.customer_phone}</p> : null}
        {sale.customer_address ? <p className="text-slate-600">{sale.customer_address}</p> : null}
      </div>

      {/* Items */}
      <table className="mb-3 w-full border-collapse text-left text-[11px]">
        <thead>
          <tr className="border-y border-slate-900 text-[9px] font-semibold uppercase tracking-wide text-slate-600">
            <th className="w-8 py-1.5 pr-2">#</th>
            <th className="py-1.5 pr-2">Product</th>
            <th className="w-14 py-1.5 pr-2 text-right">Qty</th>
            <th className="w-32 py-1.5 pr-2 text-right">Unit price</th>
            <th className="w-32 py-1.5 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.item_code || index} className="border-b border-slate-200">
              <td className="py-1.5 pr-2 text-slate-500">{index + 1}</td>
              <td className="py-1.5 pr-2">
                <span className="font-medium text-slate-900">{item.item_name}</span>
                {item.item_code ? (
                  <span className="ml-2 text-[9px] text-slate-400">{item.item_code}</span>
                ) : null}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{item.quantity}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{formatLKR(item.unit_price)}</td>
              <td className="py-1.5 text-right font-semibold tabular-nums text-slate-900">
                {formatLKR(item.line_total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="mb-3 flex justify-end break-inside-avoid">
        <table className="w-[300px] border-collapse text-[11px]">
          <tbody>
            <tr>
              <td className="py-1 pr-4 text-slate-600">Subtotal</td>
              <td className="py-1 text-right font-medium tabular-nums">{formatLKR(sale.subtotal)}</td>
            </tr>
            {hasDiscount ? (
              <tr>
                <td className="py-1 pr-4 text-slate-600">
                  Discount{sale.discount_label ? ` (${sale.discount_label})` : ''}
                </td>
                <td className="py-1 text-right font-medium tabular-nums">
                  − {formatLKR(sale.discount_amount)}
                </td>
              </tr>
            ) : null}
            {hasTax ? (
              <tr>
                <td className="py-1 pr-4 text-slate-600">
                  {Number(sale.tax_rate) > 0 ? `Tax (${sale.tax_rate}%)` : 'Tax'}
                </td>
                <td className="py-1 text-right font-medium tabular-nums">
                  + {formatLKR(sale.tax_amount)}
                </td>
              </tr>
            ) : null}
            <tr className="border-t-2 border-slate-900">
              <td className="pt-2 text-xs font-extrabold uppercase tracking-wide text-slate-900">
                Total
              </td>
              <td className="pt-2 text-right text-[17px] font-extrabold tabular-nums text-slate-900">
                {formatLKR(sale.total_cost)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {isInstallment ? (
        <>
          {/* Installment plan summary */}
          <div className="mb-4 grid grid-cols-3 gap-3 break-inside-avoid rounded-lg border border-slate-400 bg-white px-3 py-2.5 text-[11px]">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-500">
                Down payment
              </p>
              <p className="mt-0.5 text-xs font-semibold tabular-nums">
                {formatLKR(sale.down_payment)}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-500">Plan</p>
              <p className="mt-0.5 text-xs font-semibold">{planText}</p>
            </div>
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-500">
                Balance to pay
              </p>
              <p className="mt-0.5 text-[13px] font-extrabold tabular-nums">
                {formatLKR(sale.remaining_cost)}
              </p>
            </div>
          </div>

          {/* Payment terms — professional recurring-payment copy */}
          <PaymentTermsBox sale={sale} />
        </>
      ) : (
        <div className="mb-4 break-inside-avoid rounded-lg border border-slate-400 bg-white px-3 py-2.5 text-[11px]">
          <p className="text-xs font-bold text-slate-900">
            Paid in full — {formatLKR(sale.total_cost)}
          </p>
          {methods.length ? (
            <p className="mt-0.5 text-slate-600">
              Payment {methods.length > 1 ? 'methods' : 'method'}: {methods.join(', ')}
            </p>
          ) : null}
        </div>
      )}

      <BillFooter sale={sale} kind="invoice" />
    </div>
  );
}

/* ------------------- A4 installment payment receipt ----------------------- */

export function InstallmentReceiptBill({ sale, payment }) {
  const installments = Array.isArray(sale.installments) ? sale.installments : [];

  return (
    <div className="bill-root text-slate-900">
      <BillHeader sale={sale} title="Installment Receipt" />

      <div className="mt-4 mb-3 grid grid-cols-3 gap-3">
        <MetaCell label="Invoice no." value={sale.invoice_no || '—'} />
        <MetaCell label="Customer" value={sale.customer_name || 'Walk-in customer'} />
        <MetaCell label="Receipt date" value={formatDateTime(payment.created_at)} />
      </div>

      <div className="mb-3 break-inside-avoid rounded-lg border-2 border-slate-900 bg-white px-4 py-4 text-center">
        <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-600">
          Amount received
        </p>
        <p className="mt-1 text-3xl font-extrabold tabular-nums text-slate-900">
          {formatLKR(payment.amount)}
        </p>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-x-8 text-[11px]">
        <div className="flex items-baseline justify-between gap-4 border-b border-slate-200 py-1.5">
          <span className="text-slate-500">Method</span>
          <span className="font-semibold text-slate-900">{paymentMethodLabel(payment.method)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 border-b border-slate-200 py-1.5">
          <span className="text-slate-500">Cash account</span>
          <span className="font-semibold text-slate-900">{payment.cash_account_name || '—'}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 border-b border-slate-200 py-1.5">
          <span className="text-slate-500">Received by</span>
          <span className="font-semibold text-slate-900">{payment.received_by_name || '—'}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 border-b border-slate-200 py-1.5">
          <span className="text-slate-500">Payment for</span>
          <span className="font-semibold text-slate-900">
            {payment.installment_number !== null && payment.installment_number !== undefined
              ? `Installment #${payment.installment_number}`
              : 'Down payment'}
          </span>
        </div>
      </div>

      {payment.note ? (
        <p className="mb-3 text-[11px]">
          <span className="text-slate-500">Note: </span>
          <span className="font-medium text-slate-900">{payment.note}</span>
        </p>
      ) : null}

      <div className="mb-3 flex items-baseline justify-between gap-4 break-inside-avoid border-y-2 border-slate-900 py-2 text-[11px]">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
            Outstanding balance after this payment
          </p>
          <p className="mt-0.5 text-slate-600">Remaining on invoice {sale.invoice_no}</p>
        </div>
        <p className="text-xl font-extrabold tabular-nums text-slate-900">
          {formatLKR(sale.remaining_cost)}
        </p>
      </div>

      {installments.length ? (
        <ScheduleTable
          installments={installments}
          highlightNumber={payment.installment_number}
        />
      ) : null}

      <div className="mt-8 grid grid-cols-2 gap-12 text-[10px] text-slate-600">
        <p className="border-t border-slate-400 pt-1.5">Customer signature</p>
        <p className="border-t border-slate-400 pt-1.5">Received by</p>
      </div>

      <BillFooter sale={sale} kind="receipt" />
    </div>
  );
}