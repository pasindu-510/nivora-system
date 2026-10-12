/**
 * StatCard — KPI tile for dashboards.
 * value accepts a string/number; pass `tone` for semantic coloring.
 */
import { formatLKRCompact } from '../utils/format.js';

export default function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
  loading = false,
  currency = false,
}) {
  const toneClasses = {
    neutral: 'bg-slate-100 text-slate-600',
    positive: 'bg-emerald-50 text-emerald-600',
    warning: 'bg-amber-50 text-amber-600',
    danger: 'bg-rose-50 text-rose-600',
    brand: 'bg-brand-50 text-brand-600',
  };

  const displayValue = currency ? formatLKRCompact(value) : value;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          {loading ? (
            <div className="mt-2 h-8 w-24 animate-pulse rounded-md bg-slate-100" aria-hidden="true" />
          ) : (
            <p className="mt-1.5 truncate text-2xl font-extrabold tracking-tight text-slate-900" title={String(displayValue ?? '—')}>
              {displayValue ?? '—'}
            </p>
          )}
          {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
        </div>
        {icon ? (
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
              toneClasses[tone] || toneClasses.neutral
            }`}
            aria-hidden="true"
          >
            {icon}
          </div>
        ) : null}
      </div>
    </div>
  );
}
