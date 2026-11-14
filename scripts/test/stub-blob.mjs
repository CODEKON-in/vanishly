// In-memory stand-in for @vercel/blob, used only by the self-test.
export const store = new Map();
let seq = 0;

export async function put(pathname, body, opts = {}) {
  seq += 1;
  const url = `https://blob.test/${pathname}-${seq}`;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(await body.arrayBuffer());
  store.set(url, { buf, contentType: opts.contentType || 'application/octet-stream' });
  return { url, pathname, downloadUrl: url };
}

export async function del(urls) {
  for (const u of [].concat(urls)) store.delete(u);
}
