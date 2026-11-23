import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTags, extractWikiLinks, fuzzyScore, parseChecklists, toggleChecklistLine } from './engine/widgets.js';

function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

const TRASH_METHODS = {
  note: { trash: 'trashVaultNote', restore: 'restoreVaultNote', del: 'deleteVaultNote', map: 'notes', label: 'Note' },
  task: { trash: 'trashTask', restore: 'restoreTask', del: 'deleteTask', map: 'tasks', label: 'Task' },
  event: { trash: 'trashCalendarEvent', restore: 'restoreCalendarEvent', del: 'deleteCalendarEvent', map: 'calendar', label: 'Event' },
  bookmark: { trash: 'trashBookmark', restore: 'restoreBookmark', del: 'deleteBookmark', map: 'bookmarks', label: 'Bookmark' },
  contact: { trash: 'trashContact', restore: 'restoreContact', del: 'deleteContact', map: 'contacts', label: 'Contact' },
  secret: { trash: 'trashSecret', restore: 'restoreSecret', del: 'deleteSecret', map: 'secrets', label: 'Secret' },
  project: { trash: 'trashProject', restore: 'restoreProject', del: 'deleteProject', map: 'projects', label: 'Project' }
};

const DAY_MS = 86400000;

export class OrtoStore {
  constructor({ client }) {
    this.baseClient = client._base || client;
    this.client = client;
    this.activeSpace = client._space
      ? { id: client.spaceId || client._space, name: client.spaceName || 'Space', role: client.spaceRole || client._role || 'editor' }
      : null;

    this.notes = new Map();
    this.tasks = new Map();
    this.projects = new Map();
    this.calendar = new Map();
    this.bookmarks = new Map();
    this.contacts = new Map();
    this.secrets = new Map();
    this.feeds = new Map();
    this.feedArticles = new Map();
    this.posts = new Map();
    this.files = [];
    this.spaces = [];

    this.status = 'connecting';
    this.lastSyncAt = 0;
    this._unsubs = [];
    this._spaceUnsub = null;
    this._listeners = new Set();
    this._emitTimer = null;
    this._closed = false;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    if (this._closed || this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      if (this._closed) return;
      for (const fn of this._listeners) {
        try { fn(this); } catch (_) {}
      }
    }, 16);
    this._emitTimer.unref?.();
  }

  isReadOnly() {
    return this.activeSpace?.role === 'viewer';
  }

  _guardWrite() {
    if (this.isReadOnly()) {
      throw new Error('Read-only space (viewer role)');
    }
  }

  start() {
    this._closed = false;
    this._subscribeSpaces();
    this._subscribeCollections();
  }

  _subscribeSpaces() {
    if (this._spaceUnsub) {
      try { this._spaceUnsub(); } catch (_) {}
      this._spaceUnsub = null;
    }
    this._spaceUnsub = this.baseClient.onSpaces(async () => {
      try {
        this.spaces = await this.baseClient.spaces();
        this._emit();
      } catch (_) {}
    });
  }

  _bindMap(map, subscribeFn) {
    const unsub = subscribeFn((entry, soul, deleted) => {
      if (deleted || !entry) map.delete(soul);
      else map.set(soul, { ...entry, soul });
      this.lastSyncAt = Date.now();
      this.status = 'live';
      this._emit();
    });
    if (typeof unsub === 'function') this._unsubs.push(unsub);
  }

  _subscribeCollections() {
    this._unsubCollections();
    this.status = 'connecting';
    const c = this.client;

    const noteUnsub = c.onVaultNote(
      (entry, soul, deleted) => {
        if (deleted || !entry) this.notes.delete(soul);
        else this.notes.set(soul, { ...entry, soul });
        this.lastSyncAt = Date.now();
        this.status = 'live';
        this._emit();
      },
      (listedSouls) => {
        for (const k of this.notes.keys()) {
          if (!listedSouls.has(k)) this.notes.delete(k);
        }
        this.status = 'live';
        this.lastSyncAt = Date.now();
        this._emit();
      }
    );
    if (typeof noteUnsub === 'function') this._unsubs.push(noteUnsub);

    this._bindMap(this.tasks, (cb) => c.onTask(cb));
    this._bindMap(this.projects, (cb) => c.onProject(cb));
    this._bindMap(this.calendar, (cb) => c.onCalendarEvent(cb));
    this._bindMap(this.bookmarks, (cb) => c.onBookmark(cb));
    this._bindMap(this.contacts, (cb) => c.onContact(cb));
    this._bindMap(this.secrets, (cb) => c.onSecret(cb));
    this._bindMap(this.feeds, (cb) => c.onFeed(cb));

    if (typeof c._on === 'function') {
      const fileUnsub = c._on('files', () => {
        this._scheduleRefreshFiles();
      });
      if (typeof fileUnsub === 'function') this._unsubs.push(fileUnsub);
    }

    if (!this.activeSpace && this.baseClient.pub) {
      const postUnsub = this.baseClient.onPost(this.baseClient.pub, (post, id, deleted) => {
        if (deleted || !post) this.posts.delete(id);
        else this.posts.set(id, { ...post, id });
        this._emit();
      });
      if (typeof postUnsub === 'function') this._unsubs.push(postUnsub);
    }

    this.refreshFiles().catch(() => {});
    if (this.baseClient.mode === 'freenet') {
      this.status = 'live';
      this.lastSyncAt = Date.now();
    }
  }

  _scheduleRefreshFiles() {
    if (this._closed || this._filesRefreshTimer) return;
    this._filesRefreshTimer = setTimeout(() => {
      this._filesRefreshTimer = null;
      if (!this._closed) this.refreshFiles().catch(() => {});
    }, 30);
    this._filesRefreshTimer.unref?.();
  }

  async refreshFiles() {
    try {
      this.files = await this.client.listFiles();
      this._emit();
    } catch (_) {}
  }

  async refreshSpaces() {
    try {
      this.spaces = await this.baseClient.spaces();
      this._emit();
    } catch (_) {}
  }

  async refreshAfterVaultSync() {
    await Promise.allSettled([this.refreshFiles(), this.refreshSpaces()]);
    this.lastSyncAt = Date.now();
    this.status = 'live';
    this._emit();
  }

  _unsubCollections() {
    for (const u of this._unsubs) {
      try { u(); } catch (_) {}
    }
    this._unsubs = [];
  }

  _clearCollections() {
    this.notes.clear();
    this.tasks.clear();
    this.projects.clear();
    this.calendar.clear();
    this.bookmarks.clear();
    this.contacts.clear();
    this.secrets.clear();
    this.feeds.clear();
    this.feedArticles.clear();
    this.posts.clear();
    this.files = [];
  }

  async switchSpace(spaceId = null) {
    this._unsubCollections();
    if (this.client !== this.baseClient) {
      try { this.client.close(); } catch (_) {}
    }
    this._clearCollections();

    if (spaceId) {
      const view = await this.baseClient.openSpace(spaceId);
      this.client = view;
      this.activeSpace = { id: view.spaceId, name: view.spaceName, role: view.spaceRole };
    } else {
      // Keep baseClient directly so Freenet _vaultSync (which notifies v.owner._subs) still reaches listeners.
      this.client = this.baseClient;
      this.activeSpace = null;
    }
    this._subscribeCollections();
    this._emit();
    return this.activeSpace;
  }

  async acceptSpaceInvite(spaceId) {
    const view = await this.baseClient.acceptInvite(spaceId);
    this.spaces = await this.baseClient.spaces().catch(() => this.spaces);
    this._unsubCollections();
    if (this.client !== this.baseClient) {
      try { this.client.close(); } catch (_) {}
    }
    this._clearCollections();
    this.client = view;
    this.activeSpace = { id: view.spaceId, name: view.spaceName, role: view.spaceRole };
    this._subscribeCollections();
    this._emit();
    return this.activeSpace;
  }

  close() {
    this._closed = true;
    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    if (this._filesRefreshTimer) {
      clearTimeout(this._filesRefreshTimer);
      this._filesRefreshTimer = null;
    }
    this._unsubCollections();
    if (this._spaceUnsub) {
      try { this._spaceUnsub(); } catch (_) {}
      this._spaceUnsub = null;
    }
    if (this.client && this.client !== this.baseClient) {
      try { this.client.close(); } catch (_) {}
    }
    try { this.baseClient.close(); } catch (_) {}
    this._listeners.clear();
  }

  // ─── Derived Queries ──────────────────────────────────────────────────

  getActiveNotes({ filter = 'all', tag = null, query = '', projectId = null } = {}) {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const q = String(query || '').trim().toLowerCase();
    const wantTag = tag ? tag.replace(/^#/, '').toLowerCase() : null;

    return [...this.notes.values()]
      .filter((n) => {
        if (!n || n.trash || n.title === undefined) return false;
        if (projectId && n.projectId !== projectId) return false;
        const tags = extractTags(n.body);
        if (filter === 'pinned' && !n.pinned) return false;
        if (filter === 'untagged' && tags.length > 0) return false;
        if (filter === 'todo' && !parseChecklists(n.body).some((c) => !c.done)) return false;
        if (filter === 'today' && Number(n.timestamp || n.updatedAt || 0) < dayStart) return false;
        if (wantTag && !tags.some((t) => t.toLowerCase() === wantTag || t.toLowerCase().startsWith(wantTag + '/'))) {
          return false;
        }
        if (q) {
          const hay = `${n.title || ''}\n${n.body || ''}\n${n.cat || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.timestamp || 0) - (a.timestamp || 0));
  }

  getTagCounts() {
    const counts = new Map();
    for (const n of this.notes.values()) {
      if (!n || n.trash) continue;
      for (const t of extractTags(n.body)) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  findNoteByTitleOrSoul(target) {
    const clean = String(target || '').trim();
    if (!clean) return null;
    const direct = this.notes.get(clean);
    if (direct && !direct.trash) return direct;
    const low = clean.toLowerCase();
    for (const n of this.notes.values()) {
      if (!n || n.trash) continue;
      if ((n.title || '').trim().toLowerCase() === low) return n;
    }
    return null;
  }

  getWikiLinksFor(soul) {
    const note = this.notes.get(soul);
    if (!note) return { outgoing: [], backlinks: [] };
    const outgoing = extractWikiLinks(note.body).map((lnk) => ({
      ...lnk,
      hit: this.findNoteByTitleOrSoul(lnk.target)
    }));

    const noteTitleLow = (note.title || '').trim().toLowerCase();
    const backlinks = [];
    for (const other of this.notes.values()) {
      if (!other || other.trash || other.soul === soul) continue;
      const refs = extractWikiLinks(other.body);
      if (refs.some((r) => r.target.toLowerCase() === soul.toLowerCase() || (noteTitleLow && r.target.toLowerCase() === noteTitleLow))) {
        backlinks.push({ soul: other.soul, title: other.title || 'Untitled' });
      }
    }
    backlinks.sort((a, b) => a.title.localeCompare(b.title));
    return { outgoing, backlinks };
  }

  getTasks({ status = null, priority = null, query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const order = { urgent: 0, high: 1, medium: 2, low: 3 };
    return [...this.tasks.values()]
      .filter((t) => {
        if (!t || t.trash || !t.title) return false;
        const col = t.column || t.status || 'todo';
        if (status && col !== status && t.status !== status) return false;
        if (priority && (t.priority || 'medium') !== priority) return false;
        if (q) {
          const hay = `${t.title} ${t.desc || ''} ${t.assignee || ''} ${(t.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) =>
        (a.status === 'done') - (b.status === 'done')
        || (order[a.priority?.toLowerCase()] ?? 2) - (order[b.priority?.toLowerCase()] ?? 2)
        || (a.dueDate && b.dueDate ? a.dueDate - b.dueDate : (b.dueDate ? 1 : 0) - (a.dueDate ? 1 : 0))
        || (b.updatedAt || 0) - (a.updatedAt || 0)
      );
  }

  getKanbanColumns(query = '') {
    const cols = { todo: [], in_progress: [], blocked: [], done: [] };
    for (const t of this.getTasks({ query })) {
      const col = t.column || t.status || 'todo';
      if (cols[col]) cols[col].push(t);
      else cols.todo.push(t);
    }
    return cols;
  }

  getTrashItems() {
    const items = [];
    const pushMap = (map, kind, titleFn) => {
      for (const rec of map.values()) {
        if (!rec || !rec.trash) continue;
        items.push({
          kind,
          kindLabel: TRASH_METHODS[kind].label,
          soul: rec.soul,
          title: titleFn(rec) || rec.soul,
          updatedAt: rec.updatedAt || rec.timestamp || rec.createdAt || 0
        });
      }
    };
    pushMap(this.notes, 'note', (n) => n.title || 'Untitled');
    pushMap(this.tasks, 'task', (t) => t.title);
    pushMap(this.calendar, 'event', (e) => e.title);
    pushMap(this.bookmarks, 'bookmark', (b) => b.title || b.url);
    pushMap(this.contacts, 'contact', (c) => c.name);
    pushMap(this.secrets, 'secret', (s) => s.name);
    pushMap(this.projects, 'project', (p) => p.name);
    return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getGardenState(now = Date.now()) {
    const hour = new Date(now).getHours();
    const isDone = (t) => t.status === 'done' || t.column === 'done';
    const col = (t) => t.column || t.status || 'todo';
    const kindOf = (t) => (isDone(t)
      ? 'harvest'
      : (t.dueDate && Number(t.dueDate) < now
        ? 'wilted'
        : (col(t) === 'blocked'
          ? 'blocked'
          : (col(t) === 'in_progress' ? 'young' : 'sprout'))));

    const plants = [...this.tasks.values()]
      .filter((t) => t && !t.trash && t.title && (!isDone(t) || now - (t.updatedAt || 0) < 14 * DAY_MS))
      .sort((a, b) => (a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0) || (a.soul < b.soul ? -1 : 1))
      .map((t) => ({
        soul: t.soul,
        title: t.title,
        kind: kindOf(t),
        priority: t.priority || 'medium',
        dueDate: t.dueDate || null,
        weedy: !isDone(t) && now - (t.updatedAt || t.createdAt || now) > 14 * DAY_MS
      }));

    const counts = { sprout: 0, young: 0, blocked: 0, wilted: 0, harvest: 0, weeds: 0, notesWeek: 0, doneToday: 0, unreadFeeds: 0, oldSecrets: 0 };
    for (const p of plants) {
      counts[p.kind]++;
      if (p.weedy) counts.weeds++;
    }
    counts.doneToday = [...this.tasks.values()].filter((t) => t && !t.trash && isDone(t) && now - (t.updatedAt || 0) < DAY_MS).length;

    const activeNotes = [...this.notes.values()].filter((n) => n && !n.trash);
    const lastNote = activeNotes.reduce((max, n) => Math.max(max, Number(n.timestamp || 0)), 0);
    counts.notesWeek = activeNotes.filter((n) => now - (n.timestamp || 0) < 7 * DAY_MS).length;
    const raining = lastNote > 0 && now - lastNote < DAY_MS;
    const dry = now - lastNote > 7 * DAY_MS;

    const tulips = [...this.calendar.values()]
      .filter((e) => e && !e.trash && e.title && (e.end ?? e.start) >= now && e.start - now < 7 * DAY_MS)
      .sort((a, b) => a.start - b.start)
      .slice(0, 10);

    for (const soul of this.feeds.keys()) {
      counts.unreadFeeds += this.getFeedUnreadCount(soul);
    }
    counts.oldSecrets = [...this.secrets.values()].filter((s) => s && !s.trash && now - (s.updatedAt || s.createdAt || now) > 365 * DAY_MS).length;

    const night = hour < 6 || hour >= 21;
    const dawn = !night && hour < 8;
    const dusk = !night && hour >= 18;
    const sky = counts.wilted >= 3 && !night ? 'stormy' : night ? 'night' : dawn ? 'dawn' : dusk ? 'dusk' : 'day';

    const health = Math.round(Math.max(0, Math.min(100,
      100 - 12 * counts.wilted - 5 * counts.weeds - (dry ? 15 : 0) - 4 * counts.oldSecrets - Math.min(counts.unreadFeeds, 20) / 2 - 4 * counts.blocked + 3 * counts.harvest
    )));
    const mood = health >= 75 ? 'Thriving' : health >= 45 ? 'Needs some care' : 'Struggling';

    const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
    const tips = [
      counts.wilted && { kind: 'wilted', text: `${plural(counts.wilted, 'overdue task is', 'overdue tasks are')} wilting. Finish or reschedule.`, targetView: 'tasks' },
      counts.blocked && { kind: 'blocked', text: `${plural(counts.blocked, 'blocked task has', 'blocked tasks have')} a snail on it.`, targetView: 'tasks' },
      counts.weeds && { kind: 'weeds', text: `${plural(counts.weeds, 'task untouched', 'tasks untouched')} for two weeks, weeds are growing.`, targetView: 'tasks' },
      dry && { kind: 'dry', text: lastNote ? 'No notes for a week: the soil is drying out. Write something.' : 'Write your first note to water the garden.', targetView: 'notes' },
      counts.oldSecrets && { kind: 'secrets', text: `${plural(counts.oldSecrets, 'secret is', 'secrets are')} older than a year: rocks in your field. Rotate them.`, targetView: 'secrets' },
      counts.unreadFeeds && { kind: 'feeds', text: `${plural(counts.unreadFeeds, 'unread feed item', 'unread feed items')} piling up as leaves.`, targetView: 'feeds' }
    ].filter(Boolean);

    return { health, mood, sky, raining, dry, plants, tulips, counts, tips };
  }

  getGardenHealth(now = Date.now()) {
    return this.getGardenState(now).health;
  }

  getCounts() {
    const countActive = (map) => {
      let c = 0;
      for (const v of map.values()) if (v && !v.trash) c++;
      return c;
    };
    return {
      notes: countActive(this.notes),
      projects: countActive(this.projects),
      tasks: countActive(this.tasks),
      calendar: countActive(this.calendar),
      bookmarks: countActive(this.bookmarks),
      feeds: this.feeds.size,
      contacts: countActive(this.contacts),
      secrets: countActive(this.secrets),
      files: this.files.length,
      blog: this.posts.size,
      trash: this.getTrashItems().length,
      gardenHealth: this.getGardenHealth()
    };
  }

  globalSearch(query, limit = 30) {
    const q = String(query || '').trim();
    const hits = [];
    const scan = (map, kind, view, titleFn, subFn) => {
      for (const item of map.values()) {
        if (!item || item.trash) continue;
        const title = String(titleFn(item) || '');
        const sub = String(subFn(item) || '');
        const s1 = fuzzyScore(q, title);
        const s2 = fuzzyScore(q, sub);
        const score = Math.max(s1 * 1.5, s2);
        if (score > 0) {
          hits.push({ kind, view, soul: item.soul || item.id, title, subtitle: sub, score });
        }
      }
    };

    scan(this.notes, 'note', 'notes', (n) => n.title || 'Untitled', (n) => extractTags(n.body).map((t) => '#' + t).join(' '));
    scan(this.tasks, 'task', 'tasks', (t) => t.title, (t) => `${t.column || t.status || 'todo'} · ${t.priority || 'medium'}`);
    scan(this.projects, 'project', 'projects', (p) => p.name, (p) => p.status || 'active');
    scan(this.calendar, 'event', 'calendar', (e) => e.title, (e) => e.location || '');
    scan(this.bookmarks, 'bookmark', 'bookmarks', (b) => b.title || b.url, (b) => b.url);
    scan(this.contacts, 'contact', 'contacts', (c) => c.name, (c) => (c.emails || [])[0] || c.org || '');
    scan(this.secrets, 'secret', 'secrets', (s) => s.name, (s) => s.username || s.kind || ''); // never match secret value

    return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  // ─── Mutations ────────────────────────────────────────────────────────

  async saveNote(data) {
    this._guardWrite();
    const res = await this.client.writeVaultNote(data);
    const existing = data.soul ? this.notes.get(data.soul) : null;
    this.notes.set(res.soul, {
      ...(existing || {}),
      ...data,
      soul: res.soul,
      timestamp: res.timestamp,
      trash: !!res.trash,
      updatedAt: res.timestamp
    });
    this._emit();
    return res;
  }

  async toggleNotePin(soul) {
    this._guardWrite();
    const n = this.notes.get(soul);
    if (!n) throw new Error('Note not found');
    return this.saveNote({ ...n, soul, pinned: !n.pinned });
  }

  async toggleNoteChecklist(soul, lineIndex) {
    this._guardWrite();
    const n = this.notes.get(soul);
    if (!n) throw new Error('Note not found');
    const body = toggleChecklistLine(n.body || '', lineIndex);
    return this.saveNote({ ...n, soul, body });
  }

  async openOrCreateWikiTarget(target, fromSoul = null) {
    const hit = this.findNoteByTitleOrSoul(target);
    if (hit) return { soul: hit.soul, created: false };
    this._guardWrite();
    const src = fromSoul ? this.notes.get(fromSoul) : null;
    const body = src ? `Linked from [[${src.title || fromSoul}]].\n\n` : '';
    const res = await this.saveNote({
      title: String(target).trim(),
      body,
      cat: src?.cat || 'general',
      projectId: src?.projectId || ''
    });
    return { soul: res.soul, created: true };
  }

  async trashNote(soul) {
    this._guardWrite();
    const res = await this.client.trashVaultNote(soul);
    const n = this.notes.get(soul);
    if (n) this.notes.set(soul, { ...n, trash: true, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  async saveTask(data) {
    this._guardWrite();
    const res = await this.client.writeTask(data);
    const existing = data.soul ? this.tasks.get(data.soul) : null;
    const status = data.status || existing?.status || 'todo';
    this.tasks.set(res.soul, {
      ...(existing || {}),
      ...data,
      status,
      column: data.column || status,
      soul: res.soul,
      trash: !!res.trash,
      updatedAt: res.updatedAt || Date.now()
    });
    this._emit();
    return res;
  }

  async updateTask(soul, patch) {
    this._guardWrite();
    const res = await this.client.updateTask(soul, patch);
    const cur = this.tasks.get(soul);
    if (cur) {
      this.tasks.set(soul, {
        ...cur,
        ...patch,
        soul,
        updatedAt: res.updatedAt || Date.now()
      });
    }
    this._emit();
    return res;
  }

  async moveTaskColumn(soul, newCol) {
    this._guardWrite();
    const t = this.tasks.get(soul);
    if (!t) throw new Error('Task not found');
    const patch = {
      status: newCol,
      column: newCol,
      completedAt: newCol === 'done' ? Date.now() : null
    };
    return this.updateTask(soul, patch);
  }

  async cycleTaskPriority(soul) {
    this._guardWrite();
    const t = this.tasks.get(soul);
    if (!t) throw new Error('Task not found');
    const order = ['low', 'medium', 'high', 'urgent'];
    const cur = order.indexOf((t.priority || 'medium').toLowerCase());
    const next = order[(cur + 1) % order.length];
    return this.updateTask(soul, { priority: next });
  }

  async trashTask(soul) {
    this._guardWrite();
    const res = await this.client.trashTask(soul);
    const t = this.tasks.get(soul);
    if (t) this.tasks.set(soul, { ...t, trash: true, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  async restoreTrashItem(kind, soul) {
    this._guardWrite();
    const spec = TRASH_METHODS[kind];
    if (!spec) throw new Error('Unknown trash kind: ' + kind);
    const res = await this.client[spec.restore](soul);
    const map = this[spec.map];
    const cur = map.get(soul);
    if (cur) map.set(soul, { ...cur, trash: false, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  async purgeTrashItem(kind, soul) {
    this._guardWrite();
    const spec = TRASH_METHODS[kind];
    if (!spec) throw new Error('Unknown trash kind: ' + kind);
    const res = await this.client[spec.del](soul);
    this[spec.map].delete(soul);
    this._emit();
    return res;
  }

  async emptyTrash() {
    this._guardWrite();
    const items = this.getTrashItems();
    for (const item of items) {
      await this.purgeTrashItem(item.kind, item.soul);
    }
    return items.length;
  }

  // ─── Projects (M2) ────────────────────────────────────────────────────

  getProjects({ status = null, query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const order = { active: 0, on_hold: 1, completed: 2, archived: 3 };
    return [...this.projects.values()]
      .filter((p) => {
        if (!p || p.trash || !p.name) return false;
        if (status && (p.status || 'active').toLowerCase() !== status.toLowerCase()) return false;
        if (q) {
          const hay = `${p.name} ${p.desc || ''} ${(p.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) =>
        (order[(a.status || 'active').toLowerCase()] ?? 1) - (order[(b.status || 'active').toLowerCase()] ?? 1)
        || (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
      );
  }

  getProjectWorkspace(projectSoul) {
    const project = this.projects.get(projectSoul);
    if (!project || project.trash) {
      return { project: null, notes: [], tasks: [], events: [], bookmarks: [] };
    }
    const linked = (kind) => new Set((project.links || []).filter((l) => l.kind === kind).map((l) => l.soul));
    const hasLink = (item, kind, set) =>
      item.projectId === projectSoul
      || set.has(item.soul)
      || (item.links || []).some((l) => l.kind === 'project' && l.soul === projectSoul);

    const nSet = linked('note');
    const tSet = linked('task');
    const eSet = linked('event');
    const bSet = linked('bookmark');

    const notes = [...this.notes.values()]
      .filter((n) => n && !n.trash && n.title !== undefined && hasLink(n, 'note', nSet))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.timestamp || 0) - (a.timestamp || 0));
    const tasks = [...this.tasks.values()]
      .filter((t) => t && !t.trash && t.title && hasLink(t, 'task', tSet));
    const events = [...this.calendar.values()]
      .filter((e) => e && !e.trash && e.title && hasLink(e, 'event', eSet))
      .sort((a, b) => a.start - b.start);
    const bookmarks = [...this.bookmarks.values()]
      .filter((b) => b && !b.trash && b.url && hasLink(b, 'bookmark', bSet));

    return { project, notes, tasks, events, bookmarks };
  }

  async saveProject(data) {
    this._guardWrite();
    const res = await this.client.writeProject(data);
    const cur = data.soul ? this.projects.get(data.soul) : null;
    const dueDate = data.dueDate != null && data.dueDate !== '' ? new Date(data.dueDate).getTime() : null;
    this.projects.set(res.soul, {
      ...(cur || {}),
      ...data,
      dueDate,
      tags: Array.isArray(data.tags) ? data.tags : String(data.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      soul: res.soul,
      trash: !!res.trash,
      updatedAt: res.updatedAt || Date.now()
    });
    this._emit();
    return res;
  }

  async updateProject(soul, patch) {
    this._guardWrite();
    const res = await this.client.updateProject(soul, patch);
    const cur = this.projects.get(soul);
    if (cur) {
      const next = { ...cur, ...patch, soul, updatedAt: res.updatedAt || Date.now() };
      if (patch.dueDate !== undefined) {
        next.dueDate = patch.dueDate != null && patch.dueDate !== '' ? new Date(patch.dueDate).getTime() : null;
      }
      this.projects.set(soul, next);
    }
    this._emit();
    return res;
  }

  async trashProject(soul) {
    this._guardWrite();
    const res = await this.client.trashProject(soul);
    const p = this.projects.get(soul);
    if (p) this.projects.set(soul, { ...p, trash: true, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  async linkToProject(projectSoul, { kind = 'note', soul }) {
    this._guardWrite();
    const res = await this.client.linkToProject(projectSoul, { kind, soul });
    const p = this.projects.get(projectSoul);
    if (p) {
      const links = [...(p.links || [])];
      if (!links.some((l) => l.kind === kind && l.soul === soul)) links.push({ kind, soul });
      this.projects.set(projectSoul, { ...p, links, updatedAt: Date.now() });
    }
    this._emit();
    return res;
  }

  async unlinkFromProject(projectSoul, { kind = 'note', soul }) {
    this._guardWrite();
    const res = await this.client.unlinkFromProject(projectSoul, { kind, soul });
    const p = this.projects.get(projectSoul);
    if (p) {
      this.projects.set(projectSoul, {
        ...p,
        links: (p.links || []).filter((l) => !(l.kind === kind && l.soul === soul)),
        updatedAt: Date.now()
      });
    }
    this._emit();
    return res;
  }

  // ─── Calendar (M2) ────────────────────────────────────────────────────

  getEvents({ from = null, to = null, query = '' } = {}) {
    const lo = from != null ? new Date(from).getTime() : -Infinity;
    const hi = to != null ? new Date(to).getTime() : Infinity;
    const q = String(query || '').trim().toLowerCase();
    return [...this.calendar.values()]
      .filter((ev) => {
        if (!ev || ev.trash || !ev.title) return false;
        if (ev.end < lo || ev.start > hi) return false;
        if (q) {
          const hay = `${ev.title} ${ev.notes || ''} ${ev.location || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => a.start - b.start);
  }

  getEventsForMonth(year, month) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const byDay = new Map();
    for (let d = 1; d <= daysInMonth; d++) byDay.set(d, []);

    const mStart = new Date(year, month, 1, 0, 0, 0, 0).getTime();
    const mEnd = new Date(year, month, daysInMonth, 23, 59, 59, 999).getTime();

    for (const ev of this.getEvents({ from: mStart, to: mEnd })) {
      for (let d = 1; d <= daysInMonth; d++) {
        const dStart = new Date(year, month, d, 0, 0, 0, 0).getTime();
        const dEnd = new Date(year, month, d, 23, 59, 59, 999).getTime();
        if ((ev.end ?? ev.start) >= dStart && ev.start <= dEnd) {
          byDay.get(d).push(ev);
        }
      }
    }
    return byDay;
  }

  async saveEvent(data) {
    this._guardWrite();
    const res = await this.client.writeCalendarEvent(data);
    const cur = data.soul ? this.calendar.get(data.soul) : null;
    const start = new Date(data.start).getTime();
    const end = data.end != null ? new Date(data.end).getTime() : start;
    this.calendar.set(res.soul, {
      ...(cur || {}),
      ...data,
      start,
      end,
      soul: res.soul,
      trash: !!res.trash,
      updatedAt: res.updatedAt || Date.now()
    });
    this._emit();
    return res;
  }

  async trashEvent(soul) {
    this._guardWrite();
    const res = await this.client.trashCalendarEvent(soul);
    const ev = this.calendar.get(soul);
    if (ev) this.calendar.set(soul, { ...ev, trash: true, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  // ─── Bookmarks (M2) ───────────────────────────────────────────────────

  getBookmarkFolders() {
    const counts = new Map();
    for (const bm of this.bookmarks.values()) {
      if (!bm || bm.trash || !bm.url) continue;
      const f = bm.folder || '';
      counts.set(f, (counts.get(f) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([folder, count]) => ({ folder, count }))
      .sort((a, b) => {
        if (a.folder === '' && b.folder !== '') return -1;
        if (b.folder === '' && a.folder !== '') return 1;
        return a.folder.localeCompare(b.folder);
      });
  }

  getBookmarks({ folder = null, query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const words = q ? q.split(/\s+/).filter(Boolean) : [];
    return [...this.bookmarks.values()]
      .filter((bm) => {
        if (!bm || bm.trash || !bm.url) return false;
        if (folder !== null) {
          const bf = bm.folder || '';
          if (folder === '') {
            if (bf !== '') return false;
          } else if (bf !== folder && !bf.startsWith(folder + '/')) {
            return false;
          }
        }
        if (words.length) {
          const hay = `${bm.title || ''} ${bm.url || ''} ${bm.folder || ''} ${(bm.tags || []).join(' ')}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return false;
        }
        return true;
      })
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  async saveBookmark(data) {
    this._guardWrite();
    const res = await this.client.writeBookmark(data);
    const cur = this.bookmarks.get(res.soul);
    this.bookmarks.set(res.soul, {
      ...(cur || {}),
      title: data.title || data.url,
      folder: data.folder || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      addedAt: data.addedAt || cur?.addedAt || Date.now(),
      ...data,
      soul: res.soul,
      trash: !!data.trash,
      updatedAt: Date.now()
    });
    this._emit();
    return res;
  }

  async updateBookmark(soul, patch) {
    this._guardWrite();
    const res = await this.client.updateBookmark(soul, patch);
    const cur = this.bookmarks.get(soul);
    if (cur) this.bookmarks.set(soul, { ...cur, ...patch, soul, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  async trashBookmark(soul) {
    this._guardWrite();
    const res = await this.client.trashBookmark(soul);
    const bm = this.bookmarks.get(soul);
    if (bm) this.bookmarks.set(soul, { ...bm, trash: true, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  // ─── Secrets (M2) ─────────────────────────────────────────────────────

  getSecrets({ kind = null, query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const words = q ? q.split(/\s+/).filter(Boolean) : [];
    return [...this.secrets.values()]
      .filter((s) => {
        if (!s || s.trash || !s.name) return false;
        if (kind && s.kind !== kind) return false;
        if (words.length) {
          // NEVER match against s.secret
          const hay = `${s.name || ''} ${s.username || ''} ${s.url || ''} ${s.notes || ''} ${(s.tags || []).join(' ')}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return false;
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveSecret(data) {
    this._guardWrite();
    const res = await this.client.writeSecret(data);
    const cur = data.soul ? this.secrets.get(data.soul) : null;
    this.secrets.set(res.soul, {
      ...(cur || {}),
      ...data,
      soul: res.soul,
      trash: !!data.trash,
      createdAt: data.createdAt || cur?.createdAt || Date.now(),
      updatedAt: Date.now()
    });
    this._emit();
    return res;
  }

  async trashSecret(soul) {
    this._guardWrite();
    const res = await this.client.trashSecret(soul);
    const s = this.secrets.get(soul);
    if (s) this.secrets.set(soul, { ...s, trash: true, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  // ─── Spaces Management (M2) ───────────────────────────────────────────

  async refreshSpaces() {
    this.spaces = await this.baseClient.spaces();
    this._emit();
    return this.spaces;
  }

  async createSpace(name) {
    const view = await this.baseClient.createSpace(name);
    this.spaces = await this.baseClient.spaces().catch(() => this.spaces);
    this._unsubCollections();
    if (this.client !== this.baseClient) {
      try { this.client.close(); } catch (_) {}
    }
    this._clearCollections();
    this.client = view;
    this.activeSpace = { id: view.spaceId, name: view.spaceName, role: view.spaceRole };
    this._subscribeCollections();
    this._emit();
    return this.activeSpace;
  }

  async joinSpaceLink(url) {
    const view = await this.baseClient.joinLink(url);
    this.spaces = await this.baseClient.spaces().catch(() => this.spaces);
    this._unsubCollections();
    if (this.client !== this.baseClient) {
      try { this.client.close(); } catch (_) {}
    }
    this._clearCollections();
    this.client = view;
    this.activeSpace = { id: view.spaceId, name: view.spaceName, role: view.spaceRole };
    this._subscribeCollections();
    this._emit();
    return this.activeSpace;
  }

  async leaveSpace(id) {
    const res = await this.baseClient.leaveSpace(id);
    if (this.activeSpace && String(this.activeSpace.id) === String(id)) {
      await this.switchSpace(null);
    }
    this.spaces = await this.baseClient.spaces().catch(() => this.spaces);
    this._emit();
    return res;
  }

  async inviteToSpace(userOrPubkey, role = 'editor') {
    if (!this.activeSpace) throw new Error('Open a shared space first');
    return this.client.invite(userOrPubkey, role);
  }

  async createSpaceLink(role = 'viewer') {
    if (!this.activeSpace) throw new Error('Open a shared space first');
    return this.client.createLink(role);
  }

  async listSpaceMembers() {
    if (!this.activeSpace) throw new Error('Open a shared space first');
    return this.client.members();
  }

  // ─── Feeds (M3) ───────────────────────────────────────────────────────

  getFeeds({ folder = null, query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return [...this.feeds.values()]
      .filter((f) => {
        if (!f || !f.url) return false;
        if (folder !== null && (f.folder || '') !== folder) return false;
        if (q) {
          const hay = `${f.title || ''} ${f.url} ${f.folder || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || (a.title || a.url).localeCompare(b.title || b.url));
  }

  getFeedUnreadCount(soul) {
    const feed = this.feeds.get(soul);
    const cached = this.feedArticles.get(soul);
    if (!feed || !cached || !Array.isArray(cached.items)) return 0;
    const readAt = Number(feed.readAt || 0);
    return cached.items.filter((it) => Number(it.date || 0) > readAt).length;
  }

  async addFeed(url, { title = '', folder = '' } = {}) {
    this._guardWrite();
    const res = await this.client.addFeed(url, { title, folder });
    const existing = this.feeds.get(res.soul);
    this.feeds.set(res.soul, {
      ...(existing || {}),
      soul: res.soul,
      url,
      title: title || existing?.title || '',
      folder: folder || existing?.folder || '',
      addedAt: existing?.addedAt || Date.now(),
      readAt: existing?.readAt || 0
    });
    this._emit();
    return res;
  }

  async findAndAddFeed(url, { folder = '' } = {}) {
    this._guardWrite();
    let feedUrl = url;
    let feedData = null;
    try {
      const found = await this.client.findFeed(url);
      feedUrl = found.url;
      feedData = found.feed;
    } catch (_) {
      // Fallback: subscribe raw URL directly
    }
    const res = await this.addFeed(feedUrl, { title: feedData?.title || '', folder });
    if (feedData) {
      this.feedArticles.set(res.soul, { ...feedData, fetchedAt: Date.now() });
      this._emit();
    }
    return { ...res, url: feedUrl, feed: feedData };
  }

  async updateFeed(soul, { title, folder } = {}) {
    this._guardWrite();
    const res = await this.client.updateFeed(soul, { title, folder });
    const cur = this.feeds.get(soul);
    if (cur) {
      this.feeds.set(soul, {
        ...cur,
        ...(title !== undefined && { title }),
        ...(folder !== undefined && { folder })
      });
    }
    this._emit();
    return res;
  }

  async fetchFeedArticles(soul) {
    const feed = this.feeds.get(soul);
    if (!feed) throw new Error('Feed not found');
    const parsed = await this.client.fetchFeed(feed.url);
    this.feedArticles.set(soul, { ...parsed, fetchedAt: Date.now() });
    if (!feed.title && parsed.title && !this.isReadOnly()) {
      this.updateFeed(soul, { title: parsed.title }).catch(() => {});
    }
    this._emit();
    return parsed;
  }

  async markFeedRead(soul, readAt = Date.now()) {
    this._guardWrite();
    const res = await this.client.markFeedRead(soul, readAt);
    const cur = this.feeds.get(soul);
    if (cur) this.feeds.set(soul, { ...cur, readAt });
    this._emit();
    return res;
  }

  async deleteFeed(soul) {
    this._guardWrite();
    const res = await this.client.deleteFeed(soul);
    this.feeds.delete(soul);
    this.feedArticles.delete(soul);
    this._emit();
    return res;
  }

  async importFeedsOpml(xml) {
    this._guardWrite();
    const res = await this.client.importFeedsOpml(xml);
    const all = await this.client.readFeeds();
    this.feeds.clear();
    for (const f of all) this.feeds.set(f.soul, f);
    this._emit();
    return res;
  }

  async exportFeedsOpml() {
    return this.client.exportFeedsOpml();
  }

  // ─── Contacts (M3) ────────────────────────────────────────────────────

  getContacts({ tag = null, query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const wantTag = tag ? tag.replace(/^#/, '').toLowerCase() : null;
    const words = q ? q.split(/\s+/).filter(Boolean) : [];
    return [...this.contacts.values()]
      .filter((c) => {
        if (!c || c.trash || !c.name) return false;
        if (wantTag && !(c.tags || []).some((t) => t.toLowerCase() === wantTag)) return false;
        if (words.length) {
          const hay = `${c.name} ${c.org || ''} ${c.notes || ''} ${c.pub || ''} ${(c.emails || []).join(' ')} ${(c.phones || []).join(' ')} ${(c.tags || []).join(' ')}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return false;
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveContact(data) {
    this._guardWrite();
    const res = await this.client.writeContact(data);
    const cur = data.soul ? this.contacts.get(data.soul) : null;
    this.contacts.set(res.soul, {
      ...(cur || {}),
      ...data,
      soul: res.soul,
      trash: !!data.trash,
      updatedAt: Date.now()
    });
    this._emit();
    return res;
  }

  async trashContact(soul) {
    this._guardWrite();
    const res = await this.client.trashContact(soul);
    const c = this.contacts.get(soul);
    if (c) this.contacts.set(soul, { ...c, trash: true, updatedAt: Date.now() });
    this._emit();
    return res;
  }

  async importContactsVcf(text) {
    this._guardWrite();
    const res = await this.client.importContactsVcf(text);
    const all = await this.client.readContacts({ includeTrash: true });
    for (const c of all) this.contacts.set(c.soul, c);
    this._emit();
    return res;
  }

  async exportContactsVcf(opts) {
    return this.client.exportContactsVcf(opts);
  }

  // ─── Files (M3) ───────────────────────────────────────────────────────

  getFileGroups(kind = 'folder') {
    const counts = new Map();
    for (const f of this.files) {
      const g = f[kind] || '';
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        if (a.name === '' && b.name !== '') return -1;
        if (b.name === '' && a.name !== '') return 1;
        return a.name.localeCompare(b.name);
      });
  }

  getFiles({ groupKind = 'folder', groupName = null, query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return [...this.files]
      .filter((f) => {
        if (!f || !f.id) return false;
        if (groupName !== null) {
          const val = f[groupKind] || '';
          if (groupName === '') {
            if (val !== '') return false;
          } else if (groupKind === 'folder') {
            if (val !== groupName && !val.startsWith(groupName + '/')) return false;
          } else if (val !== groupName) {
            return false;
          }
        }
        if (q) {
          const hay = `${f.name || ''} ${f.folder || ''} ${f.album || ''} ${f.playlist || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  async uploadLocalFile(filePath, { folder = '', album = '', playlist = '', chunked = false, onProgress } = {}) {
    this._guardWrite();
    const abs = expandHome(filePath);
    const bytes = new Uint8Array(fs.readFileSync(abs));
    const name = path.basename(abs);
    const useChunked = chunked || bytes.length > 4 * 1024 * 1024;
    const meta = useChunked
      ? await this.client.uploadFileChunked(bytes, name, { folder, album, playlist, onProgress })
      : await this.client.uploadFile(bytes, name, { folder, album, playlist });
    await this.refreshFiles();
    return meta;
  }

  async downloadToLocalFile(id, outPath) {
    const abs = expandHome(outPath);
    const meta = this.files.find((f) => f.id === id);
    const bytes = await this.client.downloadFile(id, meta ? { meta } : undefined);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return { path: abs, bytes: bytes.length };
  }

  async previewTextFile(id, maxBytes = 32768) {
    const meta = this.files.find((f) => f.id === id);
    let bytes;
    let truncated = false;
    if (meta?.chunked) {
      const end = Math.min(meta.size, maxBytes);
      bytes = await this.client.readFileRange(id, 0, end, meta);
      truncated = meta.size > maxBytes;
    } else {
      const full = await this.client.downloadFile(id, meta ? { meta } : undefined);
      truncated = full.length > maxBytes;
      bytes = truncated ? full.subarray(0, maxBytes) : full;
    }
    const isBinary = bytes.includes(0);
    return {
      isBinary,
      text: isBinary ? '' : new TextDecoder().decode(bytes),
      truncated,
      size: meta?.size ?? bytes.length
    };
  }

  async moveFile(id, { folder, album, playlist } = {}) {
    this._guardWrite();
    const meta = await this.client.moveFile(id, { folder, album, playlist });
    await this.refreshFiles();
    return meta;
  }

  async deleteFile(id) {
    this._guardWrite();
    const res = await this.client.deleteFile(id);
    this.files = this.files.filter((f) => f.id !== id);
    this._emit();
    return res;
  }

  async shareFile(id) {
    return this.client.shareFile(id);
  }

  // ─── Blog (M3) ────────────────────────────────────────────────────────

  getPosts({ query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return [...this.posts.values()]
      .filter((p) => {
        if (!p || !p.id) return false;
        if (q) {
          const hay = `${p.title || ''} ${p.content || ''} ${(p.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async publishPost({ id = null, title, content, tags = [], createdAt = Date.now() }) {
    if (this.activeSpace) throw new Error('Blog posts are personal-only (switch to Personal workspace)');
    const res = await this.baseClient.publishBlogPost({ id, title, content, tags, createdAt });
    this.posts.set(res.id, {
      id: res.id,
      title,
      content,
      tags: Array.isArray(tags) ? tags : String(tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      authorAlias: this.baseClient.username,
      authorPub: this.baseClient.pub,
      createdAt,
      updatedAt: Date.now()
    });
    this._emit();
    return res;
  }

  async deletePost(id) {
    if (this.activeSpace) throw new Error('Blog posts are personal-only');
    const res = await this.baseClient.deleteBlogPost(id);
    this.posts.delete(id);
    this._emit();
    return res;
  }
}
