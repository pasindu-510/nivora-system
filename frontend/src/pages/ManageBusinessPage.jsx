import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { businessApi, financeSettingsApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import { useApiMutation } from '../hooks/useApiMutation.js';
import PageHeader from '../components/PageHeader.jsx';
import FormField from '../components/FormField.jsx';
import PhotoUpload from '../components/PhotoUpload.jsx';

function validateTaxRate(values) {
  const errors = {};
  const raw = String(values.tax_rate ?? '').trim();
  if (raw === '') errors.tax_rate = 'Tax rate is required.';
  else {
    const rate = Number(raw);
    // Number('') is 0 — empty is already handled above.
    if (!Number.isFinite(rate)) errors.tax_rate = 'Tax rate must be a number.';
    else if (rate < 0 || rate > 100) errors.tax_rate = 'Tax rate must be between 0 and 100.';
  }
  return errors;
}

function validateInstallmentInterestRate(values) {
  const errors = {};
  const raw = String(values.installment_interest_rate ?? '').trim();
  if (raw === '') errors.installment_interest_rate = 'Installment interest rate is required.';
  else {
    const rate = Number(raw);
    if (!Number.isFinite(rate)) errors.installment_interest_rate = 'Installment interest rate must be a number.';
    else if (rate < 0 || rate > 100) errors.installment_interest_rate = 'Installment interest rate must be between 0 and 100.';
  }
  return errors;
}

/**
 * DRF field errors come back as `{ field: [msg, ...] }` — split them so each
 * message lands on its FormField; anything else becomes a form banner.
 */
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

/** Tax-rate editor — same contract as the /settings/finance section. */
function TaxRateCard() {
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);

  const settingsQuery = useQuery({
    queryKey: qk.finance.settings,
    queryFn: async () => (await financeSettingsApi.get()).data,
  });

  const saveMutation = useApiMutation((data) => financeSettingsApi.update(data), {
    // The POS prefill on /sales/new reads the rate from /api/auth/me/
    // (UserSerializer.business_tax_rate), so both caches must refresh.
    invalidates: [qk.finance.settings, qk.auth.me],
  });

  // `tax_rate` arrives as a string ("10.00") — keep it a string until math.
  const serverRate = settingsQuery.data ? String(settingsQuery.data.tax_rate ?? '') : '';
  // Show the saved rate until the user starts editing, then the draft.
  const value = dirty ? draft : serverRate;

  function handleChange(event) {
    setDraft(event.target.value);
    setDirty(true);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const clientErrors = validateTaxRate({ tax_rate: value });
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      const response = await saveMutation.mutateAsync({
        tax_rate: String(value).trim(),
      });
      // Adopt the server's echoed value right away so the field never blinks
      // back to the pre-save cache while the invalidation refetch is in flight.
      const saved = response && response.data ? response.data.tax_rate : null;
      setDraft(saved != null ? String(saved) : String(value).trim());
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg font-bold tracking-tight text-slate-900">Tax rate</h2>
      <p className="mt-1 text-sm text-slate-500">
        {settingsQuery.isPending
          ? 'Loading tax rate...'
          : `Current rate: ${serverRate}%`}
      </p>

      {settingsQuery.isError ? (
        <div
          className="mt-4 flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load the tax rate — {apiErrorMessage(settingsQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => settingsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {banner ? (
        <div
          className="mt-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
          role="alert"
        >
          {banner}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
        <FormField
          label="Tax rate"
          required
          error={errors.tax_rate}
          hint="The default VAT rate applied to new sales and shown on the VAT report."
        >
          <div className="relative">
            <input
              className="input pr-10"
              type="number"
              min="0"
              max="100"
              step="0.01"
              name="tax_rate"
              value={value}
              onChange={handleChange}
              placeholder="0.00"
              disabled={settingsQuery.isPending || settingsQuery.isError}
            />
            <span
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-400"
              aria-hidden="true"
            >
              %
            </span>
          </div>
        </FormField>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="btn-primary"
            disabled={
              saveMutation.isPending ||
              settingsQuery.isPending ||
              settingsQuery.isError ||
              value === ''
            }
          >
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** Installment interest rate editor — mirrors TaxRateCard contract. */
function InstallmentInterestRateCard() {
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);

  const settingsQuery = useQuery({
    queryKey: qk.finance.settings,
    queryFn: async () => (await financeSettingsApi.get()).data,
  });

  const saveMutation = useApiMutation((data) => financeSettingsApi.update(data), {
    // The POS prefill on /sales/new reads the rate from /api/auth/me/
    // (UserSerializer.business_installment_interest_rate), so both caches must refresh.
    invalidates: [qk.finance.settings, qk.auth.me],
  });

  // `installment_interest_rate` arrives as a string ("2.00") — keep it a string until math.
  const serverRate = settingsQuery.data ? String(settingsQuery.data.installment_interest_rate ?? '') : '';
  // Show the saved rate until the user starts editing, then the draft.
  const value = dirty ? draft : serverRate;

  function handleChange(event) {
    setDraft(event.target.value);
    setDirty(true);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const clientErrors = validateInstallmentInterestRate({ installment_interest_rate: value });
    setErrors(clientErrors);
    setBanner(null);
    if (Object.keys(clientErrors).length) return;
    try {
      const response = await saveMutation.mutateAsync({
        installment_interest_rate: String(value).trim(),
      });
      // Adopt the server's echoed value right away so the field never blinks
      // back to the pre-save cache while the invalidation refetch is in flight.
      const saved = response && response.data ? response.data.installment_interest_rate : null;
      setDraft(saved != null ? String(saved) : String(value).trim());
    } catch (error) {
      const parsed = parseServerError(error);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg font-bold tracking-tight text-slate-900">Installment interest rate</h2>
      <p className="mt-1 text-sm text-slate-500">
        {settingsQuery.isPending
          ? 'Loading installment interest rate...'
          : `Current rate: ${serverRate}%`}
      </p>

      {settingsQuery.isError ? (
        <div
          className="mt-4 flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load the installment interest rate — {apiErrorMessage(settingsQuery.error)}</span>
          <button
            type="button"
            className="btn-secondary px-2.5 py-1 text-xs"
            onClick={() => settingsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {banner ? (
        <div
          className="mt-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
          role="alert"
        >
          {banner}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
        <FormField
          label="Installment interest rate"
          required
          error={errors.installment_interest_rate}
          hint="Interest (%) added to the balance when an installment is paid short. Charged once per shortfall payment."
        >
          <div className="relative">
            <input
              className="input pr-10"
              type="number"
              min="0"
              max="100"
              step="0.01"
              name="installment_interest_rate"
              value={value}
              onChange={handleChange}
              placeholder="0.00"
              disabled={settingsQuery.isPending || settingsQuery.isError}
            />
            <span
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-400"
              aria-hidden="true"
            >
              %
            </span>
          </div>
        </FormField>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="btn-primary"
            disabled={
              saveMutation.isPending ||
              settingsQuery.isPending ||
              settingsQuery.isError ||
              value === ''
            }
          >
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** Business logo upload — POST /api/business/logo/ (multipart). */
function LogoCard() {
  const { user } = useAuth();
  const [logo, setLogo] = useState(null);
  const [banner, setBanner] = useState(null);
  const [success, setSuccess] = useState(false);

  // me() carries the resolved media URL; it refetches via qk.auth.me
  // invalidation after a successful upload.
  const currentLogo = user && user.business_logo ? user.business_logo : null;

  const saveMutation = useApiMutation((formData) => businessApi.uploadLogo(formData), {
    invalidates: [qk.auth.me],
  });

  async function handleSubmit(event) {
    event.preventDefault();
    if (!logo) return;
    setBanner(null);
    setSuccess(false);
    try {
      const formData = new FormData();
      formData.append('logo', logo);
      await saveMutation.mutateAsync(formData);
      setLogo(null);
      setSuccess(true);
    } catch (error) {
      setBanner(error && error.message ? error.message : apiErrorMessage(error));
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg font-bold tracking-tight text-slate-900">Business logo</h2>
      <p className="mt-1 text-sm text-slate-500">
        Used on printed invoices, bills and receipts.
      </p>

      {currentLogo ? (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Current logo
          </p>
          <img
            src={currentLogo}
            alt="Current business logo"
            className="mt-2 h-16 w-auto max-w-full border border-slate-200 rounded-control"
            style={{ objectFit: 'contain' }}
          />
        </div>
      ) : null}

      {success ? (
        <div
          className="mt-4 rounded-control border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm font-medium text-emerald-700"
          role="status"
        >
          Logo updated — it now appears on the top bar and printed bills.
        </div>
      ) : null}

      {banner ? (
        <div
          className="mt-4 rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
          role="alert"
        >
          {banner}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
        <PhotoUpload
          label="Logo"
          value={logo}
          onChange={setLogo}
          hint="JPG or PNG. Compressed to about 200 KB before upload."
        />

        <button
          type="submit"
          className="btn-primary"
          disabled={saveMutation.isPending || !logo}
        >
          {saveMutation.isPending ? 'Uploading...' : 'Save logo'}
        </button>
      </form>
    </section>
  );
}

/** /settings/manage-business — business identity: tax rate, installment interest rate and logo. */
export default function ManageBusinessPage() {
  useDocumentTitle('Manage Business');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manage Business"
        description="Tax rate, installment interest rate and business identity settings."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <TaxRateCard />
        <InstallmentInterestRateCard />
        <LogoCard />
      </div>
    </div>
  );
}