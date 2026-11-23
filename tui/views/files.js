import { copyToClipboard } from '../engine/clipboard.js';
import { truncate, wrapText } from '../engine/screen.js';
import { drawModal, drawTextInput, formatRelativeTime } from '../engine/widgets.js';

const GROUP_KINDS = ['folder', 'album', 'playlist'];

function fmtSize(n) {
  if (!(n >= 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(1) : v} ${u[i]}`;
}

export class FilesView {
  constructor({ store, toast, onRedraw }) {
    this.store = store;
    this.toast = toast;
    this.onRedraw = onRedraw;

    this.pane = 'files'; // 'groups' | 'files'
    this.groupKindIdx = 0;
    this.groupIdx = 0;
    this.selectedGroup = null;
    this.fileIdx = 0;
    this.selectedId = null;
    this.scroll = 0;
    this.query = '';
    this.searchMode = false;
    this.uploadProgress = null; // null | { name, ratio }
    this.modal = null;
  }

  _groupKind() {
    return GROUP_KINDS[this.groupKindIdx];
  }

  _groupEntries() {
    const kind = this._groupKind();
    const raw = this.store.getFileGroups(kind);
    return [
      { name: null, label: `All (${kind}s)`, count: this.store.files.length },
      ...raw.map((g) => ({ name: g.name, label: g.name || 'Ungrouped', count: g.count }))
    ];
  }

  _getList() {
    return this.store.getFiles({
      groupKind: this._groupKind(),
      groupName: this.selectedGroup,
      query: this.query
    });
  }

  _current(list) {
    if (!list.length) {
      this.fileIdx = 0;
      this.selectedId = null;
      return null;
    }
    if (this.selectedId) {
      const i = list.findIndex((f) => f.id === this.selectedId);
      if (i >= 0) { this.fileIdx = i; return list[i]; }
    }
    this.fileIdx = Math.max(0, Math.min(list.length - 1, this.fileIdx));
    this.selectedId = list[this.fileIdx].id;
    return list[this.fileIdx];
  }

  async _openPreview(file) {
    try {
      const res = await this.store.previewTextFile(file.id);
      if (res.isBinary) {
        this.modal = {
          kind: 'preview',
          title: file.name || file.id,
          lines: [
            `Binary file (${fmtSize(res.size)})`,
            `Encrypted: ${file.encrypted ? 'yes' : 'no'}${file.chunked ? ' (chunked)' : ''}`,
            file.type ? `MIME: ${file.type}` : '',
            '',
            'Press D in file list to download to disk.'
          ].filter((x) => x !== undefined),
          scroll: 0
        };
      } else {
        this.modal = {
          kind: 'preview',
          title: `${file.name || file.id}${res.truncated ? ' (first 32 KB)' : ''}`,
          lines: res.text.replace(/\r\n/g, '\n').split('\n'),
          scroll: 0
        };
      }
    } catch (e) {
      this.toast(e.message || 'Could not preview file', 'error');
    }
  }

  async _handleModalKey(ev, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') { this.modal = null; return true; }

    if (m.kind === 'preview') {
      if (ev.name === 'j' || ev.name === 'down') { m.scroll++; return true; }
      if (ev.name === 'k' || ev.name === 'up') { m.scroll = Math.max(0, m.scroll - 1); return true; }
      if (ev.name === 'enter' || ev.name === 'q') { this.modal = null; return true; }
      return true;
    }

    if (m.kind === 'upload') {
      const fields = 4; // path, folder, album, playlist
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? fields - 1 : 1)) % fields;
        return true;
      }
      if (ev.name === 'enter') {
        const fp = m.path.trim();
        if (!fp) { this.toast('File path required', 'error'); return true; }
        this.modal = null;
        this.uploadProgress = { name: fp, ratio: 0 };
        this.onRedraw?.();
        try {
          const meta = await this.store.uploadLocalFile(fp, {
            folder: m.folder.trim(),
            album: m.album.trim(),
            playlist: m.playlist.trim(),
            onProgress: (ratio) => {
              this.uploadProgress = { name: fp, ratio };
              this.onRedraw?.();
            }
          });
          this.uploadProgress = null;
          this.selectedId = meta.id;
          this.toast(`Uploaded ${meta.name} (${fmtSize(meta.size)})`, 'success');
        } catch (e) {
          this.uploadProgress = null;
          this.toast(e.message || 'Upload failed', 'error');
        }
        return true;
      }
      const key = ['path', 'folder', 'album', 'playlist'][m.focus];
      if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
      if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'download' && current) {
      if (ev.name === 'enter') {
        const out = m.path.trim();
        if (!out) return true;
        this.modal = null;
        try {
          const res = await this.store.downloadToLocalFile(current.id, out);
          this.toast(`Saved ${fmtSize(res.bytes)} to ${res.path}`, 'success');
        } catch (e) { this.toast(e.message || 'Download failed', 'error'); }
        return true;
      }
      if (ev.name === 'backspace') { m.path = m.path.slice(0, -1); return true; }
      if (ev.name === 'paste') { m.path += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m.path += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'move' && current) {
      const fields = 3;
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? fields - 1 : 1)) % fields;
        return true;
      }
      if (ev.name === 'enter') {
        this.modal = null;
        try {
          await this.store.moveFile(current.id, {
            folder: m.folder.trim(),
            album: m.album.trim(),
            playlist: m.playlist.trim()
          });
          this.toast('File updated', 'success');
        } catch (e) { this.toast(e.message || 'Move failed', 'error'); }
        return true;
      }
      const key = ['folder', 'album', 'playlist'][m.focus];
      if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
      if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'delete' && current) {
      if (ev.name === 'y' || ev.name === 'enter') {
        this.modal = null;
        try {
          await this.store.deleteFile(current.id);
          this.selectedId = null;
          this.toast('Deleted file', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      if (ev.name === 'n') { this.modal = null; return true; }
      return true;
    }

    return true;
  }

  async handleKey(ev) {
    const groups = this._groupEntries();
    const list = this._getList();
    const current = this._current(list);

    if (this.modal) return this._handleModalKey(ev, current);

    if (this.searchMode) {
      if (ev.name === 'escape') { this.query = ''; this.searchMode = false; this.fileIdx = 0; this.selectedId = null; return true; }
      if (ev.name === 'enter') { this.searchMode = false; return true; }
      if (ev.name === 'backspace') { this.query = this.query.slice(0, -1); this.fileIdx = 0; this.selectedId = null; return true; }
      if (ev.name === 'paste') { this.query += ev.paste.replace(/\r?\n/g, ' '); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.query += ev.ch; this.fileIdx = 0; this.selectedId = null; return true; }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) { this.searchMode = true; return true; }
    if (ev.name === 'escape' && this.query) { this.query = ''; this.fileIdx = 0; this.selectedId = null; return true; }

    if (ev.name === 'g') {
      this.groupKindIdx = (this.groupKindIdx + 1) % GROUP_KINDS.length;
      this.groupIdx = 0;
      this.selectedGroup = null;
      this.fileIdx = 0;
      this.selectedId = null;
      return true;
    }

    if (ev.name === 'tab' || ev.name === 'h' || ev.name === 'l' || ev.name === 'left' || ev.name === 'right') {
      this.pane = this.pane === 'groups' ? 'files' : 'groups';
      return true;
    }

    if (ev.name === 'u' || (ev.name === 'n' && !ev.ctrl)) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'upload',
        path: '',
        folder: this._groupKind() === 'folder' && this.selectedGroup ? this.selectedGroup : '',
        album: this._groupKind() === 'album' && this.selectedGroup ? this.selectedGroup : '',
        playlist: this._groupKind() === 'playlist' && this.selectedGroup ? this.selectedGroup : '',
        focus: 0
      };
      return true;
    }

    if (this.pane === 'groups') {
      if (ev.name === 'j' || ev.name === 'down') {
        if (groups.length) {
          this.groupIdx = Math.min(groups.length - 1, this.groupIdx + 1);
          this.selectedGroup = groups[this.groupIdx].name;
          this.fileIdx = 0;
          this.selectedId = null;
        }
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        this.groupIdx = Math.max(0, this.groupIdx - 1);
        this.selectedGroup = groups[this.groupIdx]?.name ?? null;
        this.fileIdx = 0;
        this.selectedId = null;
        return true;
      }
      if (ev.name === 'enter') { this.pane = 'files'; return true; }
      return false;
    }

    if (ev.name === 'j' || ev.name === 'down') {
      if (list.length) { this.fileIdx = Math.min(list.length - 1, this.fileIdx + 1); this.selectedId = list[this.fileIdx].id; }
      return true;
    }
    if (ev.name === 'k' || ev.name === 'up') {
      if (list.length) { this.fileIdx = Math.max(0, this.fileIdx - 1); this.selectedId = list[this.fileIdx].id; }
      return true;
    }

    if (!current) return false;

    if (ev.name === 'v' || ev.name === 'enter') {
      await this._openPreview(current);
      return true;
    }
    if (ev.shift && ev.name === 'D') {
      this.modal = { kind: 'download', path: `~/${current.name || current.id}` };
      return true;
    }
    if (ev.name === 'm' || ev.name === 'i') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'move',
        folder: current.folder || '',
        album: current.album || '',
        playlist: current.playlist || '',
        focus: 0
      };
      return true;
    }
    if (ev.name === 'y') {
      try {
        const res = await this.store.shareFile(current.id);
        copyToClipboard(res.url, { stdout: process.stdout });
        this.toast(`Copied share link: ${res.url}`, 'success');
      } catch (e) { this.toast(e.message || 'Share failed', 'error'); }
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
    if (this.searchMode) return 'Type to filter files  ·  Enter: apply  ·  Esc: clear';
    return 'u:upload  D:download  Enter:preview  m:move  y:share link  g:folder/album/playlist  d:delete  /:search';
  }

  render(screen, theme, area) {
    const groups = this._groupEntries();
    const list = this._getList();
    const current = this._current(list);

    const wide = area.w >= 64;
    const gW = wide ? Math.max(20, Math.min(28, Math.floor(area.w * 0.28))) : area.w;

    if (wide || this.pane === 'groups') {
      screen.box(area.x, area.y, gW, area.h, {
        title: `Groups (${this._groupKind()})`,
        rightTitle: '[g]',
        borderColor: this.pane === 'groups' ? theme.borderFocus : theme.border,
        bg: theme.listBg
      });
      const ih = area.h - 2;
      for (let i = 0; i < ih && i < groups.length; i++) {
        const g = groups[i];
        const sel = i === this.groupIdx;
        const bg = sel ? theme.selectedBg : theme.listBg;
        screen.fill(area.x + 1, area.y + 1 + i, gW - 2, 1, ' ', { fg: theme.fg, bg });
        const cnt = String(g.count);
        screen.text(area.x + 2, area.y + 1 + i, (sel ? '▸ ' : '  ') + truncate(g.label, gW - 6 - cnt.length), {
          fg: sel ? theme.accent : theme.fg,
          bg,
          bold: sel
        });
        screen.text(area.x + gW - 2 - cnt.length, area.y + 1 + i, cnt, { fg: theme.fgMuted, bg });
      }
    }

    if (wide || this.pane === 'files') {
      const fx = wide ? area.x + gW : area.x;
      const fw = wide ? area.w - gW : area.w;
      const progressTitle = this.uploadProgress
        ? `Uploading ${Math.round(this.uploadProgress.ratio * 100)}%`
        : (this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[/]'));
      screen.box(fx, area.y, fw, area.h, {
        title: `Files (${list.length})`,
        rightTitle: progressTitle,
        borderColor: this.pane === 'files' ? theme.borderFocus : theme.border,
        bg: theme.panelBg
      });

      const iw = fw - 2;
      const ih = area.h - 2;
      const maxVis = Math.max(1, Math.floor(ih / 2));
      if (this.fileIdx < this.scroll) this.scroll = this.fileIdx;
      if (this.fileIdx >= this.scroll + maxVis) this.scroll = this.fileIdx - maxVis + 1;

      if (!list.length) {
        screen.text(fx + 2, area.y + 2, 'No files. Press u to upload a file.', { fg: theme.fgMuted, bg: theme.panelBg });
      } else {
        for (let i = 0; i < maxVis && this.scroll + i < list.length; i++) {
          const f = list[this.scroll + i];
          const sel = this.scroll + i === this.fileIdx;
          const bg = sel ? theme.selectedBg : theme.panelBg;
          const ry = area.y + 1 + i * 2;
          screen.fill(fx + 1, ry, iw, 2, ' ', { fg: theme.fg, bg });
          const sz = fmtSize(f.size);
          screen.text(fx + 2, ry, (sel ? '▸ ' : '  ') + truncate(f.name || f.id, Math.max(10, iw - sz.length - 5)), {
            fg: theme.fg,
            bg,
            bold: sel
          });
          screen.text(fx + fw - 2 - sz.length, ry, sz, { fg: theme.amber, bg });
          const meta = [
            f.chunked ? 'chunked' : (f.encrypted ? 'enc' : 'plain'),
            f.folder ? `dir:${f.folder}` : '',
            f.album ? `album:${f.album}` : '',
            f.playlist ? `list:${f.playlist}` : '',
            formatRelativeTime(f.addedAt)
          ].filter(Boolean).join(' · ');
          screen.text(fx + 4, ry + 1, truncate(meta, iw - 4), { fg: theme.fgMuted, bg });
        }
      }
    }

    if (this.modal) this._renderModal(screen, theme, current);
  }

  _renderModal(screen, theme) {
    const m = this.modal;
    if (m.kind === 'preview') {
      const box = drawModal(screen, theme, {
        title: m.title,
        width: Math.min(76, screen.cols - 4),
        height: Math.min(22, screen.rows - 4),
        footer: 'j/k: scroll  ·  Enter/Esc: close'
      });
      const wrapped = m.lines.flatMap((l) => wrapText(l, box.w));
      const maxS = Math.max(0, wrapped.length - box.h);
      m.scroll = Math.max(0, Math.min(maxS, m.scroll));
      for (let i = 0; i < box.h && m.scroll + i < wrapped.length; i++) {
        screen.text(box.x, box.y + i, wrapped[m.scroll + i], { fg: theme.fg, bg: theme.panelBg });
      }
    } else if (m.kind === 'upload') {
      const box = drawModal(screen, theme, {
        title: 'Upload Encrypted File',
        width: 60,
        height: 15,
        footer: 'Tab: field  ·  Enter: upload  ·  Esc: cancel'
      });
      const fields = [
        ['Local File Path', 'path', '~/file.txt'],
        ['Folder (optional)', 'folder', 'Docs/2026'],
        ['Album (optional)', 'album', ''],
        ['Playlist (optional)', 'playlist', '']
      ];
      fields.forEach(([lbl, key, ph], i) => {
        screen.text(box.x, box.y + i * 3, lbl, { fg: m.focus === i ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
        drawTextInput(screen, box.x, box.y + i * 3 + 1, box.w, m[key], m[key].length, { focused: m.focus === i, placeholder: ph, theme });
      });
    } else if (m.kind === 'download') {
      const box = drawModal(screen, theme, {
        title: 'Download Decrypted File',
        width: 58,
        height: 9,
        footer: 'Enter: save  ·  Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Destination Path', { fg: theme.accentSoft, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, m.path, m.path.length, { focused: true, theme });
    } else if (m.kind === 'move') {
      const box = drawModal(screen, theme, {
        title: 'Organize File',
        width: 58,
        height: 13,
        footer: 'Tab: field  ·  Enter: save (empty clears)  ·  Esc: cancel'
      });
      [['Folder', 'folder'], ['Album', 'album'], ['Playlist', 'playlist']].forEach(([lbl, key], i) => {
        screen.text(box.x, box.y + i * 3, lbl, { fg: m.focus === i ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
        drawTextInput(screen, box.x, box.y + i * 3 + 1, box.w, m[key], m[key].length, { focused: m.focus === i, theme });
      });
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Delete File Permanently?',
        width: 48,
        height: 8,
        footer: 'y/Enter: delete  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Delete selected file permanently?', { fg: theme.danger, bg: theme.panelBg, bold: true });
    }
  }
}
