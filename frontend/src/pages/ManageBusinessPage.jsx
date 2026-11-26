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
import Modal from '../components/Modal.jsx';

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

const SALES_FIELDS = [
  {
    name: 'tax_rate',
    label: 'Tax rate',
    type: 'percent',
    max: 100,
    hint: 'The default VAT rate applied to new sales and shown on the VAT report.',
  },
];

const INSTALLMENT_FIELDS = [
  {
    name: 'installments_enabled',
    label: 'Installment sales',
    type: 'toggle',
    text: 'Allow selling on installments',
    hint: 'Turning this off hides installments on New Sale. Existing plans can still be paid.',
  },
  {
    name: 'installment_monthly_interest_rate',
    label: 'Monthly interest rate',
    type: 'percent',
    max: 100,
    hint: 'Flat interest per month on the balance. Each installment is rounded up to the next 50. 0 means none.',
  },
  {
    name: 'min_down_payment_percent',
    label: 'Minimum down payment',
    type: 'percent',
    max: 99,
    hint: 'Share of the order total, rounded up to the next 100. 0 means no minimum.',
  },
  {
    name: 'installment_interest_rate',
    label: 'Delay payment rate',
    type: 'percent',
    max: 100,
    hint: 'Charged once on the unpaid part when an installment is paid short.',
  },
  {
    name: 'required_guarantors',
    label: 'Guarantors required',
    type: 'select',
    options: [
      [0, 'None'],
      [1, 'One guarantor'],
      [2, 'Two guarantors'],
    ],
    hint: 'Each installment sale must name this many guarantors.',
  },
];

/** Has the draft actually changed the saved value? "10" equals "10.00". */
function differs(field, draft, saved) {
  if (draft === undefined) return false;
  if (field.type === 'toggle') return draft !== saved;
  return String(draft).trim() !== '' && Number(draft) !== Number(saved);
}

/** A group of settings with one Save button, enabled only after a change. */
function SettingsCard({ title, description, fields }) {
  const [draft, setDraft] = useState({});
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [success, setSuccess] = useState(false);

  const settingsQuery = useQuery({
    queryKey: qk.finance.settings,
    queryFn: async () => (await financeSettingsApi.get()).data,
  });

  const saveMutation = useApiMutation((data) => financeSettingsApi.update(data), {
    // New Sale reads these from /api/auth/me/, so both caches must refresh.
    invalidates: [qk.finance.settings, qk.auth.me],
  });

  const saved = settingsQuery.data || {};
  const changed = fields.filter((f) => differs(f, draft[f.name], saved[f.name]));
  const locked = !settingsQuery.data;
  const valueOf = (f) => draft[f.name] ?? saved[f.name] ?? (f.type === 'toggle' ? false : '');

  function edit(name, value) {
    setDraft((prev) => ({ ...prev, [name]: value }));
    setSuccess(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBanner(null);
    const problems = {};
    changed.forEach((f) => {
      const number = Number(draft[f.name]);
      if (f.type === 'percent' && !(number >= 0 && number <= f.max)) {
        problems[f.name] = `Enter a number between 0 and ${f.max}.`;
      }
    });
    setErrors(problems);
    if (!changed.length || Object.keys(problems).length) return;
    try {
      await saveMutation.mutateAsync(
        Object.fromEntries(changed.map((f) => [f.name, draft[f.name]])),
      );
      await settingsQuery.refetch();
      setDraft({});
      setSuccess(true);
    } catch (err) {
      const parsed = parseServerError(err);
      setErrors(parsed.fields);
      setBanner(parsed.banner);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg font-bold tracking-tight text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{description}</p>

      {settingsQuery.isError ? (
        <div
          className="mt-4 flex flex-wrap items-center gap-3 rounded-control border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
          role="alert"
        >
          <span>Could not load settings — {apiErrorMessage(settingsQuery.error)}</span>
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

      <form onSubmit={handleSubmit} noValidate className="mt-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <FormField
              key={f.name}
              label={f.label}
              error={errors[f.name]}
              hint={f.hint}
              className={f.type === 'toggle' ? 'sm:col-span-2' : ''}
            >
              {f.type === 'toggle' ? (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={Boolean(valueOf(f))}
                    onChange={(e) => edit(f.name, e.target.checked)}
                    disabled={locked}
                  />
                  {f.text}
                </label>
              ) : f.type === 'select' ? (
                <select
                  className="input"
                  aria-label={f.label}
                  value={String(valueOf(f))}
                  onChange={(e) => edit(f.name, Number(e.target.value))}
                  disabled={locked}
                >
                  {f.options.map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="relative">
                  <input
                    className="input pr-10"
                    type="number"
                    min="0"
                    max={f.max}
                    step="0.01"
                    name={f.name}
                    aria-label={f.label}
                    value={valueOf(f)}
                    onChange={(e) => edit(f.name, e.target.value)}
                    disabled={locked}
                  />
                  <span
                    className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-400"
                    aria-hidden="true"
                  >
                    %
                  </span>
                </div>
              )}
            </FormField>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
          {success ? (
            <span className="text-sm font-medium text-emerald-700" role="status">
              Saved.
            </span>
          ) : null}
          <button
            type="submit"
            className="btn-primary"
            disabled={!changed.length || saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** Business logo: upload when there is none, otherwise update or remove it. */
function LogoCard() {
  const { user } = useAuth();
  const [logo, setLogo] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [banner, setBanner] = useState(null);
  const [success, setSuccess] = useState('');

  // me() carries the resolved media URL; it refetches after each change.
  const currentLogo = user && user.business_logo ? user.business_logo : null;
  const showPicker = !currentLogo || updating;

  const saveMutation = useApiMutation((formData) => businessApi.uploadLogo(formData), {
    invalidates: [qk.auth.me],
  });
  const removeMutation = useApiMutation(() => businessApi.removeLogo(), {
    invalidates: [qk.auth.me],
  });

  function reset() {
    setLogo(null);
    setUpdating(false);
    setBanner(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!logo) return;
    setBanner(null);
    setSuccess('');
    try {
      const formData = new FormData();
      formData.append('logo', logo);
      await saveMutation.mutateAsync(formData);
      setSuccess(currentLogo ? 'Logo updated.' : 'Logo uploaded.');
      reset();
    } catch (error) {
      setBanner(apiErrorMessage(error));
    }
  }

  async function handleRemove() {
    setBanner(null);
    setSuccess('');
    try {
      await removeMutation.mutateAsync();
      setSuccess('Logo removed.');
      reset();
    } catch (error) {
      setBanner(apiErrorMessage(error));
    }
    setConfirmRemove(false);
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg font-bold tracking-tight text-slate-900">Business logo</h2>
      <p className="mt-1 text-sm text-slate-500">Used on printed invoices, bills and receipts.</p>

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
          {success}
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

      {showPicker ? (
        <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
          <PhotoUpload
            label={currentLogo ? 'New logo' : 'Logo'}
            value={logo}
            onChange={setLogo}
            noun="logo"
            hint="JPG or PNG. Compressed to about 200 KB before upload."
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={saveMutation.isPending || !logo}>
              {saveMutation.isPending
                ? 'Uploading...'
                : currentLogo
                  ? 'Save new logo'
                  : 'Upload logo'}
            </button>
            {currentLogo ? (
              <button type="button" className="btn-secondary" onClick={reset}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setSuccess('');
              setUpdating(true);
            }}
          >
            Update logo
          </button>
          <button type="button" className="btn-danger" onClick={() => setConfirmRemove(true)}>
            Remove logo
          </button>
        </div>
      )}

      <Modal
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove logo?"
        description="Bills and the top bar will no longer show a logo."
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={handleRemove}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? 'Removing...' : 'Remove'}
            </button>
          </>
        }
      />
    </section>
  );
}

/** /settings/manage-business — grouped as sales, installments and branding. */
export default function ManageBusinessPage() {
  useDocumentTitle('Manage Business');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manage Business"
        description="Sales, installment and branding settings."
      />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <SettingsCard title="Sales" description="Applies to every new sale." fields={SALES_FIELDS} />
          <SettingsCard
            title="Installments"
            description="Rules for new installment sales. Plans already sold keep their amounts."
            fields={INSTALLMENT_FIELDS}
          />
        </div>
        <LogoCard />
      </div>
    </div>
  );
}
