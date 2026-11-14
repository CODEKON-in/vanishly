import { put } from '@vercel/blob';
import { randomToken } from './crypto.js';

function pathFor(id, n) {
  // Unguessable: the page index alone tells an attacker nothing useful.
  return `v/${id}/${n}-${randomToken(16)}.jpg`;
}

/**
 * Store one page image in the project's private Blob store. The returned
 * URL is kept server-side only -- it is never sent to a client; /api/page
 * fetches it (with the read-write token as a bearer credential) after its
 * own token checks.
 */
export async function putPage(id, n, buffer) {
  const pathname = pathFor(id, n);
  const result = await put(pathname, buffer, {
    access: 'private',
    contentType: 'image/jpeg',
    addRandomSuffix: true,
    cacheControlMaxAge: 0,
  });
  return result.url;
}
