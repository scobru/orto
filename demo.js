// Random demo content for the public demo account (ORTO_DEMO=1): notes, tasks, events, bookmarks, contacts, secrets and photos.
// Everything is fake. Written through the normal SDK, so it is encrypted exactly like real data.
import zlib from 'node:zlib';
import { generatePassword } from './orto.js';

const FIRST = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Elena', 'Matteo', 'Chiara', 'Paolo', 'Anna', 'Davide', 'Marta', 'Nico'];
const LAST = ['Rossi', 'Bianchi', 'Conti', 'Ferrari', 'Greco', 'Marino', 'Costa', 'Villa', 'Fontana', 'Serra'];
const CITIES = ['Lisbon', 'Kyoto', 'Bologna', 'Reykjavik', 'Oaxaca', 'Tallinn', 'Porto', 'Hanoi', 'Cape Town', 'Valparaíso'];
const ORGS = ['Studio Nord', 'Acme Labs', 'Café Aurora', 'Open Fields Co-op', 'Blue Door Press'];
const SITES = [
  ['https://developer.mozilla.org', 'MDN Web Docs', 'Dev/Reference'], ['https://www.sqlite.org', 'SQLite', 'Dev/Reference'],
  ['https://nodejs.org', 'Node.js', 'Dev/Reference'], ['https://en.wikipedia.org', 'Wikipedia', 'Reading'],
  ['https://www.openstreetmap.org', 'OpenStreetMap', 'Maps'], ['https://archive.org', 'Internet Archive', 'Reading'],
  ['https://news.ycombinator.com', 'Hacker News', 'Reading'], ['https://github.com', 'GitHub', 'Dev/Tools'],
  ['https://www.gutenberg.org', 'Project Gutenberg', 'Reading'], ['https://xkcd.com', 'xkcd', 'Fun']
];
const NOTES = [
  (r) => ({ title: `Trip to ${r.pick(CITIES)}`, cat: 'travel', body: '# Trip plan\n\n- [x] Book flights\n- [ ] Reserve a place to stay\n- [ ] Pack light\n- [ ] Offline maps\n\nLook for a local market on day two.\n\n#travel #plans' }),
  () => ({ title: 'Reading list', cat: 'general', body: '## To read\n\n- [ ] A book about maps\n- [ ] That long article on local-first software\n- [x] The SQLite file format page\n\n#reading' }),
  (r) => ({ title: `Dinner with ${r.pick(FIRST)}`, cat: 'general', body: 'Ideas:\n\n1. Fresh pasta, nothing fancy\n2. Something with lemons\n3. Plan dessert first\n\n#food #friends' }),
  () => ({ title: 'Weekly review', cat: 'work', body: '### What went well\n- Shipped the thing\n\n### What did not\n- Too many tabs open\n\n### Next week\n- [ ] Pick **three** priorities\n\n#review' }),
  () => ({ title: 'Project ideas', cat: 'research', body: '- A tiny RSS reader\n- Photo timeline that never leaves my server\n- Recipe scaler\n\n> Small and finished beats big and perfect.\n\n#ideas #projects' }),
  (r) => ({ title: `Garden notes (${r.pick(['spring', 'summer', 'autumn'])})`, cat: 'general', body: 'Tomatoes need staking.\n\n- [ ] Water on Tuesday\n- [ ] Order basil seeds\n\n#garden' }),
  () => ({ title: 'Meeting notes', cat: 'work', body: '**Attendees:** the whole team\n\n- Decision: keep it simple\n- Action: write it down (this note)\n\n#meetings' }),
  () => ({ title: 'Shopping list', cat: 'general', body: '- [ ] Olive oil\n- [ ] Coffee\n- [ ] Batteries\n- [x] Bread\n\n#home' }),
  () => ({ title: 'Quotes', cat: 'general', body: '> "Make it work, make it right, make it fast."\n\n> "Cultivate your garden."\n\n#quotes' }),
  () => ({ title: 'Learning Italian', cat: 'study', body: '| Word | Meaning |\n|---|---|\n| orto | vegetable garden |\n| scrigno | small chest |\n\n#study #italian' })
];
const TASKS = [
  ['Write the weekly summary', 'todo', 'medium', 2], ['Renew the domain', 'todo', 'high', 5], ['Fix the leaking tap', 'in_progress', 'medium', 1],
  ['Back up the server', 'todo', 'urgent', 0], ['Reply to the landlord', 'blocked', 'low', 7], ['Plan the trip', 'in_progress', 'medium', 14],
  ['Update the CV', 'done', 'low', -3], ['Buy a birthday present', 'todo', 'high', 3], ['Clean the desk', 'done', 'low', -1], ['Read the contract', 'todo', 'medium', 9]
];
const EVENTS = [
  ['Standup', 9, 0.5, 'Online'], ['Dentist', 15, 1, 'Via Roma 12'], ['Lunch with a friend', 13, 1.5, 'Café Aurora'], ['Yoga', 18, 1, 'Studio'],
  ['Call with the accountant', 11, 0.5, 'Phone'], ['Concert', 21, 2.5, 'Teatro Nuovo'], ['Review the budget', 10, 1, ''], ['Train to the coast', 8, 2, 'Central station']
];
const COLORS = ['#e04b4b', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];

const hsl = (h, s, l) => { // -> [r, g, b]
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
};
const crcChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
};
/** A smooth gradient with a few soft circles, as a PNG (no dependencies). */
export function makePng(w, h, r = { n: Math.random }) {
  const h1 = r.n() * 360, h2 = (h1 + 40 + r.n() * 120) % 360, c1 = hsl(h1, 0.65, 0.55), c2 = hsl(h2, 0.7, 0.45);
  const dots = Array.from({ length: 3 + Math.floor(r.n() * 3) }, () => ({ x: r.n() * w, y: r.n() * h, r: (0.12 + r.n() * 0.2) * w, c: hsl((h1 + r.n() * 90) % 360, 0.6, 0.75) }));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      let px = c1.map((v, i) => v + (c2[i] - v) * (y / h));
      for (const d of dots) { const k = Math.hypot(x - d.x, y - d.y) / d.r; if (k < 1) px = px.map((v, i) => v + (d.c[i] - v) * 0.6 * (1 - k * k)); }
      px.forEach((v, i) => { raw[row + 1 + x * 3 + i] = Math.round(v); });
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crcChunk('IHDR', ihdr), crcChunk('IDAT', zlib.deflateSync(raw)), crcChunk('IEND', Buffer.alloc(0))]);
}

const chunked = async (items, fn, n = 8) => { for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn)); };

/**
 * Fill an empty logged-in account (an Orto client) with random fake data.
 * @returns {Promise<{notes:number, tasks:number, events:number, bookmarks:number, contacts:number, secrets:number, photos:number}>}
 */
export async function seedDemo(os, { rng = Math.random, hours = 3 } = {}) {
  const r = { n: rng, pick: (a) => a[Math.floor(rng() * a.length)] };
  const shuffle = (a) => a.map(v => [rng(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  const day = 864e5, today = new Date(); today.setHours(0, 0, 0, 0);
  const jobs = [];

  jobs.push(() => os.writeVaultNote({ title: 'Welcome to the Orto demo', cat: 'general', pinned: true, body:
    `# Welcome 👋\n\nThis is a **demo account** full of made-up data. Everything you see is encrypted in your browser, exactly like a real account.\n\n- Change anything you like: it all resets every ${hours} hours.\n- Public links, the public blog and changing the password are switched off here.\n- Try the Tasks board, the Calendar, Photos and Secrets from the sidebar.\n\nTo keep your own data, run your own server: https://github.com/scobru/orto\n\n#welcome` }));
  const notes = shuffle(NOTES).slice(0, 7 + Math.floor(rng() * 3));
  for (const n of notes) jobs.push(() => os.writeVaultNote(n(r)));
  for (const [title, status, priority, due] of TASKS) jobs.push(() => os.writeTask({ title, status, priority, dueDate: today.getTime() + due * day, tags: [r.pick(['home', 'work', 'life'])] }));
  EVENTS.forEach(([title, hour, len, location], i) => {
    const start = today.getTime() + (i % 5 - 1 + Math.floor(rng() * 3)) * day + hour * 36e5;
    jobs.push(() => os.writeCalendarEvent({ title, start, end: start + len * 36e5, location, color: r.pick(COLORS), notes: 'Demo event' }));
  });
  for (const [url, title, folder] of shuffle(SITES)) jobs.push(() => os.writeBookmark({ url, title, folder, tags: [] }));
  const names = new Set();
  while (names.size < 7) names.add(`${r.pick(FIRST)} ${r.pick(LAST)}`);
  for (const name of names) jobs.push(() => os.writeContact({ name, emails: [name.toLowerCase().replace(' ', '.') + '@example.com'], phones: [`+1 555 01${String(Math.floor(rng() * 100)).padStart(2, '0')}`], org: r.pick(ORGS), tags: [r.pick(['friends', 'work', 'family'])] }));
  jobs.push(() => os.writeSecret({ name: 'Home Wi-Fi', kind: 'password', secret: generatePassword(16), notes: 'Demo only: not a real password', tags: ['home'] }));
  jobs.push(() => os.writeSecret({ name: 'Example account', kind: 'password', username: r.pick(FIRST).toLowerCase() + Math.floor(rng() * 90 + 10), secret: generatePassword(20), url: 'https://example.com', tags: [] }));
  jobs.push(() => os.writeSecret({ name: 'Sandbox API key', kind: 'api', secret: 'sk_demo_' + Array.from({ length: 24 }, () => Math.floor(rng() * 16).toString(16)).join(''), tags: ['dev'] }));
  jobs.push(() => os.writeSecret({ name: 'Locker code', kind: 'note', secret: 'Door 4, left shelf. Demo note.', tags: [] }));
  const photos = Array.from({ length: 8 }, (_, i) => i);
  await chunked(jobs, (j) => j());
  await chunked(photos, async (i) => {
    const full = makePng(480, 300, r), thumb = makePng(160, 100, r);
    await os.uploadFile(new Uint8Array(full), `${r.pick(['sunrise', 'harbour', 'market', 'forest', 'rooftops', 'lake', 'street', 'garden'])}-${i + 1}.png`,
      { type: 'image/png', thumb: 'data:image/png;base64,' + thumb.toString('base64'), addedAt: Date.now() - Math.floor(rng() * 60) * day });
  }, 4);
  return { notes: notes.length + 1, tasks: TASKS.length, events: EVENTS.length, bookmarks: SITES.length, contacts: names.size, secrets: 4, photos: photos.length };
}
