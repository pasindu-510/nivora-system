/** Display formatting helpers — currency (LKR) and dates. Spec 10: LKR only. */

const lkrFormatter = new Intl.NumberFormat('en-LK', {
  style: 'currency',
  currency: 'LKR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const lkrCompactFormatter = new Intl.NumberFormat('en-LK', {
  style: 'currency',
  currency: 'LKR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** formatLKR(1234.5) -> "LKR 1,234.50" */
export function formatLKR(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'LKR —';
  return lkrFormatter.format(num);
}

/** Short form for KPI cards: "LKR 12.3K" */
export function formatLKRCompact(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'LKR —';
  return lkrCompactFormatter.format(num);
}

/** parse a date-ish value to YYYY-MM-DD for date inputs / API params */
export function toDateInputValue(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 2026-09-24 -> "24 Sep 2026" (falls back to raw string) */
export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** ISO datetime -> "24 Sep 2026, 14:05" */
export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human file size: 204800 -> "200 KB" */
export function formatBytes(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 0) return '—';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${Math.round(num / 1024)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

/** Initials for avatar chips: "Amal Perera" -> "AP" */
export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
