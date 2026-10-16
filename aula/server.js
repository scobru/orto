#!/usr/bin/env node
// Aula: self-hosted Google Classroom alternative. Node >= 22.5, SQLite file, no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (message, status = 400) => { throw new HttpError(status, message); };
const str = v => (typeof v === 'string' ? v.trim() : '');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  let n = 0;
  const chunks = [];
  for await (const c of req) { if ((n += c.length) > 1e6) bad('Body too large', 413); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}') ?? {}; } catch { return bad('Invalid JSON'); }
}

export function createServer({
  data = process.env.AULA_DATA || './data',
  registration = process.env.AULA_REGISTRATION || 'open',
  maxUpload = +process.env.AULA_MAX_UPLOAD || 25e6,
} = {}) {
  const filesDir = path.join(data, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const db = new DatabaseSync(path.join(data, 'aula.db'));
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, pw TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS classes(id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS members(class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('teacher','student')), PRIMARY KEY(class_id, user_id));
    CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('announcement','assignment')), title TEXT, body TEXT NOT NULL DEFAULT '', due TEXT, points REAL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', submitted_at TEXT, grade REAL, feedback TEXT, UNIQUE(post_id, user_id));
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, user_id TEXT NOT NULL, post_id TEXT REFERENCES posts(id) ON DELETE CASCADE, submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE);
  `);
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const rmFiles = ids => ids.forEach(f => fs.rmSync(path.join(filesDir, f), { force: true }));

  const roleOf = (classId, uid) => one('SELECT role FROM members WHERE class_id=? AND user_id=?', classId, uid)?.role;
  function needRole(classId, uid, want) {
    const r = roleOf(classId, uid);
    if (!r) bad('Not found', 404);
    if (want && r !== want) bad('Teachers only', 403);
    return r;
  }
  function postOf(pid, uid) {
    const p = one('SELECT * FROM posts WHERE id=?', pid);
    if (!p) bad('Not found', 404);
    return [p, needRole(p.class_id, uid)];
  }
  const filesOf = (col, v) => q(`SELECT id, name, size FROM files WHERE ${col}=?`, v);
  const mySubmission = (pid, uid) => one('SELECT * FROM submissions WHERE post_id=? AND user_id=?', pid, uid);

  // shortcut: in-memory login throttle, resets on restart; move to the DB if you run several instances
  const fails = new Map();
  const routes = [];
  const route = (method, p, fn, open = false) => routes.push([method, new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$'), fn, open]);

  const newSession = userId => {
    const token = crypto.randomBytes(32).toString('hex');
    run('INSERT INTO sessions(token, user_id) VALUES(?,?)', sha(token), userId);
    return { token };
  };

  route('POST', '/api/register', async ({ json }) => {
    if (registration === 'closed') bad('Registration is closed', 403);
    const b = await json(), name = str(b.name), email = str(b.email).toLowerCase();
    if (!name || !/^\S+@\S+$/.test(email) || typeof b.password !== 'string' || b.password.length < 8) bad('Name, valid email and password (min 8 chars) required');
    const salt = crypto.randomBytes(16).toString('hex'), uid = id();
    try { run('INSERT INTO users(id, name, email, salt, pw) VALUES(?,?,?,?,?)', uid, name, email, salt, hashPw(b.password, salt)); }
    catch { bad('Email already registered', 409); }
    return newSession(uid);
  }, true);

  route('POST', '/api/login', async ({ json }) => {
    const b = await json(), email = str(b.email).toLowerCase();
    const f = fails.get(email);
    if (f && f.n >= 10 && Date.now() - f.t < 9e5) bad('Too many attempts, try again later', 429);
    const u = one('SELECT * FROM users WHERE email=?', email);
    const ok = u && typeof b.password === 'string' && crypto.timingSafeEqual(Buffer.from(hashPw(b.password, u.salt)), Buffer.from(u.pw));
    if (!ok) {
      const cur = f && Date.now() - f.t < 9e5 ? f : { n: 0, t: Date.now() };
      fails.set(email, { n: cur.n + 1, t: cur.t });
      bad('Invalid email or password', 401);
    }
    fails.delete(email);
    return newSession(u.id);
  }, true);

  route('GET', '/api/me', ({ user }) => ({ id: user.id, name: user.name, email: user.email }));

  route('GET', '/api/classes', ({ user }) => q(
    `SELECT c.id, c.name, m.role FROM classes c JOIN members m ON m.class_id=c.id WHERE m.user_id=? ORDER BY c.name`, user.id));

  route('POST', '/api/classes', async ({ user, json }) => {
    const name = str((await json()).name);
    if (!name) bad('Class name required');
    for (let i = 0; i < 5; i++) {
      const code = Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join(''), cid = id();
      try {
        tx(() => {
          run('INSERT INTO classes(id, name, code) VALUES(?,?,?)', cid, name, code);
          run("INSERT INTO members(class_id, user_id, role) VALUES(?,?,'teacher')", cid, user.id);
        });
        return { id: cid, code };
      } catch { /* code collision: retry */ }
    }
    return bad('Could not allocate a class code', 500);
  });

  route('POST', '/api/join', async ({ user, json }) => {
    const c = one('SELECT id FROM classes WHERE code=?', str((await json()).code).toUpperCase());
    if (!c) bad('No class with that code', 404);
    run("INSERT OR IGNORE INTO members(class_id, user_id, role) VALUES(?,?,'student')", c.id, user.id);
    return { id: c.id };
  });

  route('GET', '/api/classes/:id', ({ user, params: [cid] }) => {
    const role = needRole(cid, user.id);
    const cls = { ...one('SELECT id, name, code FROM classes WHERE id=?', cid) };
    if (role !== 'teacher') delete cls.code;
    const people = q('SELECT u.name, m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.class_id=? ORDER BY m.role DESC, u.name', cid);
    const posts = q('SELECT p.*, u.name author FROM posts p JOIN users u ON u.id=p.user_id WHERE p.class_id=? ORDER BY p.created_at DESC', cid).map(p => ({
      ...p,
      files: filesOf('post_id', p.id),
      mine: role === 'student' && p.kind === 'assignment' ? one('SELECT submitted_at, grade FROM submissions WHERE post_id=? AND user_id=?', p.id, user.id) ?? null : undefined,
    }));
    return { class: cls, role, people, posts };
  });

  route('POST', '/api/classes/:id/posts', async ({ user, params: [cid], json }) => {
    needRole(cid, user.id, 'teacher');
    const b = await json(), kind = b.kind, title = str(b.title), body = str(b.body);
    if (kind !== 'announcement' && kind !== 'assignment') bad('kind must be announcement or assignment');
    if (kind === 'assignment' ? !title : !body) bad(kind === 'assignment' ? 'Title required' : 'Text required');
    const due = b.due ? new Date(b.due) : null;
    if (due && isNaN(due)) bad('Invalid due date');
    const points = b.points == null ? null : Number(b.points);
    if (points != null && !(points >= 0)) bad('Invalid points');
    const pid = id();
    run('INSERT INTO posts(id, class_id, user_id, kind, title, body, due, points, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      pid, cid, user.id, kind, title || null, body, due?.toISOString() ?? null, kind === 'assignment' ? points : null, now());
    return { id: pid };
  });

  route('DELETE', '/api/posts/:id', ({ user, params: [pid] }) => {
    const [, role] = postOf(pid, user.id);
    if (role !== 'teacher') bad('Teachers only', 403);
    const ids = q('SELECT id FROM files WHERE post_id=? OR submission_id IN (SELECT id FROM submissions WHERE post_id=?)', pid, pid).map(f => f.id);
    run('DELETE FROM posts WHERE id=?', pid);
    rmFiles(ids);
  });

  route('GET', '/api/posts/:id', ({ user, params: [pid] }) => {
    const [post, role] = postOf(pid, user.id);
    const out = { post, role, files: filesOf('post_id', pid) };
    if (role === 'teacher') {
      // drafts stay private to the student until turned in
      out.submissions = q('SELECT s.*, u.name student FROM submissions s JOIN users u ON u.id=s.user_id WHERE s.post_id=? AND s.submitted_at IS NOT NULL ORDER BY u.name', pid)
        .map(s => ({ ...s, files: filesOf('submission_id', s.id) }));
    } else {
      const s = mySubmission(pid, user.id);
      out.submission = s ? { ...s, files: filesOf('submission_id', s.id) } : null;
    }
    return out;
  });

  route('PUT', '/api/posts/:id/submission', async ({ user, params: [pid], json }) => {
    const [p, role] = postOf(pid, user.id);
    if (p.kind !== 'assignment' || role !== 'student') bad('Only students can submit to assignments', 403);
    if (mySubmission(pid, user.id)?.grade != null) bad('Already graded', 409);
    const b = await json();
    run('INSERT INTO submissions(id, post_id, user_id, text, submitted_at) VALUES(?,?,?,?,?) ON CONFLICT(post_id, user_id) DO UPDATE SET text=excluded.text, submitted_at=excluded.submitted_at',
      id(), pid, user.id, str(b.text), b.submit ? now() : null);
  });

  route('PUT', '/api/submissions/:id/grade', async ({ user, params: [sid], json }) => {
    const s = one('SELECT p.class_id, p.points FROM submissions s JOIN posts p ON p.id=s.post_id WHERE s.id=?', sid);
    if (!s) bad('Not found', 404);
    needRole(s.class_id, user.id, 'teacher');
    const b = await json(), grade = b.grade == null || b.grade === '' ? null : Number(b.grade);
    if (grade !== null && !(grade >= 0 && (s.points == null || grade <= s.points))) bad('Invalid grade');
    run('UPDATE submissions SET grade=?, feedback=? WHERE id=?', grade, str(b.feedback) || null, sid);
  });

  // Upload = raw request body. Teacher: attaches to the post. Student: attaches to their own submission.
  route('POST', '/api/files', async ({ user, url, req }) => {
    const name = str(url.searchParams.get('name')).slice(0, 200) || 'file';
    const [p, role] = postOf(url.searchParams.get('post'), user.id);
    if (Number(req.headers['content-length']) > maxUpload) bad('File too large', 413);
    let sid = null;
    if (role === 'student') {
      if (p.kind !== 'assignment') bad('Not an assignment', 403);
      const s = mySubmission(p.id, user.id);
      if (s?.grade != null) bad('Already graded', 409);
      sid = s?.id ?? id();
      if (!s) run('INSERT INTO submissions(id, post_id, user_id) VALUES(?,?,?)', sid, p.id, user.id);
    }
    const fid = id(), dest = path.join(filesDir, fid);
    let size = 0;
    try {
      await pipeline(req, async function* (src) {
        for await (const c of src) { if ((size += c.length) > maxUpload) bad('File too large', 413); yield c; }
      }, fs.createWriteStream(dest));
    } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
    run('INSERT INTO files(id, name, size, user_id, post_id, submission_id) VALUES(?,?,?,?,?,?)', fid, name, size, user.id, sid ? null : p.id, sid);
    return { id: fid, name, size };
  });

  const fileAccess = (fid, uid) => {
    const f = one('SELECT f.*, s.user_id sub_user, s.post_id sub_post FROM files f LEFT JOIN submissions s ON s.id=f.submission_id WHERE f.id=?', fid);
    if (!f) bad('Not found', 404);
    const [, role] = postOf(f.post_id || f.sub_post, uid);
    if (f.submission_id && role === 'student' && f.sub_user !== uid) bad('Not found', 404);
    return f;
  };

  route('GET', '/api/files/:id', ({ user, params: [fid], res }) => {
    const f = fileAccess(fid, user.id);
    // octet-stream + attachment: an uploaded .html can never run in our origin
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': f.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name).replace(/'/g, '%27')}`,
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(path.join(filesDir, f.id)).pipe(res);
    return res;
  });

  route('DELETE', '/api/files/:id', ({ user, params: [fid] }) => {
    const f = fileAccess(fid, user.id);
    if (f.user_id !== user.id) bad('Not your file', 403);
    if (f.submission_id && one('SELECT grade FROM submissions WHERE id=?', f.submission_id).grade != null) bad('Already graded', 409);
    run('DELETE FROM files WHERE id=?', fid);
    rmFiles([fid]);
  });

  function serveStatic(pathname, res) {
    const f = path.join(WEB, pathname === '/' ? 'index.html' : pathname);
    if (!f.startsWith(WEB + path.sep) || !MIME[path.extname(f)] || !fs.existsSync(f)) bad('Not found', 404);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f)],
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(fs.readFileSync(f));
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      for (const [method, re, fn, open] of routes) {
        const m = method === req.method && re.exec(url.pathname);
        if (!m) continue;
        const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
        const user = tok ? one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', sha(tok)) : undefined;
        if (!user && !open) bad('Login required', 401);
        const out = await fn({ user, url, req, res, params: m.slice(1).map(decodeURIComponent), json: () => readJson(req) });
        return out === res ? undefined : sendJson(res, 200, out ?? { ok: true });
      }
      bad('Not found', 404);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
      else res.destroy();
    }
  });
}

if (fs.realpathSync(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const port = +process.env.PORT || 8788, host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`Aula on http://${host}:${port}`));
}
