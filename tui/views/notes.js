import { copyToClipboard } from '../engine/clipboard.js';
import { openInEditor, parseNoteDoc, serializeNoteDoc } from '../engine/editor.js';
import { truncate } from '../engine/screen.js';
import {
  drawModal,
  drawStyledLine,
  drawTextInput,
  extractTags,
  formatRelativeTime,
  parseChecklists,
  renderMarkdownLines
} from '../engine/widgets.js';

const FILTERS = ['all', 'pinned', 'todo', 'today', 'untagged'];

export class NotesView {
  constructor({ store, config, suspend, resume, toast }) {
    this.store = store;
    this.config = config;
    this.suspend = suspend;
    this.resume = resume;
    this.toast = toast;

    this.pane = 'list'; // 'list' | 'preview'
    this.filter = 'all';
    this.activeTag = null;
    this.query = '';
    this.searchMode = false;

    this.selectedIdx = 0;
    this.selectedSoul = null;
    this.listScroll = 0;
    this.previewScroll = 0;

    this.modal = null; // null | { kind: 'new'|'edit'|'checklist'|'links'|'delete', ... }
  }

  getFilteredNotes() {
    return this.store.getActiveNotes({
      filter: this.filter,
      tag: this.activeTag,
      query: this.query
    });
  }

  selectBySoul(soul) {
    this.filter = 'all';
    this.activeTag = null;
    this.query = '';
    this.selectedSoul = soul;
    const list = this.getFilteredNotes();
    const idx = list.findIndex((n) => n.soul === soul);
    if (idx >= 0) {
      this.selectedIdx = idx;
      this.previewScroll = 0;
    }
  }

  setTagFilter(tag) {
    this.activeTag = tag;
    this.selectedIdx = 0;
    this.listScroll = 0;
    this.previewScroll = 0;
  }

  _currentNote(list) {
    if (!list.length) {
      this.selectedSoul = null;
      this.selectedIdx = 0;
      return null;
    }
    if (this.selectedSoul) {
      const idx = list.findIndex((n) => n.soul === this.selectedSoul);
      if (idx >= 0) {
        this.selectedIdx = idx;
        return list[idx];
      }
    }
    this.selectedIdx = Math.max(0, Math.min(list.length - 1, this.selectedIdx));
    this.selectedSoul = list[this.selectedIdx].soul;
    return list[this.selectedIdx];
  }

  async _openExternalEditor(note) {
    if (this.store.isReadOnly()) {
      this.toast('Read-only space (viewer)', 'error');
      return;
    }
    const initial = serializeNoteDoc(note);
    try {
      const res = openInEditor(initial, {
        ext: '.md',
        editorCmd: this.config?.editor,
        suspend: this.suspend,
        resume: this.resume
      });
      if (!res.changed) {
        this.toast('No changes');
        return;
      }
      const parsed = parseNoteDoc(res.text, note);
      await this.store.saveNote({
        ...note,
        ...parsed,
        soul: note.soul
      });
      this.toast(`Saved "${parsed.title}"`, 'success');
    } catch (e) {
      this.toast(e.message || 'Editor failed', 'error');
    }
  }

  async _handleModalKey(ev, list, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') {
      this.modal = null;
      return true;
    }

    if (m.kind === 'new') {
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = m.focus === 0 ? 1 : 0;
        return true;
      }
      if (ev.name === 'enter' || (ev.ctrl && ev.name === 's')) {
        const title = m.title.trim() || 'Untitled';
        const tags = m.tags.trim()
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((t) => (t.startsWith('#') ? t : `#${t}`))
          .join(' ');
        const body = tags ? `${tags}\n\n` : '';
        try {
          const saved = await this.store.saveNote({ title, body, cat: 'general' });
          this.selectBySoul(saved.soul);
          this.modal = null;
          if (ev.name === 'enter' && !ev.ctrl) {
            const created = this.store.notes.get(saved.soul);
            if (created) await this._openExternalEditor(created);
          } else {
            this.toast(`Created "${title}"`, 'success');
          }
        } catch (e) {
          this.toast(e.message || 'Create failed', 'error');
        }
        return true;
      }
      const field = m.focus === 0 ? 'title' : 'tags';
      if (ev.name === 'backspace') { m[field] = m[field].slice(0, -1); return true; }
      if (ev.name === 'paste') { m[field] += ev.paste.replace(/\r?\n/g, ' '); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m[field] += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'edit' && current) {
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? 2 : 1)) % 3;
        return true;
      }
      if (m.focus === 2 && ev.name === 'space') {
        m.pinned = !m.pinned;
        return true;
      }
      if (ev.name === 'enter' || (ev.ctrl && ev.name === 's')) {
        try {
          await this.store.saveNote({
            ...current,
            soul: current.soul,
            title: m.title.trim() || current.title || 'Untitled',
            cat: m.cat.trim() || 'general',
            pinned: m.pinned
          });
          this.modal = null;
          this.toast('Updated note', 'success');
        } catch (e) {
          this.toast(e.message || 'Update failed', 'error');
        }
        return true;
      }
      if (m.focus < 2) {
        const field = m.focus === 0 ? 'title' : 'cat';
        if (ev.name === 'backspace') { m[field] = m[field].slice(0, -1); return true; }
        if (ev.name === 'paste') { m[field] += ev.paste.replace(/\r?\n/g, ' '); return true; }
        if (ev.ch && !ev.ctrl && !ev.alt) { m[field] += ev.ch; return true; }
      }
      return true;
    }

    if (m.kind === 'checklist' && current) {
      if (ev.name === 'j' || ev.name === 'down') {
        m.idx = Math.min(m.items.length - 1, m.idx + 1);
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        m.idx = Math.max(0, m.idx - 1);
        return true;
      }
      if (ev.name === 'enter' || ev.name === 'space' || ev.name === 'x') {
        const target = m.items[m.idx];
        if (target) {
          try {
            await this.store.toggleNoteChecklist(current.soul, target.lineIndex);
            const updated = this.store.notes.get(current.soul);
            m.items = parseChecklists(updated?.body || '');
            this.toast('Toggled checklist item', 'success');
          } catch (e) {
            this.toast(e.message, 'error');
          }
        }
        return true;
      }
      return true;
    }

    if (m.kind === 'links') {
      if (ev.name === 'j' || ev.name === 'down') {
        m.idx = Math.min(Math.max(0, m.items.length - 1), m.idx + 1);
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        m.idx = Math.max(0, m.idx - 1);
        return true;
      }
      if (ev.name === 'enter' && m.items[m.idx]) {
        const entry = m.items[m.idx];
        this.modal = null;
        try {
          if (entry.soul) {
            this.selectBySoul(entry.soul);
          } else {
            const res = await this.store.openOrCreateWikiTarget(entry.target, current?.soul);
            this.selectBySoul(res.soul);
            if (res.created) this.toast(`Created [[${entry.target}]]`, 'success');
          }
        } catch (e) {
          this.toast(e.message, 'error');
        }
        return true;
      }
      return true;
    }

    if (m.kind === 'delete' && current) {
      if (ev.name === 'y' || ev.name === 'enter') {
        this.modal = null;
        try {
          await this.store.trashNote(current.soul);
          this.selectedSoul = null;
          this.toast('Moved note to Trash', 'success');
        } catch (e) {
          this.toast(e.message, 'error');
        }
        return true;
      }
      if (ev.name === 'n') {
        this.modal = null;
        return true;
      }
      return true;
    }

    return true;
  }

  async handleKey(ev) {
    const list = this.getFilteredNotes();
    const current = this._currentNote(list);

    if (this.modal) {
      return this._handleModalKey(ev, list, current);
    }

    if (this.searchMode) {
      if (ev.name === 'escape') {
        this.query = '';
        this.searchMode = false;
        this.selectedIdx = 0;
        this.selectedSoul = null;
        return true;
      }
      if (ev.name === 'enter') {
        this.searchMode = false;
        return true;
      }
      if (ev.name === 'backspace') {
        this.query = this.query.slice(0, -1);
        this.selectedIdx = 0;
        this.selectedSoul = null;
        return true;
      }
      if (ev.name === 'paste') {
        this.query += ev.paste.replace(/\r?\n/g, ' ');
        this.selectedIdx = 0;
        this.selectedSoul = null;
        return true;
      }
      if (ev.ch && !ev.ctrl && !ev.alt) {
        this.query += ev.ch;
        this.selectedIdx = 0;
        this.selectedSoul = null;
        return true;
      }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) {
      this.searchMode = true;
      return true;
    }
    if (ev.name === 'escape' && (this.query || this.activeTag)) {
      this.query = '';
      this.activeTag = null;
      this.selectedIdx = 0;
      this.selectedSoul = null;
      return true;
    }

    if (ev.name === 'tab' || ev.name === 'h' || ev.name === 'l' || ev.name === 'left' || ev.name === 'right') {
      this.pane = this.pane === 'list' ? 'preview' : 'list';
      return true;
    }

    if (ev.name === 'f') {
      const idx = FILTERS.indexOf(this.filter);
      this.filter = FILTERS[(idx + 1) % FILTERS.length];
      this.activeTag = null;
      this.selectedIdx = 0;
      this.selectedSoul = null;
      this.listScroll = 0;
      this.previewScroll = 0;
      return true;
    }

    if (ev.name === 't') {
      const tags = this.store.getTagCounts();
      if (!tags.length) { this.toast('No #tags in notes'); return true; }
      if (!this.activeTag) this.activeTag = tags[0].tag;
      else {
        const i = tags.findIndex((x) => x.tag === this.activeTag);
        this.activeTag = i >= 0 && i + 1 < tags.length ? tags[i + 1].tag : null;
      }
      this.selectedIdx = 0;
      this.selectedSoul = null;
      return true;
    }

    if (ev.name === 'n' && !ev.ctrl) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'new', title: '', tags: this.activeTag ? `#${this.activeTag}` : '', focus: 0 };
      return true;
    }

    if (this.pane === 'list') {
      if (ev.name === 'j' || ev.name === 'down') {
        if (list.length) {
          this.selectedIdx = Math.min(list.length - 1, this.selectedIdx + 1);
          this.selectedSoul = list[this.selectedIdx].soul;
          this.previewScroll = 0;
        }
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        if (list.length) {
          this.selectedIdx = Math.max(0, this.selectedIdx - 1);
          this.selectedSoul = list[this.selectedIdx].soul;
          this.previewScroll = 0;
        }
        return true;
      }
      if (ev.name === 'enter' && current) {
        this.pane = 'preview';
        return true;
      }
      if (ev.shift && ev.name === 'J') { this.previewScroll += 4; return true; }
      if (ev.shift && ev.name === 'K') { this.previewScroll = Math.max(0, this.previewScroll - 4); return true; }
    } else {
      if (ev.name === 'j' || ev.name === 'down') { this.previewScroll += 1; return true; }
      if (ev.name === 'k' || ev.name === 'up') { this.previewScroll = Math.max(0, this.previewScroll - 1); return true; }
      if (ev.name === 'pagedown') { this.previewScroll += 12; return true; }
      if (ev.name === 'pageup') { this.previewScroll = Math.max(0, this.previewScroll - 12); return true; }
    }

    if (!current) return false;

    if (ev.name === 'e') {
      await this._openExternalEditor(current);
      return true;
    }
    if (ev.name === 'i') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'edit',
        title: current.title || '',
        cat: current.cat || 'general',
        pinned: !!current.pinned,
        focus: 0
      };
      return true;
    }
    if (ev.name === 'p') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      try {
        await this.store.toggleNotePin(current.soul);
        this.toast(current.pinned ? 'Unpinned' : 'Pinned', 'success');
      } catch (e) { this.toast(e.message, 'error'); }
      return true;
    }
    if (ev.name === 'x') {
      const items = parseChecklists(current.body || '');
      if (!items.length) {
        this.toast('No checkboxes (- [ ]) in this note');
        return true;
      }
      if (items.length === 1) {
        try {
          await this.store.toggleNoteChecklist(current.soul, items[0].lineIndex);
          this.toast('Toggled checkbox', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
      } else {
        this.modal = { kind: 'checklist', items, idx: 0 };
      }
      return true;
    }
    if (ev.name === 'l' && ev.shift) {
      // Shift+L or just 'g'
    }
    if (ev.name === 'w') {
      const { outgoing, backlinks } = this.store.getWikiLinksFor(current.soul);
      const items = [
        ...outgoing.map((o) => ({ dir: '→', target: o.target, label: o.label, soul: o.hit?.soul || null })),
        ...backlinks.map((b) => ({ dir: '←', target: b.title, label: b.title, soul: b.soul }))
      ];
      if (!items.length) {
        this.toast('No [[wiki-links]] or backlinks');
        return true;
      }
      this.modal = { kind: 'links', items, idx: 0 };
      return true;
    }
    if (ev.name === 'd') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'delete' };
      return true;
    }
    if (ev.name === 'y') {
      try {
        const res = await this.store.client.shareNote(current.soul);
        copyToClipboard(res.url, { stdout: process.stdout });
        this.toast(`Share link copied: ${res.url}`, 'success');
      } catch (e) {
        this.toast(e.message || 'Share failed', 'error');
      }
      return true;
    }
    return false;
  }

  getHints() {
    if (this.searchMode) return 'Type to filter  ·  Enter: apply  ·  Esc: clear';
    if (this.pane === 'preview') {
      return 'j/k:scroll  h/Tab:list  e:$EDITOR  i:quick-edit  x:checkbox  w:wiki-links  p:pin  y:share  d:trash';
    }
    return 'n:new  e:$EDITOR  i:quick-edit  f:filter  t:tag  /:search  w:wiki-links  p:pin  d:trash';
  }

  render(screen, theme, area) {
    const list = this.getFilteredNotes();
    const current = this._currentNote(list);

    const wide = area.w >= 62;
    const listW = wide ? Math.max(24, Math.min(36, Math.floor(area.w * 0.34))) : area.w;
    const showList = wide || this.pane === 'list';
    const showPreview = wide || this.pane === 'preview';

    if (showList) {
      const filterLabel = this.activeTag ? `#${this.activeTag}` : this.filter;
      screen.box(area.x, area.y, listW, area.h, {
        title: `Notes (${list.length}) · ${filterLabel}`,
        rightTitle: this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[/]'),
        borderColor: this.pane === 'list' ? theme.borderFocus : theme.border,
        bg: theme.listBg,
        titleColor: theme.fg
      });

      const innerW = listW - 2;
      const innerH = area.h - 2;
      const itemH = 2;
      const maxVisible = Math.max(1, Math.floor(innerH / itemH));
      if (this.selectedIdx < this.listScroll) this.listScroll = this.selectedIdx;
      if (this.selectedIdx >= this.listScroll + maxVisible) this.listScroll = this.selectedIdx - maxVisible + 1;

      if (!list.length) {
        screen.text(area.x + 2, area.y + 2, 'No notes match. Press n to create.', { fg: theme.fgMuted, bg: theme.listBg });
      } else {
        for (let i = 0; i < maxVisible && this.listScroll + i < list.length; i++) {
          const n = list[this.listScroll + i];
          const isSel = this.listScroll + i === this.selectedIdx;
          const bg = isSel ? theme.selectedBg : theme.listBg;
          const ry = area.y + 1 + i * itemH;
          screen.fill(area.x + 1, ry, innerW, itemH, ' ', { fg: theme.fg, bg });

          const pin = n.pinned ? '★ ' : '  ';
          screen.text(area.x + 1, ry, pin, { fg: n.pinned ? theme.amber : theme.fgMuted, bg });
          screen.text(area.x + 3, ry, truncate(n.title || 'Untitled', innerW - 3), {
            fg: isSel ? theme.fg : theme.fg,
            bg,
            bold: isSel
          });

          const tags = extractTags(n.body).slice(0, 3).map((t) => '#' + t).join(' ');
          const age = formatRelativeTime(n.timestamp || n.updatedAt);
          const meta = tags ? `${tags} · ${age}` : `${n.cat || 'general'} · ${age}`;
          screen.text(area.x + 3, ry + 1, truncate(meta, innerW - 3), {
            fg: isSel ? theme.accentSoft : theme.fgMuted,
            bg
          });
        }
      }
    }

    if (showPreview) {
      const px = wide ? area.x + listW : area.x;
      const pw = wide ? area.w - listW : area.w;
      screen.box(px, area.y, pw, area.h, {
        title: current ? (current.title || 'Untitled') : 'Preview',
        rightTitle: current ? `${current.pinned ? '★ ' : ''}${current.cat || 'general'}` : '',
        borderColor: this.pane === 'preview' ? theme.borderFocus : theme.border,
        bg: theme.panelBg,
        titleColor: theme.accent
      });

      const iw = pw - 4;
      const ih = area.h - 2;
      if (!current) {
        screen.text(px + 2, area.y + 2, 'Select a note or press n to create one.', { fg: theme.fgMuted, bg: theme.panelBg });
      } else {
        const mdLines = renderMarkdownLines(current.body || '', iw, theme);
        const { outgoing, backlinks } = this.store.getWikiLinksFor(current.soul);
        if (outgoing.length || backlinks.length) {
          mdLines.push([{ text: '', style: { fg: theme.fg, bg: theme.panelBg } }]);
          mdLines.push([{ text: '── Links & Backlinks (w) ──', style: { fg: theme.fgMuted, bg: theme.panelBg, bold: true } }]);
          for (const o of outgoing) {
            mdLines.push([{
              text: `→ [[${o.target}]]${o.hit ? '' : ' (create)'}`,
              style: { fg: o.hit ? theme.cyan : theme.amber, bg: theme.panelBg }
            }]);
          }
          for (const b of backlinks) {
            mdLines.push([{ text: `← [[${b.title}]]`, style: { fg: theme.green, bg: theme.panelBg } }]);
          }
        }

        const maxScroll = Math.max(0, mdLines.length - ih);
        this.previewScroll = Math.max(0, Math.min(maxScroll, this.previewScroll));
        for (let r = 0; r < ih && this.previewScroll + r < mdLines.length; r++) {
          drawStyledLine(screen, px + 2, area.y + 1 + r, iw, mdLines[this.previewScroll + r], theme.panelBg);
        }
      }
    }

    if (this.modal) {
      this._renderModal(screen, theme, current);
    }
  }

  _renderModal(screen, theme, current) {
    const m = this.modal;
    if (m.kind === 'new') {
      const box = drawModal(screen, theme, {
        title: 'New Note',
        width: 56,
        height: 11,
        footer: 'Enter: create & $EDITOR  ·  Ctrl+S: create  ·  Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Title', { fg: m.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, m.title, m.title.length, { focused: m.focus === 0, placeholder: 'Note title', theme });
      screen.text(box.x, box.y + 4, 'Tags (optional, e.g. #work #ideas)', { fg: m.focus === 1 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 5, box.w, m.tags, m.tags.length, { focused: m.focus === 1, placeholder: '#general', theme });
    } else if (m.kind === 'edit' && current) {
      const box = drawModal(screen, theme, {
        title: 'Quick Edit Note',
        width: 56,
        height: 13,
        footer: 'Enter: save  ·  Space: toggle pin  ·  Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Title', { fg: m.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, m.title, m.title.length, { focused: m.focus === 0, theme });
      screen.text(box.x, box.y + 4, 'Category', { fg: m.focus === 1 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 5, box.w, m.cat, m.cat.length, { focused: m.focus === 1, theme });
      screen.text(box.x, box.y + 7, `[${m.pinned ? 'x' : ' '}] Pinned`, {
        fg: m.focus === 2 ? theme.accent : theme.fg,
        bg: theme.panelBg,
        bold: m.focus === 2
      });
    } else if (m.kind === 'checklist') {
      const box = drawModal(screen, theme, {
        title: 'Toggle Checklist Items',
        width: 60,
        height: Math.min(18, m.items.length + 6),
        footer: 'j/k: select  ·  Space/Enter: toggle  ·  Esc: close'
      });
      for (let i = 0; i < Math.min(box.h, m.items.length); i++) {
        const it = m.items[i];
        const sel = i === m.idx;
        const bg = sel ? theme.selectedBg : theme.panelBg;
        screen.fill(box.x, box.y + i, box.w, 1, ' ', { fg: theme.fg, bg });
        screen.text(box.x, box.y + i, `${it.done ? '[x]' : '[ ]'} ${truncate(it.text, box.w - 4)}`, {
          fg: it.done ? theme.green : theme.fg,
          bg,
          bold: sel
        });
      }
    } else if (m.kind === 'links') {
      const box = drawModal(screen, theme, {
        title: 'Wiki-Links & Backlinks',
        width: 58,
        height: Math.min(18, m.items.length + 6),
        footer: 'j/k: select  ·  Enter: open (or create)  ·  Esc: close'
      });
      for (let i = 0; i < Math.min(box.h, m.items.length); i++) {
        const it = m.items[i];
        const sel = i === m.idx;
        const bg = sel ? theme.selectedBg : theme.panelBg;
        screen.fill(box.x, box.y + i, box.w, 1, ' ', { fg: theme.fg, bg });
        const suffix = it.soul ? '' : ' [create new]';
        screen.text(box.x, box.y + i, truncate(`${it.dir} [[${it.target}]]${suffix}`, box.w), {
          fg: it.soul ? theme.cyan : theme.amber,
          bg,
          bold: sel
        });
      }
    } else if (m.kind === 'delete' && current) {
      const box = drawModal(screen, theme, {
        title: 'Move Note to Trash?',
        width: 50,
        height: 8,
        footer: 'y/Enter: trash  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, truncate(`Move "${current.title || 'Untitled'}" to Trash?`, box.w), { fg: theme.fg, bg: theme.panelBg });
      screen.text(box.x, box.y + 3, 'You can restore it anytime from Trash.', { fg: theme.fgMuted, bg: theme.panelBg });
    }
  }
}
