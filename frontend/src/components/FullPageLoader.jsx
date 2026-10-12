/** Full-viewport loader used while the session is being restored. */
export default function FullPageLoader({ label = 'Loading' }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface">
      <div
        className="size-10 animate-spin rounded-full border-[3px] border-slate-200 border-t-brand-600"
        role="status"
        aria-label={label}
      />
      <p className="text-sm font-medium text-slate-500">{label}...</p>
    </div>
  );
}
