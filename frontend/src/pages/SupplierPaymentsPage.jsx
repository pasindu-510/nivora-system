import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cashAccountsApi, supplierPaymentsApi, suppliersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { formatDate, formatLKR, toDateInputValue } from '../utils/format.js';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import Icon from '../components/Icon.jsx';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import FormField from '../components/FormField.jsx';
import StatCard from '../components/StatCard.jsx';

/**
 * Supplier payments + supplier ledger (blueprint G-02).
 *
 * - No supplier selected: every payment made to suppliers (newest first).
 * - Supplier selected (?supplier=<id>): its ledger — value of goods received
 *   (what you owe), total paid, balance owed, its purchase orders and payments.
 * Recording a payment reduces the chosen cash account's balance.
 * API: /api/supplier-payments/ (manager+), /api/suppliers/<id>/ledger/.
 */
const LOOKUP = { page_size: 100 };
const STATUS_LABELS = {
  DRAFT: 'Draft',
  ORDERED: 'Ordered',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

function emptyForm(supplierId) {
  return {
    supplier: supplierId || '',
    purchase: '',
    amount: '',
    payment_date: toDateInputValue(new Date()),
    cash_account: '',
    note: '',
  };
}

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

export default function SupplierPaymentsPage() {
  useDocumentTitle('Supplier Payments');
  const [searchParams, setSearchParams] = useSearchParams();
  const supplierId = searchParams.get('supplier') || '';

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(() => emptyForm(supplierId));
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);

  const suppliersQuery = useQuery({
    queryKey: qk.suppliers.list({ ...LOOKUP, ordering: 'name' }),
    queryFn: async () => (await suppliersApi.list({ ...LOOKUP, ordering: 'name' })).data,
    staleTime: 5 * 60 * 1000,
  });
  const accountsQuery = useQuery({
    queryKey: qk.finance.cashAccounts({ is_active: true }),
    queryFn: async () => (await cashAccountsApi.list({ is_active: true })).data,
    staleTime: 60 * 1000,
  });
  const ledgerQuery = useQuery({
    queryKey: qk.suppliers.ledger(supplierId),
    queryFn: async () => (await suppliersApi.ledger(supplierId)).data,
    enabled: Boolean(supplierId),
  });
  const paymentsParams = { ...LOOKUP, ordering: '-payment_date' };
  const paymentsQuery = useQuery({
    queryKey: qk.finance.supplierPayments(paymentsParams),
    queryFn: async () => (await supplierPaymentsApi.list(paymentsParams)).data,
    enabled: !supplierId,
  });
  // Purchase orders offered in the form follow the supplier chosen there.
  const formLedgerQuery = useQuery({
    queryKey: qk.suppliers.ledger(String(form.supplier)),
    queryFn: async () => (await suppliersApi.ledger(form.supplier)).data,
    enabled: modalOpen && Boolean(form.supplier),
  });

  const invalidates = [qk.suppliers.root, ['finance']];
  const createMutation = useApiMutation((data) => supplierPaymentsApi.create(data), { invalidates });
  const deleteMutation = useApiMutation(({ id }) => supplierPaymentsApi.remove(id), { invalidates });

  const suppliers = (suppliersQuery.data && suppliersQuery.data.results) || [];
  const accounts = ((accountsQuery.data && accountsQuery.data.results) || []).filter((a) => a.is_active);
  const accountName = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.name]));
    return (id) => (id ? map.get(id) || '—' : '—');
  }, [accounts]);

  const ledger = ledgerQuery.data;
  const paymentRows = supplierId
    ? (ledger && ledger.payments) || []
    : (paymentsQuery.data && paymentsQuery.data.results) || [];
  const formPurchases = ((formLedgerQuery.data && formLedgerQuery.data.purchases) || []);
  const formBalance = formLedgerQuery.data ? formLedgerQuery.data.balance : null;

  function chooseSupplier(value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('supplier', value);
    else next.delete('supplier');
    setSearchParams(next, { replace: true });
  }

  function openCreate() {
    setForm(emptyForm(supplierId));
    if (accounts.length === 1) setForm((prev) => ({ ...prev, cash_account: String(accounts[0].id) }));
    setErrors({});
    setBanner(null);
    setModalOpen(true);
  }

  const setField = (key) => (event) => {
    const value = event.target.value;
    setForm((prev) => ({ ...prev, [key]: value, ...(key === 'supplier' ? { purchase: '' } : {}) }));
  };

  async function handleSubmit(event) {
    event.preventDefault();
    setBanner(null);
    const clientErrors = {};
    if (!form.supplier) clientErrors.supplier = 'Choose a supplier.';
    if (!(Number(form.amount) > 0)) clientErrors.amount = 'Enter an amount above 0.';
    if (!form.payment_date) clientErrors.payment_date = 'Choose the payment date.';
    if (!form.cash_account) clientErrors.cash_account = 'Choose the account the money was paid from.';
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;
    try {
      await createMutation.mutateAsync({
        supplier: Number(form.supplier),
        purchase: form.purchase ? Number(form.purchase) : null,
        amount: Number(form.amount).toFixed(2),
        payment_date: form.payment_date,
        cash_account: Number(form.cash_account),
        note: form.note.trim(),
      });
      setModalOpen(false);
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setActionError(null);
    try {
      await deleteMutation.mutateAsync({ id: deleteTarget.id });
      setDeleteTarget(null);
    } catch (error) {
      setActionError(apiErrorMessage(error));
    }
  }

  const paymentColumns = [
    { key: 'payment_date', header: 'Date', render: (row) => formatDate(row.payment_date) },
    ...(supplierId
      ? []
      : [{
          key: 'supplier_name',
          header: 'Supplier',
          cellClassName: 'font-semibold text-slate-900',
          render: (row) => (
            <button type="button" className="hover:underline" onClick={() => chooseSupplier(String(row.supplier))}>
              {row.supplier_name}
            </button>
          ),
        }]),
    { key: 'amount', header: 'Amount', align: 'right', cellClassName: 'font-semibold', render: (row) => formatLKR(row.amount) },
    { key: 'cash_account', header: 'Paid from', render: (row) => accountName(row.cash_account) },
    { key: 'note', header: 'Note', render: (row) => row.note || '—' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <button
          type="button"
          className="btn-danger px-2.5 py-1.5 text-xs"
          onClick={() => {
            setActionError(null);
            setDeleteTarget(row);
          }}
        >
          Delete
        </button>
      ),
    },
  ];

  const purchaseColumns = [
    { key: 'order_no', header: 'Order', cellClassName: 'font-mono font-semibold', render: (row) => row.order_no },
    { key: 'status', header: 'Status', render: (row) => STATUS_LABELS[row.status] || row.status },
    { key: 'created_at', header: 'Created', render: (row) => formatDate(row.purchase_date || row.created_at) },
    { key: 'total', header: 'Order total', align: 'right', render: (row) => formatLKR(row.total) },
    { key: 'received_value', header: 'Received value', align: 'right', render: (row) => formatLKR(row.received_value) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Supplier Payments"
        description="Pay suppliers for delivered stock and see how much you still owe each one."
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            + Record Payment
          </button>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <select
          className="input w-full sm:max-w-xs"
          value={supplierId}
          onChange={(event) => chooseSupplier(event.target.value)}
          aria-label="Choose supplier"
        >
          <option value="">All suppliers — payment history</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {supplierId ? (
          <button type="button" className="btn-secondary" onClick={() => chooseSupplier('')}>
            Show all payments
          </button>
        ) : null}
      </div>

      {actionError && !deleteTarget ? (
        <div className="rounded-control border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700" role="alert">
          {actionError}
        </div>
      ) : null}

      {(supplierId ? ledgerQuery.isError : paymentsQuery.isError) ? (
        <div className="rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800" role="alert">
          Could not load — {apiErrorMessage(supplierId ? ledgerQuery.error : paymentsQuery.error)}
        </div>
      ) : null}

      {supplierId ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="Goods received (billed)"
              value={ledger ? formatLKR(ledger.total_billed) : '—'}
              hint={ledger ? `${ledger.purchase_count} purchase order(s)` : undefined}
              loading={ledgerQuery.isPending}
              icon={<Icon name="box" />}
            />
            <StatCard
              label="Paid"
              value={ledger ? formatLKR(ledger.total_paid) : '—'}
              tone="positive"
              loading={ledgerQuery.isPending}
              icon={<Icon name="receipt" />}
            />
            <StatCard
              label="Balance owed"
              value={ledger ? formatLKR(ledger.balance) : '—'}
              tone={ledger && Number(ledger.balance) > 0 ? 'danger' : 'brand'}
              hint={ledger && Number(ledger.balance) < 0 ? 'Paid in advance' : undefined}
              loading={ledgerQuery.isPending}
              icon={<Icon name="chart" />}
            />
          </div>

          <section className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Purchase orders</h2>
            <DataTable
              columns={purchaseColumns}
              rows={(ledger && ledger.purchases) || []}
              rowKey={(row) => row.id}
              loading={ledgerQuery.isPending}
              caption="Supplier purchase orders"
              emptyTitle="No ordered or received purchase orders"
              emptyDescription="Draft and cancelled orders are not counted as owed."
            />
          </section>
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Payments</h2>
        </>
      ) : null}

      <DataTable
        columns={paymentColumns}
        rows={paymentRows}
        rowKey={(row) => row.id}
        loading={supplierId ? ledgerQuery.isPending : paymentsQuery.isPending}
        caption="Supplier payments"
        emptyTitle="No supplier payments yet"
        emptyDescription="Use “Record Payment” when you pay a supplier."
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Record supplier payment"
        description="The amount is taken out of the cash account you choose."
        size="lg"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="supplier-payment-form" className="btn-primary" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Saving...' : 'Save payment'}
            </button>
          </>
        }
      >
        {banner ? (
          <div className="mb-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700" role="alert">
            {banner}
          </div>
        ) : null}
        <form id="supplier-payment-form" onSubmit={handleSubmit} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Supplier"
              required
              error={errors.supplier}
              hint={formBalance !== null ? `Balance owed: ${formatLKR(formBalance)}` : undefined}
            >
              <select className="input" value={form.supplier} onChange={setField('supplier')}>
                <option value="">Select a supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Purchase order" error={errors.purchase} hint="Optional — link the payment to one order">
              <select className="input" value={form.purchase} onChange={setField('purchase')} disabled={!form.supplier}>
                <option value="">Not linked to an order</option>
                {formPurchases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.order_no} — {formatLKR(p.received_value)} received
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Amount" required error={errors.amount} hint="LKR">
              <input
                className="input"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={setField('amount')}
                placeholder="0.00"
              />
            </FormField>
            <FormField label="Payment date" required error={errors.payment_date}>
              <input className="input" type="date" value={form.payment_date} onChange={setField('payment_date')} />
            </FormField>
            <FormField label="Paid from" required error={errors.cash_account}>
              <select className="input" value={form.cash_account} onChange={setField('cash_account')}>
                <option value="">Select a cash account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({formatLKR(a.balance)})
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Note" error={errors.note}>
              <input
                className="input"
                value={form.note}
                onChange={setField('note')}
                placeholder="e.g. Cheque 004512"
              />
            </FormField>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete payment?"
        description={
          deleteTarget
            ? `${formatLKR(deleteTarget.amount)} to ${deleteTarget.supplier_name} will be removed and the amount returns to the cash account balance.`
            : ''
        }
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
            <button type="button" className="btn-danger" onClick={handleDeleteConfirm} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </button>
          </>
        }
      >
        {actionError ? (
          <p className="text-sm font-medium text-rose-600" role="alert">
            {actionError}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
