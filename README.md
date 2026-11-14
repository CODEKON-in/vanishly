# Vanishly

Share a PDF as a **view-only** link that **permanently self-destructs** a few minutes
after the recipient opens it.

The recipient never receives a PDF. At upload time the owner's own browser renders
every page to a JPEG with PDF.js; only those page images are uploaded, and they are
served back one at a time through short-lived signed tokens. There is no file to
download, because there is no file.

Built for Vercel's free Hobby plan with free-tier Upstash Redis and Vercel Blob.

---

## How it works

**Owner**

1. Picks a PDF. It is parsed locally — the PDF itself never leaves the device.
2. `POST /api/create` mints a 12-character id plus an upload token and an owner token.
3. Each page is rendered to JPEG (scale 1.5, quality 0.8) and sent to
   `POST /api/upload-page` **one page per request**, because Vercel caps a request
   body at 4.5 MB. A page that comes out over 1.5 MB is re-encoded at lower
   quality and scale until it fits.
4. `POST /api/finalize` marks the document ready and kills the upload token.
5. The owner gets `https://your-app.vercel.app/v/<id>`, a WhatsApp share button and
   a "Delete now" button. The owner token is kept only in that browser's
   `localStorage` — the server stores a hash of it.

**Recipient**

1. `GET /api/meta` reports status, page count, watermark and whether a password is
   needed. **Reading metadata never starts the timer.**
2. A landing screen says how long the document will be visible. The countdown starts
   **only** when the recipient taps *Open document* — so a WhatsApp or Slack link
   preview can never burn the link.
3. `POST /api/open` atomically claims the open, fixes the deadline, and returns an
   HMAC-signed session token bound to the id, a random session id and that deadline.
4. Pages are fetched from `GET /api/page`, drawn onto `<canvas>` (never `<img>`),
   watermarked client-side, and the image blob is dropped immediately after drawing.
5. At zero the canvases are wiped, the expired screen appears, and `POST /api/expire`
   deletes every page image and all metadata.

---

## Project tree

```
vanishingPDF/
├── api/
│   ├── _lib/
│   │   ├── blob.js        Vercel Blob writes (random pathname, never exposed)
│   │   ├── bots.js        link-preview / crawler user-agent sniff
│   │   ├── crypto.js      ids, tokens, scrypt passwords, HMAC session tokens
│   │   ├── doc.js         document record, lazy expiry, physical destruction
│   │   ├── http.js        body reading with hard caps, JSON helpers, JPEG sniff
│   │   ├── limits.js      every size and time limit in one place
│   │   ├── ratelimit.js   Redis fixed-window counters
│   │   └── redis.js       Upstash client + key names
│   ├── create.js          mint a document and its tokens
│   ├── upload-page.js     one page image per request
│   ├── finalize.js        seal the document, retire the upload token
│   ├── meta.js            read-only status for the landing screen
│   ├── open.js            atomic first-open claim, password check, session token
│   ├── page.js            stream one page after verifying token + deadline
│   ├── expire.js          recipient-side self-destruct
│   ├── delete.js          owner "Delete now" and failed-upload cleanup
│   └── cleanup.js         daily cron safety net
├── public/
│   ├── index.html         owner flow
│   ├── viewer.html        recipient flow
│   ├── 404.html
│   ├── css/style.css
│   ├── js/app.js          PDF.js rasterising + sequential upload
│   ├── js/viewer.js       canvas rendering, watermark, countdown, deterrents
│   └── vendor/pdfjs/      copied from node_modules at install time
├── scripts/
│   ├── vendor-pdfjs.mjs   postinstall copy of pdf.js into /public
│   └── test/              mock Redis + Blob, self-test, DOM audit, mock server
├── vercel.json
├── package.json
├── .env.example
└── README.md
```

---

## Deploy to Vercel

### 1. Push to GitHub

```bash
cd vanishingPDF
git init
git add .
git commit -m "Vanishly"
git remote add origin git@github.com:<you>/vanishly.git
git push -u origin main
```

### 2. Import the project

On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
Framework preset: **Other**. No build command needed; `npm install` runs the
`postinstall` script that copies pdf.js into `public/vendor/pdfjs`.

### 3. Add storage (both free tier)

In the project → **Storage**:

- **Upstash Redis** (Marketplace). Connect it to the project. It injects
  `KV_REST_API_URL` and `KV_REST_API_TOKEN` (some versions use
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — the app accepts either).
- **Blob**. Create a store and connect it. It injects `BLOB_READ_WRITE_TOKEN`.

### 4. Add your own environment variables

Settings → **Environment Variables**, for all environments:

| Name | Value |
| --- | --- |
| `SECRET` | long random string — signs viewer session tokens |
| `CRON_SECRET` | long random string — authenticates the daily cron |

Generate each with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 5. Redeploy

Storage integrations and env vars only reach the functions after a fresh deploy.
The cron in `vercel.json` (`/api/cleanup`, daily at 03:00 UTC) registers itself.

---

## Local development

### Mock server — no accounts needed

```bash
npm install
npm run dev:mock      # http://localhost:3000
```

In-memory stand-ins for Redis and Blob, the same security headers as production,
and `/v/:id` rewriting. State is lost on restart. Best for working on the UI.

### Real services

```bash
npm i -g vercel
vercel link
vercel env pull .env.development.local   # pulls Upstash + Blob + SECRET
vercel dev
```

### Checks

```bash
npm run verify     # syntax + DOM/CSP audit + 70-check self-test
npm test           # self-test only
npm run audit      # ids, labels, aria refs, CSS classes, CSP origins
```

---

## Security model

**Storage**

- The PDF is never uploaded, stored or served. Only flattened JPEG page images exist
  server-side, and only for the life of the link.
- Page images go to Vercel Blob under an unguessable random pathname. **Blob URLs are
  never sent to any client.** `/api/page` fetches the blob server-side and streams the
  bytes back, so every single page request passes through a token check.
- If the installed Blob SDK supports private access, `api/_lib/blob.js` uses it and
  falls back to public-with-random-pathname otherwise. The current SDK (0.27.x) only
  offers public access, so **treat the blob URL as a bearer secret** — which is why it
  is never exposed and is deleted at expiry.

**Tokens**

- `id`: 12 url-safe characters from `crypto.randomBytes` (72 bits).
- Upload and owner tokens: 256-bit random, stored only as SHA-256 hashes, compared in
  constant time. The upload token is retired by `finalize`.
- Viewer session token: `id.sessionId.deadline` signed with HMAC-SHA256 under `SECRET`.
  It is bound to one document and dies at the deadline. A token from one document
  cannot read another.

**Passwords**

- `crypto.scrypt` (N=16384, r=8, p=1) with a 128-bit random salt, constant-time
  comparison. 5 wrong attempts per link, then a 10-minute lock, both counted in Redis.

**Expiry — enforced three ways**

Hobby plan crons run only once a day, so the cron is a safety net, never the mechanism:

1. **Lazily, on every request.** `meta`, `open` and `page` all check both deadlines
   first; the request that notices expiry physically deletes the page images and the
   metadata before it answers.
2. **By the recipient.** At zero the viewer calls `/api/expire`, which deletes
   everything.
3. **By the daily cron.** `/api/cleanup` walks a Redis sorted set of documents and
   sweeps anything past its deadline, including documents whose Redis record already
   expired by TTL while their blobs survived.

Redis TTLs are set to the max lifetime at creation and shortened to the expiry window
on first open, so metadata cannot outlive the link even if nothing else runs.

**Not leaking which links exist**

Expired, deleted and never-existed ids all return exactly `{"status":"expired"}` and the
same friendly page. `/api/expire` always answers 200 but only acts on a valid signature,
so it cannot be used to destroy someone else's link.

**Link previews**

`/api/open` refuses known bot and preview user agents (WhatsApp, facebookexternalhit,
Twitterbot, Slackbot, TelegramBot, Discord, crawlers, generic HTTP clients) and, more
importantly, the timer starts on a button click rather than page load — so a preview
fetch changes no state at all.

**Headers**

`vercel.json` applies a strict CSP (`default-src 'self'`, no inline styles, no external
origins at all — pdf.js is served from `/public`), `nosniff`, `Referrer-Policy:
no-referrer`, `X-Frame-Options: DENY`, and a `Permissions-Policy` that turns off camera,
mic and geolocation. Page responses add `Cache-Control: no-store` and
`Content-Disposition: inline`.

**Logging**

Tokens, passwords and file bytes are never logged. Error handling logs messages only.

---

## Honest limitations

**View-only is a deterrent, not a guarantee. It cannot be otherwise.**

- **OS-level screenshots on Windows and macOS cannot be blocked by a web page.**
  Nothing here — the focus-loss blur, the shortcut-key blanking, the devtools
  deterrent — is anything more than a deterrent; a determined person with the
  Snipping Tool, Shift+Cmd+4, or a second camera will always get through.
  The owner's watermark, tiled large and legible across every page, is what makes a
  leak traceable back to this one link — it does not and cannot stop one.
- Right-click, text selection, drag, long-press save, `Ctrl/Cmd+S/P/C/U` and `F12` are
  blocked, and printing is disabled via `@media print`. Anyone who opens developer
  tools can defeat all of it. The devtools deterrent blurs the content on desktop
  only; it is a speed bump.
- Pages are drawn to `<canvas>`, so there is no image to right-click and no text to
  copy — but the pixels are in the browser and can be read out of it by a determined
  person. There is no DRM here, and web DRM for images does not exist.
- Text is **not** selectable or searchable for the recipient, by design. Flattening to
  images is what removes the download. It also means the viewer is not accessible to
  screen readers: a recipient who relies on one cannot read the document. If that
  matters for your use, send a real PDF.
- Blob deletion is immediate, but a CDN edge may hold a copy briefly. Blobs are written
  with `cacheControlMaxAge: 0` to keep that window as small as the platform allows.
- Rate limits are per-IP fixed windows and fail open if Redis is unreachable:
  availability is preferred over strictness. They slow abuse, they do not stop a
  distributed attacker.
- Limits are 30 pages and 15 MB of page images per document, and a single page must
  compress under 1.5 MB. Very dense scans may fail; re-scan at lower DPI.
- Everything is in memory on the client while open. A browser crash report or an OS
  screenshot cache is outside this app's reach.
- The free tiers are generous but finite. Heavy use will hit Upstash command limits or
  Blob storage limits.

---

## API reference

| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/create` | — | mint id + upload/owner tokens |
| POST | `/api/upload-page?id&n&token` | upload token | store one JPEG page |
| POST | `/api/finalize` | upload token | seal the document |
| GET | `/api/meta?id` | — | status for the landing screen |
| POST | `/api/open` | password, if set | claim the open, get a session token |
| GET | `/api/page?id&n&t` | session token | stream one page |
| POST | `/api/expire` | session token | self-destruct at zero |
| POST | `/api/delete` | owner or upload token | delete now / abort an upload |
| GET | `/api/cleanup` | `CRON_SECRET` | daily sweep |

See `TESTING.md` for the manual checklist.

## Licence

Do what you like with it.
