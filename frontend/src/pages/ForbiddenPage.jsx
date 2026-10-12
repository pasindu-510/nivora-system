import { Link } from 'react-router-dom';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import EmptyState from '../components/EmptyState.jsx';

/** 403 — the signed-in role may not open this section. */
export default function ForbiddenPage() {
  useDocumentTitle('Access denied');

  return (
    <div className="card">
      <EmptyState
        title="You do not have access to this section"
        description="Your role does not include this area of the system. Contact your business administrator if you believe you need access."
        action={
          <Link to="/dashboard" className="btn-primary">
            Back to dashboard
          </Link>
        }
        icon={
          <svg xmlns="http://www.w3.org/2000/svg" className="size-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        }
      />
    </div>
  );
}
