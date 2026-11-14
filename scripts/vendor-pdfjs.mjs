// Copies the pdf.js build we need out of node_modules into /public/vendor/pdfjs
// so the viewer and uploader never touch a CDN (strict CSP: script-src 'self').
import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist', 'build');
const dest = join(root, 'public', 'vendor', 'pdfjs');

const files = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

try {
  await access(src);
} catch {
  console.warn('[vendor-pdfjs] pdfjs-dist not installed yet; skipping.');
  process.exit(0);
}

await mkdir(dest, { recursive: true });
for (const f of files) {
  await cp(join(src, f), join(dest, f));
  console.log('[vendor-pdfjs] ->', join('public/vendor/pdfjs', f));
}
