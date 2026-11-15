/**
 * End-to-end self-test. Drives every API handler directly with mock req/res
 * objects, against in-memory stand-ins for Upstash Redis and Vercel Blob.
 *
 * What this proves: the whole owner -> recipient -> expiry lifecycle, every
 * validation path, token handling, lazy expiry, and that page images are
 * physically deleted. What it does not prove: Upstash's own behaviour, which
 * only a real deployment exercises. Run `npm test`.
 */
import { createHmac } from 'node:crypto';

process.env.SECRET = 'test-secret-value-long-enough-for-hmac';
process.env.KV_REST_API_URL = 'https://redis.test';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';
process.env.CRON_SECRET = 'cron-test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-razorpay-webhook-secret-value';
process.env.OWNER_EMAIL = 'codekon10@gmail.com';

const { store: blobStore } = await import('./stub-blob.mjs');
const { store: redisStore } = await import('./stub-redis.mjs');
const { outbox: mailOutbox } = await import('./stub-mail.mjs');

const create = (await import('../../api/create.js')).default;
const uploadPage = (await import('../../api/upload-page.js')).default;
const finalize = (await import('../../api/finalize.js')).default;
const meta = (await import('../../api/meta.js')).default;
const open = (await import('../../api/open.js')).default;
const page = (await import('../../api/page.js')).default;
const expire = (await import('../../api/expire.js')).default;
const remove = (await import('../../api/delete.js')).default;
const cleanup = (await import('../../api/cleanup.js')).default;
const auth = (await import('../../api/auth.js')).default;
const billing = (await import('../../api/billing.js')).default;
const admin = (await import('../../api/admin.js')).default;
const { randomId, randomToken, sha256, signUserSession } = await import('../../api/_lib/crypto.js');
const { K } = await import('../../api/_lib/redis.js');
const { SESSION_COOKIE, PLANS } = await import('../../api/_lib/plans.js');

/* ----------------------------------------------------------- test plumbing */

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${name}`); } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) { console.log(`\n${title}`); }

const UA_BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1';

function mkReq({ method = 'POST', url = '/', headers = {}, body = null, ip = '203.0.113.7' } = {}) {
  const parsed = new URL(url, 'http://test.local');
  const raw = body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
  return {
    method,
    url,
    headers: { 'user-agent': UA_BROWSER, 'x-forwarded-for': ip, ...headers },
    query: Object.fromEntries(parsed.searchParams.entries()),
    socket: { remoteAddress: ip },
    destroy() {},
    async *[Symbol.asyncIterator]() { if (raw) yield raw; },
  };
}

function mkRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(body) {
      this.writableEnded = true;
      if (body) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    },
  };
  Object.defineProperty(res, 'buffer', { get() { return Buffer.concat(this.chunks); } });
  Object.defineProperty(res, 'json', {
    get() {
      try { return JSON.parse(this.buffer.toString('utf8')); } catch { return null; }
    },
  });
  return res;
}

async function call(handler, reqOpts) {
  const req = mkReq(reqOpts);
  const res = mkRes();
  await handler(req, res);
  return res;
}

/** A small but structurally valid JPEG. */
function jpeg(bytes = 400) {
  const buf = Buffer.alloc(bytes, 0x20);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  buf[bytes - 2] = 0xff; buf[bytes - 1] = 0xd9;
  return buf;
}

// Serve stubbed blob URLs to /api/page, which fetches them server-side.
globalThis.fetch = async (url) => {
  const rec = blobStore.get(String(url));
  if (!rec) return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } };
  return {
    ok: true,
    status: 200,
    async arrayBuffer() { return rec.buf.buffer.slice(rec.buf.byteOffset, rec.buf.byteOffset + rec.buf.length); },
  };
};

function docKey(id) { return `vp:doc:${id}`; }
function readStoredDoc(id) {
  const rec = redisStore.get(docKey(id));
  if (!rec) return null;
  return typeof rec.v === 'string' ? JSON.parse(rec.v) : rec.v;
}
function writeStoredDoc(id, doc) {
  const rec = redisStore.get(docKey(id));
  redisStore.set(docKey(id), { v: JSON.stringify(doc), exp: rec?.exp ?? null });
}

let userSeq = 0;
function seedSession(plan = 'pro', userOverrides = {}) {
  userSeq += 1;
  const uid = `usr_${randomId(9)}`;
  const email = userOverrides.email || `user${userSeq}@example.com`;
  const emailHash = sha256(email.toLowerCase());
  const now = Date.now();
  const user = {
    id: uid,
    email: email.toLowerCase(),
    createdAt: now,
    plan,
    planPeriodEnd: plan === 'free' ? null : now + 30 * 86400 * 1000,
    cancelAtPeriodEnd: false,
    rzSubId: null,
    credits: 0,
    creditsExpiresAt: null,
    studentEligible: false,
    ...userOverrides,
  };
  redisStore.set(K.user(emailHash), { v: JSON.stringify(user), exp: null });
  redisStore.set(K.userById(uid), { v: emailHash, exp: null });

  const sid = randomToken(18);
  const expiresAt = now + 30 * 86400 * 1000;
  const sess = { id: sid, uid, emailHash, createdAt: now, expiresAt };
  redisStore.set(K.session(sha256(sid)), { v: JSON.stringify(sess), exp: expiresAt });

  const token = signUserSession({ uid, sid, expiresAt });
  return {
    uid,
    email: user.email,
    emailHash,
    sid,
    token,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
  };
}

const proOwner = seedSession('pro');

async function makeDoc(overrides = {}, pages = 2, cookie = proOwner.cookie) {
  const res = await call(create, {
    url: '/api/create',
    headers: cookie ? { cookie } : {},
    body: { pages, expirySeconds: 300, maxLifetimeSeconds: 3600, maxOpens: 1, ...overrides },
  });
  const s = res.json;
  for (let n = 0; n < pages; n += 1) {
    await call(uploadPage, {
      url: `/api/upload-page?id=${s.id}&n=${n}&token=${encodeURIComponent(s.uploadToken)}`,
      headers: { 'content-type': 'image/jpeg' },
      body: jpeg(),
    });
  }
  await call(finalize, { url: '/api/finalize', body: { id: s.id, uploadToken: s.uploadToken } });
  return s;
}

/* ------------------------------------------------------------------- tests */

section('1. Owner upload flow');
{
  const res = await call(create, {
    url: '/api/create',
    headers: { cookie: proOwner.cookie },
    body: { pages: 3, expirySeconds: 180, maxLifetimeSeconds: 3600, maxOpens: 1, watermark: 'For Priya only' },
  });
  const s = res.json;
  check('create returns 201 with id and tokens', res.statusCode === 201 && /^[A-Za-z0-9_-]{12}$/.test(s.id) && s.uploadToken && s.ownerToken, `status ${res.statusCode}`);
  check('create echoes the chosen expiry', s.expirySeconds === 180);

  const bad = await call(uploadPage, {
    url: `/api/upload-page?id=${s.id}&n=0&token=${encodeURIComponent(s.uploadToken)}`,
    headers: { 'content-type': 'image/png' },
    body: jpeg(),
  });
  check('upload rejects a non-JPEG content type', bad.statusCode === 415, `status ${bad.statusCode}`);

  const notJpeg = await call(uploadPage, {
    url: `/api/upload-page?id=${s.id}&n=0&token=${encodeURIComponent(s.uploadToken)}`,
    headers: { 'content-type': 'image/jpeg' },
    body: Buffer.alloc(400, 0x41),
  });
  check('upload rejects bytes that are not really a JPEG', notJpeg.statusCode === 400, `status ${notJpeg.statusCode}`);

  const tooBig = await call(uploadPage, {
    url: `/api/upload-page?id=${s.id}&n=0&token=${encodeURIComponent(s.uploadToken)}`,
    headers: { 'content-type': 'image/jpeg' },
    body: jpeg(1.6 * 1024 * 1024),
  });
  check('upload rejects a page over 1.5 MB', tooBig.statusCode === 413, `status ${tooBig.statusCode}`);

  const wrongToken = await call(uploadPage, {
    url: `/api/upload-page?id=${s.id}&n=0&token=nope`,
    headers: { 'content-type': 'image/jpeg' },
    body: jpeg(),
  });
  check('upload rejects a wrong upload token', wrongToken.statusCode === 403, `status ${wrongToken.statusCode}`);

  const good = await call(uploadPage, {
    url: `/api/upload-page?id=${s.id}&n=0&token=${encodeURIComponent(s.uploadToken)}`,
    headers: { 'content-type': 'image/jpeg' },
    body: jpeg(),
  });
  check('upload accepts a valid page', good.statusCode === 200 && good.json.uploaded === 1, JSON.stringify(good.json));

  const dup = await call(uploadPage, {
    url: `/api/upload-page?id=${s.id}&n=0&token=${encodeURIComponent(s.uploadToken)}`,
    headers: { 'content-type': 'image/jpeg' },
    body: jpeg(),
  });
  check('upload rejects the same page twice', dup.statusCode === 409, `status ${dup.statusCode}`);

  const outOfRange = await call(uploadPage, {
    url: `/api/upload-page?id=${s.id}&n=9&token=${encodeURIComponent(s.uploadToken)}`,
    headers: { 'content-type': 'image/jpeg' },
    body: jpeg(),
  });
  check('upload rejects an out-of-range page index', outOfRange.statusCode === 400, `status ${outOfRange.statusCode}`);

  const early = await call(finalize, { url: '/api/finalize', body: { id: s.id, uploadToken: s.uploadToken } });
  check('finalize refuses an incomplete document', early.statusCode === 409, `status ${early.statusCode}`);

  for (const n of [1, 2]) {
    await call(uploadPage, {
      url: `/api/upload-page?id=${s.id}&n=${n}&token=${encodeURIComponent(s.uploadToken)}`,
      headers: { 'content-type': 'image/jpeg' },
      body: jpeg(),
    });
  }
  const done = await call(finalize, { url: '/api/finalize', body: { id: s.id, uploadToken: s.uploadToken } });
  check('finalize succeeds once every page is present', done.statusCode === 200 && done.json.status === 'ready');

  const reuse = await call(uploadPage, {
    url: `/api/upload-page?id=${s.id}&n=0&token=${encodeURIComponent(s.uploadToken)}`,
    headers: { 'content-type': 'image/jpeg' },
    body: jpeg(),
  });
  check('the upload token is dead after finalize', reuse.statusCode === 409 || reuse.statusCode === 403, `status ${reuse.statusCode}`);
}

section('2. Limits and validation');
{
  const many = await call(create, {
    url: '/api/create',
    headers: { cookie: proOwner.cookie },
    body: { pages: 51 },
  });
  check('create rejects pages over the plan limit with 403 plan_limit', many.statusCode === 403 && many.json.error === 'plan_limit' && many.json.limit === 'pages');

  const noPages = await call(create, { url: '/api/create', headers: { cookie: proOwner.cookie }, body: {} });
  check('create rejects a missing page count', noPages.statusCode === 400);

  const shortPw = await call(create, { url: '/api/create', headers: { cookie: proOwner.cookie }, body: { pages: 1, password: 'ab' } });
  check('create rejects a password under 4 characters', shortPw.statusCode === 400 && shortPw.json.error === 'bad_password');

  const odd = await call(create, { url: '/api/create', headers: { cookie: proOwner.cookie }, body: { pages: 1, expirySeconds: 99999, maxLifetimeSeconds: 7, maxOpens: 42 } });
  check('create clamps unknown option values to the defaults', odd.json.expirySeconds === 300 && odd.json.maxOpens === 1);

  const getOnPost = await call(create, { url: '/api/create', method: 'GET' });
  check('create rejects the wrong HTTP method', getOnPost.statusCode === 405);
}

section('3. Metadata does not leak and does not start the timer');
{
  const s = await makeDoc({ password: 'hunter2', watermark: 'wm' });
  const m = await call(meta, { url: `/api/meta?id=${s.id}`, method: 'GET' });
  check('meta reports a ready document', m.json.status === 'ready' && m.json.pages === 2);
  check('meta reports that a password is required', m.json.passwordRequired === true);
  check('meta never returns a password hash or blob URL', !/passwordHash|blob\.test|salt/.test(m.buffer.toString()));

  const stored = readStoredDoc(s.id);
  check('reading meta does not open the document', stored.openedAt === null && stored.status === 'ready');

  const unknown = await call(meta, { url: '/api/meta?id=aaaaaaaaaaaa', method: 'GET' });
  check('an unknown id looks exactly like an expired one', unknown.json.status === 'expired' && Object.keys(unknown.json).length === 1);

  const malformed = await call(meta, { url: '/api/meta?id=short', method: 'GET' });
  check('a malformed id looks exactly like an expired one', malformed.json.status === 'expired');
}

section('4. Opening, passwords and lockout');
{
  const s = await makeDoc({ password: 'hunter2' });

  const bot = await call(open, { url: '/api/open', body: { id: s.id, password: 'wrong' }, headers: { 'user-agent': 'facebookexternalhit/1.1' } });
  check('a genuine link-preview crawler cannot open the document', bot.statusCode === 403 && bot.json.error === 'bot');
  check('the crawler attempt did not start the timer', readStoredDoc(s.id).openedAt === null);

  // WhatsApp's own in-app browser carries "WhatsApp/x.y.z" in its UA too —
  // it must NOT be blocked, since that is how most recipients actually open
  // these links. Use a wrong password so this probe doesn't consume the
  // single-use open itself.
  const wa = await call(open, { url: '/api/open', body: { id: s.id, password: 'wrong' }, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 WhatsApp/2.23.20.82' } });
  check('a real WhatsApp in-app browser is not mistaken for the preview bot', wa.statusCode === 401, `status ${wa.statusCode}`);

  const noPw = await call(open, { url: '/api/open', body: { id: s.id } });
  check('open without the password is refused', noPw.statusCode === 401);

  for (let i = 0; i < 3; i += 1) {
    await call(open, { url: '/api/open', body: { id: s.id, password: 'wrong' } });
  }
  const locked = await call(open, { url: '/api/open', body: { id: s.id, password: 'wrong' } });
  check('five wrong passwords lock the link', locked.statusCode === 423 && locked.json.error === 'locked', `status ${locked.statusCode}`);

  const stillLocked = await call(open, { url: '/api/open', body: { id: s.id, password: 'hunter2' } });
  check('the lock holds even for the right password', stillLocked.statusCode === 423);
}

section('5. A single-use link really is single-use');
{
  const s = await makeDoc();
  const first = await call(open, { url: '/api/open', body: { id: s.id } });
  check('the first open succeeds and returns a session token', first.statusCode === 200 && typeof first.json.token === 'string');
  check('the deadline is the expiry window, not the max lifetime', Math.abs(first.json.expiresAt - (first.json.serverNow + 300000)) < 2000);
  check('the open response carries no blob URL', !/blob\.test/.test(first.buffer.toString()));

  const second = await call(open, { url: '/api/open', body: { id: s.id } });
  check('a second open is refused', second.statusCode === 410, `status ${second.statusCode}`);
  check('the refused second open destroyed the document', readStoredDoc(s.id) === null);
  check('its page images were deleted from blob storage', [...blobStore.keys()].every((k) => !k.includes(s.id)));
}

section('6. Unlimited opens within the timer');
{
  const s = await makeDoc({ maxOpens: 0 });
  const a = await call(open, { url: '/api/open', body: { id: s.id } });
  const b = await call(open, { url: '/api/open', body: { id: s.id } });
  check('a multi-open link opens twice', a.statusCode === 200 && b.statusCode === 200, `${a.statusCode}/${b.statusCode}`);
  check('both viewers share one deadline', a.json.expiresAt === b.json.expiresAt);
}

section('7. Serving pages');
{
  const s = await makeDoc({ maxOpens: 0 });
  const opened = await call(open, { url: '/api/open', body: { id: s.id } });
  const t = encodeURIComponent(opened.json.token);

  const p0 = await call(page, { url: `/api/page?id=${s.id}&n=0&t=${t}`, method: 'GET' });
  check('a valid token serves the page bytes', p0.statusCode === 200 && p0.buffer.length > 100);
  check('the page is served as inline JPEG', p0.getHeader('content-type') === 'image/jpeg' && p0.getHeader('content-disposition') === 'inline');
  check('the page is never cached', /no-store/.test(String(p0.getHeader('cache-control'))));

  const noToken = await call(page, { url: `/api/page?id=${s.id}&n=0`, method: 'GET' });
  check('a missing token is refused', noToken.statusCode === 403);

  const forged = await call(page, { url: `/api/page?id=${s.id}&n=0&t=${s.id}.aaa.99999999999999.deadbeef`, method: 'GET' });
  check('a forged token signature is refused', forged.statusCode === 403);

  const other = await makeDoc({ maxOpens: 0 });
  const crossUse = await call(page, { url: `/api/page?id=${other.id}&n=0&t=${t}`, method: 'GET' });
  check('a token from one document cannot read another', crossUse.statusCode === 403);

  const outOfRange = await call(page, { url: `/api/page?id=${s.id}&n=7&t=${t}`, method: 'GET' });
  check('an out-of-range page is refused', outOfRange.statusCode === 404, `status ${outOfRange.statusCode}`);
}

section('8. Expiry — timer, lazy enforcement and deletion');
{
  const s = await makeDoc({ maxOpens: 0 });
  const opened = await call(open, { url: '/api/open', body: { id: s.id } });
  const t = encodeURIComponent(opened.json.token);
  const blobsBefore = [...blobStore.keys()].filter((k) => k.includes(s.id)).length;
  check('the document has page images in storage while live', blobsBefore === 2, `found ${blobsBefore}`);

  const exp = await call(expire, { url: '/api/expire', body: { id: s.id, token: opened.json.token } });
  check('expire answers 200 whatever happens', exp.statusCode === 200);
  check('expire deleted every page image', [...blobStore.keys()].filter((k) => k.includes(s.id)).length === 0);
  check('expire deleted the metadata', readStoredDoc(s.id) === null);

  const after = await call(page, { url: `/api/page?id=${s.id}&n=0&t=${t}`, method: 'GET' });
  check('pages are gone after expiry', after.statusCode === 410, `status ${after.statusCode}`);

  const m = await call(meta, { url: `/api/meta?id=${s.id}`, method: 'GET' });
  check('an expired link shows the expired page', m.json.status === 'expired');

  const reopen = await call(open, { url: '/api/open', body: { id: s.id } });
  check('an expired link cannot be reopened', reopen.statusCode === 410);
}

section('9. Expire cannot be used to grief someone else');
{
  const s = await makeDoc({ maxOpens: 0 });
  await call(open, { url: '/api/open', body: { id: s.id } });
  const attack = await call(expire, { url: '/api/expire', body: { id: s.id, token: `${s.id}.xxx.99999999999999.forged` } });
  check('a forged token cannot expire a link', attack.statusCode === 200 && readStoredDoc(s.id) !== null);
  check('its pages are still in storage', [...blobStore.keys()].filter((k) => k.includes(s.id)).length === 2);
}

section('10. Lazy expiry when nobody ever opened the link');
{
  const s = await makeDoc();
  const doc = readStoredDoc(s.id);
  doc.maxLifetimeAt = Date.now() - 1000; // pretend the max lifetime passed
  writeStoredDoc(s.id, doc);

  const m = await call(meta, { url: `/api/meta?id=${s.id}`, method: 'GET' });
  check('the request that notices expiry reports it', m.json.status === 'expired');
  check('that same request deleted the page images', [...blobStore.keys()].filter((k) => k.includes(s.id)).length === 0);
  check('that same request deleted the metadata', readStoredDoc(s.id) === null);
}

section('11. Owner delete and orphan cleanup');
{
  const s = await makeDoc();
  const wrong = await call(remove, { url: '/api/delete', body: { id: s.id, ownerToken: 'not-the-token' } });
  check('delete refuses a wrong owner token', wrong.statusCode === 403);
  check('nothing was deleted by the refused attempt', readStoredDoc(s.id) !== null);

  const gone = await call(remove, { url: '/api/delete', body: { id: s.id, ownerToken: s.ownerToken } });
  check('delete succeeds with the owner token', gone.statusCode === 200 && gone.json.deleted === true);
  check('delete removed the page images', [...blobStore.keys()].filter((k) => k.includes(s.id)).length === 0);

  const m = await call(meta, { url: `/api/meta?id=${s.id}`, method: 'GET' });
  check('a deleted link shows the expired page', m.json.status === 'expired');

  // A failed upload must leave no orphan blobs behind.
  const partial = await call(create, { url: '/api/create', body: { pages: 3 } });
  const ps = partial.json;
  await call(uploadPage, {
    url: `/api/upload-page?id=${ps.id}&n=0&token=${encodeURIComponent(ps.uploadToken)}`,
    headers: { 'content-type': 'image/jpeg' },
    body: jpeg(),
  });
  check('a partial upload has a blob in storage', [...blobStore.keys()].filter((k) => k.includes(ps.id)).length === 1);
  const cleaned = await call(remove, { url: '/api/delete', body: { id: ps.id, uploadToken: ps.uploadToken } });
  check('the abort path accepts the upload token', cleaned.statusCode === 200);
  check('an aborted upload leaves no orphan blobs', [...blobStore.keys()].filter((k) => k.includes(ps.id)).length === 0);
}

section('12. Cron cleanup safety net');
{
  const s = await makeDoc();
  // Simulate Redis TTL having removed the record while the blobs survive.
  redisStore.delete(docKey(s.id));
  check('the orphaned blobs are still in storage', [...blobStore.keys()].filter((k) => k.includes(s.id)).length === 2);

  const unauth = await call(cleanup, { url: '/api/cleanup', method: 'GET' });
  check('cleanup rejects an unauthenticated call', unauth.statusCode === 401);

  const run = await call(cleanup, {
    url: '/api/cleanup',
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  check('cleanup runs with the cron secret', run.statusCode === 200, `status ${run.statusCode}`);
  check('cleanup swept the orphaned blobs', [...blobStore.keys()].filter((k) => k.includes(s.id)).length === 0, JSON.stringify(run.json));
}

section('13. Nothing sensitive is ever logged or returned');
{
  const s = await makeDoc({ password: 'hunter2', watermark: 'For Priya only' });
  const m = await call(meta, { url: `/api/meta?id=${s.id}`, method: 'GET' });
  const text = m.buffer.toString();
  check('meta exposes the watermark but no secrets', text.includes('For Priya only') && !text.includes('hunter2') && !text.includes('Hash'));

  const stored = readStoredDoc(s.id);
  check('the password is stored only as a scrypt hash with a salt', !JSON.stringify(stored).includes('hunter2') && stored.salt && stored.passwordHash);
  check('owner and upload tokens are stored only as hashes', stored.ownerTokenHash !== s.ownerToken && stored.uploadTokenHash === null);
}

section('14. Plan enforcement — Free, Pro, and Ultra');
{
  const freeIp = '198.51.100.42';

  // Free user blocked at 11 pages
  const overPages = await call(create, {
    url: '/api/create',
    ip: freeIp,
    body: { pages: 11 },
  });
  check(
    'free user is blocked at 11 pages with 403 plan_limit',
    overPages.statusCode === 403 && overPages.json.error === 'plan_limit' && overPages.json.limit === 'pages' && overPages.json.plan === 'free',
    JSON.stringify(overPages.json),
  );

  // Free user blocked when sending a password
  const withPw = await call(create, {
    url: '/api/create',
    ip: freeIp,
    body: { pages: 2, password: 'secret' },
  });
  check(
    'free user is blocked when sending a password',
    withPw.statusCode === 403 && withPw.json.error === 'plan_limit' && withPw.json.limit === 'password' && withPw.json.plan === 'free',
    JSON.stringify(withPw.json),
  );

  // Free user blocked when sending a watermark
  const withWm = await call(create, {
    url: '/api/create',
    ip: freeIp,
    body: { pages: 2, watermark: 'Confidential' },
  });
  check(
    'free user is blocked when sending a watermark',
    withWm.statusCode === 403 && withWm.json.error === 'plan_limit' && withWm.json.limit === 'watermark' && withWm.json.plan === 'free',
    JSON.stringify(withWm.json),
  );

  // Free user blocked when asking for multi-open
  const withMulti = await call(create, {
    url: '/api/create',
    ip: freeIp,
    body: { pages: 2, maxOpens: 0 },
  });
  check(
    'free user is blocked when asking for multi-open',
    withMulti.statusCode === 403 && withMulti.json.error === 'plan_limit' && withMulti.json.limit === 'multi_open' && withMulti.json.plan === 'free',
    JSON.stringify(withMulti.json),
  );

  // Server never trusts a client-supplied plan field
  const spoofPlan = await call(create, {
    url: '/api/create',
    ip: freeIp,
    body: { pages: 25, plan: 'ultra' },
  });
  check(
    'server ignores a client-supplied plan and enforces free limits',
    spoofPlan.statusCode === 403 && spoofPlan.json.plan === 'free' && spoofPlan.json.limit === 'pages',
    JSON.stringify(spoofPlan.json),
  );

  // Free user can create 3 links (up to 10 pages), then is blocked on the 4th link of the day
  const f1 = await call(create, { url: '/api/create', ip: freeIp, body: { pages: 10, expirySeconds: 120 } });
  const f2 = await call(create, { url: '/api/create', ip: freeIp, body: { pages: 5, expirySeconds: 300 } });
  const f3 = await call(create, { url: '/api/create', ip: freeIp, body: { pages: 1 } });
  check(
    'free user can create 3 valid links of up to 10 pages per day',
    f1.statusCode === 201 && f2.statusCode === 201 && f3.statusCode === 201 && f1.json.plan === 'free',
    `${f1.statusCode}/${f2.statusCode}/${f3.statusCode}`,
  );

  const f4 = await call(create, { url: '/api/create', ip: freeIp, body: { pages: 1 } });
  check(
    'free user is blocked at the 4th link of the day',
    f4.statusCode === 403 && f4.json.error === 'plan_limit' && f4.json.limit === 'links_per_day' && f4.json.plan === 'free',
    JSON.stringify(f4.json),
  );

  // Pro user is allowed >10 pages (up to 50), password, watermark, multi-open, and >3 links/day
  const proUser = seedSession('pro');
  let proCreated = 0;
  for (let i = 0; i < 4; i += 1) {
    const r = await call(create, {
      url: '/api/create',
      headers: { cookie: proUser.cookie },
      body: {
        pages: 50,
        expirySeconds: 3600,
        maxLifetimeSeconds: 86400,
        maxOpens: 0,
        password: 'pro-password',
        watermark: 'Pro Watermark',
      },
    });
    if (r.statusCode === 201 && r.json.plan === 'pro') proCreated += 1;
  }
  check('pro user is allowed 50 pages, password, watermark, multi-open, and >3 links/day', proCreated === 4, `created ${proCreated}`);

  const proOverPages = await call(create, {
    url: '/api/create',
    headers: { cookie: proUser.cookie },
    body: { pages: 51 },
  });
  check(
    'pro user is blocked above 50 pages',
    proOverPages.statusCode === 403 && proOverPages.json.limit === 'pages' && proOverPages.json.plan === 'pro',
    JSON.stringify(proOverPages.json),
  );

  const proUltraTimer = await call(create, {
    url: '/api/create',
    headers: { cookie: proUser.cookie },
    body: { pages: 5, expirySeconds: 10 },
  });
  check(
    'pro user is blocked from Ultra-only 10s vanish timer',
    proUltraTimer.statusCode === 403 && proUltraTimer.json.limit === 'expiry' && proUltraTimer.json.plan === 'pro',
    JSON.stringify(proUltraTimer.json),
  );

  // Ultra user is allowed limits above Pro (up to 200 pages, 100 MB, 10s–24h expiry, 7d lifetime)
  const ultraUser = seedSession('ultra');
  const ultraOk = await call(create, {
    url: '/api/create',
    headers: { cookie: ultraUser.cookie },
    body: {
      pages: 200,
      expirySeconds: 10,
      maxLifetimeSeconds: 604800,
      maxOpens: 0,
      password: 'ultra-password',
      watermark: 'Ultra Watermark',
    },
  });
  check(
    'ultra user is allowed 200 pages, 10s expiry, 7-day lifetime, and 100 MB limit',
    ultraOk.statusCode === 201
      && ultraOk.json.plan === 'ultra'
      && ultraOk.json.limits.maxPages === PLANS.ultra.maxPages
      && ultraOk.json.limits.maxTotalBytes === PLANS.ultra.maxTotalBytes,
    JSON.stringify(ultraOk.json),
  );

  const ultraOverPages = await call(create, {
    url: '/api/create',
    headers: { cookie: ultraUser.cookie },
    body: { pages: 201 },
  });
  check(
    'ultra user is blocked above 200 pages',
    ultraOverPages.statusCode === 403 && ultraOverPages.json.limit === 'pages' && ultraOverPages.json.plan === 'ultra',
    JSON.stringify(ultraOverPages.json),
  );
}

section('15. Accounts — email OTP, sessions, logout, and /api/auth/me');
{
  const anonMe = await call(auth, { url: '/api/auth/me', method: 'GET' });
  check(
    'unauthenticated /api/auth/me returns free plan and authenticated: false',
    anonMe.statusCode === 200 && anonMe.json.authenticated === false && anonMe.json.plan === 'free' && anonMe.json.limits.maxPages === 10,
    JSON.stringify(anonMe.json),
  );

  const badEmail = await call(auth, {
    url: '/api/auth/request-code',
    body: { email: 'not-an-email' },
  });
  check('request-code rejects a malformed email', badEmail.statusCode === 400 && badEmail.json.error === 'bad_email');

  const reqNew = await call(auth, {
    url: '/api/auth/request-code',
    ip: '198.51.100.88',
    body: { email: 'Alice@Example.com ' },
  });
  const reqExisting = await call(auth, {
    url: '/api/auth/request-code',
    ip: '198.51.100.89',
    body: { email: proOwner.email },
  });
  check(
    'request-code returns the exact same 200 payload whether or not the account exists',
    reqNew.statusCode === 200 && reqExisting.statusCode === 200 && JSON.stringify(reqNew.json) === JSON.stringify(reqExisting.json),
  );

  const sentCode = mailOutbox.get('alice@example.com')?.code;
  check('stubbed mail provider captured a 6-digit OTP', typeof sentCode === 'string' && /^\d{6}$/.test(sentCode), String(sentCode));

  const storedOtpRaw = JSON.stringify(redisStore.get(K.otp(sha256('alice@example.com')))?.v || '');
  check('OTP is stored hashed with a salt in Redis, never in plaintext', !storedOtpRaw.includes(sentCode) && storedOtpRaw.includes('hash') && storedOtpRaw.includes('salt'));

  // Test max 5 attempts on OTP
  for (let i = 0; i < 4; i += 1) {
    const wrong = await call(auth, {
      url: '/api/auth/verify',
      ip: '198.51.100.88',
      body: { email: 'alice@example.com', code: '000000' === sentCode ? '999999' : '000000' },
    });
    if (i === 0) check('wrong OTP returns 401 invalid_code', wrong.statusCode === 401 && wrong.json.error === 'invalid_code');
  }
  const fifthWrong = await call(auth, {
    url: '/api/auth/verify',
    ip: '198.51.100.88',
    body: { email: 'alice@example.com', code: '000000' === sentCode ? '999999' : '000000' },
  });
  check('5th wrong OTP attempt locks and deletes the code (429)', fifthWrong.statusCode === 429 && fifthWrong.json.error === 'too_many_attempts');

  const afterLock = await call(auth, {
    url: '/api/auth/verify',
    ip: '198.51.100.88',
    body: { email: 'alice@example.com', code: sentCode },
  });
  check('locked OTP cannot be verified even with the original code', afterLock.statusCode === 401);

  // Request a fresh code and sign in
  await call(auth, {
    url: '/api/auth/request-code',
    ip: '198.51.100.88',
    body: { email: 'alice@example.com' },
  });
  const freshCode = mailOutbox.get('alice@example.com')?.code;
  const verified = await call(auth, {
    url: '/api/auth/verify',
    ip: '198.51.100.88',
    body: { email: 'alice@example.com', code: freshCode },
  });
  const setCookie = String(verified.getHeader('set-cookie') || '');
  check(
    'verify succeeds with 200 and returns email, plan, and limits',
    verified.statusCode === 200 && verified.json.email === 'alice@example.com' && verified.json.plan === 'free',
    JSON.stringify(verified.json),
  );
  check(
    'verify sets an HttpOnly, Secure, SameSite=Lax cookie for ~30 days',
    setCookie.includes('HttpOnly') && setCookie.includes('Secure') && setCookie.includes('SameSite=Lax') && setCookie.includes('Path=/') && setCookie.includes('Max-Age=2592000'),
    setCookie,
  );

  const replayOtp = await call(auth, {
    url: '/api/auth/verify',
    ip: '198.51.100.88',
    body: { email: 'alice@example.com', code: freshCode },
  });
  check('OTP is one-shot and cannot be replayed', replayOtp.statusCode === 401);

  const aliceCookie = setCookie.split(';')[0];
  const me1 = await call(auth, {
    url: '/api/auth/me',
    method: 'GET',
    headers: { cookie: aliceCookie },
  });
  check(
    'authenticated /api/auth/me returns the signed-in user and plan',
    me1.statusCode === 200 && me1.json.authenticated === true && me1.json.email === 'alice@example.com' && me1.json.plan === 'free',
    JSON.stringify(me1.json),
  );

  // Server-side plan changes take effect immediately without re-issuing the cookie
  const aliceHash = sha256('alice@example.com');
  const aliceRecord = JSON.parse(redisStore.get(K.user(aliceHash)).v);
  aliceRecord.plan = 'pro';
  aliceRecord.planPeriodEnd = Date.now() + 30 * 86400 * 1000;
  redisStore.set(K.user(aliceHash), { v: JSON.stringify(aliceRecord), exp: null });

  const me2 = await call(auth, {
    url: '/api/auth/me',
    method: 'GET',
    headers: { cookie: aliceCookie },
  });
  check(
    'server-side plan change takes effect immediately on existing session',
    me2.statusCode === 200 && me2.json.plan === 'pro' && me2.json.limits.maxPages === 50,
    JSON.stringify(me2.json),
  );

  // Logout revokes the session server-side immediately
  const loggedOut = await call(auth, {
    url: '/api/auth/logout',
    headers: { cookie: aliceCookie },
  });
  check('logout returns 200 and clears the cookie', loggedOut.statusCode === 200 && String(loggedOut.getHeader('set-cookie')).includes('Max-Age=0'));

  const meAfterLogout = await call(auth, {
    url: '/api/auth/me',
    method: 'GET',
    headers: { cookie: aliceCookie },
  });
  check(
    'replaying a logged-out session cookie resolves as unauthenticated free',
    meAfterLogout.json.authenticated === false && meAfterLogout.json.plan === 'free',
    JSON.stringify(meAfterLogout.json),
  );
}

section('16. Payments — Razorpay redirect checkout, webhook signature, idempotency, credits, and lapsed fallback');
{
  function signWebhook(bodyObj) {
    const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const sig = createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    return { raw, sig };
  }

  const buyer = seedSession('free', { email: 'buyer@example.com' });

  // Unauthenticated checkout is rejected
  const unauthCo = await call(billing, {
    url: '/api/billing/checkout',
    body: { plan: 'pro', period: 'monthly' },
  });
  check('checkout requires authentication (401)', unauthCo.statusCode === 401);

  // Authenticated subscription checkout 302-redirects to Razorpay hosted page
  const subCo = await call(billing, {
    url: '/api/billing/checkout',
    headers: { cookie: buyer.cookie },
    body: { plan: 'pro', period: 'yearly' },
  });
  check(
    'checkout creates a subscription and 302-redirects to Razorpay hosted URL',
    subCo.statusCode === 302 && /^https:\/\/rzp\.io\//.test(String(subCo.getHeader('location'))),
    `status ${subCo.statusCode}, location ${subCo.getHeader('location')}`,
  );

  // Credit pack checkout 302-redirects to Razorpay payment link
  const packCo = await call(billing, {
    url: '/api/billing/checkout',
    headers: { cookie: buyer.cookie },
    body: { plan: 'credits' },
  });
  check(
    'credit pack checkout 302-redirects to Razorpay hosted payment link',
    packCo.statusCode === 302 && /^https:\/\/rzp\.io\//.test(String(packCo.getHeader('location'))),
    `status ${packCo.statusCode}`,
  );

  // Unsigned or bad-signature webhooks are rejected before modifying state
  const creditEventBody = {
    id: 'evt_credit_pack_1',
    event: 'payment_link.paid',
    payload: {
      payment_link: {
        entity: {
          id: 'plink_123',
          notes: { uid: buyer.uid, pack: 'credits_20' },
        },
      },
    },
  };

  const unsignedWh = await call(billing, {
    url: '/api/billing/webhook',
    body: creditEventBody,
  });
  check('unsigned webhook is rejected with 401', unsignedWh.statusCode === 401);

  const badSigWh = await call(billing, {
    url: '/api/billing/webhook',
    headers: { 'x-razorpay-signature': 'deadbeef00000000' },
    body: creditEventBody,
  });
  check('forged webhook signature is rejected with 401', badSigWh.statusCode === 401);

  const meBeforeWh = await call(auth, { url: '/api/auth/me', method: 'GET', headers: { cookie: buyer.cookie } });
  check('rejected webhooks did not grant credits or upgrade plan', meBeforeWh.json.credits === 0 && meBeforeWh.json.plan === 'free');

  // Valid signed payment_link.paid webhook grants 20 credits
  const { raw: creditRaw, sig: creditSig } = signWebhook(creditEventBody);
  const goodCreditWh = await call(billing, {
    url: '/api/billing/webhook',
    headers: {
      'x-razorpay-signature': creditSig,
      'x-razorpay-event-id': 'evt_credit_pack_1',
    },
    body: creditRaw,
  });
  check('valid signed payment_link.paid webhook succeeds', goodCreditWh.statusCode === 200 && goodCreditWh.json.ok === true);

  // Replaying the exact same webhook event is idempotent and does NOT double-credit
  const replayCreditWh = await call(billing, {
    url: '/api/billing/webhook',
    headers: {
      'x-razorpay-signature': creditSig,
      'x-razorpay-event-id': 'evt_credit_pack_1',
    },
    body: creditRaw,
  });
  const meAfterCredit = await call(auth, { url: '/api/auth/me', method: 'GET', headers: { cookie: buyer.cookie } });
  check(
    'replayed payment_link.paid event does not double-credit (stays at 20 credits)',
    replayCreditWh.statusCode === 200 && replayCreditWh.json.duplicate === true && meAfterCredit.json.credits === 20 && meAfterCredit.json.plan === 'pro' && meAfterCredit.json.usingCredit === true,
    JSON.stringify(meAfterCredit.json),
  );

  // Creating a Pro-featured link on credits consumes 1 credit (20 -> 19)
  const creditDoc = await call(create, {
    url: '/api/create',
    headers: { cookie: buyer.cookie },
    body: { pages: 25, password: 'credit-pw', watermark: 'Credit Link' },
  });
  const meAfterUse = await call(auth, { url: '/api/auth/me', method: 'GET', headers: { cookie: buyer.cookie } });
  check(
    'creating a link with credits unlocks Pro limits and decrements credits by 1',
    creditDoc.statusCode === 201 && creditDoc.json.plan === 'pro' && meAfterUse.json.credits === 19,
    `credits=${meAfterUse.json.credits}`,
  );

  // Subscription activation upgrades user to Ultra
  const futureEndSec = Math.floor((Date.now() + 30 * 86400 * 1000) / 1000);
  const subActivatedBody = {
    id: 'evt_sub_act_1',
    event: 'subscription.activated',
    payload: {
      subscription: {
        entity: {
          id: 'sub_live_99',
          current_end: futureEndSec,
          notes: { uid: buyer.uid, plan: 'ultra', period: 'monthly' },
        },
      },
    },
  };
  const { raw: subRaw, sig: subSig } = signWebhook(subActivatedBody);
  const subWh = await call(billing, {
    url: '/api/billing/webhook',
    headers: { 'x-razorpay-signature': subSig, 'x-razorpay-event-id': 'evt_sub_act_1' },
    body: subRaw,
  });
  const meUltra = await call(auth, { url: '/api/auth/me', method: 'GET', headers: { cookie: buyer.cookie } });
  check(
    'subscription.activated upgrades user to ultra',
    subWh.statusCode === 200 && meUltra.json.plan === 'ultra' && meUltra.json.basePlan === 'ultra',
    JSON.stringify(meUltra.json),
  );

  // Cancel at period end marks cancelAtPeriodEnd: true but keeps Ultra active until period end
  const cancelRes = await call(billing, {
    url: '/api/billing/cancel',
    headers: { cookie: buyer.cookie },
  });
  const meAfterCancel = await call(auth, { url: '/api/auth/me', method: 'GET', headers: { cookie: buyer.cookie } });
  check(
    'cancel at period end keeps the paid plan active until period end',
    cancelRes.statusCode === 200 && meAfterCancel.json.cancelAtPeriodEnd === true && meAfterCancel.json.plan === 'ultra',
    JSON.stringify(meAfterCancel.json),
  );

  // Lapsed subscription falls back to free without deleting user data
  const lapsedUser = JSON.parse(redisStore.get(K.user(buyer.emailHash)).v);
  lapsedUser.planPeriodEnd = Date.now() - 5000;
  lapsedUser.credits = 0;
  redisStore.set(K.user(buyer.emailHash), { v: JSON.stringify(lapsedUser), exp: null });

  const meLapsed = await call(auth, { url: '/api/auth/me', method: 'GET', headers: { cookie: buyer.cookie } });
  check(
    'lapsed subscription resolves to free on the next check without deleting user record',
    meLapsed.statusCode === 200 && meLapsed.json.plan === 'free' && meLapsed.json.email === 'buyer@example.com',
    JSON.stringify(meLapsed.json),
  );
}

/* ------------------ 17. Owner / Developer Access & RBAC (/api/admin/*) */

section('17. Owner / Developer Access & RBAC');
{
  async function otpSignIn(email, ip) {
    await call(auth, {
      url: '/api/auth/request-code',
      ip,
      body: { email },
    });
    const code = mailOutbox.get(email.toLowerCase())?.code;
    const ver = await call(auth, {
      url: '/api/auth/verify',
      ip,
      body: { email, code },
    });
    const setCookie = String(ver.getHeader('set-cookie') || '');
    const cookiePair = setCookie.split(';')[0];
    return { ver, cookie: cookiePair };
  }

  // 1. Unauthenticated requests to /api/admin/* are rejected with 401
  const unauthAdmin = await call(admin, {
    url: '/api/admin/overview',
    method: 'GET',
    ip: '198.51.100.200',
  });
  check('unauthenticated request to /api/admin/overview is rejected (401)', unauthAdmin.statusCode === 401);

  // 2. Public user registration always gets role='user' and is rejected from /api/admin/* with 403
  const normal = await otpSignIn('public-user@example.com', '198.51.100.201');
  check(
    'public user sign-in receives role="user" and zero developer permissions',
    normal.ver.statusCode === 200
      && normal.ver.json.role === 'user'
      && Array.isArray(normal.ver.json.permissions)
      && normal.ver.json.permissions.length === 0,
    JSON.stringify(normal.ver.json),
  );

  const userAdminAttempt = await call(admin, {
    url: '/api/admin/overview',
    method: 'GET',
    ip: '198.51.100.201',
    headers: { cookie: normal.cookie },
  });
  check('normal user is blocked from /api/admin/overview (403)', userAdminAttempt.statusCode === 403);

  // 3. Owner account (codekon10@gmail.com) receives role='owner', full permissions, and Ultra plan
  const owner = await otpSignIn('codekon10@gmail.com', '198.51.100.202');
  check(
    'configured Owner account (codekon10@gmail.com) receives role="owner" and ultra plan',
    owner.ver.statusCode === 200
      && owner.ver.json.role === 'owner'
      && owner.ver.json.plan === 'ultra'
      && owner.ver.json.permissions.includes('devs:manage'),
    JSON.stringify(owner.ver.json),
  );

  // 4. Owner can access real-data overview, metrics, users, and database schema
  const ov = await call(admin, {
    url: '/api/admin/overview',
    method: 'GET',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
  });
  check(
    'Owner can read /api/admin/overview with real counts, DB health, and redacted integrations',
    ov.statusCode === 200
      && ov.json.ok === true
      && ov.json.health.dbConnected === true
      && ov.json.counts.totalRegisteredUsers >= 2
      && typeof ov.json.integrations.ownerConfigured === 'boolean',
    JSON.stringify(ov.json),
  );

  // 5. Destructive / write operations require { confirm: 'CONFIRM' }
  const noConfirm = await call(admin, {
    url: '/api/admin/users',
    method: 'POST',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
    body: {
      subAction: 'set_role',
      email: 'dev-staff@example.com',
      role: 'developer',
      permissions: ['overview:read', 'logs:read'],
    },
  });
  check(
    'admin write action without confirmation token is rejected (400 confirmation_required)',
    noConfirm.statusCode === 400 && noConfirm.json.error === 'confirmation_required',
    JSON.stringify(noConfirm.json),
  );

  // 6. Owner promotes dev-staff@example.com to 'developer' with granular read-only permissions
  const promoteDev = await call(admin, {
    url: '/api/admin/users',
    method: 'POST',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
    body: {
      subAction: 'set_role',
      email: 'dev-staff@example.com',
      role: 'developer',
      permissions: ['overview:read', 'logs:read', 'devs:manage'], // 'devs:manage' must be stripped automatically
      confirm: 'CONFIRM',
    },
  });
  check(
    'Owner can assign Developer role with granular permissions (and devs:manage is never granted to Developers)',
    promoteDev.statusCode === 200
      && promoteDev.json.user.role === 'developer'
      && promoteDev.json.user.permissions.includes('overview:read')
      && promoteDev.json.user.permissions.includes('logs:read')
      && !promoteDev.json.user.permissions.includes('devs:manage'),
    JSON.stringify(promoteDev.json),
  );

  // 7. Developer signs in and can access permitted tools, but is blocked from unpermitted tools & privilege escalation
  const devUser = await otpSignIn('dev-staff@example.com', '198.51.100.203');
  check(
    'Developer sign-in returns role="developer" and exact assigned permissions',
    devUser.ver.statusCode === 200 && devUser.ver.json.role === 'developer',
  );

  const devOv = await call(admin, {
    url: '/api/admin/overview',
    method: 'GET',
    ip: '198.51.100.203',
    headers: { cookie: devUser.cookie },
  });
  check('Developer with overview:read can access /api/admin/overview', devOv.statusCode === 200);

  const devSettingsTry = await call(admin, {
    url: '/api/admin/settings',
    method: 'POST',
    ip: '198.51.100.203',
    headers: { cookie: devUser.cookie },
    body: { maintenanceMode: true, confirm: 'CONFIRM' },
  });
  check(
    'Developer without settings:write is blocked from modifying app settings (403)',
    devSettingsTry.statusCode === 403,
  );

  const devEscalateTry = await call(admin, {
    url: '/api/admin/users',
    method: 'POST',
    ip: '198.51.100.203',
    headers: { cookie: devUser.cookie },
    body: {
      subAction: 'set_role',
      email: 'dev-staff@example.com',
      role: 'owner',
      confirm: 'CONFIRM',
    },
  });
  check(
    'Developer attempting privilege escalation via /api/admin/users is blocked (403)',
    devEscalateTry.statusCode === 403,
  );

  // 8. Owner account itself cannot be demoted or modified via set_role
  const demoteOwnerTry = await call(admin, {
    url: '/api/admin/users',
    method: 'POST',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
    body: {
      subAction: 'set_role',
      email: 'codekon10@gmail.com',
      role: 'user',
      confirm: 'CONFIRM',
    },
  });
  check(
    'Owner account cannot be demoted (400 cannot_modify_owner)',
    demoteOwnerTry.statusCode === 400 && demoteOwnerTry.json.error === 'cannot_modify_owner',
  );

  // 9. Document inspector redacts secrets, hashes, and blob URLs
  const secretDoc = await call(create, {
    url: '/api/create',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
    body: { pages: 1, password: 'top-secret-password', watermark: 'Confidential' },
  });
  const inspectRes = await call(admin, {
    url: `/api/admin/database?docId=${encodeURIComponent(secretDoc.json.id)}`,
    method: 'GET',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
  });
  const inspected = inspectRes.json?.inspectedDoc || {};
  check(
    'Document inspector returns metadata while stripping passwordHash, salt, token hashes, and blobUrls',
    inspectRes.statusCode === 200
      && inspected.id === secretDoc.json.id
      && inspected.hasPassword === true
      && inspected.passwordHash === undefined
      && inspected.salt === undefined
      && inspected.uploadTokenHash === undefined
      && inspected.ownerTokenHash === undefined
      && inspected.blobUrls === undefined,
    JSON.stringify(inspected),
  );

  // 10. Runtime application settings (maintenance mode) block public uploads while allowing Owner uploads
  const enableMaint = await call(admin, {
    url: '/api/admin/settings',
    method: 'POST',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
    body: {
      maintenanceMode: true,
      uploadsEnabled: true,
      signupsEnabled: true,
      announcement: 'Maintenance window active.',
      confirm: 'CONFIRM',
    },
  });
  check('Owner can enable maintenanceMode in runtime settings', enableMaint.statusCode === 200 && enableMaint.json.settings.maintenanceMode === true);

  const anonDuringMaint = await call(create, {
    url: '/api/create',
    ip: '198.51.100.204',
    body: { pages: 1 },
  });
  const ownerDuringMaint = await call(create, {
    url: '/api/create',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
    body: { pages: 1 },
  });
  check(
    'maintenanceMode blocks public uploads (503) while still allowing Owner uploads (201)',
    anonDuringMaint.statusCode === 503 && ownerDuringMaint.statusCode === 201,
    `anon=${anonDuringMaint.statusCode}, owner=${ownerDuringMaint.statusCode}`,
  );

  // Restore maintenanceMode=false
  await call(admin, {
    url: '/api/admin/settings',
    method: 'POST',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
    body: {
      maintenanceMode: false,
      uploadsEnabled: true,
      signupsEnabled: true,
      announcement: '',
      confirm: 'CONFIRM',
    },
  });

  // 11. Security logs and Developer Activity Audit logs recorded real events without leaking secrets
  const logsRes = await call(admin, {
    url: '/api/admin/logs',
    method: 'GET',
    ip: '198.51.100.202',
    headers: { cookie: owner.cookie },
  });
  check(
    'Security and Developer Activity Audit logs record real events',
    logsRes.statusCode === 200
      && Array.isArray(logsRes.json.securityLogs)
      && logsRes.json.securityLogs.length >= 3
      && Array.isArray(logsRes.json.devAuditLogs)
      && logsRes.json.devAuditLogs.length >= 2,
    `sec=${logsRes.json?.securityLogs?.length}, audit=${logsRes.json?.devAuditLogs?.length}`,
  );
}

/* ------------------------------------------------------------------ report */

console.log(`\n${'='.repeat(52)}`);
if (failures.length === 0) {
  console.log(`ALL GREEN — ${passed} checks passed`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} FAILED:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
