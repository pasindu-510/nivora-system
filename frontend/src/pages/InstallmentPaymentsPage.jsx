import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext.jsx';
import { salesApi, cashAccountsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate, formatLKR, toDateInputValue } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';
import EntryDateField, { pastDate, useBackdate } from '../components/EntryDateField.jsx';

/* --------------------------- server error parser -------------------------- */
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

/* ------------------------------ page ------------------------------------ */
export default function InstallmentPaymentsPage() {
  useDocumentTitle('Installment Payments');
  const { user } = useAuth();
  const { today: todayValue } = useBackdate();
  const [paymentDate, setPaymentDate] = useState('');

  // Filter state
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerNic, setCustomerNic] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [paidStatus, setPaidStatus] = useState('all'); // all | fully_paid | outstanding

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedSale, setSelectedSale] = useState(null);
  const [saleDetail, setSaleDetail] = useState(null);
  const [selectedInstallment, setSelectedInstallment] = useState(null);
  const [form, setForm] = useState({ amount: '', method: 'CASH', cash_account: '' });
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);

  // Build filter params for list query
  const listParams = {
    page_size: 100,
    customer_name: customerName || undefined,
    customer_phone: customerPhone || undefined,
    customer_nic: customerNic || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    paid_status: paidStatus !== 'all' ? paidStatus : undefined,
    is_single_payment: false, // Only installment-capable sales
  };

  const listQuery = useQuery({
    queryKey: qk.sales.list(listParams),
    queryFn: async () => (await salesApi.list(listParams)).data,
  });

  // Cash accounts for TRANSFER method
  const cashAccountsQuery = useQuery({
    queryKey: qk.finance.cashAccounts({ page_size: 100 }),
    queryFn: async () => (await cashAccountsApi.list({ page_size: 100 })).data,
  });

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;
  const cashAccounts = (cashAccountsQuery.data && cashAccountsQuery.data.results) || [];
  const hasFilters = Boolean(customerName || customerPhone || customerNic || dateFrom || dateTo || paidStatus !== 'all');

  // Collect mutation
  const collectMutation = useApiMutation(
    ({ saleId, data }) => salesApi.payInstallment(saleId, data),
    {
      invalidates: [
        (vars) => qk.installments.due({ days: 30 }),
        qk.sales.root,
        qk.dashboard.summary({}),
      ],
    }
  );

  // Fetch sale detail when modal opens
  useEffect(() => {
    if (modalOpen && selectedSale) {
      setSaleDetail(null);
      setSelectedInstallment(null);
      salesApi.get(selectedSale.id).then((res) => {
        const detail = res.data;
        setSaleDetail(detail);
        // Default-select first unpaid installment
        const unpaid = (detail.installments || []).find((inst) => !inst.is_paid);
        if (unpaid) {
          setSelectedInstallment(unpaid);
          const due = Number(unpaid.amount) + Number(unpaid.interest_charged || 0) - Number(unpaid.paid_amount);
          setForm({ amount: String(due), method: 'CASH', cash_account: '' });
        }
      }).catch(() => {
        // Error will be handled by the mutation/error UI
      });
    } else {
      setSaleDetail(null);
      setSelectedInstallment(null);
    }
  }, [modalOpen, selectedSale]);

  function openCollect(sale) {
    setSelectedSale(sale);
    setPaymentDate('');
    setErrors({});
    setBanner(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setSelectedSale(null);
    setSaleDetail(null);
    setSelectedInstallment(null);
    setForm({ amount: '', method: 'CASH', cash_account: '' });
    setErrors({});
    setBanner(null);
  }

  const setField = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  function handleInstallmentChange(event) {
    const installmentId = Number(event.target.value);
    const inst = (saleDetail?.installments || []).find((i) => i.id === installmentId);
    if (inst) {
      setSelectedInstallment(inst);
      const due = Number(inst.amount) + Number(inst.interest_charged || 0) - Number(inst.paid_amount);
      setForm((prev) => ({ ...prev, amount: String(due) }));
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!selectedSale || !selectedInstallment) return;

    const due = Number(selectedInstallment.amount) + Number(selectedInstallment.interest_charged || 0) - Number(selectedInstallment.paid_amount);
    const saleBalance = Number(saleDetail?.remaining_cost || 0);
    const clientErrors = {};
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount < 0.01) clientErrors.amount = 'Enter a valid amount.';
    if (amount > saleBalance + 0.005) clientErrors.amount = 'Amount cannot exceed balance due.';
    if (!form.method) clientErrors.method = 'Select a payment method.';
    if (form.method === 'TRANSFER' && !form.cash_account) clientErrors.cash_account = 'Select a cash account for bank transfers.';

    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;

    try {
      await collectMutation.mutateAsync({
        saleId: selectedSale.id,
        data: {
          installment: selectedInstallment.id,
          amount,
          method: form.method,
          cash_account: form.cash_account || null,
          payment_date: pastDate(paymentDate, todayValue),
        },
      });
      closeModal();
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  function handleReset() {
    setCustomerName('');
    setCustomerPhone('');
    setCustomerNic('');
    setDateFrom('');
    setDateTo('');
    setPaidStatus('all');
    listQuery.refetch();
  }

  const columns = [
    {
      key: 'invoice_no',
      header: 'Invoice',
      width: '150px',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => <span className="font-mono font-bold text-slate-900">{row.invoice_no}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => (
        <div>
          <span className="font-semibold text-slate-900">{row.customer_name || 'Walk-in'}</span>
          {row.customer_phone ? (
            <p className="text-xs text-slate-400 mt-0.5">{row.customer_phone}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'created_at',
      header: 'Date',
      width: '130px',
      render: (row) => formatDate(row.created_at),
    },
    {
      key: 'branch_name',
      header: 'Branch',
      render: (row) => row.branch_name || '—',
    },
    {
      key: 'total_cost',
      header: 'Total',
      align: 'right',
      cellClassName: 'font-semibold text-slate-900',
      render: (row) => formatLKR(row.total_cost),
    },
    {
      key: 'remaining_cost',
      header: 'Balance',
      align: 'right',
      render: (row) => formatLKR(row.remaining_cost),
    },
    {
      key: 'is_fully_paid',
      header: 'Status',
      width: '140px',
      align: 'center',
      render: (row) =>
        row.is_fully_paid ? (
          <span className="badge bg-emerald-50 text-emerald-700">Fully paid</span>
        ) : (
          <span className="badge bg-amber-50 text-amber-700">Not fully paid</span>
        ),
    },
    {
      key: 'collect',
      header: 'Collect',
      width: '100px',
      align: 'right',
      render: (row) => (
        <button
          type="button"
          className="btn-secondary px-2 py-1.5"
          onClick={(event) => {
            event.stopPropagation();
            openCollect(row);
          }}
          disabled={row.is_fully_paid}
          aria-label={row.is_fully_paid ? 'Already fully paid' : `Collect payment for ${row.invoice_no}`}
        >
          Collect
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Installment Payments"
        description={
          listQuery.isPending
            ? 'Loading sales...'
            : `${count} ${count === 1 ? 'sale' : 'sales'}`
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load sales — {apiErrorMessage(listQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => listQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Separate filter bar — each filter is its own labeled input */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex flex-col gap-1 sm:w-64">
          <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500" htmlFor="filter-customer-name">
            Customer name
          </label>
          <input
            id="filter-customer-name"
            className="input"
            type="text"
            value={customerName}
            onChange={(event) => setCustomerName(event.target.value)}
            placeholder="Customer name"
          />
        </div>

        <div className="flex flex-col gap-1 sm:w-56">
          <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500" htmlFor="filter-customer-phone">
            Customer phone
          </label>
          <input
            id="filter-customer-phone"
            className="input"
            type="text"
            value={customerPhone}
            onChange={(event) => setCustomerPhone(event.target.value)}
            placeholder="Phone"
          />
        </div>

        <div className="flex flex-col gap-1 sm:w-56">
          <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500" htmlFor="filter-customer-nic">
            Customer NIC
          </label>
          <input
            id="filter-customer-nic"
            className="input"
            type="text"
            value={customerNic}
            onChange={(event) => setCustomerNic(event.target.value)}
            placeholder="NIC"
          />
        </div>

        <div className="flex flex-col gap-1 sm:w-44">
          <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500" htmlFor="filter-date-from">
            Date from
          </label>
          <input
            id="filter-date-from"
            className="input"
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1 sm:w-44">
          <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500" htmlFor="filter-date-to">
            Date to
          </label>
          <input
            id="filter-date-to"
            className="input"
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1 sm:w-56">
          <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500" htmlFor="filter-paid-status">
            Payment status
          </label>
          <select
            id="filter-paid-status"
            className="input"
            value={paidStatus}
            onChange={(event) => setPaidStatus(event.target.value)}
          >
            <option value="all">All</option>
            <option value="fully_paid">Fully paid</option>
            <option value="outstanding">Not fully paid</option>
          </select>
        </div>

        <div className="flex flex-col gap-1 sm:flex-row sm:items-end gap-2">
          <button
            type="button"
            className="btn-primary"
            onClick={() => listQuery.refetch()}
            disabled={listQuery.isPending}
          >
            {listQuery.isPending ? 'Applying...' : 'Apply'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleReset}
            disabled={!hasFilters && !listQuery.isPending}
          >
            Reset
          </button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Installment-capable sales for payment collection"
        emptyTitle={hasFilters ? 'No sales match your filters' : 'No installment sales yet'}
        emptyDescription={
          hasFilters
            ? 'Try different filter values or click Reset.'
            : 'Sales with installment plans will appear here.'
        }
      />

      {/* Collect Payment Modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={selectedSale ? `Collect payment — ${selectedSale.invoice_no}` : 'Collect payment'}
        description="Record an installment payment against this sale."
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button
              type="submit"
              form="collect-form"
              className="btn-primary"
              disabled={collectMutation.isPending}
            >
              {collectMutation.isPending ? 'Collecting...' : 'Collect'}
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

        {saleDetail ? (
          <form id="collect-form" onSubmit={handleSubmit} noValidate>
            <div className="space-y-4">
              {/* Sale summary */}
              <div className="rounded-control border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-medium text-slate-900">
                  {saleDetail.invoice_no} — {saleDetail.customer_name || 'Walk-in'}
                </p>
                <p className="text-sm text-slate-600 mt-0.5">
                  Remaining: <span className="font-semibold text-brand-600">{formatLKR(saleDetail.remaining_cost)}</span>
                </p>
              </div>

              {/* Installment picker */}
              <FormField label="Installment" required error={errors.installment}>
                <select
                  className="input"
                  name="installment"
                  value={selectedInstallment ? selectedInstallment.id : ''}
                  onChange={handleInstallmentChange}
                  disabled={!saleDetail?.installments?.length}
                >
                  <option value="">Select installment</option>
                  {(saleDetail.installments || [])
                    .filter((inst) => !inst.is_paid)
                    .map((inst) => (
                      <option key={inst.id} value={inst.id}>
                        #{inst.number} — {formatLKR(Number(inst.amount) + Number(inst.interest_charged || 0) - Number(inst.paid_amount))} due {formatDate(inst.due_date)}
                      </option>
                    ))}
                </select>
                {errors.installment && <p className="mt-1 text-xs text-rose-600">{errors.installment}</p>}
              </FormField>

              <FormField label="Amount" required error={errors.amount}>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0.01"
                  inputMode="decimal"
                  name="amount"
                  value={form.amount}
                  onChange={setField('amount')}
                  placeholder="0.00"
                />
                {Number(user?.business_installment_interest_rate || 0) > 0 && (
                  <p className="mt-1 text-xs text-slate-600">
                    Paying less than the installment amount adds {Number(user.business_installment_interest_rate).toFixed(2)}% interest on the shortfall.
                  </p>
                )}
              </FormField>

              <EntryDateField
                label="Payment date"
                value={paymentDate}
                onChange={setPaymentDate}
                error={errors.payment_date}
                notBefore={toDateInputValue(saleDetail.created_at)}
              />

              <FormField label="Method" required error={errors.method}>
                <select
                  className="input"
                  name="method"
                  value={form.method}
                  onChange={setField('method')}
                >
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="TRANSFER">Bank Transfer</option>
                </select>
              </FormField>

              {form.method === 'TRANSFER' && (
                <FormField label="Cash account" required error={errors.cash_account}>
                  <select
                    className="input"
                    name="cash_account"
                    value={form.cash_account}
                    onChange={setField('cash_account')}
                    disabled={cashAccountsQuery.isPending}
                  >
                    <option value="">Select cash account</option>
                    {cashAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.type})
                      </option>
                    ))}
                  </select>
                </FormField>
              )}

              <p className="text-xs text-slate-500">
                Balance due on selected installment:{' '}
                <span className="font-semibold text-slate-900">
                  {selectedInstallment
                    ? formatLKR(Number(selectedInstallment.amount) + Number(selectedInstallment.interest_charged || 0) - Number(selectedInstallment.paid_amount))
                    : '—'}
                </span>
                {selectedInstallment && Number(selectedInstallment.interest_charged || 0) > 0 && (
                  <span className="ml-2 text-brand-600">
                    (incl. interest: {formatLKR(Number(selectedInstallment.interest_charged))})
                  </span>
                )}
              </p>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-center py-8 text-slate-500">
            Loading sale details...
          </div>
        )}
      </Modal>
    </div>
  );
}