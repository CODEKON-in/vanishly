export const LIMITS = {
  MAX_PAGES: 30,
  MAX_TOTAL_BYTES: 15 * 1024 * 1024,
  MAX_PAGE_BYTES: 1.5 * 1024 * 1024,
  MAX_WATERMARK_CHARS: 60,
  MIN_PASSWORD_CHARS: 4,
  MAX_PASSWORD_CHARS: 128,
  EXPIRY_CHOICES: [120, 180, 300],            // seconds after first open
  DEFAULT_EXPIRY: 300,
  LIFETIME_CHOICES: [3600, 21600, 86400],     // seconds if never opened
  DEFAULT_LIFETIME: 3600,
  MAX_OPENS_CHOICES: [1, 0],                  // 0 = unlimited within the timer
  DEFAULT_MAX_OPENS: 1,
  PW_MAX_ATTEMPTS: 5,
  PW_LOCK_SECONDS: 600,
};
