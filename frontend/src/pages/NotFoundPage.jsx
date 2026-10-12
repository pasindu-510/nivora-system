import { Link } from 'react-router-dom';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import EmptyState from '../components/EmptyState.jsx';

/** 404 — unknown or moved URL. */
export default function NotFoundPage() {
  useDocumentTitle('Page not found');

  return (
    <div className="card">
      <EmptyState
        title="Page not found"
        description="The page you are looking for does not exist or has been moved. Use the sidebar to continue."
        action={
          <Link to="/dashboard" className="btn-primary">
            Back to dashboard
          </Link>
        }
        icon={
          <svg xmlns="http://www.w3.org/2000/svg" className="size-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
        }
      />
    </div>
  );
}
