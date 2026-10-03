// Calendar roundtrip: encrypted at rest in graph, decrypts on read, range filter, delete.
import assert from 'assert';
import http from 'http';
import { ZenOS, parseBookmarksHtml, legacySmollogPair } from './zenos.js';
import { deriveMasterPair } from './identity.js';

// local in-process relay so the test needs no network
const ZEN = (await import('./zen.min.js')).default;
new ZEN({ web: http.createServer().listen(8765) });

const os = new ZenOS({ peers: ['ws://127.0.0.1:8765/zen'] });
await os.login('test-user', 'test-pass');

const { soul } = await os.writeCalendarEvent({ title: 'Dentist', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z', notes: 'secret' });
const raw = await new Promise((r) => os.userRoot.get('calendar').get(soul).once(r));
assert(!JSON.stringify(raw).includes('Dentist') && !JSON.stringify(raw).includes('secret'), 'plaintext leaked');

let evs = await os.readCalendarEvents({ timeoutMs: 500 });
assert.equal(evs.length, 1);
assert.equal(evs[0].title, 'Dentist');
assert.equal((await os.readCalendarEvents({ from: '2026-11-01', timeoutMs: 500 })).length, 0);

await os.deleteCalendarEvent(soul);
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
console.log('ok');
process.exit(0);
