/* Vanishly viewer — renders page images to <canvas>, never to <img>,
   watermarks them client-side, and tears everything down at zero. */

const $ = (id) => document.getElementById(id);
const el = {
  vbar: $('vbar'), vtitle: $('vtitle'), clock: $('clock'),
  loading: $('state-loading'), gate: $('state-gate'), doc: $('state-doc'), expired: $('state-expired'),
  gateCopy: $('gate-copy'), gateError: $('gate-error'),
  pwField: $('pw-field'), pw: $('pw'), openBtn: $('open-btn'),
  pages: $('pages'), shield: $('shield'), shieldH: $('shield-h'), shieldCopy: $('shield-copy'),
  resume: $('resume'), ring: $('ring'), clockWrap: $('clock-wrap'),
};

const ID_RE = /^[A-Za-z0-9_-]{12}$/;
const id = (location.pathname.match(/\/v\/([^/?#]+)/) || [])[1] || '';

const RING_C = 2 * Math.PI * 19; // matches r="19" on #ring

let session = null;   // { token, sid, expiresAt, totalMs, pages, watermark }
let ticker = null;
let finished = false;

/* ------------------------------------------------------------------ views */

function view(which) {
  for (const n of [el.loading, el.gate, el.doc, el.expired]) n.hidden = true;
  which.hidden = false;
}

function showExpired() {
  finished = true;
  if (ticker) clearInterval(ticker);
  stopMovingWatermark();
  wipe();
  el.vbar.hidden = true;
  el.shield.hidden = true;
  view(el.expired);
}

function gateError(msg) {
  el.gateError.textContent = msg;
  el.gateError.hidden = false;
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------- page paint */

// Owner-supplied text only. No default, no session id, no timestamp — if the
// owner set no watermark, this draws nothing at all.
function watermarkCanvas(ctx, w, h, text) {
  if (!text) return;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((-30 * Math.PI) / 180);
  const size = Math.max(28, Math.round(w * 0.055));
  ctx.font = `700 ${size}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = 'rgba(17, 24, 39, 0.16)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // ~3-4 repetitions across, ~4-5 down: readable, not a wall of text.
  const stepX = Math.max(ctx.measureText(text).width + size * 1.6, w / 3.2);
  const stepY = Math.max(size * 3, h / 4.4);
  const reach = Math.hypot(w, h);
  for (let y = -reach; y < reach; y += stepY) {
    for (let x = -reach; x < reach; x += stepX) {
      ctx.fillText(text, x, y);
    }
  }
  ctx.restore();
}

async function paintPage(slot, n) {
  if (finished || !session) return;
  const url = `/api/page?id=${encodeURIComponent(id)}&n=${n}&t=${encodeURIComponent(session.token)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 410 || res.status === 403) {
      const tok = session?.token;
      showExpired();
      notifyExpire(tok); // the server may not know yet — tell it now, not just at the client's own countdown
    }
    return;
  }

  const blob = await res.blob();
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.setAttribute('aria-label', `Page ${n + 1}`);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  watermarkCanvas(ctx, canvas.width, canvas.height, session.watermark);

  slot.textContent = '';
  slot.append(canvas);
}

function wipe() {
  for (const canvas of el.pages.querySelectorAll('canvas')) {
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 1;
    canvas.height = 1;
  }
  el.pages.textContent = '';
  session = null;
}

/* ------------------------------------------------------------- countdown */

function startClock() {
  const tick = () => {
    if (!session) return;
    const left = session.expiresAt - Date.now();
    el.clock.textContent = mmss(left);
    const low = left <= 30000;
    el.clock.classList.toggle('low', low);
    el.clockWrap?.classList.toggle('low', low);
    if (el.ring && session.totalMs) {
      const frac = Math.max(0, Math.min(1, left / session.totalMs));
      el.ring.style.strokeDashoffset = String(RING_C * (1 - frac));
    }
    if (left <= 0) {
      expireNow();
    }
  };
  tick();
  ticker = setInterval(tick, 500);
}

async function notifyExpire(token) {
  if (!token) return;
  try {
    await fetch('/api/expire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, token }),
      keepalive: true,
    });
  } catch { /* the server expires it anyway, lazily or via the daily cron */ }
}

async function expireNow() {
  if (finished) return;
  const token = session?.token;
  finished = true;
  if (ticker) clearInterval(ticker);
  stopMovingWatermark();
  wipe();
  view(el.expired);
  el.vbar.hidden = true;
  el.shield.hidden = true;
  await notifyExpire(token);
}

/* ------------------------------------------------------------------ flow */

async function loadMeta() {
  if (!ID_RE.test(id)) return showExpired();
  try {
    const meta = await fetch(`/api/meta?id=${encodeURIComponent(id)}`, { cache: 'no-store' }).then((r) => r.json());
    if (!meta || meta.status === 'expired') return showExpired();

    const mins = Math.round((meta.expirySeconds || 300) / 60);
    const pageCount = `${meta.pages} page${meta.pages === 1 ? '' : 's'}`;
    el.gateCopy.textContent = meta.status === 'open' && meta.expiresAt
      ? `${pageCount}. This document is already open and vanishes in ${mmss(meta.expiresAt - Date.now())}.`
      : `${pageCount}. This document will be visible for ${mins} minute${mins === 1 ? '' : 's'} after you open it, then it is deleted for good.`;
    el.pwField.hidden = !meta.passwordRequired;
    view(el.gate);
    if (meta.passwordRequired) el.pw.focus();
  } catch {
    gateError('Could not reach the server. Check your connection and reload.');
    view(el.gate);
  }
}

async function openDoc() {
  el.gateError.hidden = true;
  el.openBtn.disabled = true;
  el.openBtn.textContent = 'Opening…';

  try {
    const res = await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, password: el.pw.value || undefined }),
    });
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      el.openBtn.disabled = false;
      el.openBtn.textContent = 'Open document';
      if (res.status === 401) { gateError(data?.message || 'Wrong password.'); el.pw.select(); return; }
      if (res.status === 423) { gateError(data?.message || 'Locked for 10 minutes after too many wrong passwords.'); return; }
      if (res.status === 429) { gateError('Too many attempts. Wait a moment and try again.'); return; }
      return showExpired();
    }

    session = {
      token: data.token,
      sid: data.sid,
      expiresAt: Date.now() + (data.expiresAt - data.serverNow),
      totalMs: Math.max(1, data.expiresAt - data.serverNow),
      pages: data.pages,
      watermark: data.watermark || '',
    };

    el.vtitle.textContent = session.watermark || 'View-only document';
    el.vbar.hidden = false;
    view(el.doc);
    startClock();
    startMovingWatermark();

    // Skeletons first, then paint in order.
    const slots = [];
    for (let n = 0; n < session.pages; n += 1) {
      const slot = document.createElement('div');
      slot.className = 'page-slot';
      const sk = document.createElement('div');
      sk.className = 'skel';
      slot.append(sk);
      el.pages.append(slot);
      slots.push(slot);
    }
    for (let n = 0; n < slots.length; n += 1) {
      if (finished) break;
      await paintPage(slots[n], n);
    }
  } catch {
    el.openBtn.disabled = false;
    el.openBtn.textContent = 'Open document';
    gateError('Could not open the document. Check your connection and try again.');
  }
}

/* --------------------------------------------------- view-only deterrents */

// Hoisted so both guard()'s listeners and the shortcut/display-capture
// deterrents below can share one blur/overlay mechanism.
function pause(title, copy) {
  if (finished || !session) return;
  el.shieldH.textContent = title;
  el.shieldCopy.textContent = copy;
  el.shield.hidden = false;
  document.body.classList.add('blurred');
}
function unpause() {
  el.shield.hidden = true;
  document.body.classList.remove('blurred');
}

let flashTimer = null;
/** Blank the view for a few seconds, then restore automatically (unlike the
 * focus-loss shield, which waits for a tap) — for a one-off shortcut press. */
function flashBlank(ms = 3000, title = 'Screenshot attempt blocked', copy = 'This is a deterrent only — it cannot stop an OS-level screenshot.') {
  pause(title, copy);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (!document.hidden && document.hasFocus()) unpause();
  }, ms);
}

function triggerShortcutBlank() {
  flashBlank();
  try { navigator.clipboard?.writeText(''); } catch { /* no clipboard permission — fine */ }
}

/* ------------------------------------------------- moving watermark overlay */
// A dense, low-opacity overlay above every page, re-positioned every few
// seconds so a leaked screenshot is traceable to this one open, whichever
// moment it was taken at. Separate from the static per-page tile (which
// still runs — this just covers the gaps and adds a timestamp).
let wmTimer = null;
function startMovingWatermark() {
  // Nothing to tile if the owner set no watermark — and no sid/timestamp
  // filler in its place.
  if (!session?.watermark || document.getElementById('moveWatermark')) return;
  const div = document.createElement('div');
  div.id = 'moveWatermark';
  div.setAttribute('aria-hidden', 'true');
  div.textContent = Array(40).fill(session.watermark).join('   ');
  document.body.appendChild(div);
  const tick = () => {
    if (!session) return;
    // Subtle drift only — large jumps fight the per-page watermark for attention.
    const x = Math.floor(Math.random() * 30) - 15;
    const y = Math.floor(Math.random() * 30) - 15;
    div.style.transform = `translate(${x}px, ${y}px) rotate(-8deg)`;
  };
  tick();
  wmTimer = setInterval(tick, 6000);
}
function stopMovingWatermark() {
  if (wmTimer) clearInterval(wmTimer);
  wmTimer = null;
  document.getElementById('moveWatermark')?.remove();
}

function guard() {
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('selectstart', (e) => {
    if (e.target?.tagName !== 'INPUT') e.preventDefault();
  });
  document.addEventListener('copy', (e) => e.preventDefault());
  document.addEventListener('cut', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if (e.key === 'F12') { e.preventDefault(); return; }
    // devtools combos
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(k)) { e.preventDefault(); return; }
    // copy / view-source / cut — blocked outright, not a screenshot attempt
    if ((e.ctrlKey || e.metaKey) && ['c', 'u', 'x'].includes(k)) { e.preventDefault(); return; }
    // Screenshot/print/save combos. PrintScreen's e.key is the same whether
    // or not Ctrl/Alt is held, so this one check covers Ctrl+PrintScreen and
    // Alt+PrintScreen too. Most of these are actually intercepted by the OS
    // before the browser ever sees a keydown (see the keyup listener below)
    // — this only catches the cases the browser is given.
    const isShot = e.key === 'PrintScreen'
      || (e.metaKey && e.shiftKey && (k === 's' || ['3', '4', '5'].includes(k))) // Win snip, macOS screenshot/recording
      || (e.ctrlKey && e.shiftKey && k === 's')
      || ((e.ctrlKey || e.metaKey) && (k === 'p' || k === 's'));
    if (isShot) {
      e.preventDefault();
      triggerShortcutBlank();
    }
  });
  // PrintScreen is frequently delivered only on keyup (the OS intercepts the
  // keydown for its own screenshot action on many Windows/browser builds).
  document.addEventListener('keyup', (e) => {
    if (e.key === 'PrintScreen') triggerShortcutBlank();
  });

  // Blur the content whenever the tab or window loses focus. The server-side
  // timer keeps running regardless.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause('Paused', 'Tap to resume. The timer keeps running.');
  });
  window.addEventListener('blur', () => pause('Paused', 'Tap to resume. The timer keeps running.'));
  el.resume.addEventListener('click', unpause);
  el.shield.addEventListener('click', (e) => { if (e.target === el.shield) unpause(); });

  // Mild devtools deterrent and pointer-leaves-window blur — desktop pointers
  // only, so phones (where these signals are meaningless) are untouched.
  const fine = window.matchMedia?.('(pointer: fine)')?.matches;
  if (fine) {
    setInterval(() => {
      if (finished || !session || !el.shield.hidden) return;
      const wide = window.outerWidth - window.innerWidth > 220;
      const tall = window.outerHeight - window.innerHeight > 220;
      if (wide || tall) pause('Content hidden', 'Close developer tools to continue viewing.');
    }, 1200);

  }

  // The pointer leaving the document entirely (e.g. to a Snipping Tool
  // toolbar) never happens on touch input, so this is desktop-safe as-is —
  // no pointer-media gate needed, and it won't fire on ordinary scrolling.
  document.addEventListener('mouseleave', () => {
    pause('Paused', 'Tap to resume. The timer keeps running.');
  });

  // Best-effort: if anything on this page (an injected extension script, say)
  // calls the screen-capture API, blank immediately. Can't see capture
  // started from OUTSIDE the page — no web API exposes that.
  try {
    const md = navigator.mediaDevices;
    if (md?.getDisplayMedia) {
      const original = md.getDisplayMedia.bind(md);
      md.getDisplayMedia = (...args) => {
        flashBlank(5000, 'Blocked', 'Screen capture was requested on this page.');
        return original(...args);
      };
    }
  } catch { /* ignore */ }

  // If the timer already ran out, make sure the server hears about it.
  window.addEventListener('pagehide', () => {
    if (!session || finished) return;
    pause('Paused', 'Tap to resume. The timer keeps running.');
    if (session.expiresAt - Date.now() > 0) return;
    try {
      navigator.sendBeacon?.('/api/expire', new Blob(
        [JSON.stringify({ id, token: session.token })],
        { type: 'application/json' },
      ));
    } catch { /* ignore */ }
  });
}

el.openBtn.addEventListener('click', openDoc);
el.pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDoc(); });

guard();
loadMeta();
