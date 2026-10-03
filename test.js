// Calendar roundtrip: encrypted at rest in graph, decrypts on read, range filter, delete.
import assert from 'assert';
import http from 'http';
import { ZenOS } from './zenos.js';

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
console.log('ok');
process.exit(0);
