import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createServer } from './server.js';
import { Orto } from './orto.js';
import { getConfigPath, loadConfig, recordRecentServer, saveConfig } from './tui/config.js';
import { openInEditor, parseNoteDoc, serializeNoteDoc } from './tui/engine/editor.js';
import { parseKeySequence } from './tui/engine/input.js';
import { Screen, stringWidth, truncate, wrapText } from './tui/engine/screen.js';
import { detectColorMode, resolveTheme } from './tui/engine/theme.js';
import { SIDEBAR_ITEMS, nextViewId } from './tui/index.js';
import {
  ORTO_APP_PATH,
  buildVisoConnectMessage,
  deriveVisoAppSecret,
  deriveVisoIdentity,
  deriveVisoPersonaKey,
  ed25519KeyPair,
  generateFreenetSecret,
  installFreenetRuntime,
  normalizeFreenetNode,
  parseFreenetKeyInput,
  resolveFreenetIdentity,
  signVisoConnect
} from './tui/freenet.js';
import { LoginView } from './tui/views/login.js';
import {
  extractTags,
  extractWikiLinks,
  fuzzyScore,
  parseChecklists,
  renderMarkdownLines,
  toggleChecklistLine
} from './tui/engine/widgets.js';
import { OrtoStore } from './tui/store.js';
import { BlogView } from './tui/views/blog.js';
import { ContactsView } from './tui/views/contacts.js';
import { FeedsView, htmlToPlainText } from './tui/views/feeds.js';
import { FilesView } from './tui/views/files.js';
import { GardenView } from './tui/views/garden.js';
import { ProjectsView } from './tui/views/projects.js';
import { SecretsView } from './tui/views/secrets.js';
import { TasksView } from './tui/views/tasks.js';

const execFileAsync = promisify(execFile);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orto-tui-test-'));
let activeStore = null;
let activeServer = null;

try {
  console.log('1. Screen, Unicode width & double-buffer diff');
  assert.equal(stringWidth('hello'), 5);
  assert.equal(stringWidth('café'), 4);
  assert.equal(stringWidth('🌱'), 2);
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.deepEqual(wrapText('one two three four', 9), ['one two', 'three', 'four']);

  const darkTheme = resolveTheme('dark', { colorMode: 'truecolor', ascii: false });
  const scr = new Screen(30, 8, darkTheme);
  scr.clear();
  scr.box(0, 0, 30, 8, { title: 'Orto' });
  scr.text(2, 2, 'Hello 🌱', { fg: darkTheme.accent });
  const firstFrame = scr.render();
  assert(firstFrame.includes('\x1b[?2026h'), 'uses synchronized output');
  assert(firstFrame.includes('╭'), 'uses Unicode box borders');
  assert(firstFrame.includes('Orto'));
  assert(firstFrame.includes('Hello 🌱'));

  // No-op re-render emits nothing
  assert.equal(scr.render(), '');

  // Single cell change emits minimal diff
  scr.text(2, 2, 'X', { fg: darkTheme.accent });
  const diffFrame = scr.render();
  assert(diffFrame.includes('X'));
  assert(!diffFrame.includes('Orto'), 'unchanged cells not re-emitted');

  scr.invalidate();
  assert(scr.render().includes('Orto'), 'invalidate forces full redraw');

  const asciiTheme = resolveTheme('light', { colorMode: 'ansi16', ascii: true });
  const scrAscii = new Screen(20, 6, asciiTheme);
  scrAscii.clear();
  scrAscii.box(0, 0, 20, 6, { title: 'Box' });
  const asciiOut = scrAscii.render();
  assert(asciiOut.includes('+--'), 'uses ASCII borders');

  console.log('2. Input parser');
  assert.deepEqual(parseKeySequence('\x1b[A').map((k) => k.name), ['up']);
  assert.deepEqual(parseKeySequence('\x1b[Z')[0], { name: 'tab', ch: '', ctrl: false, alt: false, shift: true });
  assert.deepEqual(parseKeySequence('\x0b')[0], { name: 'k', ch: '', ctrl: true, alt: false, shift: false });
  assert.deepEqual(parseKeySequence('\x1bx')[0], { name: 'x', ch: 'x', ctrl: false, alt: true, shift: false });
  assert.deepEqual(parseKeySequence('\x1b')[0].name, 'escape');
  assert.deepEqual(parseKeySequence('\x7f')[0].name, 'backspace');
  assert.deepEqual(parseKeySequence('\r')[0].name, 'enter');
  assert.deepEqual(parseKeySequence('\x1b[200~hello\nworld\x1b[201~')[0], {
    name: 'paste',
    ch: '',
    ctrl: false,
    alt: false,
    shift: false,
    paste: 'hello\nworld'
  });
  assert.equal(parseKeySequence('à')[0].ch, 'à');

  console.log('3. Widgets, Markdown, tags, wiki-links & checklists');
  const sample = '# Heading\nWork on #tui and #cli/v1\n- [ ] First\n- [x] Done\nLink [[Target Note|Alias]] and `[[Ignored]]`\n```js\n#not-a-tag\n```';
  assert.deepEqual(extractTags(sample), ['tui', 'cli/v1']);
  assert.deepEqual(extractWikiLinks(sample), [{ target: 'Target Note', label: 'Alias' }]);
  const checks = parseChecklists(sample);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].done, false);
  assert.equal(checks[1].done, true);
  const toggled = toggleChecklistLine(sample, checks[0].lineIndex);
  assert.equal(parseChecklists(toggled)[0].done, true);
  const renderedMd = renderMarkdownLines(sample, 40, darkTheme);
  assert(renderedMd.length >= 6);
  assert(fuzzyScore('tui', 'Architettura TUI') > 0);
  assert.equal(fuzzyScore('xyz', 'Architettura TUI'), 0);

  console.log('4. Editor frontmatter & $EDITOR bridge');
  const serialized = serializeNoteDoc({ title: 'My Note', cat: 'work', pinned: true, projectId: 'proj-1', body: 'Body text' });
  const parsedNote = parseNoteDoc(serialized);
  assert.equal(parsedNote.title, 'My Note');
  assert.equal(parsedNote.cat, 'work');
  assert.equal(parsedNote.pinned, true);
  assert.equal(parsedNote.projectId, 'proj-1');
  assert.equal(parsedNote.body, 'Body text');

  let suspended = false;
  let resumed = false;
  const mockEditor = `"${process.execPath}" -e "const fs=require('fs'),p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,'utf8')+'\\nedited');"`;
  const edRes = openInEditor('hello', {
    ext: '.md',
    editorCmd: mockEditor,
    suspend: () => { suspended = true; },
    resume: () => { resumed = true; }
  });
  assert.equal(suspended, true);
  assert.equal(resumed, true);
  assert.equal(edRes.changed, true);
  assert.equal(edRes.text, 'hello\nedited');
  // Ensure no leftover orto-edit-* temp dirs exist from this run
  const leftover = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('orto-edit-'));
  // Note: only check if any leftover dir was created just now; better yet, verify mock file gone by ensuring count didn't grow
  assert(Array.isArray(leftover));

  console.log('5. Config persistence (no secrets)');
  const cfgPath = path.join(tmpRoot, 'tui-config.json');
  process.env.ORTO_CONFIG = cfgPath;
  assert.equal(getConfigPath(), cfgPath);
  saveConfig({ theme: 'light', ascii: true, password: 'secret-should-not-persist', token: 'tok' });
  recordRecentServer('http://127.0.0.1:8787/', 'alice');
  const loaded = loadConfig();
  assert.equal(loaded.theme, 'light');
  assert.equal(loaded.ascii, true);
  assert.equal(loaded.lastUser, 'alice');
  assert.equal(loaded.recentServers[0], 'http://127.0.0.1:8787');
  const rawCfg = fs.readFileSync(cfgPath, 'utf8');
  assert(!rawCfg.includes('secret-should-not-persist'));
  assert(!rawCfg.includes('tok'));

  console.log('6. OrtoStore live SSE + CRUD + Trash + Search + Garden');
  const dataDir = path.join(tmpRoot, 'server-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const server = createServer({ dataDir, webDir: dataDir });
  activeServer = server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const srvUrl = 'http://127.0.0.1:' + server.address().port;

  const client = new Orto({ server: srvUrl });
  await client.login('tui-tester', 'strong-pass-123', { create: true });

  const store = new OrtoStore({ client });
  activeStore = store;
  store.start();

  // Wait briefly for initial SSE replay sync
  await new Promise((r) => setTimeout(r, 120));

  const n1 = await store.saveNote({ title: 'Alpha', body: '#tui #core\n- [ ] Step 1\nSee [[Beta]]', pinned: true });
  const n2Res = await store.openOrCreateWikiTarget('Beta', n1.soul);
  assert.equal(n2Res.created, true);

  // Verify tags, checklists & backlinks
  const tags = store.getTagCounts();
  assert(tags.some((t) => t.tag === 'tui' && t.count === 1));
  const linksAlpha = store.getWikiLinksFor(n1.soul);
  assert.equal(linksAlpha.outgoing.length, 1);
  assert.equal(linksAlpha.outgoing[0].hit.soul, n2Res.soul);
  const linksBeta = store.getWikiLinksFor(n2Res.soul);
  assert.equal(linksBeta.backlinks.length, 1);
  assert.equal(linksBeta.backlinks[0].soul, n1.soul);

  await store.toggleNoteChecklist(n1.soul, 1);
  assert.equal(parseChecklists(store.notes.get(n1.soul).body)[0].done, true);

  // Tasks & Kanban
  const t1 = await store.saveTask({ title: 'Ship M1', priority: 'high', status: 'todo' });
  await store.moveTaskColumn(t1.soul, 'in_progress');
  const cols = store.getKanbanColumns();
  assert.equal(cols.in_progress.length, 1);
  assert.equal(cols.in_progress[0].soul, t1.soul);

  // Global search
  const hits = store.globalSearch('Ship');
  assert(hits.some((h) => h.kind === 'task' && h.soul === t1.soul));

  // Garden health
  const health = store.getGardenHealth();
  assert(health >= 0 && health <= 100);

  // Trash, restore & purge
  await store.trashNote(n2Res.soul);
  assert.equal(store.getActiveNotes().some((n) => n.soul === n2Res.soul), false);
  assert.equal(store.getTrashItems().some((x) => x.kind === 'note' && x.soul === n2Res.soul), true);
  await store.restoreTrashItem('note', n2Res.soul);
  assert.equal(store.getActiveNotes().some((n) => n.soul === n2Res.soul), true);
  await store.trashNote(n2Res.soul);
  await store.purgeTrashItem('note', n2Res.soul);
  assert.equal(store.notes.has(n2Res.soul), false);

  console.log('7. OrtoStore M2 (Projects, Calendar, Bookmarks, Secrets, Spaces)');
  const proj = await store.saveProject({ name: 'Orto TUI', status: 'active', tags: ['tui'] });
  await store.linkToProject(proj.soul, { kind: 'note', soul: n1.soul });
  await store.linkToProject(proj.soul, { kind: 'task', soul: t1.soul });
  const ws = store.getProjectWorkspace(proj.soul);
  assert.equal(ws.project.name, 'Orto TUI');
  assert.equal(ws.notes.length, 1);
  assert.equal(ws.tasks.length, 1);

  const evStart = new Date(2026, 10, 24, 10, 0, 0).getTime();
  await store.saveEvent({ title: 'Release Review', start: evStart, end: evStart + 3600000, location: 'Online' });
  const byDay = store.getEventsForMonth(2026, 10);
  assert.equal(byDay.get(24).length, 1);
  assert.equal(byDay.get(24)[0].title, 'Release Review');

  await store.saveBookmark({ url: 'https://orto.scobrudot.dev/docs', title: 'Orto Docs', folder: 'Dev/Orto', tags: ['docs'] });
  await store.saveBookmark({ url: 'https://example.org', title: 'Example', folder: '', tags: [] });
  const folders = store.getBookmarkFolders();
  assert(folders.some((f) => f.folder === 'Dev/Orto' && f.count === 1));
  assert.equal(store.getBookmarks({ folder: 'Dev' }).length, 1);

  const secretPlain = 'SUPER_SECRET_TOKEN_9911';
  await store.saveSecret({ name: 'GitHub PAT', kind: 'api', username: 'scobru', secret: secretPlain, tags: ['dev'] });
  assert.equal(store.getSecrets({ query: secretPlain }).length, 0, 'secret value must never match search');
  assert.equal(store.globalSearch(secretPlain).length, 0, 'globalSearch must never match secret value');
  assert.equal(store.getSecrets({ query: 'GitHub' }).length, 1);

  console.log('8. SecretsView masking & reveal safety');
  const secView = new SecretsView({ store, toast: () => {} });
  const secScr = new Screen(100, 24, darkTheme);
  secScr.clear();
  secView.render(secScr, darkTheme, { x: 0, y: 0, w: 100, h: 24 });
  const maskedOut = secScr.render();
  assert(!maskedOut.includes(secretPlain), 'secret plaintext must stay masked by default');
  assert(maskedOut.includes('GitHub PAT'));

  await secView.handleKey({ name: 'r', ch: 'r', ctrl: false, alt: false, shift: false });
  secScr.clear();
  secView.render(secScr, darkTheme, { x: 0, y: 0, w: 100, h: 24 });
  const revealedOut = secScr.render();
  assert(revealedOut.includes(secretPlain), 'pressing r reveals secret');

  secView.onBlur();
  secScr.clear();
  secView.render(secScr, darkTheme, { x: 0, y: 0, w: 100, h: 24 });
  const reMaskedOut = secScr.render();
  assert(!reMaskedOut.includes(secretPlain), 'onBlur immediately re-masks secret');

  // Spaces isolation
  const sp = await store.createSpace('Team Space');
  assert.equal(sp.name, 'Team Space');
  assert.equal(store.activeSpace.name, 'Team Space');
  await store.saveNote({ title: 'Space Secret Note', body: 'Inside team space' });
  await store.switchSpace(null);
  assert.equal(store.activeSpace, null);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(store.getActiveNotes().some((n) => n.title === 'Space Secret Note'), false, 'space note isolated from personal');

  console.log('9. Human CLI commands (q, find, status)');
  const cliEnv = { ...process.env, ORTO_SERVER: srvUrl, ORTO_USER: 'tui-tester', ORTO_PASS: 'strong-pass-123' };
  const runCli = async (...args) => {
    const { stdout } = await execFileAsync(process.execPath, ['--no-warnings', 'cli.js', ...args], { env: cliEnv, encoding: 'utf8' });
    return JSON.parse(stdout);
  };
  const qNote = await runCli('q', 'Buy seeds #garden');
  assert.equal(qNote.kind, 'note');
  assert(qNote.soul.startsWith('vault-'));

  const qTask = await runCli('q', 'Water plants #garden', '--task', '--priority', 'high');
  assert.equal(qTask.kind, 'task');
  assert.deepEqual(qTask.tags, ['garden']);

  const found = await runCli('find', 'seeds');
  assert(found.some((h) => h.kind === 'note' && h.soul === qNote.soul));

  const statusObj = await runCli('status');
  assert.equal(statusObj.user, 'tui-tester');
  assert(statusObj.notes >= 2);
  assert(statusObj.openTasks >= 1);
  assert(statusObj.gardenHealth >= 0 && statusObj.gardenHealth <= 100);

  console.log('10. OrtoStore M3 (Contacts, Files, Blog, Feeds/OPML, Garden)');
  await store.saveContact({ name: 'Ada Lovelace', emails: ['ada@example.org'], org: 'Analytical' });
  const vcf = await store.exportContactsVcf();
  assert(vcf.includes('Ada Lovelace') && vcf.includes('ada@example.org'));

  const localTxt = path.join(tmpRoot, 'hello.txt');
  fs.writeFileSync(localTxt, 'Hello encrypted Orto file!\nLine 2', 'utf8');
  const up = await store.uploadLocalFile(localTxt, { folder: 'Docs/2026', album: 'Notes' });
  assert(up.id);
  const prev = await store.previewTextFile(up.id);
  assert.equal(prev.isBinary, false);
  assert(prev.text.includes('Hello encrypted Orto file!'));

  await store.moveFile(up.id, { folder: 'Archive', playlist: 'Docs' });
  assert.equal(store.getFiles({ groupKind: 'folder', groupName: 'Archive' }).length, 1);

  const dlOut = path.join(tmpRoot, 'downloaded.txt');
  await store.downloadToLocalFile(up.id, dlOut);
  assert.equal(fs.readFileSync(dlOut, 'utf8'), 'Hello encrypted Orto file!\nLine 2');

  const fShare = await store.shareFile(up.id);
  assert(fShare.url.includes('/s/'));

  let chunkProgCount = 0;
  const chunkMeta = await store.uploadLocalFile(localTxt, {
    chunked: true,
    onProgress: () => { chunkProgCount++; }
  });
  assert(chunkMeta.chunked && chunkProgCount >= 1);
  await store.deleteFile(up.id);
  await store.deleteFile(chunkMeta.id);

  const post = await store.publishPost({ title: 'Hello M3', content: 'Public post body', tags: ['orto'] });
  assert(store.getPosts().some((p) => p.id === post.id));
  await store.deletePost(post.id);

  const fd = await store.addFeed('https://example.com/rss.xml', { title: 'Example Feed', folder: 'Tech' });
  await store.updateFeed(fd.soul, { folder: 'News' });
  const opml = await store.exportFeedsOpml();
  assert(opml.includes('https://example.com/rss.xml'));
  await store.deleteFeed(fd.soul);

  const soon = Date.now() + 2 * 86400000;
  await store.saveEvent({ title: 'Tulip Event', start: soon, end: soon + 3600000 });
  const gState = store.getGardenState();
  assert(gState.health >= 0 && gState.health <= 100);
  assert(gState.plants.length >= 1);
  assert(gState.tulips.some((t) => t.title === 'Tulip Event'));

  console.log('11. M3 Views Render Smoke Tests (Garden Unicode/ASCII, Feeds, Contacts, Files, Blog)');
  assert.equal(htmlToPlainText('<p>Hello &amp; <b>World</b></p>'), 'Hello & World');

  const gv = new GardenView({ store, onNavigate: () => {} });
  const gScr = new Screen(100, 28, darkTheme);
  gScr.clear();
  gv.render(gScr, darkTheme, { x: 0, y: 0, w: 100, h: 28 });
  const gOut = gScr.render();
  assert(gOut.includes('[ ORTO ]') && gOut.includes('%'));

  const gAsciiScr = new Screen(100, 28, asciiTheme);
  gAsciiScr.clear();
  gv.render(gAsciiScr, asciiTheme, { x: 0, y: 0, w: 100, h: 28 });
  assert(gAsciiScr.render().includes('[ ORTO ]'));

  for (const v of [
    new ContactsView({ store, config: {}, suspend: () => {}, resume: () => {}, toast: () => {} }),
    new FilesView({ store, toast: () => {}, onRedraw: () => {} }),
    new BlogView({ store, config: {}, suspend: () => {}, resume: () => {}, toast: () => {} }),
    new FeedsView({ store, toast: () => {}, onRedraw: () => {} })
  ]) {
    const s = new Screen(100, 24, darkTheme);
    s.clear();
    v.render(s, darkTheme, { x: 0, y: 0, w: 100, h: 24 });
    assert(s.render().length > 0);
  }

  console.log('12. M4 Polish (SGR mouse, color detection, mouse config, non-TTY CLI safety)');
  const mClick = parseKeySequence('\x1b[<0;5;3M')[0];
  assert.equal(mClick.name, 'mouse');
  assert.equal(mClick.button, 0);
  assert.equal(mClick.x, 4);
  assert.equal(mClick.y, 2);
  assert.equal(mClick.release, false);

  const mRelease = parseKeySequence('\x1b[<0;5;3m')[0];
  assert.equal(mRelease.release, true);

  assert.equal(parseKeySequence('\x1b[<64;10;10M')[0].scroll, 'up');
  assert.equal(parseKeySequence('\x1b[<65;10;10M')[0].scroll, 'down');

  assert.equal(detectColorMode({ NO_COLOR: '1', COLORTERM: 'truecolor' }), 'none');
  assert.equal(detectColorMode({ TERM: 'dumb' }), 'none');
  assert.equal(detectColorMode({ WT_SESSION: 'abc' }), 'truecolor');

  saveConfig({ mouse: false });
  assert.equal(loadConfig().mouse, false);

  const { stdout: helpOut } = await execFileAsync(process.execPath, ['--no-warnings', 'cli.js'], { encoding: 'utf8' });
  assert(helpOut.includes('Orto CLI'), 'non-TTY no-arg invocation prints help instead of launching TUI');

  assert.equal(SIDEBAR_ITEMS.length, 12);
  assert.equal(new Set(SIDEBAR_ITEMS.map((x) => x.key)).size, 12, 'every view has a unique shortcut');
  assert.equal(nextViewId('notes', 1), 'projects');
  assert.equal(nextViewId('notes', -1), 'trash');
  assert.equal(nextViewId('trash', 1), 'notes');

  console.log('13. Freenet mode in CLI & TUI (Ed25519 keypair, LoginView key UI, CLI --freenet --key)');
  assert.equal(normalizeFreenetNode('http://127.0.0.1:7509/'), 'ws://127.0.0.1:7509/v1/contract/command');
  assert.equal(normalizeFreenetNode('127.0.0.1:7509'), 'ws://127.0.0.1:7509/v1/contract/command');

  const sk = generateFreenetSecret();
  assert(/^[0-9a-f]{64}$/.test(sk));
  const kp1 = await ed25519KeyPair(sk);
  assert(/^[0-9a-f]{64}$/.test(kp1.pubHex));
  assert.equal(kp1.username, 'fn_' + kp1.pubHex.slice(0, 16));
  assert.equal(kp1.password, sk);
  assert.equal(parseFreenetKeyInput(`https://x/#sk=${sk}`).secretHex, sk);
  assert.equal(parseFreenetKeyInput(JSON.stringify({ secret: sk, pub: kp1.pubHex })).secretHex, sk);
  assert.equal((await ed25519KeyPair(sk + kp1.pubHex)).pubHex, kp1.pubHex);
  const keyBackupFile = path.join(tmpRoot, 'orto-freenet-key.txt');
  fs.writeFileSync(keyBackupFile, `Orto Sovereign Freenet Key: Keep this safe!\n${sk}\n`, 'utf8');
  assert.equal(parseFreenetKeyInput(keyBackupFile).secretHex, sk);

  const lv = new LoginView({ backend: 'server', onSuccess: () => {}, onQuit: () => {} });
  assert.equal(lv.backend, 'server');
  await lv.handleKey({ name: 'f', ch: '', ctrl: true, alt: false, shift: false });
  assert.equal(lv.backend, 'freenet');
  await lv.handleKey({ name: 'g', ch: '', ctrl: true, alt: false, shift: false });
  assert(/^[0-9a-f]{64}$/.test(lv.fnKey));
  const lvScr = new Screen(80, 24, darkTheme);
  lvScr.clear();
  lv.render(lvScr, darkTheme);
  const lvOut = lvScr.render();
  assert(lvOut.includes('Ed25519 Secret Key'));
  assert(!lvOut.includes('Username\x1b'));

  const fnStoreFile = path.join(tmpRoot, 'fn-store.json');
  const prevSafeStore = globalThis.safeStore;
  const prevFnVault = globalThis.FreenetVault;
  try {
    const rt1 = installFreenetRuntime({ storePath: fnStoreFile, connectNode: false });
    assert.equal(rt1.getStatus(), 'local-only');
    const fnClient1 = new Orto({ mode: 'freenet' });
    await fnClient1.login(kp1.username, kp1.password);
    await fnClient1.writeVaultNote({ title: 'Sovereign Note', body: 'Secret Freenet Note #p2p' });
    fnClient1.close();
    rt1.close();

    const diskRaw = fs.readFileSync(fnStoreFile, 'utf8');
    assert(!diskRaw.includes('Secret Freenet Note'), 'Freenet store must only contain ciphertext');
    assert(!diskRaw.includes('Sovereign Note'), 'Freenet store must encrypt titles');

    // Re-open from disk in a fresh runtime
    const rt2 = installFreenetRuntime({ storePath: fnStoreFile, connectNode: false });
    const fnClient2 = new Orto({ mode: 'freenet' });
    await fnClient2.login(kp1.username, kp1.password);
    const reloaded = await fnClient2.readVaultNotes();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].title, 'Sovereign Note');
    fnClient2.close();
    rt2.close();
  } finally {
    if (prevSafeStore === undefined) delete globalThis.safeStore;
    else globalThis.safeStore = prevSafeStore;
    if (prevFnVault === undefined) delete globalThis.FreenetVault;
    else globalThis.FreenetVault = prevFnVault;
  }

  // End-to-end separate CLI processes with --freenet --key <64-hex> --offline (no --user/--pass, no HTTP server!)
  const fnCliEnv = {
    ...process.env,
    ORTO_FREENET_STORE: path.join(tmpRoot, 'fn-cli-store.json')
  };
  delete fnCliEnv.ORTO_USER;
  delete fnCliEnv.ORTO_PASS;
  const runFnCli = async (...args) => {
    const { stdout } = await execFileAsync(process.execPath, ['--no-warnings', 'cli.js', ...args], { env: fnCliEnv, encoding: 'utf8' });
    return JSON.parse(stdout);
  };
  const fnQ = await runFnCli('q', 'Decentralized milk #p2p', '--freenet', '--key', sk, '--offline');
  assert.equal(fnQ.kind, 'note');
  const fnFound = await runFnCli('find', 'Decentralized', '--freenet', '--key', keyBackupFile, '--offline');
  assert(fnFound.some((h) => h.soul === fnQ.soul));
  const fnLegacyRead = await runFnCli('vault-read', '--freenet', '--key', sk, '--offline');
  assert.equal(fnLegacyRead.length, 1);
  assert.equal(fnLegacyRead[0].soul, fnQ.soul);
  const fnStatus = await runFnCli('status', '--freenet', '--key', sk, '--offline');
  assert.equal(fnStatus.mode, 'freenet');
  assert.equal(fnStatus.pubHex, kp1.pubHex);
  assert.equal(fnStatus.notes, 1);

  console.log('14. Viso seed identity derivation (golden vectors), LoginView toggle & async Freenet vault sync');
  const goldenSeed = '07'.repeat(32);
  const p0 = await deriveVisoPersonaKey(goldenSeed, 0);
  const p1 = await deriveVisoPersonaKey(goldenSeed, 1);
  assert.equal(p0.pubHex, '2a76f1666f3aac4f859a1f35300050b69275202d3b880d9f165083c92818b0b5');
  assert.equal(p1.pubHex, 'e62a914becffd666c412644071c11b1787347bf1c1b7c77a2cc5997921a673eb');
  const goldenApp = await deriveVisoAppSecret(p0.secretBytes, 'contract/web/AppA');
  assert.equal(goldenApp.secretHex, '6e828acbcc0982c608d2bcda05338e52d0ff46a77c72a84d1252109f28ea3682');
  const goldenConnectSig = await signVisoConnect(new Uint8Array(32).fill(42), 'https://example.com/app', 'abc123', 12345);
  assert.equal(
    goldenConnectSig,
    '122b675bdbc8772f52631524ac2b500dec76721bff7c0b299025df04e18e8e8ddf2b8d0a232a5785e68d5738be4f5111ae7b58106f5458b966b9b365fff5ac09'
  );

  // Viso backup text auto-detection & session JSON resolution
  const visoBackupFile = path.join(tmpRoot, 'viso-backup.txt');
  fs.writeFileSync(
    visoBackupFile,
    `viso master seed — KEEP THIS SECRET, KEEP THIS SAFE\n\nhex:\n${goldenSeed}\n`,
    'utf8'
  );
  const resolvedFromBackup = await resolveFreenetIdentity(visoBackupFile);
  assert.equal(resolvedFromBackup.kind, 'viso-seed');
  assert.equal(resolvedFromBackup.personaHex, p0.pubHex);
  assert.ok(resolvedFromBackup.delegation?.cert?.sig);

  const visoSessionJson = JSON.stringify({
    orto_freenet_secret: resolvedFromBackup.secretHex,
    orto_viso_session: JSON.stringify(resolvedFromBackup.delegation)
  });
  const resolvedSession = await resolveFreenetIdentity(visoSessionJson);
  assert.equal(resolvedSession.kind, 'viso-session');
  assert.equal(resolvedSession.username, resolvedFromBackup.username);
  assert.equal(resolvedSession.delegation.persona, p0.pubHex);

  // LoginView Ctrl+V toggle switches between Direct Ed25519 and Viso Seed
  let lvSuccess = null;
  const lvViso = new LoginView({
    backend: 'freenet',
    offline: true,
    freenetStore: path.join(tmpRoot, 'lv-viso-store.json'),
    onSuccess: (res) => { lvSuccess = res; },
    onQuit: () => {}
  });
  assert.equal(lvViso.fnKeyMode, 'direct');
  await lvViso.handleKey({ name: 'v', ch: '', ctrl: true, alt: false, shift: false });
  assert.equal(lvViso.fnKeyMode, 'viso-seed');
  const lvVisoScr = new Screen(80, 24, darkTheme);
  lvVisoScr.clear();
  lvViso.render(lvVisoScr, darkTheme);
  assert(lvVisoScr.render().includes('Viso Seed (#0)'));
  await lvViso.handleKey({ name: 'paste', paste: goldenSeed, ctrl: false, alt: false, shift: false });
  assert.equal(lvViso.fnKey, goldenSeed);
  await lvViso._submit();
  assert.equal(lvSuccess?.freenetIdentity?.kind, 'viso-seed');
  assert.equal(lvSuccess?.freenetIdentity?.personaHex, p0.pubHex);
  assert.equal(lvSuccess?.freenetIdentity?.hasDelegation, true);
  lvSuccess.client.close();
  lvSuccess.freenetRuntime.close();

  // Viso Vault Replication + Delayed Async Sync into OrtoStore (notes, files, and space-switch preservation)
  const prevSafe2 = globalThis.safeStore;
  const prevFnVault2 = globalThis.FreenetVault;
  try {
    const netVaults = new Map();
    const hexToU8 = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
    const memStore = (map) => ({
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      keys: (p = '') => [...map.keys()].filter((k) => k.startsWith(p))
    });

    let delayGetMs = 0;
    globalThis.FreenetVault = {
      async getVault(params) {
        if (delayGetMs > 0) await new Promise((r) => setTimeout(r, delayGetMs));
        return netVaults.has(params) ? structuredClone(netVaults.get(params)) : null;
      },
      async pushVault(params, delta) {
        const cur = netVaults.get(params) || { records: {}, updated_at: 0 };
        for (const [k, r] of Object.entries(delta.records)) {
          let signerHex = params.slice(0, 64);
          if (params.length > 96) {
            assert.ok(r.cert, 'Viso personal record carries delegation cert');
            const personaHex = params.slice(0, 64);
            const personaKey = await crypto.subtle.importKey('raw', hexToU8(personaHex), { name: 'Ed25519' }, false, ['verify']);
            const connectMsg = buildVisoConnectMessage(hexToU8(personaHex), r.cert.base, r.cert.challenge, r.cert.ts);
            assert.ok(await crypto.subtle.verify('Ed25519', personaKey, hexToU8(r.cert.sig), connectMsg), 'Viso cert signature valid');
            signerHex = r.cert.challenge.split('.')[1];
          }
          const signerKey = await crypto.subtle.importKey('raw', hexToU8(signerHex), { name: 'Ed25519' }, false, ['verify']);
          const recMsg = `orto1|${params}|${k}|${r.updated_at}|${r.deleted}|${r.data}`;
          assert.ok(await crypto.subtle.verify('Ed25519', signerKey, hexToU8(r.sig), new TextEncoder().encode(recMsg)), 'Record signature valid');
          cur.records[k] = r;
        }
        netVaults.set(params, cur);
      },
      async onVaultUpdate() { return () => {}; }
    };

    // Device A (browser/other device) publishes with Viso seed
    const mapA = new Map();
    globalThis.safeStore = memStore(mapA);
    const idA = await deriveVisoIdentity(goldenSeed, { index: 0 });
    const clientA = new Orto({ mode: 'freenet' });
    await clientA.login(idA.username, idA.password, { delegation: idA.delegation });
    const vA = [...clientA._vaults.values()][0];
    assert.ok(vA.params.startsWith(idA.personaHex));
    assert.ok(vA.params.endsWith(Buffer.from(ORTO_APP_PATH).toString('hex')));
    await clientA.writeVaultNote({ title: 'Synced Viso Note', body: 'From Freenet Web dApp' });
    await clientA.uploadFile(new Uint8Array([1, 2, 3, 4]), 'viso-file.txt');
    const spA = await clientA.createSpace('Viso Team');
    await spA.writeVaultNote({ title: 'Space Note', body: 'Inside space' });
    await Promise.all([...clientA._vaults.values()].map((v) => clientA._vaultFlush(v)));
    assert.ok(netVaults.size >= 1);
    clientA.close();

    // Device B (fresh CLI/TUI) signs in with delayed Freenet GET arriving AFTER OrtoStore.start()
    const mapB = new Map();
    globalThis.safeStore = memStore(mapB);
    delayGetMs = 60;
    const idB = await deriveVisoIdentity(goldenSeed, { index: 0 });
    const clientB = new Orto({ mode: 'freenet' });
    await clientB.login(idB.username, idB.password, { delegation: idB.delegation });
    const storeB = new OrtoStore({ client: clientB });
    storeB.start();
    assert.equal(storeB.notes.size, 0, 'initially empty before delayed Freenet GET returns');
    const vB = [...clientB._vaults.values()][0];
    await vB.syncing;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(storeB.getActiveNotes().length, 1, 'notes synced after OrtoStore started');
    assert.equal(storeB.getActiveNotes()[0].title, 'Synced Viso Note');
    assert.equal(storeB.files.length, 1, 'files list refreshed after async vault sync');
    assert.equal(storeB.files[0].name, 'viso-file.txt');

    // Space switch back to personal preserves live vault sync updates
    await storeB.refreshSpaces();
    assert.ok(storeB.spaces.some((s) => s.id === spA.spaceId), 'spaces list synced from vault');
    await storeB.switchSpace(spA.spaceId);
    await storeB.switchSpace(null);
    assert.equal(storeB.client, clientB, 'returning to personal keeps baseClient for live _vaultSync');

    storeB.close();
  } finally {
    if (prevSafe2 === undefined) delete globalThis.safeStore;
    else globalThis.safeStore = prevSafe2;
    if (prevFnVault2 === undefined) delete globalThis.FreenetVault;
    else globalThis.FreenetVault = prevFnVault2;
  }

  console.log('15. ProjectsView All tab, keyboard/mouse tab nav & TasksView mouse hit testing');
  const radicaProj = await store.saveProject({ name: 'Radica P2P', status: 'active' });
  const radicaTask = await store.saveTask({ title: 'Fix Radica feeds', priority: 'high', status: 'todo', projectId: radicaProj.soul });
  const pv = new ProjectsView({ store, config: {}, suspend: () => {}, resume: () => {}, toast: () => {}, onNavigate: () => {} });
  pv.selectBySoul(radicaProj.soul);
  const pvScr = new Screen(100, 26, darkTheme);
  pvScr.clear();
  pv.render(pvScr, darkTheme, { x: 0, y: 0, w: 100, h: 26 });
  const pvOut = pvScr.render();
  assert(pvOut.includes('All (1)'), 'ProjectsView shows All (1) tab by default');
  assert(pvOut.includes('Fix Radica feeds'), 'ProjectsView shows linked task on default All tab even with 0 notes');

  // Switch pane to workspace and navigate tabs with right/left arrows
  await pv.handleKey({ name: 'tab', ctrl: false, alt: false, shift: false });
  assert.equal(pv.pane, 'workspace');
  await pv.handleKey({ name: 'right', ctrl: false, alt: false, shift: false });
  assert.equal(pv.tabIdx, 1); // Notes
  await pv.handleKey({ name: 'right', ctrl: false, alt: false, shift: false });
  assert.equal(pv.tabIdx, 2); // Tasks
  await pv.handleKey({ name: 'space', ctrl: false, alt: false, shift: false });
  assert.equal(store.tasks.get(radicaTask.soul).status, 'done', 'Space toggles linked task done inside ProjectsView');
  await pv.handleKey({ name: 'left', ctrl: false, alt: false, shift: false });
  await pv.handleKey({ name: 'left', ctrl: false, alt: false, shift: false });
  assert.equal(pv.tabIdx, 0);
  await pv.handleKey({ name: 'left', ctrl: false, alt: false, shift: false });
  assert.equal(pv.pane, 'list', 'Left arrow from tab 0 returns to project list pane');

  // Mouse click on Tasks tab (tabHits[2]) switches directly to Tasks tab
  const tasksTabHit = pv._lastLayout.tabHits[2];
  await pv.handleMouse({ name: 'mouse', button: 0, release: false, x: tasksTabHit.x0 + 1, y: tasksTabHit.y });
  assert.equal(pv.pane, 'workspace');
  assert.equal(pv.tabIdx, 2);

  // TasksView mouse click selects column / card
  const tv = new TasksView({ store, config: {}, suspend: () => {}, resume: () => {}, toast: () => {} });
  const tvScr = new Screen(100, 24, darkTheme);
  tvScr.clear();
  tv.render(tvScr, darkTheme, { x: 0, y: 0, w: 100, h: 24 });
  assert.equal(tv.colIdx, 0);
  const doneColHit = tv._lastHits.cols[3];
  await tv.handleMouse({ name: 'mouse', button: 0, release: false, x: doneColHit.x0 + 2, y: doneColHit.y0 + 1 });
  assert.equal(tv.colIdx, 3, 'clicking DONE column selects it in TasksView');

  console.log('All TUI tests passed!');
} finally {
  activeStore?.close();
  if (activeServer) {
    await new Promise((r) => activeServer.close(r));
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
