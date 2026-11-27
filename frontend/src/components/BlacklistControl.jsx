import { useState } from 'react';
import { customersApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';
import { apiErrorMessage } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApiMutation } from '../hooks/useApiMutation.js';
import { ADMIN_MANAGER, canAccess } from '../utils/permissions.js';

/**
 * Blacklist state of one person (buyer or guarantor). Everyone sees it;
 * managers and owners can change it. The form is inline so it also works
 * inside a modal.
 *
 * person: { id, name, is_blacklisted, blacklist_reason }
 */
export default function BlacklistControl({ person }) {
  const { user } = useAuth();
  const canManage = canAccess(ADMIN_MANAGER, user?.role);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const mutation = useApiMutation(
    (text) =>
      text === null
        ? customersApi.unblacklist(person.id)
        : customersApi.blacklist(person.id, { reason: text }),
    { invalidates: [qk.customers.root, qk.sales.root] },
  );

  async function submit(text) {
    setError('');
    try {
      await mutation.mutateAsync(text);
      setOpen(false);
      setReason('');
    } catch (err) {
      setError(err?.response?.data?.reason || apiErrorMessage(err));
    }
  }

  const listed = person.is_blacklisted;

  return (
    <div className="mt-2 space-y-2">
      {listed ? (
        <p className="rounded-control border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <strong>Blacklisted</strong>
          {person.blacklist_reason ? ` — ${person.blacklist_reason}` : ''}
        </p>
      ) : null}

      {canManage && !open ? (
        <button
          type="button"
          className={`${listed ? 'btn-secondary' : 'btn-danger'} px-3 py-1.5 text-xs`}
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          {listed ? 'Remove from blacklist' : 'Blacklist'}
        </button>
      ) : null}

      {canManage && open ? (
        <div className="space-y-2 rounded-control border border-slate-200 p-3">
          {listed ? (
            <p className="text-xs text-slate-600">
              Let {person.name} buy and guarantee on installments again?
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-600">
                {person.name} will not be able to buy or guarantee on installments.
              </p>
              <input
                className="input"
                aria-label={`Reason for blacklisting ${person.name}`}
                placeholder="Reason, e.g. missed 3 payments"
                maxLength={255}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                autoFocus
              />
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${listed ? 'btn-primary' : 'btn-danger'} px-3 py-1.5 text-xs`}
              disabled={mutation.isPending || (!listed && !reason.trim())}
              onClick={() => submit(listed ? null : reason.trim())}
            >
              {mutation.isPending ? 'Saving...' : listed ? 'Yes, remove' : 'Confirm blacklist'}
            </button>
            <button
              type="button"
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-xs font-medium text-rose-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
