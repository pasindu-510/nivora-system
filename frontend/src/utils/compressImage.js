/**
 * Client-side image compression (spec 7.2 / 8: keep uploads near 200 KB —
 * the server disk budget is shared and small).
 *
 * Strategy: draw to canvas at max width, then walk JPEG quality down; if
 * quality alone cannot reach the target, shrink dimensions and repeat.
 */

const DEFAULT_MAX_BYTES = 200 * 1024; // ~200 KB
const DEFAULT_MAX_WIDTH = 1600;

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function loadImage(objectUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read the selected image.'));
    image.src = objectUrl;
  });
}

/**
 * Compress an image File to <= maxBytes (best effort, target ~200 KB).
 * Returns the original file untouched when it is already small enough.
 *
 * @param {File|Blob} file
 * @param {{ maxBytes?: number, maxWidth?: number }} [options]
 * @returns {Promise<File>}
 */
export async function compressImage(file, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, maxWidth = DEFAULT_MAX_WIDTH } = options;

  if (!file || typeof file !== 'object') {
    throw new Error('An image file is required.');
  }
  if (!file.type || !file.type.startsWith('image/')) {
    throw new Error('Only image files can be uploaded.');
  }
  if (file.size <= maxBytes) {
    return file instanceof File ? file : new File([file], 'image.jpg', { type: file.type });
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);

    let width = image.naturalWidth || image.width;
    let height = image.naturalHeight || image.height;
    if (!width || !height) {
      throw new Error('Could not read image dimensions.');
    }

    const scale = Math.min(1, maxWidth / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image compression is not supported in this browser.');
    ctx.drawImage(image, 0, 0, width, height);

    let quality = 0.85;
    let blob = await canvasToBlob(canvas, 'image/jpeg', quality);

    let rounds = 0;
    while (blob && blob.size > maxBytes && rounds < 8) {
      rounds += 1;
      if (quality > 0.3) {
        quality = Math.max(0.3, quality - 0.1);
        blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      } else {
        width = Math.max(1, Math.round(width * 0.75));
        height = Math.max(1, Math.round(height * 0.75));
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(image, 0, 0, width, height);
        quality = 0.7;
        blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      }
    }

    if (!blob) {
      throw new Error('Image compression failed. Try a different photo.');
    }

    const originalName = file.name || 'image.jpg';
    const baseName = originalName.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export const IMAGE_COMPRESS_OPTIONS = Object.freeze({
  maxBytes: DEFAULT_MAX_BYTES,
  maxWidth: DEFAULT_MAX_WIDTH,
});
