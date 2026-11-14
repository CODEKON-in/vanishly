import { put } from '@vercel/blob';
import { randomToken } from './crypto.js';

// Probe once per cold start: use private access when the installed SDK/plan
// supports it, otherwise fall back to public + unguessable pathname.
let privateSupported = null;

function pathFor(id, n) {
  // Unguessable: the page index alone tells an attacker nothing useful.
  return `v/${id}/${n}-${randomToken(16)}.jpg`;
}

/**
 * Store one page image. The returned URL is kept server-side only — it is
 * never sent to a client; /api/page fetches it after token checks.
 */
export async function putPage(id, n, buffer) {
  const pathname = pathFor(id, n);
  const base = {
    contentType: 'image/jpeg',
    addRandomSuffix: true,
    cacheControlMaxAge: 0,
  };

  if (privateSupported !== false) {
    try {
      const result = await put(pathname, buffer, { ...base, access: 'private' });
      privateSupported = true;
      return result.url;
    } catch (err) {
      if (privateSupported === true) throw err;
      // Don't memoize the failure: it may be a transient network error, not
      // proof the plan/SDK lacks private access. Fall through to public for
      // THIS request only and let the next cold start try private again.
    }
  }

  const result = await put(pathname, buffer, { ...base, access: 'public' });
  return result.url;
}
