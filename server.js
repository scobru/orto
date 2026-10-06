#!/usr/bin/env node
/**
 * Orto server (formerly ZenOS): your personal workspace on a server you run.
 * One SQLite file (records, users, sessions) + a folder of uploaded blobs, zero npm dependencies.
 * Requires Node >= 22.5 (built-in node:sqlite).
 *
 * The server never sees plaintext of private collections: clients encrypt (AES-GCM) before PUT.
 * Only the `posts` collection (public blog) is stored and served in clear.
 *
 * Backup: node server.js backup <folder>  (database + uploads; restore by stopping the server and using the folder as ORTO_DATA).
 * Env: PORT (8787), HOST (127.0.0.1), ORTO_DATA (./data), ORTO_WEB (./web),
 *      ORTO_REGISTRATION=open|closed (open), ORTO_MAX_UPLOAD bytes (200MB), ORTO_QUOTA bytes per user (5GB)
 *      (the old ZENOS_* names still work)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const NAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
const SEG = /^[\w.:-]{1,128}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function readBody(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'Payload too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 8e6) {
  const raw = (await readBody(req, limit)).toString() || '{}';
  try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch (_) {}
  throw new HttpError(400, 'Body must be a JSON object');
}

// settings come from ORTO_*; the old ZENOS_* names still work
const settings = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ZENOS_')).map(([k, v]) => ['ORTO_' + k.slice(6), v])), ...process.env };

export function createServer(opts = {}) {
  const env = settings;
  const dataDir = path.resolve(opts.dataDir || env.ORTO_DATA || path.join(process.cwd(), 'data'));
  const webDir = path.resolve(opts.webDir || env.ORTO_WEB || path.join(here, 'web'));
  const registration = opts.registration || env.ORTO_REGISTRATION || 'open';
  const maxUpload = Number(opts.maxUpload || env.ORTO_MAX_UPLOAD || 200 * 1024 * 1024);
  const quota = Number(opts.quota || env.ORTO_QUOTA || 5 * 1024 ** 3);
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  // zenos.db is the file name from before the rename: keep using it if that is what is on disk
  const dbFile = ['orto.db', 'zenos.db'].map(f => path.join(dataDir, f)).find(f => fs.existsSync(f)) || path.join(dataDir, 'orto.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS records (user_id INTEGER NOT NULL REFERENCES users(id), coll TEXT NOT NULL, soul TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, coll, soul));
    CREATE TABLE IF NOT EXISTS files (user_id INTEGER NOT NULL REFERENCES users(id), id TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (user_id, id));
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), file_id TEXT, data TEXT, created_at INTEGER NOT NULL);
  `);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
    addUser: db.prepare('INSERT INTO users (name, auth_hash, created_at) VALUES (?, ?, ?)'),
    addSession: db.prepare('INSERT INTO sessions VALUES (?, ?, ?)'),
    session: db.prepare('SELECT s.user_id, s.expires, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    list: db.prepare('SELECT soul, data, updated_at FROM records WHERE user_id = ? AND coll = ?'),
    get: db.prepare('SELECT soul, data, updated_at FROM records WHERE user_id = ? AND coll = ? AND soul = ?'),
    put: db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, coll, soul) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
    del: db.prepare('DELETE FROM records WHERE user_id = ? AND coll = ? AND soul = ?'),
    addFile: db.prepare('INSERT INTO files VALUES (?, ?, ?)'),
    file: db.prepare('SELECT size FROM files WHERE user_id = ? AND id = ?'),
    delFile: db.prepare('DELETE FROM files WHERE user_id = ? AND id = ?'),
    setFileSize: db.prepare('UPDATE files SET size = ? WHERE user_id = ? AND id = ?'),
    addShare: db.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?)'),
    share: db.prepare('SELECT user_id, file_id, data FROM shares WHERE id = ?'),
    delShare: db.prepare('DELETE FROM shares WHERE id = ? AND user_id = ?'),
    setAuth: db.prepare('UPDATE users SET auth_hash = ? WHERE id = ?'),
    dropSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    used: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE user_id = ?')
  };

  const toRecord = (r) => ({ soul: r.soul, ...JSON.parse(r.data), updatedAt: r.updated_at });
  const listeners = new Map(); // user_id -> Set<ServerResponse>
  const emit = (uid, evt) => { for (const res of listeners.get(uid) || []) res.write('data: ' + JSON.stringify(evt) + '\n\n'); };

  // ponytail: in-memory login throttle, resets on restart; put a reverse proxy rate limit in front for more
  const fails = new Map();
  const throttled = (key) => { const f = fails.get(key); return f && f.n >= 10 && f.until > Date.now(); };
  const failed = (key) => { const f = fails.get(key) || { n: 0 }; f.n++; f.until = Date.now() + 15 * 60e3; fails.set(key, f); };

  function authed(req) {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    const s = t && q.session.get(sha(t));
    if (!s || s.expires < Date.now()) throw new HttpError(401, 'Unauthorized');
    return s;
  }
  const newSession = (uid) => {
    const token = crypto.randomBytes(32).toString('hex');
    q.addSession.run(sha(token), uid, Date.now() + 30 * 864e5);
    return token;
  };

  // Stream the request body to disk (new file, or replace `id` in place). Written to a temp file first so a failed upload never damages the old blob.
  async function saveUpload(u, req, id = null) {
    const old = id && q.file.get(u.user_id, id);
    const used = q.used.get(u.user_id).n - (old ? old.size : 0);
    if (used + Number(req.headers['content-length'] || 0) > quota) throw new HttpError(413, 'Storage quota exceeded');
    id = id || crypto.randomBytes(12).toString('hex');
    const dir = path.join(filesDir, String(u.user_id));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id), tmp = file + '.part', out = fs.createWriteStream(tmp);
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxUpload || used + size > quota) throw new HttpError(413, 'File too large');
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end(); await once(out, 'finish');
      fs.renameSync(tmp, file);
    } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
    if (old) q.setFileSize.run(size, u.user_id, id); else q.addFile.run(u.user_id, id, size);
    return { id, size };
  }
  const dropFile = (uid, id) => { q.delFile.run(uid, id); fs.rmSync(path.join(filesDir, String(uid), id), { force: true }); };

  async function api(req, res, url) {
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent); // after /api
    const [a, b, c] = parts;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    for (const p of parts) if (!SEG.test(p)) throw new HttpError(400, 'Bad path');

    if (a === 'health') return json(200, { ok: true, name: 'orto' });

    if (a === 'config') return json(200, { registration, maxUpload });

    if ((a === 'register' || a === 'login') && req.method === 'POST') {
      const { name: raw, auth } = await readJson(req, 1e4);
      const name = String(raw || '').trim().toLowerCase();
      if (!NAME.test(name)) throw new HttpError(400, 'Username: 2-32 chars, a-z 0-9 _ . -');
      if (typeof auth !== 'string' || auth.length < 32 || auth.length > 128) throw new HttpError(400, 'Bad auth key');
      const key = req.socket.remoteAddress + '|' + name;
      if (throttled(key)) throw new HttpError(429, 'Too many attempts, try again later');
      const hash = sha(auth);
      if (a === 'register') {
        if (registration !== 'open') throw new HttpError(403, 'Registration is closed');
        try { q.addUser.run(name, hash, Date.now()); } catch (_) { throw new HttpError(409, 'Username taken'); }
      }
      const user = q.userByName.get(name);
      if (!user) throw new HttpError(404, 'Unknown user');
      const ok = crypto.timingSafeEqual(Buffer.from(sha(hash)), Buffer.from(sha(user.auth_hash)));
      if (!ok) { failed(key); throw new HttpError(401, 'Wrong username or password'); }
      fails.delete(key);
      return json(200, { token: newSession(user.id), name });
    }

    // public: author handle + published posts
    if (a === 'u') {
      const user = q.userByName.get(String(b || '').toLowerCase());
      if (!user) throw new HttpError(404, 'Unknown user');
      if (!c) return json(200, { name: user.name });
      if (c === 'posts') return json(200, q.list.all(user.id, 'posts').map(toRecord));
      throw new HttpError(404, 'Not found');
    }

    // public share: the server only holds ciphertext, the key lives in the link's #fragment
    if (a === 's' && b && req.method === 'GET') {
      const sh = /^[a-f0-9]{32}$/.test(b) && q.share.get(b);
      if (!sh) throw new HttpError(404, 'Not found');
      if (!sh.file_id) return json(200, { data: sh.data });
      const file = path.join(filesDir, String(sh.user_id), sh.file_id);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
      return void fs.createReadStream(file).pipe(res);
    }

    const u = authed(req);

    if (a === 'events') { // live updates of the user's own collections (SSE)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      if (!listeners.has(u.user_id)) listeners.set(u.user_id, new Set());
      listeners.get(u.user_id).add(res);
      const beat = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => { clearInterval(beat); listeners.get(u.user_id)?.delete(res); });
      return;
    }

    if (a === 'c' && b) {
      if (!c) {
        if (req.method === 'GET') return json(200, q.list.all(u.user_id, b).map(toRecord));
        throw new HttpError(405, 'Method not allowed');
      }
      if (req.method === 'GET') {
        const r = q.get.get(u.user_id, b, c);
        if (!r) throw new HttpError(404, 'Not found');
        return json(200, toRecord(r));
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        delete body.soul; delete body.updatedAt;
        const now = Date.now();
        q.put.run(u.user_id, b, c, JSON.stringify(body), now);
        emit(u.user_id, { coll: b, soul: c, deleted: false, record: { soul: c, ...body, updatedAt: now } });
        return json(200, { soul: c, updatedAt: now });
      }
      if (req.method === 'DELETE') {
        q.del.run(u.user_id, b, c);
        emit(u.user_id, { coll: b, soul: c, deleted: true });
        return json(200, { soul: c, deleted: true });
      }
    }

    if (a === 'password' && req.method === 'POST') { // the client re-encrypted everything first; this swaps the login secret and signs out every other session
      const { auth, newAuth } = await readJson(req, 1e4);
      for (const v of [auth, newAuth]) if (typeof v !== 'string' || v.length < 32 || v.length > 128) throw new HttpError(400, 'Bad auth key');
      const key = req.socket.remoteAddress + '|' + u.name;
      if (throttled(key)) throw new HttpError(429, 'Too many attempts, try again later');
      const user = q.userByName.get(u.name);
      if (!crypto.timingSafeEqual(Buffer.from(sha(sha(auth))), Buffer.from(sha(user.auth_hash)))) { failed(key); throw new HttpError(401, 'Wrong password'); }
      q.setAuth.run(sha(newAuth), user.id);
      q.dropSessions.run(user.id, sha((req.headers.authorization || '').replace(/^Bearer /, '')));
      return json(200, { ok: true });
    }

    if (a === 's') {
      if (req.method === 'POST' && !b) { // JSON {data:"e1..."} = text share, raw bytes = file share
        const id = crypto.randomBytes(16).toString('hex');
        if (String(req.headers['content-type'] || '').startsWith('application/json')) {
          const { data } = await readJson(req);
          if (typeof data !== 'string' || !data.startsWith('e1.')) throw new HttpError(400, 'data must be ciphertext');
          q.addShare.run(id, u.user_id, null, data, Date.now());
        } else {
          const f = await saveUpload(u, req);
          q.addShare.run(id, u.user_id, f.id, null, Date.now());
        }
        return json(200, { id });
      }
      if (req.method === 'DELETE' && b) {
        const sh = q.share.get(b);
        if (!sh || sh.user_id !== u.user_id) throw new HttpError(404, 'Not found');
        q.delShare.run(b, u.user_id);
        if (sh.file_id) dropFile(u.user_id, sh.file_id);
        return json(200, { id: b, deleted: true });
      }
    }

    if (a === 'files') {
      if (req.method === 'POST' && !b) return json(200, await saveUpload(u, req));
      const f = b && q.file.get(u.user_id, b);
      if (!f) throw new HttpError(404, 'Not found');
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size });
        return void fs.createReadStream(path.join(filesDir, String(u.user_id), b)).pipe(res);
      }
      if (req.method === 'PUT') return json(200, await saveUpload(u, req, b));
      if (req.method === 'DELETE') {
        dropFile(u.user_id, b);
        return json(200, { id: b, deleted: true });
      }
    }
    throw new HttpError(404, 'Not found');
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/blog/')) rel = '/blog.html';
    else if (rel.startsWith('/s/')) rel = '/share.html';
    if (rel.endsWith('/')) rel += 'index.html';
    // the SDK lives next to this file (not in web/) so the CLI and the browser share one copy
    const file = rel === '/orto.js' ? path.join(here, 'orto.js') : path.normalize(path.join(webDir, rel));
    if ((rel !== '/orto.js' && !file.startsWith(webDir + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // bearer tokens, no cookies: safe to open
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (res.headersSent) return res.end();
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: e.status ? e.message : 'Internal error' }));
    }
  });
  server.on('close', () => db.close());
  // Consistent copy of everything: the database (VACUUM INTO is safe while the server runs) plus the uploads folder.
  // Restore = stop the server and put the copy back as the data folder.
  server.backup = (out) => {
    out = path.resolve(out);
    fs.mkdirSync(out, { recursive: true });
    const copy = path.join(out, 'orto.db');
    if (fs.existsSync(copy)) throw new Error(copy + ' already exists');
    db.prepare('VACUUM INTO ?').run(copy);
    fs.cpSync(filesDir, path.join(out, 'files'), { recursive: true, filter: (f) => !f.endsWith('.part') });
    return out;
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'backup') { // node server.js backup <folder>
    if (!process.argv[3]) { console.error('Usage: node server.js backup <folder>'); process.exit(1); }
    console.log('Backup written to ' + createServer().backup(process.argv[3]));
    process.exit(0);
  }
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`Orto server on http://${host}:${port}`));
}
