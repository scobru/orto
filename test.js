// End-to-end: in-process server on a temp SQLite DB + SDK. Checks round trips, encryption at rest, isolation, files, live events.
import assert from 'assert';
import fs from 'fs';
import os_ from 'os';
import path from 'path';
import { createServer } from './server.js';
import { ZenOS, parseBookmarksHtml, bookmarksToHtml, parseVcf, contactsToVcf, generatePassword, normalizeServer } from './zenos.js';

const dir = fs.mkdtempSync(path.join(os_.tmpdir(), 'zenos-test-'));
const server = createServer({ dataDir: dir, webDir: dir });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port;
const clients = [];
const client = async (user, pass, create = true) => { const c = new ZenOS({ server: url }); await c.login(user, pass, { create }); clients.push(c); return c; };
const raw = (c, coll, soul) => c._json('GET', `/c/${coll}/${soul}`); // what the server stores

assert.equal(normalizeServer('http://h:1/'), 'http://h:1');

console.log('1. Accounts');
const os = await client('Test-User', 'test-pass');
assert.equal(os.pub, 'test-user');
await assert.rejects(client('test-user', 'wrong', false), (e) => e.status === 401);
await assert.rejects(client('nobody', 'x', false), (e) => e.status === 404);
await assert.rejects(client('test-user', 'x', true), (e) => e.status === 409);
await assert.rejects(new ZenOS({ server: url })._json('GET', '/c/vault'), (e) => e.status === 401);
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
const anon = new ZenOS({ server: url }); // no login: public read
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

console.log('ok - all tests passed');
clients.forEach(c => c.close());
server.closeAllConnections();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
