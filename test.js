// End-to-end: in-process server on a temp SQLite DB + SDK. Checks round trips, encryption at rest, isolation, files, live events.
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os_ from 'os';
import path from 'path';
import { createServer } from './server.js';
import { DatabaseSync } from 'node:sqlite';
import { Orto, ZenOS, readShare, parseBookmarksHtml, bookmarksToHtml, parseVcf, contactsToVcf, generatePassword, normalizeServer } from './orto.js';

const dir = fs.mkdtempSync(path.join(os_.tmpdir(), 'orto-test-'));
const server = createServer({ dataDir: dir, webDir: dir });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port;
const clients = [];
const client = async (user, pass, create = true) => { const c = new Orto({ server: url }); await c.login(user, pass, { create }); clients.push(c); return c; };
const raw = (c, coll, soul) => c._json('GET', `/c/${coll}/${soul}`); // what the server stores

assert.equal(normalizeServer('http://h:1/'), 'http://h:1');

console.log('1. Accounts');
const os = await client('Test-User', 'test-pass');
assert.equal(os.pub, 'test-user');
await assert.rejects(client('test-user', 'wrong', false), (e) => e.status === 401);
await assert.rejects(client('nobody', 'x', false), (e) => e.status === 404);
await assert.rejects(client('test-user', 'x', true), (e) => e.status === 409);
await assert.rejects(new Orto({ server: url })._json('GET', '/c/vault'), (e) => e.status === 401);
const sameLogin = await client('test-user', 'test-pass', false);
assert.equal((await os.encrypt({ a: 1 })).startsWith('e1.'), true);
assert.deepEqual(await sameLogin.decrypt(await os.encrypt({ a: 1 })), { a: 1 }); // same login, same key

console.log('2. Calendar');
const { soul } = await os.writeCalendarEvent({ title: 'Dentist', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z', notes: 'secret' });
assert(!JSON.stringify(await raw(os, 'calendar', soul)).match(/Dentist|secret/), 'plaintext leaked');
let evs = await os.readCalendarEvents();
assert.equal(evs.length, 1); assert.equal(evs[0].title, 'Dentist');
assert.equal((await os.readCalendarEvents({ from: '2026-11-01' })).length, 0);
await os.deleteCalendarEvent(soul);
assert.equal((await os.readCalendarEvents()).length, 0);

console.log('3. Bookmarks');
const HTML = `<DL><p><DT><H3 ADD_DATE="1">Bookmarks bar</H3><DL><p>
<DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="1700000000">Example &amp; A</A>
<DT><H3>Dev</H3><DL><p><DT><A HREF="https://dev.example/b" ADD_DATE="1700000100">Dev B</A></DL><p>
<DT><A HREF="javascript:alert(1)">evil</A></DL><p></DL><p>`;
const parsed = parseBookmarksHtml(HTML);
assert.equal(parsed.length, 2, 'javascript: dropped');
assert.deepEqual(parsed.map(b => b.folder), ['Bookmarks bar', 'Bookmarks bar/Dev']);
assert.equal(parsed[0].url, 'https://example.com/a?x=1&y=2');
assert.equal(parsed[0].addedAt, 1700000000000);
assert.deepEqual(await os.importBookmarksHtml(HTML), { imported: 2, failed: 0 });
await os.importBookmarksHtml(HTML); // no duplicates
const bms = await os.readBookmarks();
assert.equal(bms.length, 2);
assert(!/example|Dev/.test(JSON.stringify(await raw(os, 'bookmarks', bms[0].soul))), 'bookmark leaked');
assert.equal((await os.readBookmarks({ folder: 'Bookmarks bar/Dev' })).length, 1);
assert.equal((await os.readBookmarks({ query: 'EXAMPLE.com bar' })).length, 1);
assert.equal((await os.readBookmarks({ query: 'example nope' })).length, 0);
const dev = bms.find(b => b.title === 'Dev B');
assert.deepEqual(await os.updateBookmarks([{ soul: dev.soul, folder: 'Work/Dev', tags: ['x'] }, { soul: 'bm-nope', folder: 'Z' }]), { updated: 1, missing: ['bm-nope'], failed: 0 });
const moved = (await os.readBookmarks({ folder: 'Work' }))[0];
assert(moved.title === 'Dev B' && moved.url === dev.url && moved.addedAt === dev.addedAt && moved.tags[0] === 'x');
const exported = await os.exportBookmarksHtml();
const key = (b) => [b.url, b.title, b.folder, b.addedAt, (b.tags || []).join(',')].join('|');
assert.deepEqual(parseBookmarksHtml(exported).map(key).sort(), (await os.readBookmarks()).map(key).sort());
assert.equal(parseBookmarksHtml(bookmarksToHtml([{ url: 'https://a.example/?q="1"&r=<2>', title: 'T <b>', folder: 'A/B', addedAt: 5000, tags: [] }]))[0].url, 'https://a.example/?q="1"&r=<2>');
await os.deleteBookmark(bms[1].soul);
assert.equal(await os.getBookmark(bms[1].soul), null);

console.log('4. Vault + links');
const note = await os.writeVaultNote({ title: 'Meeting prep', body: 'agenda', cat: 'work' });
assert(!JSON.stringify(await raw(os, 'vault', note.soul)).match(/Meeting|agenda/), 'note leaked');
const ev = await os.writeCalendarEvent({ title: 'Meeting', start: Date.now() + 3600000 });
await os.linkToEvent(ev.soul, { soul: note.soul });
await os.linkToEvent(ev.soul, { soul: note.soul });
await os.linkToEvent(ev.soul, { kind: 'note', soul: 'vault-gone' });
assert.deepEqual((await os.getCalendarEvent(ev.soul)).links, [{ kind: 'note', soul: note.soul }, { kind: 'note', soul: 'vault-gone' }]);
assert.deepEqual((await os.eventsFor({ soul: note.soul })).map(e => e.soul), [ev.soul]);
assert.deepEqual((await os.notesForEvent(ev.soul)).map(n => n.title), ['Meeting prep']);
await assert.rejects(os.writeCalendarEvent({ soul: ev.soul, title: 'x', start: 1, links: [{ kind: 'url', soul: 'a' }] }));
await os.unlinkFromEvent(ev.soul, { soul: note.soul });
assert.equal((await os.eventsFor({ soul: note.soul })).length, 0);
await os.writeVaultNote({ title: 'Pinned', body: '', pinned: true });
assert.equal((await os.readVaultNotes())[0].title, 'Pinned');
assert.equal((await os.getVaultNote(note.soul)).title, 'Meeting prep');
await os.deleteVaultNote(note.soul);
assert.equal(await os.getVaultNote(note.soul), null);

console.log('5. Tasks');
const { soul: taskSoul } = await os.writeTask({ title: 'Build Bridge', priority: 'high', desc: 'Top secret blueprints', dueDate: '2026-12-01T00:00:00Z', tags: ['ai', 'core'], assignee: 'agent-007' });
assert(taskSoul.startsWith('task-'));
assert(!JSON.stringify(await raw(os, 'tasks', taskSoul)).match(/Bridge|secret/), 'task leaked');
const t = await os.getTask(taskSoul);
assert.deepEqual([t.title, t.status, t.priority, t.assignee, t.tags], ['Build Bridge', 'todo', 'high', 'agent-007', ['ai', 'core']]);
assert((await os.readTasks({ status: 'todo' })).some(x => x.soul === taskSoul));
assert(!(await os.readTasks({ status: 'done' })).some(x => x.soul === taskSoul));
await os.updateTask(taskSoul, { status: 'done' });
const done = await os.getTask(taskSoul);
assert.equal(done.status, 'done'); assert(done.completedAt > 0);
const taskNote = await os.writeVaultNote({ title: 'Specs', body: 'x' });
await os.linkToTask(taskSoul, { soul: taskNote.soul });
assert.deepEqual((await os.tasksFor({ soul: taskNote.soul })).map(x => x.soul), [taskSoul]);
const calForTask = await os.writeCalendarEvent({ title: 'Deadline', start: Date.now() + 7200000 });
await os.linkToEvent(calForTask.soul, { kind: 'task', soul: taskSoul });
assert.deepEqual((await os.eventsFor({ kind: 'task', soul: taskSoul })).map(e => e.soul), [calForTask.soul]);
await os.deleteTask(taskSoul);
assert.equal(await os.getTask(taskSoul), null);

console.log('6. Contacts');
const ct = await os.writeContact({ name: 'Ada Lovelace', emails: 'ada@example.com', phones: ['+39 333 1234567'], org: 'Analytical', notes: 'met at ETHRome', tags: '#friends, math' });
assert(!JSON.stringify(await raw(os, 'contacts', ct.soul)).match(/Ada|example\.com/), 'contact leaked');
await os.writeContact({ name: 'Bob', emails: ['bob@example.org'] });
const cts = await os.readContacts();
assert.deepEqual(cts.map(c => c.name), ['Ada Lovelace', 'Bob']);
assert.deepEqual(cts[0].tags, ['friends', 'math']);
assert.equal((await os.readContacts({ query: 'ethrome' })).length, 1);
assert.equal((await os.readContacts({ tag: '#math' })).length, 1);
const vcf = contactsToVcf([{ name: 'Smith, J; Jr', emails: ['j@x.io'], phones: ['1'], org: 'Org', notes: 'a\nb', tags: ['t1', 't2'] }]);
const vback = parseVcf(vcf)[0];
assert.equal(vback.name, 'Smith, J; Jr'); assert.equal(vback.notes, 'a\nb'); assert.deepEqual(vback.tags, ['t1', 't2']);
assert.equal((await os.importContactsVcf(vcf)).imported, 1);
await os.deleteContact(ct.soul);
assert.equal(await os.getContact(ct.soul), null);

console.log('7. Secrets');
const sc = await os.writeSecret({ name: 'GitHub', username: 'ada', secret: 'hunter2-XYZ', url: 'https://github.com', tags: 'dev' });
assert(!/GitHub|ada|hunter2/.test(JSON.stringify(await raw(os, 'secrets', sc.soul))), 'secret leaked');
await os.writeSecret({ name: 'Stripe key', kind: 'api', secret: 'sk_live_abc' });
assert.equal((await os.readSecrets()).length, 2);
assert.equal((await os.readSecrets({ kind: 'api' }))[0].name, 'Stripe key');
assert.equal((await os.readSecrets({ query: 'hunter2' })).length, 0);
await os.writeSecret({ soul: sc.soul, name: 'GitHub', username: 'ada', secret: 'new-pass', url: 'https://github.com' });
assert.equal((await os.getSecret(sc.soul)).secret, 'new-pass');
await assert.rejects(() => os.writeSecret({ name: 'x', secret: '' }));
await os.deleteSecret(sc.soul);
assert.equal(await os.getSecret(sc.soul), null);
const pw = generatePassword(24); assert.equal(pw.length, 24); assert.notEqual(pw, generatePassword(24));
assert.match(generatePassword(40, { symbols: false }), /^[A-Za-z0-9]+$/);

console.log('8. Files');
const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
const up = await os.uploadFile(bytes, 'photo.bin');
assert.equal(up.size, 5000); assert(up.encrypted);
const onDisk = fs.readFileSync(path.join(dir, 'files', '1', up.id));
assert(onDisk.length > 5000 && !onDisk.includes(Buffer.from(bytes.slice(0, 64))), 'file stored in clear');
assert.deepEqual(await os.downloadFile(up.id), bytes);
const pub = await os.uploadFile(new TextEncoder().encode('hello'), 'hello.txt', { encrypt: false });
assert.equal(new TextDecoder().decode(await os.downloadFile(pub.id)), 'hello');
assert.deepEqual((await os.listFiles()).map(f => f.name).sort(), ['hello.txt', 'photo.bin']);
const other = await client('mallory', 'pw');
await assert.rejects(other._fetch('GET', '/files/' + up.id), (e) => e.status === 404);
assert.deepEqual(await other.listFiles(), []);
await os.deleteFile(up.id);
assert.equal((await os.listFiles()).length, 1);
await assert.rejects(os._fetch('GET', '/files/' + up.id), (e) => e.status === 404);

console.log('9. Blog + isolation');
const post = await os.publishBlogPost({ title: 'Hello', content: '# Welcome', tags: ['zen', 'os'], id: 'post-1' });
assert.equal(post.id, 'post-1');
const anon = new Orto({ server: url }); // no login: public read
const read = await anon.readBlogPosts('Test-User');
assert.deepEqual([read[0].title, read[0].tags, read[0].authorAlias], ['Hello', ['zen', 'os'], 'test-user']);
assert.equal((await anon.getBlogPost('post-1', 'test-user')).content, '# Welcome');
assert.equal(await anon.resolveAlias('TEST-user'), 'test-user');
assert.equal(await anon.resolveAlias('ghost'), null);
assert.deepEqual(await other.readBlogPosts('mallory'), []);
assert.deepEqual(await other.readSecrets(), []); // other users see nothing of mine
await os.publishBlogPost({ title: 'Hello 2', content: 'x', id: 'post-1', createdAt: read[0].createdAt });
assert.equal((await os.getBlogPost('post-1')).title, 'Hello 2');
await os.deleteBlogPost('post-1');
assert.equal(await os.getBlogPost('post-1'), null);

console.log('10. Live events');
const seen = [];
const stop = sameLogin.onTask((tk, soul, deleted) => seen.push([tk?.title, deleted]));
await new Promise(r => setTimeout(r, 200));
const lt = await os.writeTask({ title: 'live one' });
await os.deleteTask(lt.soul);
for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise(r => setTimeout(r, 50));
assert.deepEqual(seen, [['live one', false], [undefined, true]]);
stop();

console.log('11. Public share links');
const sn = await os.writeVaultNote({ title: 'Shared note', body: '# Hi', cat: 'x' });
const shn = await os.shareNote(sn.soul);
assert(/\/s\/[a-f0-9]{32}#.{40,}$/.test(shn.url));
const rn = await readShare(shn.url); // anonymous: the key is only in the link
assert.deepEqual([rn.kind, rn.title, rn.body], ['note', 'Shared note', '# Hi']);
assert(!/Shared note|# Hi/.test(await (await fetch(url + '/api/s/' + shn.id)).text()), 'share stored in clear');
await assert.rejects(readShare(shn.url.replace(/#.*/, '#' + 'A'.repeat(43))), 'wrong key must fail');
const fbytes = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) % 256);
const sf0 = await os.uploadFile(fbytes, 'pic.png', { type: 'image/png' });
const shf = await os.shareFile(sf0.id);
const rf = await readShare(shf.url);
assert.deepEqual([rf.kind, rf.name, rf.type], ['file', 'pic.png', 'image/png']);
assert.deepEqual(rf.data, fbytes);
assert.deepEqual((await os.listShares()).map(x => x.id).sort(), [shn.id, shf.id].sort());
assert.equal((await os.listFiles()).find(f => f.id === sf0.id).type, 'image/png');
await assert.rejects(other._json('DELETE', '/s/' + shn.id), (e) => e.status === 404); // not yours to revoke
assert.equal((await readShare(shn.url)).title, 'Shared note');
await os.unshare(shn.id); await os.unshare(shf.id);
await assert.rejects(readShare(shn.url), (e) => e.status === 404);
await assert.rejects(readShare(shf.url), (e) => e.status === 404);
assert.deepEqual(await os.listShares(), []);
await os.deleteFile(sf0.id);

console.log('12. Export / import');
const dump = await os.exportAll();
assert.equal(dump.format, 'orto-export');
assert(dump.collections.vault.some(n => n.title === 'Shared note'));
const migrant = await client('migrant', 'pw-1');
const dn = await migrant.importAll(JSON.parse(JSON.stringify(dump)));
assert(dn.records >= 3 && dn.files === 1);
assert((await migrant._readAll('vault')).some(n => n.title === 'Shared note'));
const mf = (await migrant.listFiles())[0], of = (await os.listFiles())[0];
assert.equal(mf.name, of.name);
assert.deepEqual(await migrant.downloadFile(mf.id), await os.downloadFile(of.id));
assert.equal((await migrant.importAll(dump)).files, 0, 'files not duplicated');
await assert.rejects(migrant.importAll({}), /Not an Orto export/);

console.log('13. Change password');
const pwc = await client('pwc-user', 'old-pass');
const pn = await pwc.writeVaultNote({ title: 'Keep me', body: 'secret body' });
const pf = await pwc.uploadFile(fbytes, 'keep.bin');
const dev2 = await client('pwc-user', 'old-pass', false); // another signed-in device
await assert.rejects(pwc.changePassword(''), /required/);
await pwc.changePassword('new-pass');
await assert.rejects(client('pwc-user', 'old-pass', false), (e) => e.status === 401);
const np = await client('pwc-user', 'new-pass', false);
assert.equal((await np._get('vault', pn.soul)).title, 'Keep me');
assert.deepEqual(await np.downloadFile(pf.id), fbytes);
assert.equal((await pwc._get('vault', pn.soul)).title, 'Keep me'); // the client that changed it keeps working
await assert.rejects(dev2._json('GET', '/c/vault'), (e) => e.status === 401); // other sessions signed out
// interrupted run: everything re-encrypted but the login secret not swapped yet; re-running finishes it
const rs = await client('rs-user', 'a1');
const rn1 = await rs.writeVaultNote({ title: 'Resume', body: 'b' });
const realJson = rs._json.bind(rs);
rs._json = async (m, p, b) => { if (p === '/password') throw new Error('boom'); return realJson(m, p, b); };
await assert.rejects(rs.changePassword('b1'), /boom/);
const rs2 = await client('rs-user', 'a1', false); // old password still logs in
await rs2.changePassword('b1');
assert.equal((await (await client('rs-user', 'b1', false))._get('vault', rn1.soul)).title, 'Resume');

console.log('14. Backup');
const bdir = path.join(dir, 'backup-out');
server.backup(bdir);
const bdb = new DatabaseSync(path.join(bdir, 'orto.db'));
assert(bdb.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 5);
assert(bdb.prepare('SELECT COUNT(*) AS n FROM records').get().n > 0);
bdb.close();
assert(fs.readdirSync(path.join(bdir, 'files')).length > 0);
assert.throws(() => server.backup(bdir), /already exists/);

console.log('15. Compatibility with the ZenOS name');
assert.equal(ZenOS, Orto);
assert.equal((await migrant.importAll({ ...JSON.parse(JSON.stringify(dump)), format: 'zenos-export' })).files, 0, 'old export format still imports');
const legacyDir = path.join(dir, 'legacy');
fs.cpSync(bdir, legacyDir, { recursive: true });
fs.renameSync(path.join(legacyDir, 'orto.db'), path.join(legacyDir, 'zenos.db')); // data folder from before the rename
const old = createServer({ dataDir: legacyDir, webDir: dir });
await new Promise((r) => old.listen(0, '127.0.0.1', r));
const oldClient = new Orto({ server: 'http://127.0.0.1:' + old.address().port });
await oldClient.login('test-user', 'test-pass'); // same login, same keys as before the rename
assert((await oldClient._readAll('vault')).some(n => n.title === 'Shared note'));
assert(!fs.existsSync(path.join(legacyDir, 'orto.db')), 'must keep using zenos.db');
oldClient.close(); old.closeAllConnections(); old.close();

console.log('16. Demo account');
const ddir = path.join(dir, 'demo-data');
const dsrv = createServer({ dataDir: ddir, webDir: dir, demo: true, demoHours: 3 });
await new Promise((r) => dsrv.listen(0, '127.0.0.1', r));
const durl = 'http://127.0.0.1:' + dsrv.address().port;
const seeded = await dsrv.demoReady;
assert.deepEqual(await (await fetch(durl + '/api/config')).json(), { registration: 'open', maxUpload: 200 * 1024 * 1024, demo: { user: 'demo', pass: 'demo', hours: 3 } });
const dm = new Orto({ server: durl }); await dm.login('demo', 'demo');
const count = async () => ({ notes: (await dm._readAll('vault')).length, tasks: (await dm.readTasks()).length, events: (await dm._readAll('calendar')).length, bookmarks: (await dm.readBookmarks()).length,
  contacts: (await dm._readAll('contacts')).length, secrets: (await dm._readAll('secrets')).length, photos: (await dm.listFiles()).length });
assert.deepEqual(await count(), seeded);
assert(seeded.notes >= 8 && seeded.tasks >= 8 && seeded.events >= 6 && seeded.bookmarks >= 6 && seeded.contacts >= 6 && seeded.secrets >= 3 && seeded.photos === 8);
const ph = (await dm.listFiles())[0];
assert(ph.type === 'image/png' && ph.thumb.startsWith('data:image/png;base64,'));
assert.deepEqual([...(await dm.downloadFile(ph.id)).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a real PNG');
assert(!fs.readFileSync(path.join(ddir, 'zenos.db').replace('zenos.db', 'orto.db')).includes('Welcome to the Orto demo'), 'demo data stored in clear');
await assert.rejects(dm.changePassword('hijack'), (e) => e.status === 403); // would lock everyone out
assert.deepEqual(await count(), seeded, 'refused before re-encrypting anything')
await assert.rejects(dm._json('POST', '/password', { auth: 'x'.repeat(40), newAuth: 'y'.repeat(40) }), (e) => e.status === 403);
await assert.rejects(dm.shareNote((await dm._readAll('vault'))[0].soul), (e) => e.status === 403);
await assert.rejects(dm.publishBlogPost({ title: 'spam', content: 'x' }), (e) => e.status === 403);
const normal = new Orto({ server: durl }); await normal.login('someone', 'pw', { create: true }); // real accounts on the same server are unaffected
await normal.writeVaultNote({ title: 'mine', body: 'private' });
await normal.publishBlogPost({ title: 'ok', content: 'x' });
for (const n of await dm._readAll('vault')) await dm.deleteVaultNote(n.soul); // a visitor wipes the notes
assert.equal((await count()).notes, 0);
const again = await dsrv.resetDemo();
await assert.rejects(dm._json('GET', '/c/vault'), (e) => e.status === 401); // visitors are signed out by the reset
await dm.login('demo', 'demo');
assert.deepEqual(await count(), again); assert(again.notes >= 8, 'reset refills');
assert.equal((await normal._readAll('vault')).length, 1, 'reset leaves other users alone');
dm.close(); normal.close(); dsrv.closeAllConnections(); dsrv.close();
// a real account called "demo" is never wiped
const rdir = path.join(dir, 'demo-real');
const plain = createServer({ dataDir: rdir, webDir: dir });
await new Promise((r) => plain.listen(0, '127.0.0.1', r));
const real = new Orto({ server: 'http://127.0.0.1:' + plain.address().port }); await real.login('demo', 'not-the-demo-password', { create: true });
await real.writeVaultNote({ title: 'precious', body: 'x' }); real.close(); plain.closeAllConnections(); plain.close();
const guarded = createServer({ dataDir: rdir, webDir: dir, demo: true });
await new Promise((r) => guarded.listen(0, '127.0.0.1', r));
await assert.rejects(guarded.demoReady, /another password/);
const real2 = new Orto({ server: 'http://127.0.0.1:' + guarded.address().port }); await real2.login('demo', 'not-the-demo-password');
assert.equal((await real2._readAll('vault'))[0].title, 'precious'); real2.close(); guarded.closeAllConnections(); guarded.close();

console.log('Admin panel');
{
  const adir = path.join(dir, 'admin');
  const off = createServer({ dataDir: path.join(adir, 'off'), webDir: dir });
  await new Promise((r) => off.listen(0, '127.0.0.1', r));
  assert.equal((await fetch('http://127.0.0.1:' + off.address().port + '/api/admin/settings')).status, 404, 'off without ORTO_ADMIN_PASS');
  off.closeAllConnections(); off.close();
  const srv = createServer({ dataDir: path.join(adir, 'on'), webDir: dir, adminPass: 'admin-secret' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, p, body, token) => { const r = await fetch(base + '/api/admin/' + p, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) }); return Object.assign(await r.json(), { status: r.status }); };
  assert.equal((await call('POST', 'login', { pass: 'nope' })).status, 401);
  assert.equal((await call('GET', 'settings')).status, 401);
  const { token } = await call('POST', 'login', { pass: 'admin-secret' });
  const u = new Orto({ server: base }); await u.login('alice', 'pw', { create: true });
  assert.equal((await call('GET', 'settings', null, u.token || 'x')).status, 401, 'a user session is not an admin token');
  assert.equal((await call('PUT', 'settings', { registration: 'closed', quota: 12345 }, token)).settings.quota, 12345);
  assert.equal((await (await fetch(base + '/api/config')).json()).registration, 'closed', 'setting is live');
  assert.equal((await call('PUT', 'settings', { quota: -1 }, token)).status, 400);
  assert.equal((await call('PUT', 'settings', { registration: null, quota: null }, token)).settings.registration, 'open', 'null = env default');
  const users = await call('GET', 'users', null, token);
  assert.equal(users.length, 1); assert.equal(users[0].name, 'alice');
  assert(fs.existsSync(path.join((await call('POST', 'backup', null, token)).path, 'orto.db')));
  assert.equal((await call('DELETE', 'users/alice', null, token)).deleted, true);
  await assert.rejects(u._json('GET', '/c/vault'), (e) => e.status === 401, 'deleted user is signed out');
  assert.equal((await call('GET', 'users', null, token)).length, 0);
  u.close(); srv.closeAllConnections(); srv.close();
}

console.log('Folders and albums');
{
  const fo = await client('folders-user', 'pw');
  const a = await fo.uploadFile(new TextEncoder().encode('aaa'), 'a.txt', { folder: ' Docs / 2026 ' });
  const b = await fo.uploadFile(new TextEncoder().encode('bbb'), 'b.png', { type: 'image/png', album: 'Trip//Italy' });
  const c = await fo.uploadFile(new TextEncoder().encode('ccc'), 'c.txt');
  assert.equal(a.folder, 'Docs/2026'); assert.equal(b.album, 'Trip-Italy'); assert.equal(c.folder, undefined);
  assert(!JSON.stringify(await raw(fo, 'files', a.id)).includes('Docs'), 'folder name is encrypted at rest');
  await fo.addFileGroup('folder', 'Empty/Sub'); await fo.addFileGroup('album', 'Pets');
  assert.deepEqual(await fo.fileGroups(), { folders: ['Empty/Sub'], albums: ['Pets'], playlists: [] });
  assert.equal((await fo.listFiles()).length, 3, 'the groups record is not a file');
  await fo.moveFile(c.id, { folder: 'Docs' });
  assert.equal((await fo.moveFile(c.id, { album: 'Pets' })).folder, 'Docs', 'undefined keeps the other field');
  assert.equal((await fo.moveFile(c.id, { folder: '' })).folder, undefined, 'empty clears it');
  await fo.moveFile(c.id, { folder: 'Docs/2026/Tax' });
  assert.deepEqual(await fo.renameFileGroup('folder', 'Docs', 'Papers'), { name: 'Papers', moved: 2 });
  const byName = Object.fromEntries((await fo.listFiles()).map((f) => [f.name, f]));
  assert.equal(byName['a.txt'].folder, 'Papers/2026'); assert.equal(byName['c.txt'].folder, 'Papers/2026/Tax');
  const ex = await fo.exportAll();
  assert.deepEqual(await fo.renameFileGroup('album', 'Trip-Italy', ''), { name: '', moved: 1 }, 'removing keeps the file');
  assert.equal((await fo.listFiles()).find((f) => f.name === 'b.png').album, undefined);
  await fo.changePassword('pw2'); // re-encrypts the groups record too
  assert.deepEqual((await fo.fileGroups()).albums, ['Pets']);
  const fresh = await client('folders-copy', 'pw');
  await fresh.importAll(ex);
  const got = Object.fromEntries((await fresh.listFiles()).map((f) => [f.name, f]));
  assert.equal(got['a.txt'].folder, 'Papers/2026'); assert.equal(got['b.png'].album, 'Trip-Italy');
  assert.deepEqual(await fresh.fileGroups(), { folders: ['Empty/Sub'], albums: ['Pets'], playlists: [] }, 'empty folders survive export/import');
}

console.log('Landing page and app routes');
{
  const web = createServer({ dataDir: path.join(dir, 'web-routes') }); // default web folder
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const get = (p) => fetch('http://127.0.0.1:' + web.address().port + p);
  const about = await get('/about');
  assert.equal(about.status, 200); assert((await about.text()).includes('Your workspace'), '/about is the landing page');
  assert.equal((await get('/about/')).status, 200);
  const app = await get('/app/'); assert.equal(app.status, 200); assert((await app.text()).includes('login-screen'), '/app/ is the web app');
  assert.equal((await get('/app')).status, 200);
  assert.equal((await get('/app/vendor/fonts.css')).status, 200, 'assets resolve under /app too');
  assert.equal((await get('/vendor/fonts.css')).status, 200);
  assert.equal((await get('/app/../server.js')).status, 404, 'no path escape');
  web.closeAllConnections(); web.close();
}

console.log('On-device assistant model (add-on plumbing)');
{
  const llm = await import('./web/llm.js');
  assert.deepEqual(llm.parseToolCalls('<think>x</think><|tool_call_start|>[task_write(title="Pane, latte", priority="high", tags=["a","b"])]<|tool_call_end|>'),
    [{ name: 'task_write', arguments: { title: 'Pane, latte', priority: 'high', tags: ['a', 'b'] } }]);
  assert.deepEqual(llm.parseToolCalls('<|tool_call_start|>[note_list(), task_list(status="todo", limit=5)]<|tool_call_end|>').map((c) => c.name), ['note_list', 'task_list']);
  assert.deepEqual(llm.parseToolCalls('<|tool_call_start|>[x(a=foo bar)]<|tool_call_end|>'), [], 'malformed calls are dropped, not guessed');
  assert.equal(llm.stripThink('<think>abc</think>ciao'), 'ciao');
  assert.equal(llm.stripThink('<think>unfinished'), '');
  assert.equal(await llm.llmInstalled('http://127.0.0.1:1'), null, 'not installed when the server is unreachable');
}

console.log('On-device assistant (tool loop)');
{
  const { askAssistant, TOOLS } = await import('./web/assistant.js');
  assert(!TOOLS.some((t) => /delete|share|secret/.test(t[0])), 'no destructive, public or secret tool');
  const created = [], os = { readTasks: async () => [{ soul: 't1', title: 'Pane' }], writeTask: async (t) => { created.push(t.title); return { soul: 't2' }; } };
  const script = (...replies) => { const seen = []; return { seen, chat: async (msgs) => { seen.push(msgs.map((m) => m.role + ':' + m.content)); return replies.shift(); } }; };
  let s = script('<|tool_call_start|>[task_list()]<|tool_call_end|>', '<think>x</think>You have one task: Pane.');
  const hist = [];
  assert.equal(await askAssistant(os, 'what is open?', hist, { chat: s.chat }), 'You have one task: Pane.');
  assert(s.seen[1].some((m) => m.startsWith('tool:') && m.includes('Pane')), 'tool result goes back to the model');
  assert.equal(hist.length, 2, 'history keeps only the question and the final answer');
  s = script('<|tool_call_start|>[task_write(title="Latte")]<|tool_call_end|>', 'Not done.');
  await askAssistant(os, 'add Latte', [], { chat: s.chat, ask: async () => false });
  assert.deepEqual(created, [], 'a declined write never runs');
  s = script('<|tool_call_start|>[task_write(title="Latte")]<|tool_call_end|>', 'Done.');
  await askAssistant(os, 'add Latte', [], { chat: s.chat, ask: async (n, a) => n === 'task_write' && a.title === 'Latte' });
  assert.deepEqual(created, ['Latte'], 'an approved write runs');
  s = script('<|tool_call_start|>[delete(kind="note", id="x")]<|tool_call_end|>', '<|tool_call_start|>[task_write()]<|tool_call_end|>', 'Sorry.');
  assert.equal(await askAssistant(os, 'x', [], { chat: s.chat, ask: async () => true }), 'Sorry.');
  assert(s.seen[1].some((m) => m.includes('Unknown tool')) && s.seen[2].some((m) => m.includes('Missing argument')), 'bad calls are answered with an error, not run');
  s = script(...Array(4).fill('<|tool_call_start|>[task_list()]<|tool_call_end|>'));
  assert.match(await askAssistant(os, 'loop', [], { chat: s.chat }), /could not finish/, 'a looping model is stopped');
}

console.log('On-device tag suggestions (add-on plumbing)');
{
  const ai = await import('./web/classifier.js');
  assert.equal(ai.aiEnabled(), false, 'off by default');
  assert.equal(ai.emojiFor({ slug: 'technology', name: 'Technology & Software' }), '💻');
  assert.equal(ai.emojiFor({ slug: 'food-drink', name: 'Food & Drink' }), '🍳');
  assert.equal(ai.emojiFor({ slug: 'zzz', name: 'Unknown thing' }), '🏷️', 'neutral fallback');
  assert.equal(ai.tagFor({ slug: 'Arts & Culture!' }), 'arts-culture');
  ai.setClassifier({ classify: async (text, k) => { assert(!text.includes('http') && !text.includes('const x'), 'links and code are not sent to the model'); return [{ slug: 'technology', name: 'Technology & Software', score: 0.9 }].slice(0, k); } });
  assert.deepEqual(await ai.suggestTags('Intro https://example.com/x ```const x = 1``` to computers'), [{ tag: 'technology', label: 'Technology & Software', emoji: '💻', score: 0.9 }]);
  assert.deepEqual(await ai.suggestTags('  '), [], 'nothing to tag');
  ai.setClassifier({ emoji: async (text, k) => { assert(!text.includes('http'), 'links are not sent to the model'); return [{ emoji: '💰', confidence: 0.65 }, { emoji: '', confidence: 0.1 }].slice(0, k); } });
  assert.deepEqual(await ai.suggestEmoji('Pay my bills https://example.com'), [{ emoji: '💰', confidence: 0.65 }]);
  assert.deepEqual(await ai.suggestEmoji(' '), [], 'nothing to suggest');
  ai.setClassifier(null);

  // /models/* is <data>/models/* and nothing else of the data folder
  const mdir = path.join(dir, 'models-route');
  fs.mkdirSync(path.join(mdir, 'models', 'gist'), { recursive: true });
  fs.writeFileSync(path.join(mdir, 'models', 'gist', 'manifest.json'), '{"name":"gist"}');
  fs.writeFileSync(path.join(mdir, 'secret.txt'), 'nope');
  const ms = createServer({ dataDir: mdir });
  await new Promise((r) => ms.listen(0, '127.0.0.1', r));
  const mget = (p) => fetch('http://127.0.0.1:' + ms.address().port + p);
  assert.equal((await mget('/models/gist/manifest.json')).status, 200);
  assert.equal((await mget('/models/gist/missing.json')).status, 404);
  assert.equal((await mget('/models/../secret.txt')).status, 404, 'no path escape');
  assert.equal((await mget('/models/%2e%2e/secret.txt')).status, 404, 'no encoded path escape');
  assert.equal((await mget('/models/../orto.db')).status, 404);
  ms.closeAllConnections(); ms.close();
  const alt = path.join(dir, 'models-elsewhere'); // ORTO_MODELS / opts.modelsDir: a folder outside the data folder (the Docker image)
  fs.mkdirSync(path.join(alt, 'gist'), { recursive: true }); fs.writeFileSync(path.join(alt, 'gist', 'manifest.json'), '{}');
  const as = createServer({ dataDir: path.join(dir, 'models-data'), modelsDir: alt });
  await new Promise((r) => as.listen(0, '127.0.0.1', r));
  assert.equal((await fetch('http://127.0.0.1:' + as.address().port + '/models/gist/manifest.json')).status, 200);
  as.closeAllConnections(); as.close();
}

console.log('Feeds (reader + blog RSS)');
{
  const { parseFeed, parseOpml, feedsToOpml } = await import('./orto.js');
  const fs_ = createServer({ dataDir: path.join(dir, 'feeds'), webDir: dir, feedsPrivate: true, publicUrl: 'https://blog.example' });
  await new Promise((r) => fs_.listen(0, '127.0.0.1', r));
  const furl = 'http://127.0.0.1:' + fs_.address().port;
  const a = new Orto({ server: furl }); await a.login('writer', 'pw-feed', { create: true });
  await a.publishBlogPost({ title: 'First & <best>', content: 'Hello\n\nworld ]]> end' });
  const xml = await (await fetch(furl + '/blog/writer/feed.xml')).text();
  assert((await fetch(furl + '/blog/writer/feed.xml')).headers.get('content-type').includes('rss'));
  assert(xml.includes('<link>https://blog.example/blog/writer</link>') && xml.includes('First &amp; &lt;best&gt;'), 'rss shape');
  const parsed = parseFeed(xml);
  assert.equal(parsed.title, 'writer'); assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'First & <best>'); assert(parsed.items[0].content.includes('<p>world ]]&gt; end</p>') || parsed.items[0].content.includes('world ]]'), 'content kept');
  assert.equal((await fetch(furl + '/blog/nobody/feed.xml')).status, 404);
  // follow it from another account: relayed through the server, list stored encrypted
  const b = new Orto({ server: furl }); await b.login('reader', 'pw-read', { create: true });
  const found = await b.findFeed(furl + '/blog/writer/feed.xml');
  assert.equal(found.feed.items.length, 1);
  const rec = await b.addFeed(found.url, { title: found.feed.title, folder: 'Friends' });
  await b.addFeed(found.url); // same URL, same subscription
  const list = await b.readFeeds();
  assert.equal(list.length, 1); assert.equal(list[0].folder, 'Friends'); assert.equal(list[0].title, 'writer');
  assert(!JSON.stringify(await b._json('GET', '/c/feeds')).includes('writer/feed'), 'feed list leaked');
  await b.markFeedRead(list[0].soul, 123); assert.equal((await b.readFeeds())[0].readAt, 123);
  const opml = await b.exportFeedsOpml();
  assert.deepEqual(parseOpml(opml), [{ url: found.url, title: 'writer', folder: 'Friends' }]);
  const b2 = new Orto({ server: furl }); await b2.login('reader2', 'pw-read2', { create: true });
  assert.deepEqual(await b2.importFeedsOpml(opml), { imported: 1, failed: 0 });
  // a page that points at its feed
  const page = http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(`<html><head><link rel="alternate" type="application/rss+xml" href="${furl}/blog/writer/feed.xml"></head></html>`); });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  assert.equal((await b.findFeed('http://127.0.0.1:' + page.address().port + '/')).url, furl + '/blog/writer/feed.xml');
  await assert.rejects(b.findFeed(furl + '/about'), /No RSS|Not|404|502/);
  page.close();
  assert.throws(() => parseFeed('<html></html>'), /Not an RSS/);
  assert.equal(feedsToOpml([]).includes('<opml'), true);
  await assert.rejects(new Orto({ server: furl })._json('GET', '/feed?url=' + encodeURIComponent(furl)), (e) => e.status === 401);
  b.close(); b2.close(); a.close(); fs_.close();
  // by default private addresses are refused (SSRF), literal and resolved
  const ps = createServer({ dataDir: path.join(dir, 'feeds2'), webDir: dir });
  await new Promise((r) => ps.listen(0, '127.0.0.1', r));
  const c = new Orto({ server: 'http://127.0.0.1:' + ps.address().port }); await c.login('x1', 'pw-x1', { create: true });
  for (const u of ['http://127.0.0.1/', 'http://localhost:1/', 'http://[::1]/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd', 'ftp://x/'])
    await assert.rejects(c.fetchFeed(u), (e) => e.status === 400 || e.status === 502, u);
  c.close(); ps.close();
}

console.log('MCP server (stdio)');
{
  const { spawn } = await import('node:child_process');
  const os_mcp = await client('mcp-user', 'mcp-pass');
  const run = async (extraEnv, steps) => {
    const p = spawn(process.execPath, ['mcp.js'], { env: { ...process.env, ORTO_SERVER: url, ORTO_USER: 'mcp-user', ORTO_PASS: 'mcp-pass', ...extraEnv } });
    let buf = ''; const waiting = new Map();
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
    let n = 0;
    const rpc = (method, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    try { return await steps(rpc, (m, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params }) + '\n')); } finally { p.stdin.end(); }
  };
  const tool = async (rpc, name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { err: !!r.result.isError, text: r.result.content[0].text }; };
  await run({}, async (rpc, notify) => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'orto');
    notify('notifications/initialized');
    const names = (await rpc('tools/list')).result.tools.map((x) => x.name);
    assert(names.includes('note_write') && names.includes('delete') && !names.includes('secret_get'), 'secrets are off by default');
    assert.equal((await rpc('nope')).error.code, -32601);
    const w = await tool(rpc, 'note_write', { title: 'From an agent', body: 'hello #mcp' });
    const soul = JSON.parse(w.text).soul;
    assert(JSON.parse((await tool(rpc, 'note_list', { query: 'agent' })).text)[0].soul === soul);
    assert.equal(JSON.parse((await tool(rpc, 'note_get', { soul })).text).body, 'hello #mcp');
    const tk = JSON.parse((await tool(rpc, 'task_write', { title: 'T1', priority: 'high', tags: ['x'] })).text).soul;
    await tool(rpc, 'task_update', { soul: tk, status: 'done' });
    assert.equal(JSON.parse((await tool(rpc, 'task_list', { status: 'done' })).text)[0].title, 'T1');
    await tool(rpc, 'bookmark_add', { url: 'https://example.com/a', title: 'A' });
    assert.equal(JSON.parse((await tool(rpc, 'bookmark_list', {})).text).length, 1);
    await tool(rpc, 'event_write', { title: 'E', start: '2026-10-05T10:00:00Z' });
    assert.equal(JSON.parse((await tool(rpc, 'calendar_list', {})).text).length, 1);
    assert(!JSON.stringify(await raw(os_mcp, 'vault', soul)).includes('hello #mcp'), 'agent notes are encrypted at rest');
    assert((await tool(rpc, 'delete', { kind: 'bogus', id: 'x' })).err);
    assert((await tool(rpc, 'note_get', {})).text !== undefined);
    assert((await tool(rpc, 'nope_tool', {})).err);
    const J = async (name, args) => { const r = await tool(rpc, name, args); assert(!r.err, name + ': ' + r.text); try { return JSON.parse(r.text); } catch (_) { return r.text; } };
    // partial updates keep the other fields
    await J('note_update', { soul, pinned: true });
    assert.deepEqual([(await J('note_get', { soul })).title, (await J('note_get', { soul })).pinned], ['From an agent', true]);
    const evSoul = (await J('calendar_list', {}))[0].soul;
    await J('event_update', { soul: evSoul, notes: 'bring ID' });
    const ev = await J('event_get', { soul: evSoul }); assert.equal(ev.title, 'E'); assert.equal(ev.notes, 'bring ID');
    const ct = (await J('contact_write', { name: 'Ada', emails: ['a@x.org'] })).soul;
    await J('contact_update', { soul: ct, org: 'Lab' });
    const c2 = await J('contact_get', { soul: ct }); assert.deepEqual([c2.name, c2.org, c2.emails], ['Ada', 'Lab', ['a@x.org']]);
    const bm = (await J('bookmark_list', {}))[0].soul;
    await J('bookmark_update', { soul: bm, folder: 'Dev', tags: ['t'] });
    assert.equal((await J('bookmark_list', { folder: 'Dev' }))[0].title, 'A');
    // links
    await J('link_add', { owner: 'task', ownerSoul: tk, kind: 'note', soul });
    await J('link_add', { owner: 'event', ownerSoul: evSoul, kind: 'note', soul });
    const lk = await J('linked_list', { kind: 'note', soul }); assert.equal(lk.tasks.length, 1); assert.equal(lk.events.length, 1);
    await J('link_remove', { owner: 'task', ownerSoul: tk, kind: 'note', soul });
    assert.equal((await J('linked_list', { kind: 'note', soul })).tasks.length, 0);
    // files: text in, text out, moved, listed in groups; binary is not dumped
    const up = await J('file_write', { name: 'todo.txt', content: 'milk\neggs', folder: 'Home' });
    assert.equal((await J('file_read', { id: up.id })).content, 'milk\neggs');
    await J('file_move', { id: up.id, folder: 'Home/Lists' });
    assert.equal((await J('file_list', {}))[0].folder, 'Home/Lists');
    await J('file_group_add', { kind: 'playlist', name: 'Road' });
    assert((await J('file_groups', {})).playlists.includes('Road'));
    const bin = await J('file_write', { name: 'x.bin', content_base64: Buffer.from([0, 255, 1, 2]).toString('base64'), type: 'application/octet-stream' });
    assert(/Binary/.test((await J('file_read', { id: bin.id })).note));
    assert((await tool(rpc, 'file_write', { name: 'x', content: 'a', content_base64: 'YQ==' })).err);
    // public links: create, list (with url), revoke
    const sh = await J('share_note', { soul });
    assert(sh.url.includes('#'), 'share url carries the key');
    assert.equal((await J('share_list', {})).length, 1);
    await J('share_revoke', { id: sh.id });
    assert.equal((await J('share_list', {})).length, 0);
    // feeds (no network: added through the SDK)
    const fsoul = (await os_mcp.addFeed('https://feeds.example/a.xml', { title: 'A' })).soul;
    await J('feed_update', { soul: fsoul, title: 'Alpha', folder: 'News' });
    assert.deepEqual((await J('feed_list', {})).map((f) => [f.title, f.folder]), [['Alpha', 'News']]);
    assert.equal((await J('feed_mark_read', {})).marked, 1);
    const opml = await J('feed_export_opml', {}); assert(opml.includes('xmlUrl="https://feeds.example/a.xml"'));
    assert.deepEqual(await J('feed_import_opml', { opml: opml.replace('feeds.example/a', 'feeds.example/b') }), { imported: 1, failed: 0 });
    await tool(rpc, 'delete', { kind: 'note', id: soul });
    assert.equal((await tool(rpc, 'note_get', { soul })).text, 'null');
  });
  await run({ ORTO_MCP_READONLY: '1', ORTO_MCP_SECRETS: '1' }, async (rpc) => {
    const names = (await rpc('tools/list')).result.tools.map((x) => x.name);
    assert(names.includes('note_list') && names.includes('secret_get') && !names.includes('note_write') && !names.includes('delete'), 'read-only hides writes');
  });
  await run({ ORTO_PASS: 'wrong' }, async (rpc) => { // a bad login is a tool error, not a crash
    const r = await tool(rpc, 'note_list', {}); assert(r.err && /password/i.test(r.text), r.text);
  });
}

console.log('Docs in step with the CLI');
{
  const { execFileSync } = await import('node:child_process');
  const help = execFileSync(process.execPath, ['cli.js', '--help'], { encoding: 'utf8' });
  const skill = fs.readFileSync('SKILL.md', 'utf8');
  const missing = [...new Set([...help.matchAll(/node cli\.js ([a-z][\w-]*)/g)].map((m) => m[1]))].filter((c) => !new RegExp('(?<![\\w-])' + c + '(?![\\w-])').test(skill));
  assert.deepEqual(missing, [], 'CLI commands missing from SKILL.md: ' + missing);
}

console.log('Chunked files (big files, streaming)');
{
  const cu = await client('chunky', 'pw');
  const bytes = new Uint8Array(300000); for (let o = 0; o < bytes.length; o += 60000) crypto.getRandomValues(bytes.subarray(o, o + 60000));
  const prog = [];
  const m = await cu.uploadFileChunked(new Blob([bytes]), 'big.bin', { chunkSize: 100000, type: 'application/x-test', playlist: 'Mix', onProgress: (p) => prog.push(p) });
  assert.equal(m.size, 300000); assert.deepEqual(m.chunked.n, 3); assert.equal(m.playlist, 'Mix'); assert.deepEqual(prog.length, 3);
  const stored = fs.readdirSync(path.join(dir, 'files')).map((u) => path.join(dir, 'files', u, m.id)).find((p) => fs.existsSync(p));
  assert.equal(fs.statSync(stored).size, 300000 + 3 * 28, 'chunk overhead only, no base64');
  assert(!Buffer.from(fs.readFileSync(stored)).includes(Buffer.from(bytes.subarray(1000, 1032))), 'ciphertext at rest');
  assert.deepEqual(await cu.downloadFile(m.id), bytes, 'whole file');
  for (const [a, b] of [[0, 1], [99999, 100001], [100000, 200000], [250000, 300000], [5, 299999], [299999, 300000], [0, 300000]]) {
    assert.deepEqual(await cu.readFileRange(m.id, a, b), bytes.subarray(a, b), `range ${a}-${b}`);
  }
  assert.equal((await cu.readFileRange(m.id, 300000, 400000)).length, 0);
  // the server answers Range itself (the browser's media element and the service worker rely on it)
  const rget = (range) => fetch(url + '/api/files/' + m.id, { headers: { Authorization: 'Bearer ' + cu.token, ...(range && { Range: range }) } });
  let r = await rget('bytes=10-19'); assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 10-19/300084'); assert.equal((await r.arrayBuffer()).byteLength, 10);
  r = await rget('bytes=-5'); assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 5);
  r = await rget('bytes=300000-'); assert.equal(r.status, 206);
  r = await rget('bytes=999999-'); assert.equal(r.status, 416);
  r = await rget(); assert.equal(r.status, 200); assert.equal(r.headers.get('accept-ranges'), 'bytes');
  // tampering: swap two chunks, or cut the file short
  const good = fs.readFileSync(stored), P = 100000 + 28;
  fs.writeFileSync(stored, Buffer.concat([good.subarray(P, 2 * P), good.subarray(0, P), good.subarray(2 * P)]));
  await assert.rejects(cu.downloadFile(m.id), 'swapped chunks are detected');
  fs.writeFileSync(stored, good.subarray(0, 2 * P));
  await assert.rejects(cu.readFileRange(m.id, 0, 300000), 'a truncated file is detected');
  fs.writeFileSync(stored, good);
  // empty file, and a file that is not a multiple of the chunk size
  const e = await cu.uploadFileChunked(new Uint8Array(0), 'empty.bin');
  assert.equal((await cu.downloadFile(e.id)).length, 0);
  // password change re-encrypts chunked files chunk by chunk, in place
  await cu.changePassword('pw-new');
  assert.deepEqual(await cu.downloadFile(m.id), bytes, 'readable after the password change');
  const again = await client('chunky', 'pw-new', false);
  assert.deepEqual(await again.readFileRange(m.id, 150000, 160000), bytes.subarray(150000, 160000));
  await assert.rejects(client('chunky', 'pw', false), (er) => er.status === 401);
  // export / import (import re-uploads in the plain format) and public share keep working
  const ex2 = await again.exportAll();
  const copy = await client('chunky-copy', 'pw');
  await copy.importAll(ex2);
  const imp = (await copy.listFiles()).find((f) => f.name === 'big.bin');
  assert.deepEqual(await copy.downloadFile(imp.id), bytes); assert.equal(imp.playlist, 'Mix');
  const sh = await again.shareFile(m.id);
  assert.deepEqual((await readShare(sh.url)).data, bytes, 'a public link of a chunked file');
  // upload rules: offsets must line up, limits apply per append and a failed append can be retried
  const tiny = createServer({ dataDir: path.join(dir, 'tiny'), webDir: dir, maxUpload: 150 });
  await new Promise((rs) => tiny.listen(0, '127.0.0.1', rs));
  const tu = new Orto({ server: 'http://127.0.0.1:' + tiny.address().port }); await tu.login('tiny', 'pw', { create: true });
  const { id: tmp } = await tu._json('POST', '/files/begin');
  await tu._fetch('PUT', `/files/${tmp}/append`, new Uint8Array(100), undefined, { 'X-Offset': '0' });
  await assert.rejects(tu._fetch('PUT', `/files/${tmp}/append`, new Uint8Array(10), undefined, { 'X-Offset': '5' }), (er) => er.status === 409, 'wrong offset');
  await assert.rejects(tu._fetch('PUT', `/files/${tmp}/append`, new Uint8Array(100), undefined, { 'X-Offset': '100' }), (er) => er.status === 413, 'over the limit');
  assert.equal((await (await tu._fetch('PUT', `/files/${tmp}/append`, new Uint8Array(20), undefined, { 'X-Offset': '100' })).json()).size, 120, 'the failed append left the file at its last good size');
  await assert.rejects(tu._json('POST', '/files/aaaaaaaaaaaaaaaaaaaaaaaa/finish'), (er) => er.status === 404);
  assert.equal((await tu._json('POST', `/files/${tmp}/finish`)).size, 120);
  tu.close(); tiny.closeAllConnections(); tiny.close();
}

console.log('ok - all tests passed');
clients.forEach(c => c.close());
server.closeAllConnections();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
