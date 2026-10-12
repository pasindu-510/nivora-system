import EmptyState from './EmptyState.jsx';

/**
 * DataTable — the shared list primitive (spec 7.2).
 *
 * columns: [{ key, header, render?(row), align?, className?, width? }]
 *
 * Handles loading skeletons, empty states, row clicks, and horizontal
 * scrolling on tablets (cashiers often work on small screens).
 */
export default function DataTable({
  columns = [],
  rows = [],
  rowKey = (row, index) => row.id ?? index,
  loading = false,
  emptyTitle = 'Nothing here yet',
  emptyDescription = 'Records will appear here once they exist.',
  onRowClick,
  caption,
}) {
  if (loading) {
    return (
      <div className="card overflow-hidden">
        <div className="space-y-0">
          {Array.from({ length: 5 }).map((_, rowIndex) => (
            <div key={rowIndex} className="flex gap-4 border-b border-slate-100 px-5 py-4 last:border-b-0">
              {columns.map((column, colIndex) => (
                <div
                  key={column.key}
                  className={`h-4 animate-pulse rounded bg-slate-100 ${colIndex === 0 ? 'w-1/4' : 'w-1/6'}`}
                />
              ))}
            </div>
          ))}
        </div>
        <span className="sr-only">Loading records</span>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="card">
        <EmptyState title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="bg-slate-50/80">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 ${
                    column.align === 'right' ? 'text-right' : 'text-left'
                  } ${column.className || ''}`}
                  style={column.width ? { width: column.width } : undefined}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={
                  onRowClick
                    ? 'cursor-pointer transition hover:bg-brand-50/50 focus-within:bg-brand-50/50'
                    : undefined
                }
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-5 py-3.5 text-slate-700 ${
                      column.align === 'right' ? 'text-right tabular-nums' : 'text-left'
                    } ${column.cellClassName || ''}`}
                  >
                    {column.render ? column.render(row, index) : row[column.key] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
