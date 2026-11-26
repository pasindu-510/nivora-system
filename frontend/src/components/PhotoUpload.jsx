import { useEffect, useRef, useState } from 'react';
import { compressImage, IMAGE_COMPRESS_OPTIONS } from '../utils/compressImage.js';
import { formatBytes } from '../utils/format.js';

/**
 * PhotoUpload — pick an image, compress it client-side to ~200 KB
 * (spec 7.2 PhotoUpload; disk budget is only 7 GB), preview it, and hand
 * the resulting File to the parent for multipart upload.
 *
 * value: File | null
 * onChange: (file: File | null) => void
 */
export default function PhotoUpload({
  label = 'Photo',
  value = null,
  onChange,
  hint,
  error,
  accept = 'image/*',
  id = 'photo-upload',
  noun = 'photo',
}) {
  const inputRef = useRef(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(null);

  // Keep an object URL for the current File in sync.
  useEffect(() => {
    if (!value) {
      setPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(value);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  async function handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    setLocalError(null);
    setBusy(true);
    try {
      const compressed = await compressImage(file, IMAGE_COMPRESS_OPTIONS);
      if (onChange) onChange(compressed);
    } catch (err) {
      setLocalError(err.message || 'Could not process that image.');
      if (onChange) onChange(null);
      if (inputRef.current) inputRef.current.value = '';
    } finally {
      setBusy(false);
    }
  }

  function handleRemove() {
    if (onChange) onChange(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  const displayError = error || localError;

  return (
    <div>
      <span className="label">{label}</span>

      <div className="flex flex-col gap-4 rounded-card border border-dashed border-slate-300 bg-slate-50/60 p-4 sm:flex-row sm:items-center">
        <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white">
          {previewUrl ? (
            <img src={previewUrl} alt="Selected preview" className="size-full object-cover" />
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="size-7 text-slate-300"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 19.5h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z"
              />
            </svg>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              id={id}
              type="file"
              accept={accept}
              onChange={handleFileChange}
              className="sr-only"
              aria-label={label}
            />
            <button type="button" className="btn-secondary" onClick={() => inputRef.current && inputRef.current.click()} disabled={busy}>
              {busy ? 'Compressing...' : value ? `Replace ${noun}` : `Choose ${noun}`}
            </button>
            {value ? (
              <button type="button" className="btn-ghost" onClick={handleRemove} disabled={busy}>
                Remove
              </button>
            ) : null}
          </div>

          <p className="mt-2 text-xs text-slate-500">
            {value ? (
              <span>
                <span className="font-semibold text-slate-700">{value.name}</span>
                {' — '}
                {formatBytes(value.size)}
                {value.size <= IMAGE_COMPRESS_OPTIONS.maxBytes ? ' (ready to upload)' : ' (larger than target)'}
              </span>
            ) : (
              hint || `JPG or PNG. Compressed to about ${formatBytes(IMAGE_COMPRESS_OPTIONS.maxBytes)} before upload.`
            )}
          </p>
        </div>
      </div>

      {displayError ? (
        <p className="mt-1.5 text-xs font-medium text-rose-600" role="alert">
          {displayError}
        </p>
      ) : null}
    </div>
  );
}
