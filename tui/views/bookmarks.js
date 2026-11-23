import { copyToClipboard } from '../engine/clipboard.js';
import { openUrl } from '../engine/open.js';
import { truncate } from '../engine/screen.js';
import { drawModal, drawTextInput, formatRelativeTime } from '../engine/widgets.js';

export class BookmarksView {
  constructor({ store, toast }) {
    this.store = store;
    this.toast = toast;

    this.pane = 'list'; // 'folders' | 'list'
    this.folderIdx = 0;
    this.selectedFolder = null; // null = All, '' = Unfiled, string = folder
    this.itemIdx = 0;
    this.selectedSoul = null;
    this.listScroll = 0;
    this.query = '';
    this.searchMode = false;
    this.modal = null;
  }

  selectBySoul(soul) {
    this.selectedFolder = null;
    this.folderIdx = 0;
    this.query = '';
    this.selectedSoul = soul;
    const list = this.store.getBookmarks({ folder: null, query: '' });
    const idx = list.findIndex((b) => b.soul === soul);
    if (idx >= 0) this.itemIdx = idx;
    this.pane = 'list';
  }

  _folderEntries() {
    const raw = this.store.getBookmarkFolders();
    const total = this.store.getBookmarks({ folder: null }).length;
    return [
      { folder: null, label: 'All Bookmarks', count: total },
      ...raw.map((r) => ({ folder: r.folder, label: r.folder || 'Unfiled', count: r.count }))
    ];
  }

  _getList() {
    return this.store.getBookmarks({ folder: this.selectedFolder, query: this.query });
  }

  _current(list) {
    if (!list.length) {
      this.itemIdx = 0;
      this.selectedSoul = null;
      return null;
    }
    if (this.selectedSoul) {
      const idx = list.findIndex((b) => b.soul === this.selectedSoul);
      if (idx >= 0) {
        this.itemIdx = idx;
        return list[idx];
      }
    }
    this.itemIdx = Math.max(0, Math.min(list.length - 1, this.itemIdx));
    this.selectedSoul = list[this.itemIdx].soul;
    return list[this.itemIdx];
  }

  async _handleModalKey(ev, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') { this.modal = null; return true; }

    if (m.kind === 'new' || m.kind === 'edit') {
      const fields = m.kind === 'new' ? 4 : 3;
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? fields - 1 : 1)) % fields;
        return true;
      }
      if (ev.name === 'enter') {
        const tags = m.tags.split(/[,\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
        try {
          if (m.kind === 'new') {
            const url = m.url.trim();
            if (!/^https?:\/\//i.test(url)) { this.toast('URL must start with http(s)://', 'error'); return true; }
            const res = await this.store.saveBookmark({
              url,
              title: m.title.trim() || url,
              folder: m.folder.trim(),
              tags
            });
            this.selectBySoul(res.soul);
            this.toast('Saved bookmark', 'success');
          } else if (current) {
            await this.store.updateBookmark(current.soul, {
              title: m.title.trim() || current.url,
              folder: m.folder.trim(),
              tags
            });
            this.toast('Updated bookmark', 'success');
          }
          this.modal = null;
        } catch (e) {
          this.toast(e.message || 'Save failed', 'error');
        }
        return true;
      }
      const key = m.kind === 'new'
        ? (m.focus === 0 ? 'url' : m.focus === 1 ? 'title' : m.focus === 2 ? 'folder' : 'tags')
        : (m.focus === 0 ? 'title' : m.focus === 1 ? 'folder' : 'tags');
      if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
      if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'delete' && current) {
      if (ev.name === 'y' || ev.name === 'enter') {
        this.modal = null;
        try {
          await this.store.trashBookmark(current.soul);
          this.selectedSoul = null;
          this.toast('Moved bookmark to Trash', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      if (ev.name === 'n') { this.modal = null; return true; }
      return true;
    }

    return true;
  }

  async handleKey(ev) {
    const folders = this._folderEntries();
    const list = this._getList();
    const current = this._current(list);

    if (this.modal) return this._handleModalKey(ev, current);

    if (this.searchMode) {
      if (ev.name === 'escape') { this.query = ''; this.searchMode = false; this.itemIdx = 0; this.selectedSoul = null; return true; }
      if (ev.name === 'enter') { this.searchMode = false; return true; }
      if (ev.name === 'backspace') { this.query = this.query.slice(0, -1); this.itemIdx = 0; this.selectedSoul = null; return true; }
      if (ev.name === 'paste') { this.query += ev.paste.replace(/\r?\n/g, ' '); this.itemIdx = 0; this.selectedSoul = null; return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.query += ev.ch; this.itemIdx = 0; this.selectedSoul = null; return true; }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) { this.searchMode = true; return true; }
    if (ev.name === 'escape' && this.query) { this.query = ''; this.itemIdx = 0; this.selectedSoul = null; return true; }

    if (ev.name === 'tab' || ev.name === 'h' || ev.name === 'l' || ev.name === 'left' || ev.name === 'right') {
      this.pane = this.pane === 'folders' ? 'list' : 'folders';
      return true;
    }

    if (ev.name === 'n' && !ev.ctrl) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'new',
        url: 'https://',
        title: '',
        folder: this.selectedFolder || '',
        tags: '',
        focus: 0
      };
      return true;
    }

    if (this.pane === 'folders') {
      if (ev.name === 'j' || ev.name === 'down') {
        if (folders.length) {
          this.folderIdx = Math.min(folders.length - 1, this.folderIdx + 1);
          this.selectedFolder = folders[this.folderIdx].folder;
          this.itemIdx = 0;
          this.selectedSoul = null;
        }
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        this.folderIdx = Math.max(0, this.folderIdx - 1);
        this.selectedFolder = folders[this.folderIdx]?.folder ?? null;
        this.itemIdx = 0;
        this.selectedSoul = null;
        return true;
      }
      if (ev.name === 'enter') {
        this.pane = 'list';
        return true;
      }
      return false;
    }

    if (ev.name === 'j' || ev.name === 'down') {
      if (list.length) {
        this.itemIdx = Math.min(list.length - 1, this.itemIdx + 1);
        this.selectedSoul = list[this.itemIdx].soul;
      }
      return true;
    }
    if (ev.name === 'k' || ev.name === 'up') {
      if (list.length) {
        this.itemIdx = Math.max(0, this.itemIdx - 1);
        this.selectedSoul = list[this.itemIdx].soul;
      }
      return true;
    }

    if (!current) return false;

    if (ev.name === 'o' || ev.name === 'enter') {
      const res = openUrl(current.url);
      this.toast(res.ok ? `Opened ${current.title || current.url}` : res.error, res.ok ? 'success' : 'error');
      return true;
    }
    if (ev.name === 'y') {
      copyToClipboard(current.url, { stdout: process.stdout });
      this.toast(`Copied URL: ${current.url}`, 'success');
      return true;
    }
    if (ev.name === 'i') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'edit',
        title: current.title || '',
        folder: current.folder || '',
        tags: (current.tags || []).join(', '),
        focus: 0
      };
      return true;
    }
    if (ev.name === 'd') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'delete' };
      return true;
    }

    return false;
  }

  getHints() {
    if (this.searchMode) return 'Type to filter bookmarks  ·  Enter: apply  ·  Esc: clear';
    return 'j/k:select  h/l:folders  o/Enter:open URL  y:copy URL  n:new  i:edit  d:trash  /:search';
  }

  render(screen, theme, area) {
    const folders = this._folderEntries();
    const list = this._getList();
    const current = this._current(list);

    const wide = area.w >= 64;
    const fW = wide ? Math.max(20, Math.min(28, Math.floor(area.w * 0.28))) : area.w;

    if (wide || this.pane === 'folders') {
      screen.box(area.x, area.y, fW, area.h, {
        title: 'Folders',
        borderColor: this.pane === 'folders' ? theme.borderFocus : theme.border,
        bg: theme.listBg
      });
      const ih = area.h - 2;
      for (let i = 0; i < ih && i < folders.length; i++) {
        const f = folders[i];
        const sel = i === this.folderIdx;
        const bg = sel ? theme.selectedBg : theme.listBg;
        screen.fill(area.x + 1, area.y + 1 + i, fW - 2, 1, ' ', { fg: theme.fg, bg });
        const cnt = String(f.count);
        screen.text(area.x + 2, area.y + 1 + i, (sel ? '▸ ' : '  ') + truncate(f.label, fW - 6 - cnt.length), {
          fg: sel ? theme.accent : theme.fg,
          bg,
          bold: sel
        });
        screen.text(area.x + fW - 2 - cnt.length, area.y + 1 + i, cnt, { fg: theme.fgMuted, bg });
      }
    }

    if (wide || this.pane === 'list') {
      const lx = wide ? area.x + fW : area.x;
      const lw = wide ? area.w - fW : area.w;
      screen.box(lx, area.y, lw, area.h, {
        title: `Bookmarks (${list.length})`,
        rightTitle: this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[/]'),
        borderColor: this.pane === 'list' ? theme.borderFocus : theme.border,
        bg: theme.panelBg
      });

      const iw = lw - 2;
      const ih = area.h - 2;
      const maxVis = Math.max(1, Math.floor(ih / 2));
      if (this.itemIdx < this.listScroll) this.listScroll = this.itemIdx;
      if (this.itemIdx >= this.listScroll + maxVis) this.listScroll = this.itemIdx - maxVis + 1;

      if (!list.length) {
        screen.text(lx + 2, area.y + 2, 'No bookmarks. Press n to add one.', { fg: theme.fgMuted, bg: theme.panelBg });
      } else {
        for (let i = 0; i < maxVis && this.listScroll + i < list.length; i++) {
          const b = list[this.listScroll + i];
          const sel = this.listScroll + i === this.itemIdx;
          const bg = sel ? theme.selectedBg : theme.panelBg;
          const ry = area.y + 1 + i * 2;
          screen.fill(lx + 1, ry, iw, 2, ' ', { fg: theme.fg, bg });
          const age = formatRelativeTime(b.addedAt);
          screen.text(lx + 2, ry, (sel ? '▸ ' : '  ') + truncate(b.title || b.url, Math.max(10, iw - age.length - 5)), {
            fg: theme.fg,
            bg,
            bold: sel
          });
          if (age) screen.text(lx + lw - 2 - age.length, ry, age, { fg: theme.fgMuted, bg });
          const tags = (b.tags || []).map((t) => '#' + t).join(' ');
          const sub = [b.url, b.folder ? `[${b.folder}]` : '', tags].filter(Boolean).join(' · ');
          screen.text(lx + 4, ry + 1, truncate(sub, iw - 4), { fg: theme.cyan, bg });
        }
      }
    }

    if (this.modal) this._renderModal(screen, theme, current);
  }

  _renderModal(screen, theme) {
    const m = this.modal;
    if (m.kind === 'new' || m.kind === 'edit') {
      const box = drawModal(screen, theme, {
        title: m.kind === 'new' ? 'New Bookmark' : 'Edit Bookmark',
        width: 60,
        height: m.kind === 'new' ? 15 : 13,
        footer: 'Tab: field  ·  Enter: save  ·  Esc: cancel'
      });
      let yOff = 0;
      if (m.kind === 'new') {
        screen.text(box.x, box.y + yOff, 'URL', { fg: m.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
        drawTextInput(screen, box.x, box.y + yOff + 1, box.w, m.url, m.url.length, { focused: m.focus === 0, theme });
        yOff += 3;
      }
      const titleIdx = m.kind === 'new' ? 1 : 0;
      const folderIdx = m.kind === 'new' ? 2 : 1;
      const tagsIdx = m.kind === 'new' ? 3 : 2;
      screen.text(box.x, box.y + yOff, 'Title', { fg: m.focus === titleIdx ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + yOff + 1, box.w, m.title, m.title.length, { focused: m.focus === titleIdx, theme });
      yOff += 3;
      screen.text(box.x, box.y + yOff, 'Folder (e.g. Work/Docs)', { fg: m.focus === folderIdx ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + yOff + 1, box.w, m.folder, m.folder.length, { focused: m.focus === folderIdx, theme });
      yOff += 3;
      screen.text(box.x, box.y + yOff, 'Tags (comma separated)', { fg: m.focus === tagsIdx ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + yOff + 1, box.w, m.tags, m.tags.length, { focused: m.focus === tagsIdx, theme });
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Move Bookmark to Trash?',
        width: 48,
        height: 8,
        footer: 'y/Enter: trash  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Move selected bookmark to Trash?', { fg: theme.fg, bg: theme.panelBg });
    }
  }
}
