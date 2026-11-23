import { DEFAULT_SERVER, Orto, normalizeServer } from '../orto.js';
import { loadConfig, recordRecentServer, saveConfig } from './config.js';
import { copyToClipboard } from './engine/clipboard.js';
import { attachInput } from './engine/input.js';
import { Screen, truncate } from './engine/screen.js';
import { detectColorMode, resolveTheme } from './engine/theme.js';
import { DEFAULT_FREENET_NODE, installFreenetRuntime, normalizeFreenetNode, resolveFreenetIdentity } from './freenet.js';
import { OrtoStore } from './store.js';
import { BlogView } from './views/blog.js';
import { BookmarksView } from './views/bookmarks.js';
import { CalendarView } from './views/calendar.js';
import { ContactsView } from './views/contacts.js';
import { FeedsView } from './views/feeds.js';
import { FilesView } from './views/files.js';
import { GardenView } from './views/garden.js';
import { LoginView } from './views/login.js';
import { NotesView } from './views/notes.js';
import { CommandPalette, HelpOverlay, SpacesOverlay } from './views/palette.js';
import { ProjectsView } from './views/projects.js';
import { SecretsView } from './views/secrets.js';
import { TasksView } from './views/tasks.js';
import { TrashView } from './views/trash.js';

export const SIDEBAR_ITEMS = [
  { id: 'notes', label: 'Notes', short: 'Notes', key: '1', countKey: 'notes' },
  { id: 'projects', label: 'Projects', short: 'Proj', key: '2', countKey: 'projects' },
  { id: 'tasks', label: 'Tasks', short: 'Tasks', key: '3', countKey: 'tasks' },
  { id: 'calendar', label: 'Calendar', short: 'Cal', key: '4', countKey: 'calendar' },
  { id: 'bookmarks', label: 'Bookmarks', short: 'Bkmk', key: '5', countKey: 'bookmarks' },
  { id: 'feeds', label: 'Feeds', short: 'Feeds', key: '6', countKey: 'feeds' },
  { id: 'contacts', label: 'Contacts', short: 'Cont', key: '7', countKey: 'contacts' },
  { id: 'secrets', label: 'Secrets', short: 'Secr', key: '8', countKey: 'secrets' },
  { id: 'files', label: 'Files', short: 'Files', key: '9', countKey: 'files' },
  { id: 'blog', label: 'Blog', short: 'Blog', key: '0', countKey: 'blog' },
  { id: 'garden', label: 'Garden', short: 'Gard', key: 'G', countKey: 'gardenHealth', suffix: '%' },
  { id: 'trash', label: 'Trash', short: 'Trash', key: 'T', countKey: 'trash' }
];

const VIEW_IDS = new Set(SIDEBAR_ITEMS.map((x) => x.id));

export function nextViewId(currentId, delta = 1) {
  const idx = Math.max(0, SIDEBAR_ITEMS.findIndex((x) => x.id === currentId));
  return SIDEBAR_ITEMS[(idx + delta + SIDEBAR_ITEMS.length) % SIDEBAR_ITEMS.length].id;
}

export async function startTui(options = {}) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error('Interactive TUI requires a TTY terminal.');
  }

  let config = loadConfig();
  let themeName = options.theme === 'light' || options.theme === 'dark' ? options.theme : config.theme;
  let asciiMode = options.ascii !== undefined ? !!options.ascii : config.ascii;
  let mouseEnabled = options.mouse !== undefined ? !!options.mouse : config.mouse;
  let theme = resolveTheme(themeName, { colorMode: detectColorMode(), ascii: asciiMode });

  const screen = new Screen(process.stdout.columns || 80, process.stdout.rows || 24, theme);

  let store = null;
  let views = null;
  let activeViewId = VIEW_IDS.has(options.initialView) ? options.initialView : 'notes';
  let activeMode = options.mode === 'freenet' || options.mode === 'server' ? options.mode : (config.mode || 'server');
  let freenetRuntime = null;
  let freenetIdentity = null;
  let freenetStatusUnsub = null;
  let sidebarOpen = true;
  let sidebarFocused = false;
  let overlay = null;
  let loginView = null;
  let toastState = null;
  let toastTimer = null;
  let lockTimer = null;
  let renderTimer = null;
  let closed = false;
  let inputHandle = null;
  const origWarn = console.warn;

  const toast = (message, kind = 'info') => {
    toastState = { message: String(message || ''), kind };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toastState = null;
      scheduleRender();
    }, 3500);
    toastTimer.unref?.();
    scheduleRender();
  };

  const enterTerminal = () => {
    console.warn = () => {};
    process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?25l' + (mouseEnabled ? '\x1b[?1000h\x1b[?1006h' : ''));
    screen.invalidate();
  };

  const leaveTerminal = () => {
    console.warn = origWarn;
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?1049l');
  };

  const suspend = () => {
    inputHandle?.pause();
    leaveTerminal();
  };

  const resume = () => {
    enterTerminal();
    inputHandle?.resume();
    screen.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    scheduleRender();
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (renderTimer) clearTimeout(renderTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (lockTimer) clearTimeout(lockTimer);
    process.stdout.off('resize', onResize);
    process.off('SIGINT', quit);
    process.off('SIGTERM', quit);
    process.off('uncaughtException', onFatal);
    inputHandle?.destroy();
    store?.close();
    freenetStatusUnsub?.();
    freenetStatusUnsub = null;
    freenetRuntime?.close();
    freenetRuntime = null;
    freenetIdentity = null;
    leaveTerminal();
  };

  const quit = () => {
    cleanup();
    process.exit(0);
  };

  const onFatal = (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  };

  const resetLockTimer = () => {
    if (lockTimer) clearTimeout(lockTimer);
    const envMins = process.env.ORTO_LOCK_MIN !== undefined ? Number(process.env.ORTO_LOCK_MIN) : NaN;
    const mins = Number.isFinite(envMins) && envMins >= 0 ? envMins : Number(config.lockMinutes || 0);
    if (mins <= 0 || !store) return;
    lockTimer = setTimeout(() => {
      lockSession();
    }, mins * 60 * 1000);
    lockTimer.unref?.();
  };

  const openLoginScreen = ({ locked = false, backend = activeMode } = {}) => {
    const srv = store?.baseClient?.server || options.server || config.server || DEFAULT_SERVER;
    const usr = store?.baseClient?.username || options.user || config.lastUser || '';
    const lockedId = freenetIdentity?.username || usr;
    if (store) {
      store.close();
      store = null;
    }
    freenetStatusUnsub?.();
    freenetStatusUnsub = null;
    freenetRuntime?.close();
    freenetRuntime = null;
    freenetIdentity = null;
    views = null;
    overlay = null;
    sidebarFocused = false;
    loginView = new LoginView({
      backend,
      server: srv,
      freenetNode: options.freenetNode || config.freenetNode || DEFAULT_FREENET_NODE,
      freenetStore: options.freenetStore,
      offline: !!options.offline,
      fnKeyMode: options.visoSeed ? 'viso-seed' : 'direct',
      personaIndex: options.personaIndex || 0,
      user: usr,
      recentServers: config.recentServers,
      locked,
      lockedIdentity: lockedId,
      onSuccess: onAuthenticated,
      onQuit: quit
    });
    loginView.onRedraw = scheduleRender;
    scheduleRender();
  };

  const lockSession = () => {
    if (!store) return;
    openLoginScreen({ locked: true, backend: activeMode });
  };

  const switchView = (nextId) => {
    if (!VIEW_IDS.has(nextId) || nextId === activeViewId) return;
    views?.[activeViewId]?.onBlur?.();
    activeViewId = nextId;
  };

  const buildViews = (s) => {
    const navigate = (viewId, soul) => {
      switchView(viewId);
      if (soul) views[viewId]?.selectBySoul?.(soul);
      scheduleRender();
    };
    return {
      notes: new NotesView({ store: s, config, suspend, resume, toast }),
      projects: new ProjectsView({ store: s, config, suspend, resume, toast, onNavigate: navigate }),
      tasks: new TasksView({ store: s, config, suspend, resume, toast }),
      calendar: new CalendarView({ store: s, config, suspend, resume, toast }),
      bookmarks: new BookmarksView({ store: s, toast }),
      feeds: new FeedsView({ store: s, toast, onRedraw: scheduleRender }),
      contacts: new ContactsView({ store: s, config, suspend, resume, toast }),
      secrets: new SecretsView({ store: s, toast }),
      files: new FilesView({ store: s, toast, onRedraw: scheduleRender }),
      blog: new BlogView({ store: s, config, suspend, resume, toast }),
      garden: new GardenView({ store: s, onNavigate: navigate }),
      trash: new TrashView({ store: s, toast })
    };
  };

  const onAuthenticated = async ({ client, mode = 'server', server, freenetNode, freenetRuntime: fnRt, freenetIdentity: fnId, username }) => {
    activeMode = mode;
    freenetStatusUnsub?.();
    freenetStatusUnsub = null;
    if (fnRt) freenetRuntime = fnRt;
    freenetIdentity = fnId ? { ...fnId, username } : null;
    config = recordRecentServer(server || config.server, mode === 'server' ? username : '', {
      mode,
      ...(freenetNode ? { freenetNode } : {})
    });
    if (options.space) {
      try {
        const view = await client.openSpace(options.space);
        store = new OrtoStore({ client: view });
      } catch (e) {
        store = new OrtoStore({ client });
        toast(`Could not open space ${options.space}: ${e.message}`, 'error');
      }
    } else {
      store = new OrtoStore({ client });
    }
    store.onChange(() => scheduleRender());
    store.start();
    views = buildViews(store);
    loginView = null;
    resetLockTimer();

    const handleSyncInfo = (info) => {
      if (!info) return;
      if (info.syncState === 'synced') {
        void store?.refreshAfterVaultSync();
        toast(`Freenet synced (${info.lastRecordCount} records · vault ${info.lastVaultId?.slice(0, 10)}…)`, 'success');
      } else if (info.syncState === 'empty') {
        const hint = freenetIdentity?.hasDelegation
          ? `Freenet vault empty (${info.lastVaultId?.slice(0, 10)}…)`
          : `Freenet vault not found (${info.lastVaultId?.slice(0, 10)}…) — if you used Viso on web, login with Viso Seed (Ctrl+V)`;
        toast(hint, 'info');
      } else if (info.syncState === 'error') {
        toast(`Freenet sync failed: ${info.lastSyncError || 'unreachable'}`, 'error');
      }
      scheduleRender();
    };
    if (freenetRuntime?.onStatusChange) {
      freenetStatusUnsub = freenetRuntime.onStatusChange(handleSyncInfo);
      const cur = freenetRuntime.getSyncInfo?.();
      if (cur && cur.syncState !== 'idle' && cur.syncState !== 'local-only') {
        handleSyncInfo(cur);
      }
    }

    toast(`Connected as @${username} (${mode === 'freenet' ? (freenetIdentity?.hasDelegation ? 'Freenet Viso' : 'Freenet P2P') : 'Server'})`, 'success');
    scheduleRender();
  };

  const paletteCommands = () => [
    ...SIDEBAR_ITEMS.map((it) => ({ id: `go:${it.id}`, label: `Go to ${it.label}`, shortcut: it.key })),
    { id: 'new-note', label: 'New Note', shortcut: 'n' },
    { id: 'new-task', label: 'New Task', shortcut: 'n' },
    { id: 'new-project', label: 'New Project', shortcut: 'n' },
    { id: 'new-event', label: 'New Calendar Event', shortcut: 'n' },
    { id: 'new-bookmark', label: 'New Bookmark', shortcut: 'n' },
    { id: 'new-contact', label: 'New Contact', shortcut: 'n' },
    { id: 'add-feed', label: 'Add RSS/Atom Feed', shortcut: 'n' },
    { id: 'upload-file', label: 'Upload Encrypted File', shortcut: 'u' },
    { id: 'new-post', label: 'New Public Blog Post', shortcut: 'n' },
    { id: 'new-secret', label: 'New Secret', shortcut: 'n' },
    { id: 'gen-password', label: 'Generate & Copy Password', shortcut: 'g' },
    { id: 'switch-space', label: 'Switch Workspace / Shared Space', shortcut: 's' },
    { id: 'switch-backend', label: `Switch Backend (to ${activeMode === 'freenet' ? 'Server' : 'Freenet P2P'})`, shortcut: '' },
    ...(activeMode === 'freenet' && freenetRuntime ? [
      { id: 'fn-sync', label: 'Sync Freenet Vault Now', shortcut: '' },
      { id: 'fn-copy-vault', label: 'Copy Freenet Vault Contract ID', shortcut: '' }
    ] : []),
    ...(activeMode === 'freenet' && freenetIdentity ? [
      { id: 'fn-copy-pub', label: 'Copy Freenet Public Key (Ed25519)', shortcut: '' },
      { id: 'fn-copy-sec', label: 'Copy Freenet Secret Key Backup (20s clear)', shortcut: '' }
    ] : []),
    { id: 'toggle-theme', label: `Toggle Theme (${themeName === 'dark' ? 'Light' : 'Dark'})`, shortcut: '' },
    { id: 'toggle-ascii', label: `Toggle ASCII Borders (${asciiMode ? 'Unicode' : 'ASCII'})`, shortcut: '' },
    { id: 'toggle-mouse', label: `Toggle Mouse (${mouseEnabled ? 'Off' : 'On'})`, shortcut: '' },
    { id: 'toggle-sidebar', label: 'Toggle Sidebar', shortcut: '\\' },
    { id: 'focus-sidebar', label: 'Focus Sidebar', shortcut: 'Ctrl+B' },
    { id: 'lock', label: 'Lock Session', shortcut: 'Ctrl+L' },
    { id: 'quit', label: 'Quit Orto', shortcut: 'q' }
  ];

  const runCommand = async (id) => {
    if (id.startsWith('go:')) {
      switchView(id.slice(3));
      sidebarFocused = false;
      return;
    }
    if (id === 'new-note') {
      switchView('notes');
      await views.notes.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false });
    } else if (id === 'new-task') {
      switchView('tasks');
      await views.tasks.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false }, currentArea());
    } else if (id === 'new-project') {
      switchView('projects');
      await views.projects.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false });
    } else if (id === 'new-event') {
      switchView('calendar');
      await views.calendar.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false });
    } else if (id === 'new-bookmark') {
      switchView('bookmarks');
      await views.bookmarks.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false });
    } else if (id === 'new-contact') {
      switchView('contacts');
      await views.contacts.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false });
    } else if (id === 'add-feed') {
      switchView('feeds');
      await views.feeds.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false });
    } else if (id === 'upload-file') {
      switchView('files');
      await views.files.handleKey({ name: 'u', ch: 'u', ctrl: false, alt: false, shift: false });
    } else if (id === 'new-post') {
      switchView('blog');
      await views.blog.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false });
    } else if (id === 'new-secret') {
      switchView('secrets');
      await views.secrets.handleKey({ name: 'n', ch: 'n', ctrl: false, alt: false, shift: false });
    } else if (id === 'gen-password') {
      switchView('secrets');
      await views.secrets.handleKey({ name: 'g', ch: 'g', ctrl: false, alt: false, shift: false });
    } else if (id === 'open-garden') {
      switchView('garden');
    } else if (id === 'switch-space') {
      overlay = new SpacesOverlay({ store, onClose: () => { overlay = null; }, toast });
    } else if (id === 'switch-backend') {
      openLoginScreen({ locked: false, backend: activeMode === 'freenet' ? 'server' : 'freenet' });
    } else if (id === 'fn-sync' && freenetRuntime) {
      toast('Syncing Freenet vault...', 'info');
      await freenetRuntime.forceSync(store.baseClient);
      await store.refreshAfterVaultSync();
    } else if (id === 'fn-copy-vault' && freenetRuntime) {
      const vid = freenetRuntime.getSyncInfo?.()?.lastVaultId;
      if (vid) {
        copyToClipboard(vid, { stdout: process.stdout });
        toast(`Copied vault ID: ${vid.slice(0, 16)}…`, 'success');
      } else {
        toast('Vault contract ID not resolved yet.', 'info');
      }
    } else if (id === 'fn-copy-pub' && freenetIdentity) {
      copyToClipboard(freenetIdentity.pubHex, { stdout: process.stdout });
      toast(`Copied pubkey: ${freenetIdentity.pubHex.slice(0, 16)}…`, 'success');
    } else if (id === 'fn-copy-sec' && freenetIdentity) {
      copyToClipboard(freenetIdentity.secretHex, { clearAfterMs: 20000, stdout: process.stdout });
      toast('Copied 64-hex Freenet secret key (clears in 20s)', 'success');
    } else if (id === 'open-trash') {
      switchView('trash');
    } else if (id === 'toggle-theme') {
      themeName = themeName === 'dark' ? 'light' : 'dark';
      config = saveConfig({ theme: themeName });
      theme = resolveTheme(themeName, { colorMode: detectColorMode(), ascii: asciiMode });
      screen.theme = theme;
      screen.invalidate();
      toast(`Theme: ${themeName}`, 'success');
    } else if (id === 'toggle-ascii') {
      asciiMode = !asciiMode;
      config = saveConfig({ ascii: asciiMode });
      theme = resolveTheme(themeName, { colorMode: detectColorMode(), ascii: asciiMode });
      screen.theme = theme;
      screen.invalidate();
      toast(`Borders: ${asciiMode ? 'ASCII' : 'Unicode'}`, 'success');
    } else if (id === 'toggle-mouse') {
      mouseEnabled = !mouseEnabled;
      config = saveConfig({ mouse: mouseEnabled });
      process.stdout.write(mouseEnabled ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1006l\x1b[?1000l');
      toast(`Mouse: ${mouseEnabled ? 'on' : 'off'}`, 'success');
    } else if (id === 'toggle-sidebar') {
      sidebarOpen = !sidebarOpen;
      if (!sidebarOpen) sidebarFocused = false;
    } else if (id === 'focus-sidebar') {
      sidebarOpen = true;
      sidebarFocused = true;
    } else if (id === 'lock') {
      lockSession();
    } else if (id === 'quit') {
      quit();
    }
  };

  const currentArea = () => {
    const showSidebar = (sidebarOpen && screen.cols >= 66) || (sidebarFocused && screen.cols >= 46);
    const sw = showSidebar ? (screen.cols >= 90 ? 23 : 20) : 0;
    const topStrip = showSidebar ? 0 : 1;
    return {
      x: sw,
      y: 1 + topStrip,
      w: Math.max(20, screen.cols - sw),
      h: Math.max(5, screen.rows - 2 - topStrip),
      showSidebar,
      sidebarW: sw,
      topStrip
    };
  };

  const renderAll = () => {
    if (closed) return;
    screen.setCursor(0, 0, false);

    if (loginView) {
      loginView.render(screen, theme);
      screen.render(process.stdout);
      return;
    }

    screen.clear(theme.bg, theme.fg);
    const area = currentArea();
    const counts = store.getCounts();

    // Header bar
    screen.fill(0, 0, screen.cols, 1, ' ', { fg: theme.fg, bg: theme.sidebarBg });
    const spaceLabel = store.activeSpace
      ? `${store.activeSpace.name} (${store.activeSpace.role})`
      : 'Personal';
    const modeTag = activeMode === 'freenet' ? ' [Freenet]' : '';
    const leftHead = ` Orto${modeTag} · ${spaceLabel} · @${store.baseClient.username}`;
    screen.text(0, 0, truncate(leftHead, screen.cols - 30), { fg: theme.fg, bg: theme.sidebarBg, bold: true });

    const fnStatus = freenetRuntime?.getStatus?.();
    const fnSync = freenetRuntime?.getSyncInfo?.();
    let statusDot = store.status === 'live' ? '● live' : '◌ syncing';
    let statusColor = store.status === 'live' ? theme.green : theme.amber;
    if (activeMode === 'freenet') {
      if (fnSync?.syncState === 'syncing') {
        statusDot = '◌ syncing…';
        statusColor = theme.amber;
      } else if (fnSync?.syncState === 'error') {
        statusDot = '⚠ fn error';
        statusColor = theme.danger;
      } else if (fnSync?.syncState === 'synced') {
        statusDot = `● freenet (${fnSync.lastRecordCount})`;
        statusColor = theme.cyan;
      } else if (fnSync?.syncState === 'empty') {
        statusDot = '● freenet (new)';
        statusColor = theme.cyan;
      } else if (fnStatus === 'connected') {
        statusDot = '● freenet';
        statusColor = theme.cyan;
      } else {
        statusDot = '● local-p2p';
        statusColor = theme.amber;
      }
    }
    const rightHead = `${statusDot}  [Ctrl+K] Search `;
    screen.text(Math.max(0, screen.cols - rightHead.length), 0, rightHead, {
      fg: statusColor,
      bg: theme.sidebarBg
    });

    // Sidebar
    if (area.showSidebar) {
      screen.box(0, 1, area.sidebarW, area.h, {
        title: sidebarFocused ? 'Views (↑↓/Enter)' : 'Views [Ctrl+B]',
        borderColor: sidebarFocused ? theme.borderFocus : theme.border,
        bg: theme.sidebarBg,
        titleColor: sidebarFocused ? theme.accent : theme.fgMuted
      });
      let row = 2;
      for (const item of SIDEBAR_ITEMS) {
        if (row >= area.h) break;
        const active = item.id === activeViewId;
        const bg = active ? theme.selectedBg : theme.sidebarBg;
        screen.fill(1, row, area.sidebarW - 2, 1, ' ', { fg: theme.fg, bg });
        const prefix = active ? '▸' : ' ';
        const val = `${counts[item.countKey] ?? 0}${item.suffix || ''}`;
        screen.text(1, row, `${prefix}${item.key} `, {
          fg: active ? theme.accent : theme.cyan,
          bg,
          bold: active
        });
        screen.text(4, row, truncate(item.label, area.sidebarW - 6 - val.length), {
          fg: active ? (sidebarFocused ? theme.accentSoft : theme.fg) : theme.fgDim,
          bg,
          bold: active
        });
        screen.text(area.sidebarW - 2 - val.length, row, val, {
          fg: active ? theme.fg : theme.fgMuted,
          bg
        });
        row++;
      }

      if (activeViewId === 'notes' && row + 2 < area.h) {
        const tags = store.getTagCounts();
        if (tags.length) {
          row++;
          screen.text(2, row++, 'TAGS', { fg: theme.fgMuted, bg: theme.sidebarBg, bold: true });
          for (const t of tags) {
            if (row >= area.h) break;
            const activeTag = views.notes.activeTag === t.tag;
            const bg = activeTag ? theme.selectedBg : theme.sidebarBg;
            screen.fill(1, row, area.sidebarW - 2, 1, ' ', { fg: theme.fg, bg });
            const cnt = String(t.count);
            screen.text(2, row, truncate('#' + t.tag, area.sidebarW - 6 - cnt.length), {
              fg: activeTag ? theme.accentSoft : theme.fgDim,
              bg,
              bold: activeTag
            });
            screen.text(area.sidebarW - 2 - cnt.length, row, cnt, { fg: theme.fgMuted, bg });
            row++;
          }
        }
      }
    } else if (area.topStrip) {
      screen.fill(0, 1, screen.cols, 1, ' ', { fg: theme.fgDim, bg: theme.listBg });
      let tx = 1;
      for (const item of SIDEBAR_ITEMS) {
        const active = item.id === activeViewId;
        const tok = ` ${item.key}:${item.short} `;
        if (tx + tok.length >= screen.cols - 1) break;
        screen.text(tx, 1, tok, {
          fg: active ? theme.bg : theme.fgDim,
          bg: active ? theme.accent : theme.listBg,
          bold: active
        });
        tx += tok.length;
      }
    }

    // Active View
    const activeView = views[activeViewId];
    activeView.render(screen, theme, area);

    // Overlay
    if (overlay) {
      overlay.render(screen, theme);
    }

    // Footer bar (Toast or Hints)
    const fy = screen.rows - 1;
    screen.fill(0, fy, screen.cols, 1, ' ', { fg: theme.fgDim, bg: theme.sidebarBg });
    if (toastState) {
      const color = toastState.kind === 'error' ? theme.danger : toastState.kind === 'success' ? theme.green : theme.amber;
      screen.text(1, fy, truncate(toastState.message, screen.cols - 2), { fg: color, bg: theme.sidebarBg, bold: true });
    } else if (sidebarFocused) {
      const hints = '↑/↓ or j/k: switch view  ·  Enter/l/Esc: focus view  ·  1-9/0/G/T: jump  ·  \\: hide sidebar';
      screen.text(1, fy, truncate(hints, screen.cols - 2), { fg: theme.cyan, bg: theme.sidebarBg });
    } else {
      const hints = activeView.getHints?.() || '';
      screen.text(1, fy, truncate(`1-0/G/T or [/]:views  Ctrl+B:sidebar  ·  ${hints}  ·  ?:help  q:quit`, screen.cols - 2), { fg: theme.fgMuted, bg: theme.sidebarBg });
    }

    screen.render(process.stdout);
  };

  const scheduleRender = () => {
    if (closed || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 16);
    renderTimer.unref?.();
  };

  const onResize = () => {
    screen.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    screen.invalidate();
    scheduleRender();
  };

  const handleKey = async (ev) => {
    if (closed) return;
    resetLockTimer();

    if (loginView) {
      if (ev.name === 'mouse') return;
      await loginView.handleKey(ev);
      scheduleRender();
      return;
    }

    if (ev.name === 'mouse') {
      if (ev.release) return;
      if (ev.scroll === 'up' || ev.scroll === 'down') {
        const syn = { name: ev.scroll, ch: '', ctrl: false, alt: false, shift: false };
        if (overlay) await overlay.handleKey(syn);
        else await views[activeViewId]?.handleKey(syn, currentArea());
        scheduleRender();
        return;
      }
      if (ev.button === 0 && !overlay) {
        if (ev.y === 0) {
          if (ev.x >= Math.max(0, screen.cols - 24)) {
            await handleKey({ name: 'k', ch: '', ctrl: true, alt: false, shift: false });
          } else if (ev.x < 40) {
            overlay = new SpacesOverlay({ store, onClose: () => { overlay = null; }, toast });
            scheduleRender();
          }
          return;
        }
        const area = currentArea();
        if (area.topStrip && ev.y === 1) {
          let tx = 1;
          for (const item of SIDEBAR_ITEMS) {
            const tok = ` ${item.key}:${item.short} `;
            if (tx + tok.length >= screen.cols - 1) break;
            if (ev.x >= tx && ev.x < tx + tok.length) {
              switchView(item.id);
              sidebarFocused = false;
              scheduleRender();
              return;
            }
            tx += tok.length;
          }
        }
        if (area.showSidebar && ev.x < area.sidebarW) {
          const itemIdx = ev.y - 2;
          if (itemIdx >= 0 && itemIdx < SIDEBAR_ITEMS.length) {
            switchView(SIDEBAR_ITEMS[itemIdx].id);
            sidebarFocused = false;
            scheduleRender();
            return;
          }
          if (activeViewId === 'notes') {
            const tags = store.getTagCounts();
            const tagStart = 2 + SIDEBAR_ITEMS.length + 2;
            const tagIdx = ev.y - tagStart;
            if (tagIdx >= 0 && tagIdx < tags.length) {
              const clicked = tags[tagIdx].tag;
              views.notes.setTagFilter(views.notes.activeTag === clicked ? null : clicked);
              scheduleRender();
            }
          }
        }
      }
      return;
    }

    if (ev.ctrl && ev.name === 'c') {
      quit();
      return;
    }
    if (ev.ctrl && ev.name === 'l') {
      lockSession();
      return;
    }

    if (overlay) {
      await overlay.handleKey(ev);
      scheduleRender();
      return;
    }

    if (ev.ctrl && ev.name === 'b') {
      sidebarOpen = true;
      sidebarFocused = !sidebarFocused;
      scheduleRender();
      return;
    }

    if (ev.ctrl && ev.name === 'k') {
      overlay = new CommandPalette({
        store,
        commands: paletteCommands(),
        onClose: () => { overlay = null; },
        onRunCommand: runCommand,
        onSelectItem: async (hit) => {
          if (VIEW_IDS.has(hit.view)) switchView(hit.view);
          if (hit.soul) views[hit.view]?.selectBySoul?.(hit.soul);
          sidebarFocused = false;
        }
      });
      scheduleRender();
      return;
    }

    if (sidebarFocused) {
      if (ev.name === 'j' || ev.name === 'down') {
        switchView(nextViewId(activeViewId, 1));
        scheduleRender();
        return;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        switchView(nextViewId(activeViewId, -1));
        scheduleRender();
        return;
      }
      if (ev.name === 'enter' || ev.name === 'l' || ev.name === 'right' || ev.name === 'tab' || ev.name === 'escape') {
        sidebarFocused = false;
        scheduleRender();
        return;
      }
      if (ev.name === '\\') {
        sidebarOpen = false;
        sidebarFocused = false;
        scheduleRender();
        return;
      }
      if (ev.name === 'q' && !ev.ctrl && !ev.alt) {
        quit();
        return;
      }
      const jump = SIDEBAR_ITEMS.find((x) => x.key === ev.ch || x.key === ev.name);
      if (jump && !ev.ctrl && !ev.alt) {
        switchView(jump.id);
        sidebarFocused = false;
        scheduleRender();
        return;
      }
      return;
    }

    const activeView = views[activeViewId];
    const handled = await activeView.handleKey(ev, currentArea());
    if (handled) {
      scheduleRender();
      return;
    }

    // Global shortcuts when view didn't consume key (not in modal or search)
    if (ev.name === 'escape') {
      sidebarOpen = true;
      sidebarFocused = true;
      scheduleRender();
      return;
    }
    if (ev.name === 'q' && !ev.ctrl && !ev.alt) {
      quit();
      return;
    }
    if (ev.name === '?') {
      const meta = SIDEBAR_ITEMS.find((x) => x.id === activeViewId);
      overlay = new HelpOverlay({
        viewTitle: meta?.label || activeViewId,
        viewHints: activeView.getHints?.() || '',
        onClose: () => { overlay = null; }
      });
      scheduleRender();
      return;
    }
    if (ev.name === 's' && !ev.ctrl && !ev.alt) {
      overlay = new SpacesOverlay({ store, onClose: () => { overlay = null; }, toast });
      scheduleRender();
      return;
    }
    if (ev.name === '[') {
      switchView(nextViewId(activeViewId, -1));
      scheduleRender();
      return;
    }
    if (ev.name === ']') {
      switchView(nextViewId(activeViewId, 1));
      scheduleRender();
      return;
    }
    if (ev.name === '\\') {
      sidebarOpen = !sidebarOpen;
      if (!sidebarOpen) sidebarFocused = false;
      scheduleRender();
      return;
    }

    // Number / letter view jumps
    const jump = SIDEBAR_ITEMS.find((x) => x.key === ev.ch || x.key === ev.name);
    if (jump && !ev.ctrl && !ev.alt) {
      switchView(jump.id);
      scheduleRender();
    }
  };

  process.stdout.on('resize', onResize);
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('uncaughtException', onFatal);

  enterTerminal();
  inputHandle = attachInput(process.stdin, (ev) => {
    handleKey(ev).catch((err) => {
      toast(err?.message || 'Error', 'error');
    });
  });

  const targetServer = normalizeServer(options.server || config.server || DEFAULT_SERVER);
  const targetNode = normalizeFreenetNode(options.freenetNode || config.freenetNode || DEFAULT_FREENET_NODE);

  // Auto-login if credentials were provided via flags / .env
  const fnCredInput = options.visoSeed || options.freenetKey;
  if ((activeMode === 'freenet' && (fnCredInput || (options.user && options.pass))) || (activeMode === 'server' && options.user && options.pass)) {
    try {
      if (activeMode === 'freenet') {
        const fnRt = installFreenetRuntime({
          storePath: options.freenetStore,
          nodeUrl: targetNode,
          connectNode: !options.offline
        });
        const client = new Orto({ mode: 'freenet' });
        if (fnCredInput) {
          const id = await resolveFreenetIdentity(fnCredInput, {
            keyMode: options.visoSeed ? 'viso-seed' : 'auto',
            personaIndex: options.personaIndex || 0,
            delegationRaw: options.delegation
          });
          await client.login(id.username, id.password, { delegation: id.delegation || null });
          await onAuthenticated({
            client,
            mode: 'freenet',
            freenetNode: targetNode,
            freenetRuntime: fnRt,
            freenetIdentity: {
              kind: id.kind,
              pubHex: id.pubHex,
              persona: id.persona,
              personaHex: id.personaHex || id.pubHex,
              personaIndex: id.personaIndex ?? null,
              secretHex: id.secretHex,
              hasDelegation: !!id.delegation
            },
            username: id.username
          });
        } else {
          await client.login(options.user, options.pass);
          await onAuthenticated({
            client,
            mode: 'freenet',
            freenetNode: targetNode,
            freenetRuntime: fnRt,
            username: client.username
          });
        }
        return;
      }
      const client = new Orto({ server: targetServer });
      await client.login(options.user, options.pass);
      await onAuthenticated({ client, mode: 'server', server: targetServer, username: client.username });
      return;
    } catch (e) {
      loginView = new LoginView({
        backend: activeMode,
        server: targetServer,
        freenetNode: targetNode,
        freenetStore: options.freenetStore,
        offline: !!options.offline,
        fnKeyMode: options.visoSeed ? 'viso-seed' : 'direct',
        personaIndex: options.personaIndex || 0,
        user: options.user,
        recentServers: config.recentServers,
        onSuccess: onAuthenticated,
        onQuit: quit
      });
      loginView.error = e.message || 'Auto-login failed';
      loginView.onRedraw = scheduleRender;
      scheduleRender();
      return;
    }
  }

  loginView = new LoginView({
    backend: activeMode,
    server: targetServer,
    freenetNode: targetNode,
    freenetStore: options.freenetStore,
    offline: !!options.offline,
    fnKeyMode: options.visoSeed ? 'viso-seed' : 'direct',
    personaIndex: options.personaIndex || 0,
    user: options.user || config.lastUser || '',
    recentServers: config.recentServers,
    onSuccess: onAuthenticated,
    onQuit: quit
  });
  loginView.onRedraw = scheduleRender;
  scheduleRender();
}
