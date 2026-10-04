// Calendar roundtrip: encrypted at rest in graph, decrypts on read, range filter, delete.
import assert from 'assert';
import http from 'http';
import osmod from 'os';
import path from 'path';

process.env.ZENOS_CACHE_FILE = path.join(osmod.tmpdir(), `zenos-test-cache-${Date.now()}.json`);

const { ZenOS, parseBookmarksHtml, bookmarksToHtml, legacySmollogPair } = await import('./zenos.js');
const { deriveMasterPair } = await import('./identity.js');

// local in-process relay so the test needs no network
const ZEN = (await import('./zen.min.js')).default;
new ZEN({ web: http.createServer().listen(8765) });

console.log('1. Starting test...');
const os = new ZenOS({ peers: ['ws://127.0.0.1:8765/zen'], localStorage: true, radisk: true });
await os.login('test-user', 'test-pass');
console.log('2. Logged in');

const { soul } = await os.writeCalendarEvent({ title: 'Dentist', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z', notes: 'secret' });
console.log('3. Wrote calendar event');
const raw = await new Promise((r) => os.userRoot.get('calendar').get(soul).once(r));
assert(!JSON.stringify(raw).includes('Dentist') && !JSON.stringify(raw).includes('secret'), 'plaintext leaked');

let evs = await os.readCalendarEvents({ timeoutMs: 500 });
console.log('4. Read calendar events:', evs.length);
assert.equal(evs.length, 1);
assert.equal(evs[0].title, 'Dentist');
assert.equal((await os.readCalendarEvents({ from: '2026-11-01', timeoutMs: 500 })).length, 0);

await os.deleteCalendarEvent(soul);
console.log('5. Deleted calendar event');
assert.equal((await os.readCalendarEvents({ timeoutMs: 500 })).length, 0);

// Bookmarks: Brave-style export parse + encrypted import roundtrip + dedup + filters
const HTML = `<DL><p><DT><H3 ADD_DATE="1">Bookmarks bar</H3><DL><p>
<DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="1700000000">Example &amp; A</A>
<DT><H3>Dev</H3><DL><p><DT><A HREF="https://dev.example/b" ADD_DATE="1700000100">Dev B</A></DL><p>
<DT><A HREF="javascript:alert(1)">evil</A></DL><p></DL><p>`;
const parsed = parseBookmarksHtml(HTML);
assert.equal(parsed.length, 2, 'javascript: dropped');
assert.deepEqual(parsed.map(b => b.folder), ['Bookmarks bar', 'Bookmarks bar/Dev']);
assert.equal(parsed[0].url, 'https://example.com/a?x=1&y=2');
assert.equal(parsed[0].title, 'Example & A');
assert.equal(parsed[0].addedAt, 1700000000000);

assert.deepEqual(await os.importBookmarksHtml(HTML), { imported: 2, failed: 0 });
await os.importBookmarksHtml(HTML); // re-import must not duplicate
const bms = await os.readBookmarks({ timeoutMs: 500 });
assert.equal(bms.length, 2);
assert.equal((await os.readBookmarks({ folder: 'Bookmarks bar/Dev', timeoutMs: 500 })).length, 1);
assert.equal((await os.readBookmarks({ query: 'example & a', timeoutMs: 500 })).length, 1);
const braw = await new Promise((r) => os.userRoot.get('bookmarks').get(bms[0].soul).once(r));
assert(!/example|Dev/.test(JSON.stringify(braw)), 'bookmark plaintext leaked');
// agent-style reorganisation: move by soul, keep url/addedAt, report unknown souls
const dev = bms.find(b => b.title === 'Dev B');
assert.deepEqual(await os.updateBookmarks([{ soul: dev.soul, folder: 'Work/Dev', tags: ['x'] }, { soul: 'bm-nope', folder: 'Z' }]), { updated: 1, missing: ['bm-nope'], failed: 0 });
const moved = (await os.readBookmarks({ folder: 'Work', timeoutMs: 500 }))[0];
assert(moved.title === 'Dev B' && moved.url === dev.url && moved.addedAt === dev.addedAt && moved.tags[0] === 'x');
// export is the inverse of import: parse(export(x)) gives x back, entities and tags included
const exported = await os.exportBookmarksHtml({ timeoutMs: 500 });
const back = parseBookmarksHtml(exported);
const key = (b) => [b.url, b.title, b.folder, b.addedAt, (b.tags || []).join(',')].join('|');
const now = await os.readBookmarks({ timeoutMs: 500 });
assert.deepEqual(back.map(key).sort(), now.map(key).sort());
assert(exported.includes('Example &amp; A') && exported.includes('TAGS="x"'));
assert.equal(parseBookmarksHtml(bookmarksToHtml([{ url: 'https://a.example/?q="1"&r=<2>', title: 'T <b> "q"', folder: 'A/B', addedAt: 5000, tags: [] }]))[0].url, 'https://a.example/?q="1"&r=<2>');
await os.deleteBookmark(bms[0].soul);
assert.equal((await os.readBookmarks({ timeoutMs: 500 })).length, 1);

// Identity: FID derivation (identity.js), pinned vector shared with fid; the older schemes differ from it
const ZENlib = (await import('./zen.min.js')).default;
assert.equal((await deriveMasterPair(ZENlib, 'alice', 'correct horse battery staple')).pub, '0QVOEafmRes1AeAnUMav9avHzAf7OnW4yB0wwSMKBKCY0');
assert.equal((await legacySmollogPair('Scobru', 'pw')).pub, '0Dxl7yX7XKZU5pbgBRpQaVCMeSZwNJsqypyQvo5Lu5dr0');
assert.equal(os.legacyPairs.length, 2);
assert(os.legacyPairs.every(p => p.pub !== os.pub));

// Migration: data under either earlier identity (smollog PBKDF2, plain user+pass) shows up (re-encrypted) under the new pub, idempotently
const [L, L2] = os.legacyPairs, lput = (path, soul, v, P = L) => new Promise((r) => os.zen.get('~' + P.pub).get(path).get(soul).put(v, r, { authenticator: P }));
await lput('vault', 'vault-old', { title: await ZEN.encrypt('Old title', L), body: await ZEN.encrypt('Old body', L), cat: await ZEN.encrypt('c', L), pinned: true, trash: false, timestamp: 1, encrypted: true });
await lput('calendar', 'cal-old', { data: await ZEN.encrypt({ title: 'Old ev', start: 5, end: 6 }, L2), updatedAt: 1, encrypted: true }, L2); // oldest scheme (user + pass)
await lput('bookmarks', 'bm-old', { data: await ZEN.encrypt({ url: 'https://old.example', title: 'Old bm', folder: '', tags: [], addedAt: 1 }, L), updatedAt: 1, encrypted: true });
assert.equal((await os.readVaultNotes(500)).length, 0, 'nothing under new pub yet');
assert.deepEqual(await os.migrateLegacy(1000), { migrated: 3, skipped: 0, failed: 0 });
assert.deepEqual(await os.migrateLegacy(1000), { migrated: 0, skipped: 3, failed: 0 });
const [n] = await os.readVaultNotes(500);
assert(n.title === 'Old title' && n.body === 'Old body' && n.pinned);
assert.equal((await os.readCalendarEvents({ timeoutMs: 500 })).find(e => e.title === 'Old ev').soul, 'cal-old');
assert((await os.readBookmarks({ timeoutMs: 500 })).some(b => b.title === 'Old bm'));
// Links: note <-> event, stored in the encrypted event; idempotent, validated, dangling links skipped
const note = await os.writeVaultNote({ title: 'Meeting prep', body: 'agenda', cat: 'work' });
const ev = await os.writeCalendarEvent({ title: 'Meeting', start: Date.now() + 3600000 });
await os.linkToEvent(ev.soul, { soul: note.soul });
await os.linkToEvent(ev.soul, { soul: note.soul });
await os.linkToEvent(ev.soul, { kind: 'note', soul: 'vault-gone' });
assert.deepEqual((await os.getCalendarEvent(ev.soul)).links, [{ kind: 'note', soul: note.soul }, { kind: 'note', soul: 'vault-gone' }]);
assert.deepEqual((await os.eventsFor({ soul: note.soul }, 500)).map(e => e.soul), [ev.soul]);
assert.deepEqual((await os.notesForEvent(ev.soul, 500)).map(n => n.title), ['Meeting prep']);
const raw2 = await new Promise((r) => os.userRoot.get('calendar').get(ev.soul).once(r));
assert(!JSON.stringify(raw2).includes(note.soul), 'link target leaked in clear');
await assert.rejects(os.writeCalendarEvent({ soul: ev.soul, title: 'x', start: 1, links: [{ kind: 'url', soul: 'a' }] }));
await os.unlinkFromEvent(ev.soul, { soul: note.soul });
assert.equal((await os.eventsFor({ soul: note.soul }, 500)).length, 0);

// Vault single get & delete
const singleNote = await os.getVaultNote(note.soul);
assert.equal(singleNote.title, 'Meeting prep');
await os.deleteVaultNote(note.soul);
assert.equal(await os.getVaultNote(note.soul), null);

// Bookmarks single get & delete
const singleBm = await os.getBookmark(bms[1].soul);
assert.ok(singleBm && singleBm.url);
await os.deleteBookmark(bms[1].soul);
assert.equal(await os.getBookmark(bms[1].soul), null);

// Blog / smollog CRUD & alias
const blogRes = await os.publishBlogPost({ title: 'Hello Sovereign World', content: '# Welcome to ZenOS', tags: ['zen', 'os'], id: 'post-test-1' });
assert.equal(blogRes.id, 'post-test-1');
const singlePost = await os.getBlogPost('post-test-1', os.pub);
assert.equal(singlePost.title, 'Hello Sovereign World');
assert.deepEqual(singlePost.tags, ['zen', 'os']);

const blogList = await os.readBlogPosts(os.pub, 500);
assert.ok(blogList.some(p => p.id === 'post-test-1'));

await os.registerAlias('tester');
const resolvedPub = await os.resolveAlias('tester');
assert.equal(resolvedPub, os.pub);

await os.deleteBlogPost('post-test-1');
const deletedPost = await os.getBlogPost('post-test-1', os.pub);
assert.equal(deletedPost, null);

console.log('ok - all CRUD tests passed');
process.exit(0);
