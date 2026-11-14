// 'whatsapp' is deliberately NOT in this list: WhatsApp's own in-app browser
// (the primary way recipients open these links) sends a UA containing
// "WhatsApp/x.y.z" too, which would block real humans, not just the preview
// crawler. The crawler never runs this page's JS anyway (it only scrapes
// viewer.html for OG tags), so it can never reach /api/open regardless —
// the click-to-start timer is what actually stops it, not this list.
const BOT_PATTERNS = [
  'facebookexternalhit', 'facebot', 'twitterbot', 'slackbot',
  'slack-imgproxy', 'telegrambot', 'discordbot', 'linkedinbot', 'skypeuripreview',
  'viber', 'line-podcast', 'googlebot', 'bingbot', 'yandexbot', 'duckduckbot',
  'applebot', 'embedly', 'quora link preview', 'pinterest', 'redditbot',
  'vkshare', 'w3c_validator', 'developers.google.com/+/web/snippet',
  'preview', 'crawler', 'spider', 'bot/', 'headlesschrome', 'python-requests',
  'curl/', 'wget/', 'go-http-client', 'okhttp', 'axios/', 'node-fetch',
];

/**
 * Conservative UA sniff. Used only to keep link-preview fetchers from
 * consuming a one-shot link; a real browser never matches these.
 */
export function isBot(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (!ua) return true; // no UA at all -> almost certainly not a human browser
  return BOT_PATTERNS.some((p) => ua.includes(p));
}
