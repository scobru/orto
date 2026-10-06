// Makes the app installable and keeps the shell (not your data) available when the server is briefly unreachable.
// Network first, so updates always win; never touches /api, which is where all data lives.
//
// It also streams encrypted media. <audio>/<video> point at <scope>__media/<file id>; the browser asks for byte ranges, and this worker
// fetches just the encrypted chunks that cover them from the Orto server, decrypts them and answers 206. The page hands over what
// is needed (the key, the session token, the file's index entry) with postMessage, and re-sends it if this worker was stopped meanwhile.
// The chunk format and its authenticated data are the same as in orto.js (CHUNK, sealChunk/openChunk): keep in sync.
const CACHE = 'orto-shell-v1';
const GCM = 28;
const media = new Map(); // file id -> { key, token, base, meta }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('message', (e) => { const d = e.data || {}; if (d.type === 'orto-media') media.set(d.id, d); else if (d.type === 'orto-media-clear') media.clear(); });

const aad = (nonce, i, n) => { const a = new Uint8Array(nonce.length + 8); a.set(nonce); const v = new DataView(a.buffer); v.setUint32(nonce.length, i); v.setUint32(nonce.length + 4, n); return a; };
const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const chunkLen = (m, i) => (i < m.chunked.n - 1 ? m.chunked.size : m.size - (m.chunked.n - 1) * m.chunked.size) + GCM;

async function ask(clientId, id) { // the page re-sends its parameters if this worker lost them
  const client = (clientId && await self.clients.get(clientId)) || (await self.clients.matchAll({ type: 'window' }))[0];
  if (!client) return null;
  return new Promise((res) => {
    const ch = new MessageChannel(); const t = setTimeout(() => res(null), 5000);
    ch.port1.onmessage = (e) => { clearTimeout(t); if (e.data) media.set(id, e.data); res(e.data || null); };
    client.postMessage({ type: 'orto-media-need', id }, [ch.port2]);
  });
}

async function serveMedia(e) {
  const id = decodeURIComponent(new URL(e.request.url).pathname.split('/__media/')[1] || '');
  const m = media.get(id) || await ask(e.clientId, id);
  if (!m?.meta?.chunked) return new Response('Locked', { status: 401 });
  const { meta } = m, P = meta.chunked.size, n = meta.chunked.n, size = meta.size, nonce = fromB64(meta.chunked.nonce);
  let start = 0, end = size - 1, status = 200;
  const rg = /^bytes=(\d*)-(\d*)$/.exec(e.request.headers.get('range') || '');
  if (rg && (rg[1] || rg[2])) {
    start = rg[1] === '' ? Math.max(0, size - Number(rg[2])) : Number(rg[1]);
    end = rg[1] === '' || rg[2] === '' ? size - 1 : Math.min(Number(rg[2]), size - 1);
    if (!(start <= end && start < size)) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
    status = 206;
  }
  if (size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': meta.type || 'application/octet-stream', 'Content-Length': '0' } });
  let i = Math.floor(start / P); const last = Math.floor(end / P);
  const body = new ReadableStream({
    async pull(ctrl) {
      if (i > last) return ctrl.close();
      try {
        const from = i * (P + GCM);
        const r = await fetch(m.base + '/api/files/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + m.token, Range: `bytes=${from}-${from + chunkLen(meta, i) - 1}` } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const enc = new Uint8Array(await r.arrayBuffer());
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: enc.subarray(0, 12), additionalData: aad(nonce, i, n) }, m.key, enc.subarray(12)));
        ctrl.enqueue(plain.subarray(Math.max(start, i * P) - i * P, Math.min(end + 1, i * P + plain.length) - i * P));
        i++;
      } catch (err) { ctrl.error(err); }
    }
  });
  return new Response(body, { status, headers: { 'Content-Type': meta.type || 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', ...(status === 206 && { 'Content-Range': `bytes ${start}-${end}/${size}` }) } });
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === 'GET' && u.origin === location.origin && u.pathname.includes('/__media/')) return e.respondWith(serveMedia(e));
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
