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
  console.error('[vendor-pdfjs] FATAL: pdfjs-dist is not installed (node_modules/pdfjs-dist/build missing).');
  console.error('[vendor-pdfjs] Make sure pdfjs-dist is in "dependencies" (not devDependencies) so hosts that skip dev deps still install it.');
  process.exit(1);
}

await mkdir(dest, { recursive: true });
for (const f of files) {
  await cp(join(src, f), join(dest, f));
  console.log('[vendor-pdfjs] ->', join('public/vendor/pdfjs', f));
}
