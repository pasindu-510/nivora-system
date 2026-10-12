import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';

/**
 * Capture a DOM element and save it as an A4 PDF.
 *
 * Uses html2canvas-pro (modern oklch/color-function support — html2canvas
 * 1.4.x cannot parse Tailwind v4 `oklch()` tokens) and jsPDF directly.
 * Long content is sliced across A4 pages (same approach html2pdf.js uses
 * internally). The captured element is expected to already be A4-shaped
 * (see `.bill-preview-sheet` in index.css); scale 2 keeps text crisp.
 *
 * @param {HTMLElement} element  Visible element to capture (self-contained).
 * @param {{ filename?: string }} options
 */
export default async function downloadElementAsPdf(element, { filename = 'bill.pdf' } = {}) {
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
    logging: false,
    windowWidth: element.scrollWidth,
  });

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PAGE_W = 210;
  const PAGE_H = 297;
  const imageWmm = PAGE_W;
  const imageHmm = (canvas.height * imageWmm) / canvas.width;
  const imageData = canvas.toDataURL('image/jpeg', 0.95);

  let position = 0;
  let heightLeft = imageHmm;
  pdf.addImage(imageData, 'JPEG', 0, position, imageWmm, imageHmm);
  heightLeft -= PAGE_H;

  // Only slice another page when a meaningful amount of content remains
  // (an exact-1-page sheet measures 297.0x mm at scale 2, which leaves a
  // sub-millimetre remainder that would otherwise produce a blank page).
  while (heightLeft > 0.5) {
    position -= PAGE_H;
    pdf.addPage();
    pdf.addImage(imageData, 'JPEG', 0, position, imageWmm, imageHmm);
    heightLeft -= PAGE_H;
  }

  pdf.save(filename);
}