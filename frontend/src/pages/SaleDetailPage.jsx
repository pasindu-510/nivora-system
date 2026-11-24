import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApiMutation } from '../hooks/useApiMutation.js';
import { salesApi, cashAccountsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatLKR, formatDate, formatDateTime } from '../utils/format.js';
import downloadElementAsPdf from '../utils/downloadBillPdf.js';
import { paymentMethodLabel } from '../components/print/Bills.jsx';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FullPageLoader from '../components/FullPageLoader.jsx';
import { SaleInvoiceBill } from '../components/print/Bills.jsx';
import { InstallmentReceiptBill } from '../components/print/Bills.jsx';

/** Invoice status badge tones — kept in sync with SalesListPage. */
const STATUS_BADGES = {
  OPEN: { label: 'Open', className: 'bg-emerald-50 text-emerald-700' },
  CLOSED: { label: 'Closed', className: 'bg-slate-100 text-slate-500' },
  CANCELLED: { label: 'Cancelled', className: 'bg-rose-50 text-rose-600' },
};

export default function SaleDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();

  // --- Query: sale detail ---
  const salesQuery = useQuery({
    queryKey: qk.sales.detail(id),
    queryFn: async () => (await salesApi.get(id)).data,
    enabled: !!id,
  });

  // --- Mutation: pay installment ---
  const payInstallmentMutation = useApiMutation(
    (variables) => salesApi.payInstallment(id, variables),
    {
      invalidates: [
        qk.sales.root,
        qk.sales.detail(id),
        qk.installments.due({}),
        qk.dashboard.summary({}),
        qk.items.root,
        qk.stock.root,
      ],
    }
  );

  // --- Mutation: cancel sale ---
  const cancelMutation = useApiMutation(
    (id) => salesApi.cancel(id),
    {
      invalidates: [
        qk.sales.root,
        qk.items.root,
        qk.stock.root,
        qk.dashboard.summary({}),
        qk.installments.due({}),
      ],
    }
  );

  // --- Collect payment modal state ---
  const [showCollectModal, setShowCollectModal] = useState(false);
  const [collectInstallment, setCollectInstallment] = useState(null);
  const [collectForm, setCollectForm] = useState({ amount: '', method: 'CASH', cash_account: '' });
  const [collectErrors, setCollectErrors] = useState({});
  const [collectBanner, setCollectBanner] = useState(null);

  // --- Cancel confirm state ---
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelBanner, setCancelBanner] = useState(null);

  // --- Bill preview modal state ---
  const [showBillPreview, setShowBillPreview] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfStatus, setPdfStatus] = useState('');
  const invoiceSheetRef = useRef(null);

  // While the preview modal is open, `bill-print-mode` on <body> tells the
  // print stylesheet to send only the A4 bill to paper (see index.css).
  useEffect(() => {
    if (showBillPreview) {
      document.body.classList.add('bill-print-mode');
    } else {
      document.body.classList.remove('bill-print-mode');
    }
    return () => document.body.classList.remove('bill-print-mode');
  }, [showBillPreview]);

  // --- Cash accounts (only needed while the collect modal is open) ---
  const cashAccountsQuery = useQuery({
    queryKey: qk.finance.cashAccounts({ page_size: 100 }),
    queryFn: async () => (await cashAccountsApi.list({ page_size: 100 })).data,
    enabled: showCollectModal,
  });

  // --- Document title (single conditional-free call) ---
  useDocumentTitle(salesQuery.data ? `Sale ${salesQuery.data.invoice_no || '—'}` : 'Sale');

  // --- Error state ---
  if (salesQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Sale"
          actions={
            <a
              href="/sales"
              className="btn btn-ghost text-sm"
              aria-label="Back to sales"
            >
              ← Back to sales
            </a>
          }
        />

        <div
          className="rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>{apiErrorMessage(salesQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => salesQuery.refetch()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!id || salesQuery.isPending) {
    return <FullPageLoader />;
  }

  const sale = salesQuery.data;

  // --- Cash accounts (for TRANSFER installment collection) ---
  const cashAccounts = (cashAccountsQuery.data && cashAccountsQuery.data.results) || [];

  // --- Role check ---
  const isCashier = user && user.role === 'cashier';

  // --- Status badge ---
  const statusBadge = STATUS_BADGES[sale.status] || {
    label: sale.status || '—',
    className: 'bg-slate-100 text-slate-500',
  };

  // A cancelled sale can never be cancelled again (the API answers 400), so
  // do not offer the action — and keep the print action available.
  const isCancelled = sale.status === 'CANCELLED';

  // --- Open the A4 bill preview modal ---
  const openBillPreview = () => setShowBillPreview(true);

  // --- Header card ---
  const headerActions = isCashier
    ? null
    : [
        <button
          key="print"
          type="button"
          className="btn-secondary"
          onClick={openBillPreview}
          aria-label="Preview, print, or download the A4 bill"
        >
          Print / Download
        </button>,
        ...(isCancelled
          ? []
          : [
              <button
                key="cancel"
                type="button"
                className="btn-danger"
                onClick={() => setShowCancelConfirm(true)}
                aria-label="Cancel sale"
              >
                Cancel sale
              </button>,
            ]),
      ];

  // --- Open the collect modal for an installment row ---
  const openCollect = (row) => {
    setCollectInstallment(row);
    setCollectForm({
      amount: String(Number(row.amount) + Number(row.interest_charged || 0) - Number(row.paid_amount)),
      method: 'CASH',
      cash_account: '',
    });
    setCollectErrors({});
    setCollectBanner(null);
    setShowCollectModal(true);
  };

  const closeCollect = () => {
    setShowCollectModal(false);
    setCollectInstallment(null);
  };

  const setCollectField = (key) => (event) => {
    setCollectForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  // --- Handle collect payment submit ---
  const handleCollectSubmit = async () => {
    if (!collectInstallment) return;

    const due = Number(collectInstallment.amount) + Number(collectInstallment.interest_charged || 0) - Number(collectInstallment.paid_amount);
    const saleBalance = Number(sale.remaining_cost || 0);
    const clientErrors = {};
    const amount = Number(collectForm.amount);
    if (!Number.isFinite(amount) || amount < 0.01) clientErrors.amount = 'Enter a valid amount.';
    if (amount > saleBalance + 0.005) clientErrors.amount = 'Amount cannot exceed balance due.';
    if (!collectForm.method) clientErrors.method = 'Select a payment method.';
    if (collectForm.method === 'TRANSFER' && !collectForm.cash_account) {
      clientErrors.cash_account = 'Select a cash account for bank transfers.';
    }

    setCollectErrors(clientErrors);
    setCollectBanner(null);
    if (Object.keys(clientErrors).length) return;

    try {
      await payInstallmentMutation.mutateAsync({
        installment: collectInstallment.id,
        amount,
        method: collectForm.method,
        cash_account: collectForm.cash_account || null,
      });
      closeCollect();
    } catch (error) {
      const parsed = parseServerError(error);
      setCollectBanner(parsed.banner);
      setCollectErrors(parsed.fields);
    }
  };

  // --- Handle cancel submit ---
  const handleCancelSubmit = async () => {
    setCancelBanner(null);
    try {
      await cancelMutation.mutateAsync(id);
      setShowCancelConfirm(false);
    } catch (error) {
      setCancelBanner(parseServerError(error).banner);
    }
  };

  // --- parseServerError helper ---
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

  // --- Sale invoice bill rendered into hidden print container ---
  const renderInvoiceBill = () => (
    <div className="hidden print:block">
      <SaleInvoiceBill sale={sale} />
    </div>
  );

  // --- Find last collected payment for receipt bill ---
  const lastPayment =
    sale.payments && sale.payments.length > 0
      ? sale.payments[sale.payments.length - 1]
      : null;

  const renderReceiptBill = () =>
    // Receipts are installment-payment documents only — a single-payment sale
    // has no installments, so its print output is the invoice alone (with the
    // "Paid in full" box), matching the approved single-payment bill design.
    lastPayment && !sale.is_single_payment ? (
      <div className="hidden print:block print-receipt-block">
        <InstallmentReceiptBill sale={sale} payment={lastPayment} />
      </div>
    ) : null;

  // --- Download the visible invoice sheet as an A4 PDF ---
  const handleDownloadPdf = async () => {
    if (pdfBusy || !invoiceSheetRef.current) return;
    setPdfBusy(true);
    setPdfStatus('Generating PDF…');
    try {
      await downloadElementAsPdf(invoiceSheetRef.current, {
        filename: `${sale.invoice_no || 'bill'}.pdf`,
      });
      setPdfStatus('Downloaded ✓');
    } catch (error) {
      console.error('[bill] PDF download failed:', error);
      setPdfStatus('PDF failed — use Print instead');
    } finally {
      setPdfBusy(false);
    }
  };

  // Visible receipt copy inside the preview modal (PDF capture source is the
  // invoice sheet only; the receipt is for screen/print).
  const renderReceiptBillPreview = () =>
    lastPayment && !sale.is_single_payment ? (
      <div className="bill-preview-sheet">
        <InstallmentReceiptBill sale={sale} payment={lastPayment} />
      </div>
    ) : null;

  return (
    <div className="space-y-6">
      {/* --- Header --- */}
      <PageHeader
        title={`Sale ${sale.invoice_no || '—'}`}
        description={
          <div className="flex flex-col items-start sm:flex-row sm:items-center gap-2">
            <span className={`badge ${statusBadge.className}`}>{statusBadge.label}</span>
            <span className="text-sm text-slate-500">
              {sale.created_by_name || '—'} • {formatDateTime(sale.created_at)}
            </span>
            <span className="text-sm text-slate-500">
              {sale.branch_name || '—'}
            </span>
          </div>
        }
        actions={headerActions}
      />

      {/* --- Customer card --- */}
      <div className="card rounded-control border border-slate-200 p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Customer
            </p>
            <p className="mt-1 font-semibold text-slate-900">
              {sale.customer_name || 'Walk-in customer'}
            </p>
          </div>
          {sale.customer_phone && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Phone
              </p>
              <p className="mt-1 text-slate-600">{sale.customer_phone}</p>
            </div>
          )}
          {sale.customer_address && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Address
              </p>
              <p className="mt-1 text-slate-600">{sale.customer_address}</p>
            </div>
          )}
        </div>
      </div>

      {/* --- Items table --- */}
      <div className="card rounded-control border border-slate-200 p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 mb-3">Sale items</h2>
        <DataTable
          columns={[
            {
              key: 'index',
              header: '#',
              width: '30px',
              align: 'center',
              render: (row, index) => index + 1,
            },
            {
              key: 'item',
              header: 'Item',
              width: '200px',
              align: 'left',
              render: (row) => {
                const itemName = row.item_name || '—';
                const itemCode = row.item_code ? (
                  <span className="text-[10px] text-slate-500 ml-1">
                    {row.item_code}
                  </span>
                ) : null;
                return (
                  <div>
                    <span className="font-medium text-slate-900">{itemName}</span>{itemCode}
                  </div>
                );
              },
            },
            {
              key: 'quantity',
              header: 'Qty',
              width: '50px',
              align: 'center',
              render: (row) => row.quantity || 0,
            },
            {
              key: 'unit_price',
              header: 'Unit price',
              width: '100px',
              align: 'right',
              render: (row) => formatLKR(row.unit_price),
            },
            {
              key: 'line_total',
              header: 'Total',
              width: '100px',
              align: 'right',
              render: (row) => (
                <span className="font-bold text-slate-900">
                  {formatLKR(row.line_total)}
                </span>
              ),
            },
            {
              key: 'fifo_cost',
              header: 'Cost',
              width: '80px',
              align: 'right',
              render: (row) => {
                // Only when the row has fifo_cost present (backend strips it for cashiers)
                if (row.fifo_cost != null) {
                  return <span className="font-medium text-slate-600">{formatLKR(row.fifo_cost)}</span>;
                }
                return null;
              },
            },
          ]}
          rows={sale.items || []}
          rowKey={(row) => row.id}
          loading={false}
          caption="Sale items"
        />
      </div>

      {/* --- Totals card --- */}
      <div className="card rounded-control border border-slate-200 p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 mb-3">Totals</h2>
        <div className="space-y-2 text-slate-900">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Subtotal</p>
            <p className="mt-1 font-semibold">{formatLKR(sale.subtotal)}</p>
          </div>
          {sale.discount_amount > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Discount
              </p>
              <p className="mt-1">
                − {formatLKR(sale.discount_amount)}{sale.discount_label ? ` (${sale.discount_label})` : ''}
              </p>
            </div>
          )}
          {sale.tax_amount > 0 && Number(sale.tax_rate) > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Tax
              </p>
              <p className="mt-1">
                {Number(sale.tax_rate) > 0 ? `(${sale.tax_rate}%)` : ''}
                + {formatLKR(sale.tax_amount)}
              </p>
            </div>
          )}
          <div className="border-t border-slate-900 pt-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">TOTAL</p>
            <p className="mt-1 font-bold text-2xl text-slate-900">
              {formatLKR(sale.total_cost)}
            </p>
          </div>
        </div>

        {/* Installment-specific totals */}
        {!sale.is_single_payment && (
          <div className="mt-3 pt-3 border-t border-slate-200">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Installment plan</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-sm font-medium">Down payment</p>
                <p className="mt-1 font-bold">{formatLKR(sale.down_payment)}</p>
              </div>
              <div>
                <p className="text-sm font-medium">Plan</p>
                <p className="mt-1">{sale.number_of_installments} installments</p>
              </div>
            </div>
            <div className="mt-2">
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Balance to pay
              </p>
              <p className="mt-1 font-bold text-xl text-brand-600">
                {formatLKR(sale.remaining_cost)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* --- Installments section (only when !is_single_payment) --- */}
      {!sale.is_single_payment && (
        <div className="card rounded-control border border-slate-200 p-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 mb-3">
            Installment schedule
          </h2>
          <DataTable
            columns={[
              {
                key: 'number',
                header: 'No',
                width: '40px',
                align: 'center',
                render: (row) => '#' + row.number,
              },
              {
                key: 'due_date',
                header: 'Due date',
                width: '100px',
                align: 'center',
                render: (row) => formatDate(row.due_date),
              },
              {
                key: 'amount',
                header: 'Amount',
                width: '100px',
                align: 'right',
                render: (row) => formatLKR(row.amount),
              },
              {
                key: 'paid_amount',
                header: 'Paid',
                width: '100px',
                align: 'right',
                render: (row) => formatLKR(row.paid_amount),
              },
              {
                key: 'balance',
                header: 'Balance',
                width: '100px',
                align: 'right',
                render: (row) => {
                  const balance = Number(row.amount) - Number(row.paid_amount);
                  return formatLKR(balance);
                },
              },
              {
                key: 'status',
                header: 'Status',
                width: '100px',
                align: 'center',
                render: (row) => {
                  const isPaid = Boolean(row.is_paid);
                  const dueDate = new Date(row.due_date);
                  const today = new Date();
                  const isOverdue = !isPaid && dueDate < today;

                  if (isPaid) {
                    return (
                      <span className="badge bg-emerald-50 text-emerald-700">Paid</span>
                    );
                  }
                  if (isOverdue) {
                    return (
                      <span className="badge bg-rose-50 text-rose-600">Overdue</span>
                    );
                  }
                  return (
                    <span className="badge bg-amber-50 text-amber-700">Due</span>
                  );
                },
              },
              {
                key: 'actions',
                header: 'Action',
                width: '80px',
                align: 'center',
                render: (row) => {
                  const isPaid = Boolean(row.is_paid);
                  if (isPaid) return null;

                  return (
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1.5 text-xs"
                      onClick={() => openCollect(row)}
                      aria-label={`Collect installment #${row.number}`}
                    >
                      Collect
                    </button>
                  );
                },
              },
            ]}
            rows={sale.installments || []}
            rowKey={(row) => row.id}
            loading={false}
            caption="Installment schedule"
          />
          {sale.installments && sale.installments.every((r) => Boolean(r.is_paid)) && (
            <p className="mt-3 text-sm text-slate-500">
              All installments paid — sale is complete
            </p>
          )}
        </div>
      )}

      {/* --- Collect Payment Modal --- */}
      {showCollectModal && (
        <Modal
          open={true}
          onClose={() => setShowCollectModal(false)}
          title={`Collect installment #${collectInstallment ? collectInstallment.number : ''}`}
          size="sm"
          footer={
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeCollect}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleCollectSubmit}
                disabled={payInstallmentMutation.isPending}
              >
                {payInstallmentMutation.isPending ? 'Processing...' : 'Collect'}
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            {collectBanner && (
              <div
                className="rounded-control border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
                role="alert"
              >
                {collectBanner}
              </div>
            )}

            <div>
              <label
                className="text-[10px] font-bold uppercase tracking-wide text-slate-500"
                htmlFor="collect-amount"
              >
                Amount
              </label>
              <input
                id="collect-amount"
                name="amount"
                type="number"
                className="input w-full mt-1"
                min={0.01}
                step="0.01"
                value={collectForm.amount}
                onChange={setCollectField('amount')}
                aria-invalid={collectErrors.amount ? 'true' : 'false'}
              />
              {collectErrors.amount ? (
                <p className="mt-1 text-xs text-rose-600">{collectErrors.amount}</p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-slate-500">
                    Default:{' '}
                    {formatLKR(
                      Number(collectInstallment.amount) + Number(collectInstallment.interest_charged || 0) - Number(collectInstallment.paid_amount)
                    )}
                  </p>
                  {Number(user?.business_installment_interest_rate || 0) > 0 && (
                    <p className="mt-1 text-xs text-slate-600">
                      Paying less than the installment amount adds {Number(user.business_installment_interest_rate).toFixed(2)}% interest on the shortfall.
                    </p>
                  )}
                  {collectInstallment && Number(collectInstallment.interest_charged || 0) > 0 && (
                    <p className="mt-1 text-xs text-brand-600">
                      Incl. interest: {formatLKR(Number(collectInstallment.interest_charged))}
                    </p>
                  )}
                </>
              )}
            </div>

            <div>
              <label
                className="text-[10px] font-bold uppercase tracking-wide text-slate-500"
                htmlFor="collect-method"
              >
                Method
              </label>
              <select
                id="collect-method"
                name="method"
                className="input w-full mt-1"
                value={collectForm.method}
                onChange={setCollectField('method')}
                aria-invalid={collectErrors.method ? 'true' : 'false'}
              >
                <option value="CASH">Cash</option>
                <option value="CARD">Card</option>
                <option value="TRANSFER">Transfer</option>
              </select>
              {collectErrors.method && (
                <p className="mt-1 text-xs text-rose-600">{collectErrors.method}</p>
              )}
            </div>

            {collectForm.method === 'TRANSFER' && (
              <div>
                <label
                  className="text-[10px] font-bold uppercase tracking-wide text-slate-500"
                  htmlFor="collect-cash-account"
                >
                  Cash account
                </label>
                <select
                  id="collect-cash-account"
                  name="cash_account"
                  className="input w-full mt-1"
                  value={collectForm.cash_account}
                  onChange={setCollectField('cash_account')}
                  aria-invalid={collectErrors.cash_account ? 'true' : 'false'}
                >
                  <option value="">—</option>
                  {cashAccounts.map((acct) => (
                    <option key={acct.id} value={acct.id}>
                      {acct.name}
                    </option>
                  ))}
                </select>
                {collectErrors.cash_account && (
                  <p className="mt-1 text-xs text-rose-600">{collectErrors.cash_account}</p>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* --- Payments history section --- */}
      <div className="card rounded-control border border-slate-200 p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500 mb-3">Payments history</h2>
        {sale.payments && sale.payments.length > 0 ? (
          <div className="space-y-2 text-sm text-slate-900">
            {sale.payments.map((payment) => (
              <div key={payment.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2 border-b border-slate-100 last:border-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="font-medium">
                    {sale.is_single_payment
                      ? 'Full payment'
                      : payment.installment_number !== null && payment.installment_number !== undefined
                        ? `Installment #${payment.installment_number}`
                        : 'Down payment'}
                  </span>
                  <span className="text-slate-500">•</span>
                  <span className={`font-medium text-slate-700 ${paymentMethodLabel(
                    payment.method
                  )}`}>
                    {paymentMethodLabel(payment.method)}
                  </span>
                </div>
                <div className="sm:text-right">
                  <span className="font-semibold">
                    {formatLKR(payment.amount)}
                  </span>
                  <span className="text-slate-400"> • </span>
                  <span className="text-slate-400">
                    {payment.cash_account_name || '—'}
                  </span>
                  <span className="text-slate-400"> • </span>
                  <span className="text-slate-400">
                    {payment.received_by_name || '—'}
                  </span>
                </div>
                <span className="text-xs text-slate-400">
                  {formatDateTime(payment.created_at)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            No payments recorded yet
          </p>
        )}
      </div>

      {/* --- A4 Bill Print section --- */}
      <div className="bill-print-target mt-6">
        <button
          type="button"
          className="btn-secondary print:hidden"
          onClick={openBillPreview}
          aria-label="Preview, print, or download the A4 bill"
        >
          Print / Download
        </button>

        {/* Sale invoice bill — always rendered */}
        {renderInvoiceBill()}

        {/* Installment receipt bill — rendered when last payment exists */}
        {renderReceiptBill()}
      </div>

      {/* --- Bill preview modal --- */}
      {showBillPreview && (
        <div className="bill-preview-modal">
          <Modal
            open={true}
            onClose={() => setShowBillPreview(false)}
            title="Bill preview"
            size="xl"
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => window.print()}
                aria-label="Print bill on A4"
              >
                Print
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleDownloadPdf}
                disabled={pdfBusy}
                aria-label="Download bill as PDF"
              >
                {pdfBusy ? 'Generating…' : 'Download PDF'}
              </button>
              <span className="text-xs text-slate-400" role="status">
                {pdfStatus || 'A4 sheet'}
              </span>
            </div>

            {/* Visible A4 copies — the invoice sheet is the PDF capture source */}
            {/* The A4 sheet is a fixed 210mm wide; scroll sideways on narrow screens */}
            <div className="overflow-x-auto">
              <div className="bill-preview-sheet" ref={invoiceSheetRef}>
                <SaleInvoiceBill sale={sale} />
              </div>

              {renderReceiptBillPreview()}
            </div>
          </Modal>
        </div>
      )}

      {/* --- Cancel sale confirm modal --- */}
      {showCancelConfirm && (
        <Modal
          open={true}
          onClose={() => setShowCancelConfirm(false)}
          title="Cancel sale?"
          size="sm"
          description="Are you sure you want to cancel this sale? This will reverse any stock lots and close the sale."
          footer={
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowCancelConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={handleCancelSubmit}
                disabled={cancelMutation.isPending}
              >
                {cancelMutation.isPending ? 'Cancelling...' : 'Cancel'}
              </button>
            </div>
          }
        >
          {cancelBanner && (
            <div
              className="mb-3 rounded-control border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
              role="alert"
            >
              {cancelBanner}
            </div>
          )}
          <p className="text-sm text-slate-700">
            This will reverse stock lots and close the sale. This action cannot be undone.
          </p>
        </Modal>
      )}
    </div>
  );
}