import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs?v=2';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs?v=2';

const LIMITS = {
  maxPages: 30,
  maxTotalBytes: 15 * 1024 * 1024,
  maxPageBytes: 1.5 * 1024 * 1024,
};
const STORE_KEY = 'vanishly.links.v1';

const $ = (id) => document.getElementById(id);
const el = {
  drop: $('drop'), file: $('file'),
  stepPick: $('step-pick'), stepOpts: $('step-options'),
  stepProg: $('step-progress'), stepDone: $('step-done'),
  fileInfo: $('file-info'), optError: $('opt-error'), pickError: $('pick-error'),
  go: $('go'), cancelPick: $('cancel-pick'), again: $('again'),
  password: $('password'), watermark: $('watermark'),
  progLabel: $('prog-label'), progPct: $('prog-pct'), progBar: $('prog-bar'), progNote: $('prog-note'),
  shareUrl: $('share-url'), copy: $('copy'), share: $('share'), delNow: $('del-now'),
  sheet: $('sheet'), sheetClose: $('sheet-close'), shareGrid: $('share-grid'),
  doneCopy: $('done-copy'), doneMsg: $('done-msg'),
  linksCard: $('links-card'), links: $('links'),
};

let picked = null;       // { file, pdf, pages }
let current = null;      // { id, ownerToken, url }

/* ------------------------------------------------------------------ utils */

function show(step) {
  for (const s of [el.stepPick, el.stepOpts, el.stepProg, el.stepDone]) s.hidden = true;
  step.hidden = false;
}

/** One place to ask whether the user wants motion. */
function reduceMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function radio(name) {
  const hit = document.querySelector(`input[name="${name}"]:checked`);
  return hit ? Number(hit.value) : null;
}

function error(msg) {
  el.optError.textContent = msg;
  el.optError.hidden = false;
}

/** Errors that happen before a file is accepted belong on the pick step. */
function pickError(msg) {
  el.pickError.textContent = msg;
  el.pickError.hidden = false;
  show(el.stepPick);
}

function clearError() {
  el.optError.hidden = true;
  el.optError.textContent = '';
  el.pickError.hidden = true;
  el.pickError.textContent = '';
}

function progress(pct, label) {
  el.progBar.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(0)}%`;
  el.progPct.textContent = `${Math.round(pct)}%`;
  if (label) el.progLabel.textContent = label;
}

async function api(path, { method = 'POST', json, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON (shouldn't happen) */ }
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.code = data?.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* --------------------------------------------------------------- picking */

async function pick(file) {
  clearError();
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    pickError('That file is not a PDF. Choose a .pdf file.');
    return;
  }

  show(el.stepProg);
  progress(4, 'Reading PDF…');

  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    if (pdf.numPages > LIMITS.maxPages) {
      picked = null;
      el.file.value = '';
      pickError(`This PDF has ${pdf.numPages} pages. The limit is ${LIMITS.maxPages}.`);
      return;
    }
    picked = { file, pdf, pages: pdf.numPages };
    el.fileInfo.textContent = `${file.name} · ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'} · ${fmtBytes(file.size)}`;
    show(el.stepOpts);
  } catch (err) {
    picked = null;
    el.file.value = '';
    el.fileInfo.textContent = '';
    pickError('That PDF could not be read. It may be corrupt or password-protected.');
  }
}

/* ------------------------------------------------------- page rasterising */

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { alpha: false });

async function rasterise(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  let scale = 1.5;
  let quality = 0.8;
  let blob = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // intent 'print' renders without requestAnimationFrame, which browsers
    // pause in background tabs: with 'display' the upload hangs on
    // "Rendering page 1" the moment the owner switches apps.
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('This browser could not export the page image.');
    if (blob.size <= LIMITS.maxPageBytes) break;

    // Too heavy for a single request — step down and try again.
    quality = Math.max(0.45, quality - 0.12);
    scale = Math.max(0.75, scale * 0.8);
  }

  page.cleanup();
  if (blob.size > LIMITS.maxPageBytes) {
    throw new Error(`Page ${pageNumber} is too dense to compress under 1.5 MB.`);
  }
  return blob;
}

/* ------------------------------------------------------------ the upload */

async function createLink() {
  if (!picked) return;
  clearError();
  el.go.disabled = true;

  const password = el.password.value.trim();
  if (password && password.length < 4) {
    el.go.disabled = false;
    error('A password needs at least 4 characters.');
    return;
  }

  show(el.stepProg);
  progress(2, 'Creating secure link…');

  let session = null;
  try {
    session = await api('/api/create', {
      json: {
        pages: picked.pages,
        expirySeconds: radio('expiry'),
        maxLifetimeSeconds: radio('life'),
        maxOpens: radio('opens'),
        password: password || undefined,
        watermark: el.watermark.value.trim() || undefined,
      },
    });

    let total = 0;
    for (let i = 1; i <= picked.pages; i += 1) {
      const base = ((i - 1) / picked.pages) * 94 + 3;
      progress(base, `Rendering page ${i} of ${picked.pages}…`);
      const blob = await rasterise(picked.pdf, i);

      total += blob.size;
      if (total > LIMITS.maxTotalBytes) {
        throw new Error(`This document is over the ${fmtBytes(LIMITS.maxTotalBytes)} limit. Try a shorter PDF.`);
      }

      progress(base + (94 / picked.pages) * 0.5, `Uploading page ${i} of ${picked.pages}…`);
      await api(`/api/upload-page?id=${encodeURIComponent(session.id)}&n=${i - 1}`, {
        body: blob,
        headers: { 'Content-Type': 'image/jpeg', 'X-Upload-Token': session.uploadToken },
      });
    }

    progress(98, 'Finishing…');
    await api('/api/finalize', { json: { id: session.id, uploadToken: session.uploadToken } });
    progress(100, 'Done');

    current = {
      id: session.id,
      ownerToken: session.ownerToken,
      url: `${location.origin}/v/${session.id}`,
      mins: Math.round(session.expirySeconds / 60),
    };

    remember({
      id: session.id,
      ownerToken: session.ownerToken,
      name: picked.file.name,
      pages: picked.pages,
      expirySeconds: session.expirySeconds,
      createdAt: Date.now(),
    });

    el.shareUrl.value = current.url;
    const mins = Math.round(session.expirySeconds / 60);
    el.doneCopy.textContent = `Link vanishes ${mins} minute${mins === 1 ? '' : 's'} after it is first opened${session.maxOpens === 1 ? ', and can be opened only once' : ''}.`;
    el.doneMsg.hidden = true;
    el.stepProg.classList.add('dissolving');
    setTimeout(() => el.stepProg.classList.remove('dissolving'), 600);
    show(el.stepDone);
    renderList();
  } catch (err) {
    // Leave nothing behind.
    if (session?.id) {
      try {
        // Also send ownerToken: if finalize actually succeeded server-side
        // and only the response was lost, the upload token is already dead.
        await api('/api/delete', { json: { id: session.id, uploadToken: session.uploadToken, ownerToken: session.ownerToken } });
      } catch { /* best effort */ }
    }
    show(el.stepOpts);
    error(err.message || 'Something went wrong. Please try again.');
  } finally {
    el.go.disabled = false;
  }
}


/* ------------------------------------------------------------ sharing */

function shareText() {
  const mins = current?.mins || 5;
  return `I've sent you a view-only document. It vanishes ${mins} minute${mins === 1 ? '' : 's'} after you open it.`;
}

/** Links for every option in the fallback sheet. */
function shareTargets(url, text) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  const both = encodeURIComponent(`${text} ${url}`);
  return {
    whatsapp: `https://wa.me/?text=${both}`,
    telegram: `https://t.me/share/url?url=${u}&text=${t}`,
    email: `mailto:?subject=${encodeURIComponent('A document for you')}&body=${both}`,
    sms: `sms:?&body=${both}`,
    x: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    reddit: `https://www.reddit.com/submit?url=${u}&title=${t}`,
  };
}

let toastTimer = null;
function toast(message) {
  document.getElementById('vp-toast')?.remove();
  const node = document.createElement('div');
  node.id = 'vp-toast';
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.textContent = message;
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2200);
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(el.shareUrl.value);
  } catch {
    el.shareUrl.select();
    document.execCommand?.('copy');
  }
  toast('Copied!');
}

/* --- fallback sheet: focus trap, Esc to close, focus returned on close --- */
let lastFocused = null;

function sheetFocusable() {
  return [...el.sheet.querySelectorAll('a[href], button:not([disabled])')]
    .filter((n) => n.offsetParent !== null);
}

function onSheetKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const items = sheetFocusable();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openSheet() {
  if (!current) return;
  const targets = shareTargets(current.url, shareText());
  for (const node of el.shareGrid.querySelectorAll('a[data-share]')) {
    const href = targets[node.dataset.share];
    if (href) node.href = href;
  }
  lastFocused = document.activeElement;
  el.sheet.hidden = false;
  document.addEventListener('keydown', onSheetKeydown);
  sheetFocusable()[0]?.focus();
}

function closeSheet() {
  el.sheet.hidden = true;
  document.removeEventListener('keydown', onSheetKeydown);
  lastFocused?.focus?.();
}

async function shareLink() {
  if (!current) return;
  const data = { title: 'A document for you', text: shareText(), url: current.url };
  // The OS sheet lists every installed app — always prefer it on mobile.
  if (navigator.share) {
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // user dismissed it
      // anything else: fall through to our own sheet
    }
  }
  openSheet();
}

/* ------------------------------------------------- local link bookkeeping */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function save(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* private mode */ }
}

function remember(entry) {
  const list = load();
  list.unshift({ ...entry, state: 'ready' });
  save(list);
}

function forget(id) {
  save(load().filter((x) => x.id !== id));
}

function pillFor(entry) {
  if (entry.state === 'expired') return { cls: 'dead', text: 'Expired' };
  if (entry.state === 'open' && entry.expiresAt) {
    const left = entry.expiresAt - Date.now();
    if (left <= 0) return { cls: 'dead', text: 'Expired' };
    return { cls: 'live', text: `Open · ${mmss(left)}` };
  }
  if (entry.state === 'ready') return { cls: 'waiting', text: 'Waiting' };
  return { cls: '', text: '…' };
}

function renderList() {
  const list = load();
  el.linksCard.hidden = list.length === 0;
  el.links.textContent = '';

  for (const entry of list) {
    const li = document.createElement('li');

    const main = document.createElement('div');
    main.className = 'l-main';
    const name = document.createElement('div');
    name.className = 'l-name';
    name.textContent = entry.name || 'Document';
    const meta = document.createElement('div');
    meta.className = 'tiny';
    meta.textContent = `${entry.pages} page${entry.pages === 1 ? '' : 's'} · /v/${entry.id}`;
    main.append(name, meta);

    const { cls, text } = pillFor(entry);
    const pill = document.createElement('span');
    pill.className = `pill ${cls}`;
    pill.textContent = text;

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'btn sm danger';
    kill.textContent = entry.state === 'expired' ? 'Clear' : 'Delete';
    kill.addEventListener('click', async () => {
      kill.disabled = true;
      if (entry.state !== 'expired') {
        try { await api('/api/delete', { json: { id: entry.id, ownerToken: entry.ownerToken } }); } catch { /* ignore */ }
      }
      // Let the row come apart before it goes, like everything else here.
      li.classList.add('dissolving');
      const gone = () => { forget(entry.id); renderList(); };
      if (reduceMotion()) gone(); else setTimeout(gone, 420);
    });

    li.append(main, pill, kill);
    el.links.append(li);
  }
}

async function refreshStatuses() {
  const list = load();
  if (!list.length) return;
  let changed = false;
  for (const entry of list) {
    if (entry.state === 'expired') continue; // dead links never come back
    try {
      const meta = await fetch(`/api/meta?id=${encodeURIComponent(entry.id)}`, { cache: 'no-store' }).then((r) => r.json());
      const next = meta.status === 'open' ? 'open' : meta.status === 'ready' ? 'ready' : 'expired';
      if (entry.state !== next || entry.expiresAt !== meta.expiresAt) changed = true;
      entry.state = next;
      entry.expiresAt = meta.expiresAt || null;
    } catch { /* offline — keep the last known state */ }
  }
  if (changed) save(list);
  renderList();
}

/* ------------------------------------------------------------ wiring up */

el.drop.addEventListener('click', () => el.file.click());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); }
});
el.file.addEventListener('change', () => pick(el.file.files?.[0]));

for (const type of ['dragenter', 'dragover']) {
  el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add('hot'); });
}
for (const type of ['dragleave', 'drop']) {
  el.drop.addEventListener(type, () => el.drop.classList.remove('hot'));
}
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const icon = el.drop.querySelector('.drop-icon');
  if (icon) {
    icon.classList.remove('bounce');
    void icon.offsetWidth;        // restart the animation on a repeat drop
    icon.classList.add('bounce');
  }
  pick(e.dataTransfer?.files?.[0]);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

el.go.addEventListener('click', createLink);
el.cancelPick.addEventListener('click', () => {
  picked = null;
  el.file.value = '';
  clearError();
  show(el.stepPick);
});
el.again.addEventListener('click', () => {
  picked = null;
  current = null;
  el.file.value = '';
  el.password.value = '';
  el.watermark.value = '';
  el.share.disabled = false;
  clearError();
  show(el.stepPick);
});

el.copy.addEventListener('click', async () => {
  await copyLink();
  el.copy.textContent = '\u2713 Copied';
  el.copy.classList.add('copy-ok');
  setTimeout(() => { el.copy.textContent = 'Copy'; el.copy.classList.remove('copy-ok'); }, 1600);
});

el.share.addEventListener('click', shareLink);
el.sheetClose.addEventListener('click', closeSheet);
el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });
el.shareGrid.addEventListener('click', async (e) => {
  const opt = e.target.closest?.('[data-share]');
  if (!opt) return;
  if (opt.dataset.share === 'copy') { await copyLink(); return; }
  closeSheet();
});

el.delNow.addEventListener('click', async () => {
  if (!current) return;
  el.delNow.disabled = true;
  try {
    await api('/api/delete', { json: { id: current.id, ownerToken: current.ownerToken } });
    forget(current.id);
    el.doneMsg.textContent = 'Deleted. That link will never open again.';
    el.doneMsg.hidden = false;
    el.copy.disabled = true;
    el.share.disabled = true;
    renderList();
  } catch {
    el.doneMsg.textContent = 'Could not delete right now — it will still expire on its own.';
    el.doneMsg.hidden = false;
  } finally {
    el.delNow.disabled = false;
  }
});

renderList();
refreshStatuses();
setInterval(renderList, 1000);
setInterval(() => { if (!document.hidden) refreshStatuses(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatuses(); });
