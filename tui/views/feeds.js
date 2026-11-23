import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openUrl } from '../engine/open.js';
import { truncate, wrapText } from '../engine/screen.js';
import { drawModal, drawTextInput, formatShortDate } from '../engine/widgets.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

export function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, k) => {
      if (k.startsWith('#x') || k.startsWith('#X')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return ENT[k.toLowerCase()] ?? m;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

export class FeedsView {
  constructor({ store, toast, onRedraw }) {
    this.store = store;
    this.toast = toast;
    this.onRedraw = onRedraw;

    this.pane = 'feeds'; // 'feeds' | 'articles' | 'reader'
    this.feedIdx = 0;
    this.selectedSoul = null;
    this.articleIdx = 0;
    this.readerScroll = 0;
    this.loadingSoul = null;
    this.query = '';
    this.searchMode = false;
    this.modal = null;
  }

  _getFeeds() {
    return this.store.getFeeds({ query: this.query });
  }

  _currentFeed(list) {
    if (!list.length) {
      this.feedIdx = 0;
      this.selectedSoul = null;
      return null;
    }
    if (this.selectedSoul) {
      const idx = list.findIndex((f) => f.soul === this.selectedSoul);
      if (idx >= 0) {
        this.feedIdx = idx;
        return list[idx];
      }
    }
    this.feedIdx = Math.max(0, Math.min(list.length - 1, this.feedIdx));
    this.selectedSoul = list[this.feedIdx].soul;
    return list[this.feedIdx];
  }

  async _fetchFeed(feed) {
    if (!feed) return;
    this.loadingSoul = feed.soul;
    this.onRedraw?.();
    try {
      const parsed = await this.store.fetchFeedArticles(feed.soul);
      this.loadingSoul = null;
      this.articleIdx = 0;
      this.readerScroll = 0;
      this.toast(`Loaded ${parsed.items.length} article(s)`, 'success');
    } catch (e) {
      this.loadingSoul = null;
      this.toast(e.message || 'Could not fetch feed', 'error');
    }
    this.onRedraw?.();
  }

  async _handleModalKey(ev, currentFeed) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') { this.modal = null; return true; }

    if (m.kind === 'add') {
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = m.focus === 0 ? 1 : 0;
        return true;
      }
      if (ev.name === 'enter') {
        const url = m.url.trim();
        if (!/^https?:\/\//i.test(url)) { this.toast('Feed URL must be http(s)', 'error'); return true; }
        this.modal = null;
        this.toast('Discovering feed...');
        this.onRedraw?.();
        try {
          const res = await this.store.findAndAddFeed(url, { folder: m.folder.trim() });
          this.selectedSoul = res.soul;
          this.toast(`Subscribed to ${res.feed?.title || res.url}`, 'success');
        } catch (e) {
          this.toast(e.message || 'Add feed failed', 'error');
        }
        return true;
      }
      const key = m.focus === 0 ? 'url' : 'folder';
      if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
      if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'edit' && currentFeed) {
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = m.focus === 0 ? 1 : 0;
        return true;
      }
      if (ev.name === 'enter') {
        try {
          await this.store.updateFeed(currentFeed.soul, { title: m.title.trim(), folder: m.folder.trim() });
          this.modal = null;
          this.toast('Feed updated', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      const key = m.focus === 0 ? 'title' : 'folder';
      if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
      if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'opml-import' || m.kind === 'opml-export') {
      if (ev.name === 'enter') {
        const filePath = expandHome(m.path);
        this.modal = null;
        try {
          if (m.kind === 'opml-import') {
            const xml = fs.readFileSync(filePath, 'utf8');
            const res = await this.store.importFeedsOpml(xml);
            this.toast(`Imported ${res.imported} feed(s)`, 'success');
          } else {
            const xml = await this.store.exportFeedsOpml();
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, xml, 'utf8');
            this.toast(`Exported OPML to ${filePath}`, 'success');
          }
        } catch (e) {
          this.toast(e.message || 'OPML error', 'error');
        }
        return true;
      }
      if (ev.name === 'backspace') { m.path = m.path.slice(0, -1); return true; }
      if (ev.name === 'paste') { m.path += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m.path += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'delete' && currentFeed) {
      if (ev.name === 'y' || ev.name === 'enter') {
        this.modal = null;
        try {
          await this.store.deleteFeed(currentFeed.soul);
          this.selectedSoul = null;
          this.toast('Unsubscribed feed', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      if (ev.name === 'n') { this.modal = null; return true; }
      return true;
    }

    return true;
  }

  async handleKey(ev) {
    const feeds = this._getFeeds();
    const currentFeed = this._currentFeed(feeds);
    const cached = currentFeed ? this.store.feedArticles.get(currentFeed.soul) : null;
    const articles = cached?.items || [];
    this.articleIdx = articles.length ? Math.max(0, Math.min(articles.length - 1, this.articleIdx)) : 0;
    const currentArticle = articles[this.articleIdx] || null;

    if (this.modal) return this._handleModalKey(ev, currentFeed);

    if (this.searchMode) {
      if (ev.name === 'escape') { this.query = ''; this.searchMode = false; this.feedIdx = 0; this.selectedSoul = null; return true; }
      if (ev.name === 'enter') { this.searchMode = false; return true; }
      if (ev.name === 'backspace') { this.query = this.query.slice(0, -1); this.feedIdx = 0; this.selectedSoul = null; return true; }
      if (ev.name === 'paste') { this.query += ev.paste.replace(/\r?\n/g, ' '); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.query += ev.ch; this.feedIdx = 0; this.selectedSoul = null; return true; }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) { this.searchMode = true; return true; }
    if (ev.name === 'escape') {
      if (this.pane === 'reader') { this.pane = 'articles'; return true; }
      if (this.query) { this.query = ''; this.feedIdx = 0; this.selectedSoul = null; return true; }
    }

    if (ev.name === 'n' || ev.name === 'a') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'add', url: 'https://', folder: '', focus: 0 };
      return true;
    }
    if (ev.shift && ev.name === 'I') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'opml-import', path: '~/feeds.opml' };
      return true;
    }
    if (ev.shift && ev.name === 'E') {
      this.modal = { kind: 'opml-export', path: '~/feeds.opml' };
      return true;
    }

    if (ev.name === 'tab' || ev.name === 'h' || ev.name === 'l' || ev.name === 'left' || ev.name === 'right') {
      const dir = (ev.name === 'h' || ev.name === 'left' || (ev.shift && ev.name === 'tab')) ? -1 : 1;
      const order = ['feeds', 'articles', 'reader'];
      const cur = order.indexOf(this.pane);
      this.pane = order[(cur + dir + order.length) % order.length];
      return true;
    }

    if (this.pane === 'feeds') {
      if (ev.name === 'j' || ev.name === 'down') {
        if (feeds.length) {
          this.feedIdx = Math.min(feeds.length - 1, this.feedIdx + 1);
          this.selectedSoul = feeds[this.feedIdx].soul;
          this.articleIdx = 0;
          this.readerScroll = 0;
        }
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        if (feeds.length) {
          this.feedIdx = Math.max(0, this.feedIdx - 1);
          this.selectedSoul = feeds[this.feedIdx].soul;
          this.articleIdx = 0;
          this.readerScroll = 0;
        }
        return true;
      }
      if (ev.name === 'enter' && currentFeed) {
        if (!cached) await this._fetchFeed(currentFeed);
        this.pane = 'articles';
        return true;
      }
    } else if (this.pane === 'articles') {
      if (ev.name === 'j' || ev.name === 'down') {
        if (articles.length) { this.articleIdx = Math.min(articles.length - 1, this.articleIdx + 1); this.readerScroll = 0; }
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        this.articleIdx = Math.max(0, this.articleIdx - 1);
        this.readerScroll = 0;
        return true;
      }
      if (ev.name === 'enter' && currentArticle) {
        this.pane = 'reader';
        this.readerScroll = 0;
        return true;
      }
    } else if (this.pane === 'reader') {
      if (ev.name === 'j' || ev.name === 'down') { this.readerScroll += 1; return true; }
      if (ev.name === 'k' || ev.name === 'up') { this.readerScroll = Math.max(0, this.readerScroll - 1); return true; }
      if (ev.name === 'pagedown') { this.readerScroll += 10; return true; }
      if (ev.name === 'pageup') { this.readerScroll = Math.max(0, this.readerScroll - 10); return true; }
    }

    if (!currentFeed) return false;

    if (ev.name === 'r') {
      await this._fetchFeed(currentFeed);
      return true;
    }
    if (ev.name === 'm') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      try {
        await this.store.markFeedRead(currentFeed.soul);
        this.toast('Marked feed as read', 'success');
      } catch (e) { this.toast(e.message, 'error'); }
      return true;
    }
    if (ev.name === 'i') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'edit', title: currentFeed.title || '', folder: currentFeed.folder || '', focus: 0 };
      return true;
    }
    if (ev.name === 'd') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'delete' };
      return true;
    }
    if (ev.name === 'o' && currentArticle?.link) {
      const r = openUrl(currentArticle.link);
      this.toast(r.ok ? 'Opened article in browser' : r.error, r.ok ? 'success' : 'error');
      return true;
    }
    if (ev.name === 'b' && currentArticle?.link) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      try {
        await this.store.saveBookmark({ url: currentArticle.link, title: currentArticle.title || currentArticle.link, folder: 'Feeds' });
        this.toast('Saved article as Bookmark', 'success');
      } catch (e) { this.toast(e.message, 'error'); }
      return true;
    }

    return false;
  }

  getHints() {
    if (this.searchMode) return 'Type to filter feeds  ·  Enter: apply  ·  Esc: clear';
    return 'Enter:fetch/read  r:refresh  m:mark read  o:open URL  b:bookmark  n:add  I/E:OPML  d:unsub';
  }

  render(screen, theme, area) {
    const feeds = this._getFeeds();
    const currentFeed = this._currentFeed(feeds);
    const cached = currentFeed ? this.store.feedArticles.get(currentFeed.soul) : null;
    const articles = cached?.items || [];
    this.articleIdx = articles.length ? Math.max(0, Math.min(articles.length - 1, this.articleIdx)) : 0;
    const currentArticle = articles[this.articleIdx] || null;

    const wide = area.w >= 64;
    const leftW = wide ? Math.max(24, Math.min(34, Math.floor(area.w * 0.34))) : area.w;

    if (wide || this.pane === 'feeds') {
      screen.box(area.x, area.y, leftW, area.h, {
        title: `Feeds (${feeds.length})`,
        rightTitle: this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[/]'),
        borderColor: this.pane === 'feeds' ? theme.borderFocus : theme.border,
        bg: theme.listBg
      });
      const iw = leftW - 2;
      const ih = area.h - 2;
      const maxVis = Math.max(1, Math.floor(ih / 2));
      const scroll = this.feedIdx >= maxVis ? this.feedIdx - maxVis + 1 : 0;

      if (!feeds.length) {
        screen.text(area.x + 2, area.y + 2, 'No feeds yet. Press n to subscribe.', { fg: theme.fgMuted, bg: theme.listBg });
      } else {
        for (let i = 0; i < maxVis && scroll + i < feeds.length; i++) {
          const f = feeds[scroll + i];
          const sel = scroll + i === this.feedIdx;
          const bg = sel ? theme.selectedBg : theme.listBg;
          const ry = area.y + 1 + i * 2;
          screen.fill(area.x + 1, ry, iw, 2, ' ', { fg: theme.fg, bg });
          const unread = this.store.getFeedUnreadCount(f.soul);
          const badge = this.loadingSoul === f.soul ? '...' : (unread > 0 ? `(${unread})` : '');
          screen.text(area.x + 2, ry, (sel ? '▸ ' : '  ') + truncate(f.title || f.url, Math.max(8, iw - badge.length - 5)), {
            fg: theme.fg,
            bg,
            bold: sel || unread > 0
          });
          if (badge) screen.text(area.x + leftW - 2 - badge.length, ry, badge, { fg: theme.accentSoft, bg });
          screen.text(area.x + 4, ry + 1, truncate(f.folder ? `[${f.folder}] ${f.url}` : f.url, iw - 4), { fg: theme.fgMuted, bg });
        }
      }
    }

    if (wide || this.pane !== 'feeds') {
      const rx = wide ? area.x + leftW : area.x;
      const rw = wide ? area.w - leftW : area.w;

      if (this.pane === 'reader' && currentArticle) {
        screen.box(rx, area.y, rw, area.h, {
          title: truncate(currentArticle.title || 'Article', rw - 10),
          rightTitle: 'Esc: articles',
          borderColor: theme.borderFocus,
          bg: theme.panelBg,
          titleColor: theme.accent
        });
        const iw = rw - 4;
        const ih = area.h - 2;
        const headerLines = [
          currentArticle.title || '',
          [currentArticle.date ? formatShortDate(currentArticle.date) : '', currentArticle.link || ''].filter(Boolean).join(' · '),
          '─'.repeat(Math.min(iw, 40)),
          ''
        ];
        const bodyPlain = htmlToPlainText(currentArticle.content || currentArticle.summary || '(No content)');
        const lines = [...headerLines.flatMap((l) => wrapText(l, iw)), ...wrapText(bodyPlain, iw)];
        const maxS = Math.max(0, lines.length - ih);
        this.readerScroll = Math.max(0, Math.min(maxS, this.readerScroll));
        for (let r = 0; r < ih && this.readerScroll + r < lines.length; r++) {
          screen.text(rx + 2, area.y + 1 + r, lines[this.readerScroll + r], {
            fg: this.readerScroll + r === 1 ? theme.cyan : theme.fg,
            bg: theme.panelBg,
            bold: this.readerScroll + r === 0
          });
        }
      } else {
        screen.box(rx, area.y, rw, area.h, {
          title: currentFeed ? (currentFeed.title || currentFeed.url) : 'Articles',
          rightTitle: cached ? `${articles.length} items` : 'r: fetch',
          borderColor: this.pane === 'articles' ? theme.borderFocus : theme.border,
          bg: theme.panelBg
        });
        const iw = rw - 4;
        const ih = area.h - 2;
        if (!currentFeed) {
          screen.text(rx + 2, area.y + 2, 'Select a feed.', { fg: theme.fgMuted, bg: theme.panelBg });
        } else if (this.loadingSoul === currentFeed.soul) {
          screen.text(rx + 2, area.y + 2, 'Fetching feed...', { fg: theme.amber, bg: theme.panelBg });
        } else if (!cached) {
          screen.text(rx + 2, area.y + 2, 'Press Enter or r to fetch articles live.', { fg: theme.fgMuted, bg: theme.panelBg });
        } else if (!articles.length) {
          screen.text(rx + 2, area.y + 2, 'Feed returned 0 articles.', { fg: theme.fgMuted, bg: theme.panelBg });
        } else {
          const readAt = Number(currentFeed.readAt || 0);
          const maxVis = Math.max(1, Math.floor(ih / 2));
          const scroll = this.articleIdx >= maxVis ? this.articleIdx - maxVis + 1 : 0;
          for (let i = 0; i < maxVis && scroll + i < articles.length; i++) {
            const a = articles[scroll + i];
            const sel = this.pane === 'articles' && scroll + i === this.articleIdx;
            const unread = Number(a.date || 0) > readAt;
            const bg = sel ? theme.selectedBg : theme.panelBg;
            const ry = area.y + 1 + i * 2;
            screen.fill(rx + 1, ry, rw - 2, 2, ' ', { fg: theme.fg, bg });
            const dt = a.date ? formatShortDate(a.date) : '';
            screen.text(rx + 2, ry, (sel ? '▸ ' : (unread ? '● ' : '  ')), { fg: unread ? theme.accent : theme.fgMuted, bg });
            screen.text(rx + 4, ry, truncate(a.title || a.link || 'Untitled', Math.max(10, iw - dt.length - 4)), {
              fg: unread ? theme.fg : theme.fgDim,
              bg,
              bold: sel || unread
            });
            if (dt) screen.text(rx + rw - 2 - dt.length, ry, dt, { fg: theme.fgMuted, bg });
            if (a.summary || a.link) {
              screen.text(rx + 4, ry + 1, truncate(htmlToPlainText(a.summary) || a.link, iw - 2), { fg: theme.fgMuted, bg });
            }
          }
        }
      }
    }

    if (this.modal) this._renderModal(screen, theme);
  }

  _renderModal(screen, theme) {
    const m = this.modal;
    if (m.kind === 'add' || m.kind === 'edit') {
      const box = drawModal(screen, theme, {
        title: m.kind === 'add' ? 'Subscribe to RSS/Atom Feed' : 'Edit Feed',
        width: 60,
        height: 11,
        footer: 'Tab: field  ·  Enter: save  ·  Esc: cancel'
      });
      const firstLbl = m.kind === 'add' ? 'Feed or Website URL' : 'Title';
      const firstVal = m.kind === 'add' ? m.url : m.title;
      screen.text(box.x, box.y + 1, firstLbl, { fg: m.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, firstVal, firstVal.length, { focused: m.focus === 0, theme });
      screen.text(box.x, box.y + 4, 'Folder (optional)', { fg: m.focus === 1 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 5, box.w, m.folder, m.folder.length, { focused: m.focus === 1, theme });
    } else if (m.kind === 'opml-import' || m.kind === 'opml-export') {
      const box = drawModal(screen, theme, {
        title: m.kind === 'opml-import' ? 'Import OPML File' : 'Export OPML File',
        width: 58,
        height: 9,
        footer: 'Enter: run  ·  Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'File Path', { fg: theme.accentSoft, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, m.path, m.path.length, { focused: true, theme });
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Unsubscribe Feed?',
        width: 48,
        height: 8,
        footer: 'y/Enter: delete  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Remove this feed subscription?', { fg: theme.fg, bg: theme.panelBg });
    }
  }
}
