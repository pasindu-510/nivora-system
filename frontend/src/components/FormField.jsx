import { useRef } from 'react';

/**
 * FormField — labelled control wrapper with error + hint support.
 * Wrap your input/select/textarea as children; the control picks up the
 * generated id implicitly via the wrapping label.
 *
 * <FormField label="Phone" error={errors.phone} required>
 *   <input className="input" name="phone" />
 * </FormField>
 */
let fieldCounter = 0;

export default function FormField({ label, htmlFor, error, hint, required, children, className = '' }) {
  const autoId = useAutoId();
  const id = htmlFor || autoId;
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label className="label" htmlFor={id}>
        {label}
        {required ? <span className="ml-0.5 text-rose-500" aria-hidden="true">*</span> : null}
      </label>
      <div aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}>{children}</div>
      {hint && !error ? (
        <p className="mt-1.5 text-xs text-slate-500" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="mt-1.5 text-xs font-medium text-rose-600" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function useAutoId() {
  const idRef = useRef(null);
  if (idRef.current === null) {
    fieldCounter += 1;
    idRef.current = `field-${fieldCounter}`;
  }
  return idRef.current;
}
