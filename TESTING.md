# Manual test checklist

Automated first — this covers most of the list below without a browser:

```bash
npm run verify
```

`npm run check` syntax-checks every function, `npm run audit` verifies element ids,
labels, ARIA references, CSS classes and CSP origins, and `npm test` runs 70
end-to-end assertions against in-memory stand-ins for Redis and Blob.

Then walk the list by hand, ideally with a phone on WhatsApp since that is the main
use. Run it on a real deployment, not only the mock server — the mock does not
exercise Upstash or Blob.

## Setup

- [ ] `npm install` finishes and `public/vendor/pdfjs/` contains `pdf.min.mjs` and
      `pdf.worker.min.mjs`.
- [ ] `npm run dev:mock` serves `http://localhost:3000` with no console errors.
- [ ] On the deployment, `SECRET` and `CRON_SECRET` are set and Upstash + Blob are
      connected. Redeploy after adding them.

## Owner flow

- [ ] Drag a PDF onto the dropzone — it is accepted. Tap-to-choose also works on a phone.
- [ ] Drop a non-PDF (a .png, a .txt) — a clear error appears on the pick step and no
      upload starts.
- [ ] Drop a PDF with more than 30 pages — the page-count error names the limit.
- [ ] Drop a corrupt or password-protected PDF — "could not be read", nothing uploads.
- [ ] Options render and are reachable by keyboard: expiry (2/3/5, default 5), lifetime
      (1h/6h/24h, default 1h), opens (once by default), password, watermark.
- [ ] A 3-character password is rejected before any upload begins.
- [ ] Upload a 5–10 page PDF: the progress bar advances per page and the label names
      the page being rendered, then uploaded.
- [ ] Check the network panel: **one request per page**, each body under 1.5 MB, and no
      request carrying the whole document.
- [ ] A dense scanned PDF still uploads (pages get re-encoded smaller automatically).
- [ ] The result screen shows the link, a working Copy button, a "Share link" button
      and Delete now.
- [ ] On a phone, "Share link" opens the OS share sheet with your installed apps.
- [ ] On desktop (no Web Share API), it opens the in-page sheet instead: every icon
      opens the right service with the link prefilled, "Copy link" shows a toast,
      Esc and the backdrop close it, and Tab cycles inside the sheet only.
- [ ] The microcopy says "vanishes X minutes after first open" with the chosen X.

## Recipient flow

- [ ] Open the link on another device. The landing screen names the page count and the
      visible-for duration. No page content is visible yet.
- [ ] **The countdown does not exist yet** — no timer is running on the landing screen.
- [ ] Tap *Open document*. Pages render, the top bar appears, the clock starts counting
      down in mm:ss and turns red under 30 seconds.
- [ ] The watermark is tiled diagonally across every page at low opacity, and a fainter
      session id is tiled behind it.
- [ ] Right-click is blocked. Text cannot be selected. Dragging a page does nothing.
      Long-press on a phone does not offer "Save image".
- [ ] `Ctrl/Cmd+S`, `+P`, `+C`, `+U` and `F12` do nothing. Browser print preview shows
      a blank page.
- [ ] Switch tabs or apps and come back: the content is blurred behind a "Tap to
      resume" overlay, and the clock has kept running the whole time.
- [ ] On desktop, opening devtools blurs the content with a message. On a phone,
      nothing is blurred spuriously while scrolling.

## Expiry

- [ ] Let the clock reach 00:00. Pages are cleared instantly and "This link has
      expired" appears.
- [ ] Reload the same link → the expired page, every time.
- [ ] In the Vercel Blob dashboard, the `v/<id>/…` page images are **gone**.
- [ ] In Upstash, `vp:doc:<id>` and `vp:blobs:<id>` are gone and `vp:tomb:<id>` remains.
- [ ] Hit `GET /api/page?id=<id>&n=0&t=<old token>` directly → `410`.
- [ ] Create a link, never open it, and set the lifetime to 1 hour. After an hour, the
      first `GET /api/meta?id=…` returns `expired` **and** that request deletes the
      blobs (check the dashboard straight after).
- [ ] With "open once", open the link, then open it again from another browser → the
      expired page, not the document.
- [ ] With "any number of opens", two devices can view at once and share one deadline;
      when it runs out, both expire.

## Password and lockout

- [ ] A password-protected link asks for the password before the Open button does
      anything.
- [ ] A wrong password shows how many attempts remain and does **not** start the timer.
- [ ] After 5 wrong attempts, the link is locked for 10 minutes, and the correct
      password is refused during the lock.
- [ ] After the lock expires, the correct password works and only then does the
      countdown start.

## Link previews must not consume the link

- [ ] Paste the link into a WhatsApp chat and **do not tap it**. Wait for the preview
      card to render.
- [ ] Open the link afterwards — it still works, and the status in the owner's link
      list still reads "Waiting".
- [ ] Same with Slack and Telegram.
- [ ] `curl -X POST -A 'WhatsApp/2.23' …/api/open -d '{"id":"…"}'` → `403`, and
      `/api/meta` still reports `ready`.

## Owner controls

- [ ] "Delete now" on the result screen: the link immediately shows the expired page
      for the recipient, and the blobs disappear from the dashboard.
- [ ] The link list shows every link created in this browser with live status —
      Waiting, then Open with a live countdown, then Expired.
- [ ] Delete from the list works, and Clear removes an expired entry.
- [ ] The list survives a reload (localStorage) and is empty in a different browser.
- [ ] Open devtools → Application → Local Storage: the owner tokens are there, and
      nothing else.

## Failure paths leave nothing behind

- [ ] Start an upload and kill the network mid-way (devtools offline). An error appears,
      and the Blob dashboard holds **no** orphaned `v/<id>/…` images for that id.
- [ ] Reload during an upload, then check the dashboard an hour later — the daily cron
      or the next `/api/meta` sweeps anything left.
- [ ] `curl -X POST …/api/upload-page?id=<id>&n=0&token=wrong` → `403`.
- [ ] `curl …/api/upload-page` with `Content-Type: image/png` → `415`; with JPEG
      content-type but non-JPEG bytes → `400`.
- [ ] `curl …/api/meta?id=aaaaaaaaaaaa` (never existed) → `{"status":"expired"}`,
      identical to a real expired link.
- [ ] `curl -X POST …/api/expire -d '{"id":"<live id>","token":"forged"}'` → `200` and
      the live link **still works**.
- [ ] `curl …/api/cleanup` with no `Authorization` header → `401`; with
      `Authorization: Bearer $CRON_SECRET` → a JSON summary.

## Headers and hygiene

- [ ] `curl -I https://…/` shows the CSP, `X-Frame-Options: DENY`, `nosniff` and
      `Referrer-Policy: no-referrer`.
- [ ] `curl -I "https://…/api/page?id=…&n=0&t=…"` shows `Cache-Control: no-store` and
      `Content-Disposition: inline`.
- [ ] The browser console has **no CSP violations** on either page.
- [ ] No request in the network panel ever contains a `blob.vercel-storage.com` URL.
- [ ] Vercel function logs contain no tokens, no passwords and no image data.

## Mobile

- [ ] Both pages are usable one-handed on a small phone; buttons are at least 44px tall.
- [ ] Pages fill the width without horizontal scrolling, and pinch-zoom still works.
- [ ] Light mode and dark mode both look right.
