// Calendar roundtrip: encrypted at rest in graph, decrypts on read, range filter, delete.
import assert from 'assert';
import http from 'http';
import { ZenOS, parseBookmarksHtml } from './zenos.js';

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
await os.deleteBookmark(bms[0].soul);
assert.equal((await os.readBookmarks({ timeoutMs: 500 })).length, 1);
console.log('ok');
process.exit(0);
