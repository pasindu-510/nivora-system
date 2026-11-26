import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { installmentsApi, salesApi, cashAccountsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate, formatLKR } from '../utils/format.js';
import { paymentMethodLabel } from '../components/print/Bills.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';
import EntryDateField, { pastDate, useBackdate } from '../components/EntryDateField.jsx';
import StatCard from '../components/StatCard.jsx';

/* ------------------------------ icons ----------------------------------- */
const IconOverdue = (
  <svg xmlns="http://www.w3.org/2000/svg" className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
  </svg>
);
const IconDueSoon = (
  <svg xmlns="http://www.w3.org/2000/svg" className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
  </svg>
);

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
export default function InstallmentsPage() {
  useDocumentTitle('Installments');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { today: todayValue } = useBackdate();
  const [paymentDate, setPaymentDate] = useState('');

  const [windowDays, setWindowDays] = useState('7');
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRow, setSelectedRow] = useState(null);
  const [form, setForm] = useState({ amount: '', method: 'CASH', cash_account: '' });
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);

  const listParams = { days: windowDays };

  const listQuery = useQuery({
    queryKey: qk.installments.due(listParams),
    queryFn: async () => (await installmentsApi.due(listParams)).data,
  });

  const cashAccountsQuery = useQuery({
    queryKey: qk.finance.cashAccounts({ page_size: 100 }),
    queryFn: async () => (await cashAccountsApi.list({ page_size: 100 })).data,
  });

  const collectMutation = useApiMutation(
    ({ saleId, data }) => salesApi.payInstallment(saleId, data),
    {
      invalidates: [
        (vars) => qk.installments.due({ days: windowDays }),
        qk.sales.root,
        qk.dashboard.summary({}),
      ],
    }
  );

  const rows = (listQuery.data && listQuery.data.results) || [];
  const count = listQuery.data ? listQuery.data.count : rows.length;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const overdueRows = rows.filter((row) => new Date(row.due_date) < today);
  const dueSoonRows = rows.filter((row) => new Date(row.due_date) >= today);

  const overdueCount = overdueRows.length;
  const overdueTotal = overdueRows.reduce((sum, row) => sum + Number(row.due_amount || 0), 0);
  const dueSoonCount = dueSoonRows.length;
  const dueSoonTotal = dueSoonRows.reduce((sum, row) => sum + Number(row.due_amount || 0), 0);

  const cashAccounts = (cashAccountsQuery.data && cashAccountsQuery.data.results) || [];

  function openCollect(row) {
    setSelectedRow(row);
    setPaymentDate('');
    setForm({
      amount: String(row.due_amount),
      method: 'CASH',
      cash_account: '',
    });
    setErrors({});
    setBanner(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setSelectedRow(null);
  }

  const setField = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  async function handleSubmit(event) {
    event.preventDefault();
    if (!selectedRow) return;

    const clientErrors = {};
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount < 0.01) clientErrors.amount = 'Enter a valid amount.';
    // Any amount is allowed (overpayment rolls forward to later installments);
    // the backend rejects amounts beyond the whole sale's remaining balance.
    if (!form.method) clientErrors.method = 'Select a payment method.';
    if (form.method === 'TRANSFER' && !form.cash_account) clientErrors.cash_account = 'Select a cash account for bank transfers.';

    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;

    try {
      await collectMutation.mutateAsync({
        saleId: selectedRow.sale,
        data: {
          installment: selectedRow.id,
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

  const columns = [
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
      key: 'invoice_no',
      header: 'Invoice',
      render: (row) => <span className="font-mono text-xs">{row.invoice_no}</span>,
    },
    {
      key: 'number',
      header: 'Installment #',
      render: (row) => <span className="font-mono text-xs">#{row.number}</span>,
    },
    {
      key: 'due_date',
      header: 'Due date',
      render: (row) => formatDate(row.due_date),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) => formatLKR(Number(row.amount)),
    },
    {
      key: 'paid_amount',
      header: 'Paid',
      align: 'right',
      render: (row) => formatLKR(Number(row.paid_amount)),
    },
    {
      key: 'due_amount',
      header: 'Balance',
      align: 'right',
      cellClassName: 'font-bold text-slate-900',
      render: (row) => (
        <span>
          {formatLKR(Number(row.due_amount))}
          {Number(row.interest_charged || 0) > 0 && (
            <span className="ml-1 text-[10px] font-medium text-slate-500">
              (incl. {formatLKR(Number(row.interest_charged))})
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => {
        const isOverdue = new Date(row.due_date) < today;
        return isOverdue ? (
          <span className="badge bg-rose-50 text-rose-600">Overdue</span>
        ) : (
          <span className="badge bg-amber-50 text-amber-600">Due soon</span>
        );
      },
    },
    {
      key: 'collect',
      header: 'Collect',
      align: 'right',
      render: (row) => (
        <button
          type="button"
          className="btn-secondary px-2 py-1.5"
          onClick={(event) => {
            event.stopPropagation();
            openCollect(row);
          }}
        >
          Collect
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Installments"
        description={
          listQuery.isPending
            ? 'Loading installments...'
            : `${count} ${count === 1 ? 'installment' : 'installments'} due`
        }
        actions={
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-slate-600">Due within</label>
            <select
              className="input w-auto"
              value={windowDays}
              onChange={(event) => setWindowDays(event.target.value)}
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </select>
          </div>
        }
      />

      {listQuery.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load installments — {apiErrorMessage(listQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => listQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="Overdue"
          value={overdueCount}
          hint={formatLKR(overdueTotal)}
          tone="danger"
          loading={listQuery.isPending}
          icon={IconOverdue}
        />
        <StatCard
          label={`Due within ${windowDays} days`}
          value={dueSoonCount}
          hint={formatLKR(dueSoonTotal)}
          tone="warning"
          loading={listQuery.isPending}
          icon={IconDueSoon}
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        loading={listQuery.isPending}
        caption="Overdue and upcoming installments for collection"
        onRowClick={(row) => navigate(`/sales/${row.sale}`)}
        emptyTitle={count === 0 ? 'All caught up' : 'No installments due'}
        emptyDescription={
          count === 0
            ? 'No overdue or upcoming installments in the selected window.'
            : 'Try a different due window.'
        }
      />

      {/* Collect Payment Modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={selectedRow ? `Collect installment — ${selectedRow.invoice_no} #${selectedRow.number}` : 'Collect installment'}
        description="Record a payment against this installment."
        size="sm"
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
        <form id="collect-form" onSubmit={handleSubmit} noValidate>
          <div className="space-y-4">
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
              Balance due: <span className="font-semibold text-slate-900">{selectedRow ? formatLKR(Number(selectedRow.due_amount)) : '—'}</span>
              {selectedRow && Number(selectedRow.interest_charged || 0) > 0 && (
                <span className="ml-2 text-brand-600">
                  (incl. interest: {formatLKR(Number(selectedRow.interest_charged))})
                </span>
              )}
            </p>
          </div>
        </form>
      </Modal>
    </div>
  );
}
