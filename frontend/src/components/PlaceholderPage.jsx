/**
 * PlaceholderPage — scaffold shell for routes that phase-9 page work will
 * fill in: page header + a meaningful empty state. Keeps every route live
 * and navigable without fake data.
 */
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import PageHeader from './PageHeader.jsx';
import EmptyState from './EmptyState.jsx';

export default function PlaceholderPage({
  title,
  description,
  emptyTitle,
  emptyDescription,
  actions,
  emptyAction,
}) {
  useDocumentTitle(title);

  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} actions={actions} />
      <div className="card">
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      </div>
    </div>
  );
}
