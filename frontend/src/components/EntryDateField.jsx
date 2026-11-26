import { useAuth } from '../context/AuthContext.jsx';
import { toDateInputValue } from '../utils/format.js';
import { ROLES } from '../utils/permissions.js';
import FormField from './FormField.jsx';

/**
 * What the signed-in user may back-date to. The business limit comes from
 * /auth/me: null = unlimited, 0 = off, N = N days. The server re-checks it.
 */
export function useBackdate() {
  const { user } = useAuth();
  const limit = user ? user.business_backdate_limit_days : 0;
  const isManager = Boolean(
    user && (user.role === ROLES.BUSINESS_ADMIN || user.role === ROLES.MANAGER),
  );
  const allowed = isManager && limit !== 0 && limit !== undefined;
  const today = toDateInputValue(new Date());
  let min;
  if (allowed && limit !== null) {
    const earliest = new Date();
    earliest.setDate(earliest.getDate() - limit);
    min = toDateInputValue(earliest);
  }
  return { allowed, today, min };
}

/** The value to send: undefined unless a past date was chosen. */
export function pastDate(value, today) {
  return value && value !== today ? value : undefined;
}

/**
 * Optional past-date input. Renders nothing when the user cannot back-date.
 * An empty value means today.
 */
export default function EntryDateField({ label, value, onChange, error, notBefore }) {
  const { allowed, today, min } = useBackdate();
  if (!allowed) return null;
  // The later of the business limit and a record-specific floor (e.g. sale date).
  const floor = [min, notBefore].filter(Boolean).sort().pop();
  return (
    <FormField label={label} error={error}>
      <input
        className="input"
        type="date"
        aria-label={label}
        value={value || today}
        min={floor}
        max={today}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}
