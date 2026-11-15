import { PLANS } from './plans.js';

/**
 * Shared validation & security bounds. Per-tier limits live in `PLANS`
 * (api/_lib/plans.js) and are resolved server-side per request.
 */
export const LIMITS = {
  MAX_PAGES: PLANS.ultra.maxPages,            // absolute upper ceiling across all plans (200)
  MAX_TOTAL_BYTES: PLANS.ultra.maxTotalBytes, // absolute upper ceiling across all plans (100 MB)
  MAX_PAGE_BYTES: 1.5 * 1024 * 1024,
  MAX_WATERMARK_CHARS: 60,
  MIN_PASSWORD_CHARS: 4,
  MAX_PASSWORD_CHARS: 128,
  PW_MAX_ATTEMPTS: 5,
  PW_LOCK_SECONDS: 600,
};
