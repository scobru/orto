// Test suite for Orto in Freenet native mode (mode: 'freenet')
import assert from 'node:assert/strict';
import { Orto } from './orto.js';

const clients = [];
const createClient = (opts = {}) => {
  const c = new Orto({ mode: 'freenet', ...opts });
  clients.push(c);
  return c;
};

try {
  console.log('1. Freenet mode: login and identity derivation');
  const orto1 = createClient();
  const pair1 = await orto1.login('fn_testidentity123', 'secret-key-64-hex-value-for-testing-freenet-identity-derivation');
  assert.equal(pair1.pub, 'fn_testidentity123');
  assert.equal(orto1.pub, 'fn_testidentity123');
  assert.ok(orto1.key, 'AES-GCM key derived');

  console.log('2. Freenet mode: writeVaultNote and readVaultNotes round trip');
  const orto2 = createClient();
  await orto2.login('fn_user_notes_test', 'secret-pass-for-notes-roundtrip');
  const os2 = orto2.personal();
  const note1 = await os2.writeVaultNote({ title: 'Nota Freenet 1', body: 'Contenuto segreto', cat: 'ideas', pinned: false });
  assert.ok(note1.soul.startsWith('vault-'));
  const note2 = await os2.writeVaultNote({ title: 'Nota Freenet 2 Pinned', body: 'Contenuto importante', cat: 'work', pinned: true });
  assert.ok(note2.soul.startsWith('vault-'));
  const notes = await os2.readVaultNotes();
  assert.equal(notes.length, 2);
  assert.equal(notes[0].title, 'Nota Freenet 2 Pinned');
  assert.equal(notes[1].title, 'Nota Freenet 1');
  const single = await os2.getVaultNote(note1.soul);
  assert.equal(single.title, 'Nota Freenet 1');
  assert.equal(single.body, 'Contenuto segreto');
  await os2.deleteVaultNote(note1.soul);
  assert.equal((await os2.readVaultNotes()).length, 1);

  console.log('3. Freenet mode: live onVaultNote event listener receives updates');
  const orto3 = createClient();
  await orto3.login('fn_user_events_test', 'secret-pass-for-events');
  const os3 = orto3.personal();
  const eventsReceived = [];
  const unsub3 = os3.onVaultNote((note, soul, isDeleted) => {
    eventsReceived.push({ note, soul, isDeleted });
  });
  const written = await os3.writeVaultNote({ title: 'Nota Live', body: 'Test live event', cat: 'test' });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(eventsReceived.length >= 1);
  const match = eventsReceived.find(e => e.soul === written.soul && !e.isDeleted);
  assert.ok(match, 'Live event for newly written note received');
  assert.equal(match.note.title, 'Nota Live');
  await os3.deleteVaultNote(written.soul);
  await new Promise(r => setTimeout(r, 20));
  const delMatch = eventsReceived.find(e => e.soul === written.soul && e.isDeleted);
  assert.ok(delMatch, 'Live event for deleted note received');
  unsub3();

  console.log('4. Freenet mode: persistence across simulated reload via window.name');
  globalThis.window = { name: '' };
  const s1 = createClient();
  await s1.login('fn_persistent_user', 'secret-key-for-persistence-test');
  const persNote = await s1.personal().writeVaultNote({ title: 'Nota Persistente', body: 'Deve sopravvivere al refresh', cat: 'archive' });
  assert.ok(globalThis.window.name.includes('Nota Persistente') === false, 'State in window.name is encrypted');
  assert.ok(globalThis.window.name.includes('__orto__'), 'window.name holds serialized orto store');
  const s2 = createClient();
  await s2.login('fn_persistent_user', 'secret-key-for-persistence-test');
  const reloaded = await s2.personal().readVaultNotes();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].soul, persNote.soul);
  assert.equal(reloaded[0].title, 'Nota Persistente');
  assert.equal(reloaded[0].body, 'Deve sopravvivere al refresh');
  delete globalThis.window;

  console.log('5. Freenet mode: P2P spaces and capability invite links');
  const orto5 = createClient();
  await orto5.login('fn_spaces_user', 'secret-key-for-spaces');
  const space = await orto5.createSpace('Mio Spazio P2P');
  assert.ok(space.spaceId.startsWith('sp_'));
  assert.equal(space.spaceName, 'Mio Spazio P2P');
  const spNote = await space.writeVaultNote({ title: 'Nota Condivisa', body: 'Visibile solo nello spazio' });
  assert.equal(spNote.status, 'saved');
  const spaceNotes = await space.readVaultNotes();
  assert.equal(spaceNotes.length, 1);
  assert.equal(spaceNotes[0].title, 'Nota Condivisa');
  const link = await space.createLink('editor');
  assert.ok(link.url.includes('#join=cap.'));
  assert.equal(link.role, 'editor');
  const members = await space.members();
  assert.ok(members.length >= 1);

  console.log('6. Freenet mode: AI settings persistence via safeStore and window.name');
  const ai = await import('./web/classifier.js');
  globalThis.safeStore = {
    _map: new Map(),
    getItem(k) { return this._map.get(k) ?? null; },
    setItem(k, v) { this._map.set(k, String(v)); },
    removeItem(k) { this._map.delete(k); }
  };
  assert.equal(ai.aiEnabled(), false, 'initial AI is false');
  ai.setAiEnabled(true);
  assert.equal(ai.aiEnabled(), true, 'AI is now enabled in safeStore');
  assert.equal(globalThis.safeStore.getItem('orto_ai_tags'), '1');
  ai.setAiEnabled(false);
  assert.equal(ai.aiEnabled(), false, 'AI is disabled');
  assert.equal(globalThis.safeStore.getItem('orto_ai_tags'), null);
  delete globalThis.safeStore;

  console.log('7. Freenet mode: safeStore shared store does not clobber notes across setItem calls');
  const sharedMap = new Map();
  globalThis.safeStore = {
    getItem(k) { return sharedMap.get(k) ?? null; },
    setItem(k, v) { sharedMap.set(k, String(v)); },
    removeItem(k) { sharedMap.delete(k); },
    keys(prefix = '') { return Array.from(sharedMap.keys()).filter(k => k.startsWith(prefix)); }
  };
  const orto7 = createClient();
  await orto7.login('fn_user_safestore', 'secret-pass-safestore');
  const os7 = orto7.personal();
  const n7 = await os7.writeVaultNote({ title: 'Nota Shared Store', body: 'Non deve essere cancellata da safeStore.setItem' });
  // Simulate cache and settings writes (which previously wiped out window.name/memStore)
  globalThis.safeStore.setItem('orto_cache_vault:fn_user_safestore', 'some-cache-blob');
  globalThis.safeStore.setItem('orto_theme', 'dark');
  globalThis.safeStore.setItem('orto_freenet_secret', 'secret-pass-safestore');

  const orto7b = createClient();
  await orto7b.login('fn_user_safestore', 'secret-pass-safestore');
  const reloadedNotes = await orto7b.personal().readVaultNotes();
  assert.equal(reloadedNotes.length, 1);
  assert.equal(reloadedNotes[0].soul, n7.soul);
  assert.equal(reloadedNotes[0].title, 'Nota Shared Store');
  console.log('8. Freenet mode: file and photo upload, listing, range read, and download');
  const orto8 = createClient();
  await orto8.login('fn_user_files', 'secret-pass-files');
  const os8 = orto8.personal();
  const testBytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  const upMeta = await os8.uploadFileChunked(testBytes, 'vacanza.jpg', {
    type: 'image/jpeg',
    thumb: 'data:image/jpeg;base64,abc123thumb',
    album: 'Vacanze 2026'
  });
  assert.ok(upMeta.id, 'File received a valid ID');
  assert.equal(upMeta.name, 'vacanza.jpg');
  assert.equal(upMeta.album, 'Vacanze 2026');
  assert.equal(upMeta.thumb, 'data:image/jpeg;base64,abc123thumb');

  const filesList = await os8.listFiles();
  assert.equal(filesList.length, 1);
  assert.equal(filesList[0].id, upMeta.id);
  assert.equal(filesList[0].name, 'vacanza.jpg');

  const downloaded = await os8.downloadFile(upMeta.id);
  assert.deepEqual(downloaded, testBytes, 'Downloaded bytes match uploaded bytes');

  const rangeBytes = await os8.readFileRange(upMeta.id, 2, 6);
  assert.deepEqual(rangeBytes, testBytes.subarray(2, 6), 'Range read matches byte range');

  await os8.deleteFile(upMeta.id);
  const afterDel = await os8.listFiles();
  assert.equal(afterDel.length, 0, 'File successfully deleted');

  console.log('9. Freenet mode: blog post publish, streaming, read, and delete');
  const orto9 = createClient();
  await orto9.login('fn_user_blog', 'secret-pass-blog');
  const blogEvents = [];
  const unsubBlog = orto9.onPost('fn_user_blog', (post, id, isDeleted) => {
    blogEvents.push({ post, id, isDeleted });
  });

  const pubRes = await orto9.publishBlogPost({
    title: 'Benvenuti su Freenet',
    content: '# Freenet\nUn blog sovrano e peer-to-peer.',
    tags: ['freenet', 'blog', 'crypto']
  });
  assert.ok(pubRes.id.startsWith('post-'), 'Post generated valid id');
  assert.equal(pubRes.status, 'published');

  await new Promise(r => setTimeout(r, 20));
  assert.ok(blogEvents.length >= 1, 'Stream received blog post event');
  const evMatch = blogEvents.find(e => e.id === pubRes.id && !e.isDeleted);
  assert.ok(evMatch, 'Live post event found');
  assert.equal(evMatch.post.title, 'Benvenuti su Freenet');
  assert.equal(evMatch.post.content, '# Freenet\nUn blog sovrano e peer-to-peer.');
  assert.deepEqual(evMatch.post.tags, ['freenet', 'blog', 'crypto']);

  const postsList = await orto9.readBlogPosts('fn_user_blog');
  assert.equal(postsList.length, 1);
  assert.equal(postsList[0].id, pubRes.id);
  assert.equal(postsList[0].title, 'Benvenuti su Freenet');
  assert.equal(postsList[0].content, '# Freenet\nUn blog sovrano e peer-to-peer.');

  const singlePost = await orto9.getBlogPost(pubRes.id, 'fn_user_blog');
  assert.ok(singlePost);
  assert.equal(singlePost.title, 'Benvenuti su Freenet');

  await orto9.deleteBlogPost(pubRes.id);
  await new Promise(r => setTimeout(r, 20));
  const delEv = blogEvents.find(e => e.id === pubRes.id && e.isDeleted);
  assert.ok(delEv, 'Post deletion event streamed');

  const afterDeletePosts = await orto9.readBlogPosts('fn_user_blog');
  assert.equal(afterDeletePosts.length, 0, 'Blog post list is empty after deletion');
  unsubBlog();

  console.log('10. Freenet mode: note linking to calendar events and tasks');
  const orto10 = createClient();
  await orto10.login('fn_user_linking', 'secret-pass-linking');
  const os10 = orto10.personal();

  const noteA = await os10.writeVaultNote({ title: 'Nota di Progetto', body: 'Dettagli architettura' });
  assert.ok(noteA.soul.startsWith('vault-'));

  const evA = await os10.writeCalendarEvent({
    title: 'Review Architettura',
    start: Date.now(),
    links: [{ kind: 'note', soul: noteA.soul }]
  });
  assert.ok(evA.soul.startsWith('cal-'));

  const calEvs = await os10.readCalendarEvents();
  assert.equal(calEvs.length, 1);
  assert.equal(calEvs[0].soul, evA.soul);
  assert.ok(calEvs[0].links && calEvs[0].links.length === 1);
  assert.equal(calEvs[0].links[0].soul, noteA.soul);

  const linkedEvents = await os10.eventsFor({ kind: 'note', soul: noteA.soul });
  assert.equal(linkedEvents.length, 1);
  assert.equal(linkedEvents[0].soul, evA.soul);

  const notesFromEv = await os10.notesForEvent(evA.soul);
  assert.equal(notesFromEv.length, 1);
  assert.equal(notesFromEv[0].soul, noteA.soul);
  assert.equal(notesFromEv[0].title, 'Nota di Progetto');

  const taskA = await os10.writeTask({
    title: 'Completare Specifica',
    links: [{ kind: 'note', soul: noteA.soul }]
  });
  assert.ok(taskA.soul.startsWith('task-'));

  const linkedTasks = await os10.tasksFor({ kind: 'note', soul: noteA.soul });
  assert.equal(linkedTasks.length, 1);
  assert.equal(linkedTasks[0].soul, taskA.soul);

  console.log('11. Freenet mode: self-contained public share links');
  const sh = await os10.shareNote(noteA.soul);
  assert.ok(sh.url.includes('#fshare='));
  const { readShare } = await import('./orto.js');
  const opened = await readShare(sh.url);
  assert.equal(opened.kind, 'note');
  assert.equal(opened.title, 'Nota di Progetto');
  assert.equal((await os10.listShares()).length, 1);
  await os10.unshare(sh.id);
  console.log('12. Freenet mode: chunk-based persistence via FreenetChunks');
  const chunkStore = new Map();
  globalThis.FreenetChunks = {
    putChunk: async (bytes) => {
      const addr = 'ch_' + chunkStore.size + '_' + Math.random().toString(36).slice(2, 8);
      chunkStore.set(addr, new Uint8Array(bytes));
      return addr;
    },
    getChunk: async (addr) => {
      const b = chunkStore.get(addr);
      if (!b) throw new Error('Chunk not found: ' + addr);
      return b;
    }
  };

  const testAudio = new Uint8Array(500);
  for (let i = 0; i < testAudio.length; i++) testAudio[i] = (i * 7) % 256;
  const audioMeta = await os10.uploadFileChunked(testAudio, 'Faso.mp3', { chunkSize: 150, type: 'audio/mpeg' });
  assert.ok(audioMeta.chunked);
  assert.ok(audioMeta.chunked.freenetChunks && audioMeta.chunked.freenetChunks.length === 4, 'Split into 4 chunks');
  assert.equal(chunkStore.size, 4, 'Chunks published to FreenetChunks');

  // Verify range read
  const rangePart = await os10.readFileRange(audioMeta.id, 50, 200, audioMeta);
  assert.deepEqual(rangePart, testAudio.subarray(50, 200));

  // Simulate full browser refresh: new client instance with EMPTY memory
  const ortoReloaded = createClient();
  await ortoReloaded.login('fn_user_linking', 'secret-pass-linking');
  const osReloaded = ortoReloaded.personal();
  assert.ok(!ortoReloaded._memFiles || ortoReloaded._memFiles.size === 0);

  // Download whole file from FreenetChunks
  const downloadedAudio = await osReloaded.downloadFile(audioMeta.id);
  assert.deepEqual(downloadedAudio, testAudio, 'Audio downloaded byte-for-byte across simulated reload');

  delete globalThis.FreenetChunks;

  console.log('13. Freenet mode: personal records replicate through the vault contract');
  // A stand-in for the network: verifies each record signature like contracts/vault and merges last-write-wins.
  const vaults = new Map(), listeners = new Map();
  const hexToU8 = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  globalThis.FreenetVault = {
    async getVault(params) { return vaults.has(params) ? structuredClone(vaults.get(params)) : null; },
    async pushVault(params, delta, exists) {
      assert.equal(exists, vaults.has(params), 'put the first time, update after');
      const pub = await crypto.subtle.importKey('raw', hexToU8(params.slice(0, 64)), { name: 'Ed25519' }, false, ['verify']);
      const state = vaults.get(params) || { records: {}, updated_at: 0 };
      for (const [k, r] of Object.entries(delta.records)) {
        const msg = `orto1|${params}|${k}|${r.updated_at}|${r.deleted}|${r.data}`;
        assert.ok(await crypto.subtle.verify('Ed25519', pub, hexToU8(r.sig), new TextEncoder().encode(msg)), 'record signed by the vault owner');
        const cur = state.records[k];
        if (!cur || [r.updated_at, r.sig] > [cur.updated_at, cur.sig]) state.records[k] = r;
      }
      vaults.set(params, state);
      for (const fn of listeners.get(params) || []) fn();
    },
    async onVaultUpdate(params, fn) { listeners.set(params, [...(listeners.get(params) || []), fn]); return () => {}; },
  };
  const settle = () => new Promise((r) => setTimeout(r, 400)); // the vault push is debounced
  const devA = createClient(), devB = createClient();
  await devA.login('fn_vault_user', 'vault-pass');
  const noteFromA = await devA.personal().writeVaultNote({ title: 'From A', body: 'replicated' });
  await settle();
  assert.equal(vaults.size, 1, 'one vault for this identity');
  await devB.login('fn_vault_user', 'vault-pass'); // another device: same password, same vault
  await settle();
  const vaultOf = (c) => c._vaults.get(c._vaultPrefix()).params;
  assert.equal(vaultOf(devA), vaultOf(devB));
  assert.equal((await devB.personal().getVaultNote(noteFromA.soul)).body, 'replicated');
  await devB.personal().deleteVaultNote(noteFromA.soul);
  await settle();
  assert.equal((await devA.personal().readVaultNotes()).length, 0, 'deletion reached device A');
  const other = createClient();
  await other.login('fn_vault_other', 'other-pass');
  await settle();
  assert.notEqual(vaultOf(other), vaultOf(devA), 'another user has another vault');

  // a shared space replicates between members who hold its key
  const spaceA = await devA.createSpace('Shared on Freenet');
  const shared = await spaceA.writeVaultNote({ title: 'For the team', body: 'hello' });
  const { url } = await spaceA.createLink('editor');
  await settle();
  const spaceOther = await other.joinLink(url);
  await settle();
  assert.equal(vaultOf(spaceOther), vaultOf(spaceA), 'members derive the same space vault');
  assert.notEqual(vaultOf(spaceA), vaultOf(devA), 'the space is not the personal vault');
  assert.equal((await spaceOther.getVaultNote(shared.soul)).body, 'hello');
  await spaceOther.writeVaultNote({ title: 'Reply', body: 'from the other member' });
  await settle();
  assert.ok((await spaceA.readVaultNotes()).some((n) => n.title === 'Reply'), 'a member write reached the owner');
  assert.equal((await devA.personal().readVaultNotes()).length, 0, 'space notes stay out of personal data');
  delete globalThis.FreenetVault;

  console.log('ok - all freenet tests passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  clients.forEach(c => c.close());
  process.exit(process.exitCode ?? 0);
}
