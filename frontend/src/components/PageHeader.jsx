/**
 * Consistent page header: H1 + supporting copy + optional right-side actions.
 */
export default function PageHeader({ title, description, actions }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{title}</h1>
        {description ? (
          /* A <div>, not a <p>: callers pass rich block content (spans, divs)
             here, and block elements cannot legally nest inside a <p>. */
          <div className="mt-1 text-sm text-slate-500">{description}</div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
