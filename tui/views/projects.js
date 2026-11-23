import { openInEditor } from '../engine/editor.js';
import { openUrl } from '../engine/open.js';
import { truncate } from '../engine/screen.js';
import { drawModal, drawTextInput, formatShortDate } from '../engine/widgets.js';

const STATUS_FILTERS = ['all', 'active', 'on_hold', 'completed', 'archived'];
const STATUS_EDIT = ['active', 'on_hold', 'completed', 'archived'];
const TABS = [
  { key: 'notes', label: 'Notes' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'events', label: 'Events' },
  { key: 'bookmarks', label: 'Bookmarks' }
];

const STATUS_ICON = {
  active: '●',
  on_hold: '◐',
  completed: '✓',
  archived: '◌'
};

export class ProjectsView {
  constructor({ store, config, suspend, resume, toast, onNavigate }) {
    this.store = store;
    this.config = config;
    this.suspend = suspend;
    this.resume = resume;
    this.toast = toast;
    this.onNavigate = onNavigate;

    this.pane = 'list'; // 'list' | 'workspace'
    this.statusFilter = 'all';
    this.query = '';
    this.searchMode = false;

    this.selectedIdx = 0;
    this.selectedSoul = null;
    this.listScroll = 0;

    this.tabIdx = 0;
    this.itemIdx = 0;
    this.modal = null;
  }

  selectBySoul(soul) {
    this.statusFilter = 'all';
    this.query = '';
    this.selectedSoul = soul;
    const list = this._getList();
    const idx = list.findIndex((p) => p.soul === soul);
    if (idx >= 0) this.selectedIdx = idx;
    this.itemIdx = 0;
  }

  _getList() {
    return this.store.getProjects({
      status: this.statusFilter === 'all' ? null : this.statusFilter,
      query: this.query
    });
  }

  _currentProject(list) {
    if (!list.length) {
      this.selectedIdx = 0;
      this.selectedSoul = null;
      return null;
    }
    if (this.selectedSoul) {
      const idx = list.findIndex((p) => p.soul === this.selectedSoul);
      if (idx >= 0) {
        this.selectedIdx = idx;
        return list[idx];
      }
    }
    this.selectedIdx = Math.max(0, Math.min(list.length - 1, this.selectedIdx));
    this.selectedSoul = list[this.selectedIdx].soul;
    return list[this.selectedIdx];
  }

  async _editDescInEditor(project) {
    if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return; }
    const initial = `# ${project.name}\n\n${project.desc || ''}`;
    try {
      const res = openInEditor(initial, {
        ext: '.md',
        editorCmd: this.config?.editor,
        suspend: this.suspend,
        resume: this.resume
      });
      if (!res.changed) { this.toast('No changes'); return; }
      const lines = res.text.split('\n');
      let name = project.name;
      let start = 0;
      if (lines[0]?.startsWith('# ')) {
        name = lines[0].slice(2).trim() || project.name;
        start = lines[1] === '' ? 2 : 1;
      }
      const desc = lines.slice(start).join('\n').trimEnd();
      await this.store.updateProject(project.soul, { name, desc });
      this.toast(`Updated "${name}"`, 'success');
    } catch (e) {
      this.toast(e.message || 'Editor failed', 'error');
    }
  }

  async _handleModalKey(ev, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') { this.modal = null; return true; }

    if (m.kind === 'new' || m.kind === 'edit') {
      const fields = 5;
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? fields - 1 : 1)) % fields;
        return true;
      }
      if (m.focus === 1 && (ev.name === 'left' || ev.name === 'right' || ev.name === 'space')) {
        const i = STATUS_EDIT.indexOf(m.status);
        m.status = STATUS_EDIT[(i + (ev.name === 'left' ? STATUS_EDIT.length - 1 : 1)) % STATUS_EDIT.length];
        return true;
      }
      if (ev.name === 'enter') {
        const name = m.name.trim();
        if (!name) { this.toast('Name is required', 'error'); return true; }
        const tags = m.tags.split(/[,\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
        try {
          if (m.kind === 'new') {
            const res = await this.store.saveProject({
              name,
              status: m.status,
              dueDate: m.due.trim() || null,
              tags,
              desc: m.desc.trim()
            });
            this.selectBySoul(res.soul);
            this.toast(`Created "${name}"`, 'success');
          } else if (current) {
            await this.store.updateProject(current.soul, {
              name,
              status: m.status,
              dueDate: m.due.trim() || null,
              tags,
              desc: m.desc.trim()
            });
            this.toast('Project updated', 'success');
          }
          this.modal = null;
        } catch (e) {
          this.toast(e.message || 'Invalid project input', 'error');
        }
        return true;
      }
      const key = m.focus === 0 ? 'name' : m.focus === 2 ? 'due' : m.focus === 3 ? 'tags' : m.focus === 4 ? 'desc' : null;
      if (key) {
        if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
        if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ' '); return true; }
        if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      }
      return true;
    }

    if (m.kind === 'delete' && current) {
      if (ev.name === 'y' || ev.name === 'enter') {
        this.modal = null;
        try {
          await this.store.trashProject(current.soul);
          this.selectedSoul = null;
          this.toast('Moved project to Trash', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      if (ev.name === 'n') { this.modal = null; return true; }
      return true;
    }

    return true;
  }

  async handleKey(ev) {
    const list = this._getList();
    const current = this._currentProject(list);

    if (this.modal) return this._handleModalKey(ev, current);

    if (this.searchMode) {
      if (ev.name === 'escape') { this.query = ''; this.searchMode = false; this.selectedIdx = 0; this.selectedSoul = null; return true; }
      if (ev.name === 'enter') { this.searchMode = false; return true; }
      if (ev.name === 'backspace') { this.query = this.query.slice(0, -1); this.selectedIdx = 0; this.selectedSoul = null; return true; }
      if (ev.name === 'paste') { this.query += ev.paste.replace(/\r?\n/g, ' '); this.selectedIdx = 0; this.selectedSoul = null; return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.query += ev.ch; this.selectedIdx = 0; this.selectedSoul = null; return true; }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) { this.searchMode = true; return true; }
    if (ev.name === 'escape' && this.query) { this.query = ''; this.selectedIdx = 0; this.selectedSoul = null; return true; }

    if (ev.name === 'f') {
      const i = STATUS_FILTERS.indexOf(this.statusFilter);
      this.statusFilter = STATUS_FILTERS[(i + 1) % STATUS_FILTERS.length];
      this.selectedIdx = 0;
      this.selectedSoul = null;
      return true;
    }

    if (ev.name === 'n' && !ev.ctrl) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'new', name: '', status: 'active', due: '', tags: '', desc: '', focus: 0 };
      return true;
    }

    if (ev.name === 'tab' || ev.name === 'h' || ev.name === 'l' || ev.name === 'left' || ev.name === 'right') {
      if (this.pane === 'workspace' && (ev.name === 'l' || ev.name === 'right') && ev.shift) {
        this.tabIdx = (this.tabIdx + 1) % TABS.length;
        this.itemIdx = 0;
        return true;
      }
      this.pane = this.pane === 'list' ? 'workspace' : 'list';
      return true;
    }

    if (ev.name === 'm') {
      this.tabIdx = (this.tabIdx + 1) % TABS.length;
      this.itemIdx = 0;
      return true;
    }

    if (this.pane === 'list') {
      if (ev.name === 'j' || ev.name === 'down') {
        if (list.length) {
          this.selectedIdx = Math.min(list.length - 1, this.selectedIdx + 1);
          this.selectedSoul = list[this.selectedIdx].soul;
          this.itemIdx = 0;
        }
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        if (list.length) {
          this.selectedIdx = Math.max(0, this.selectedIdx - 1);
          this.selectedSoul = list[this.selectedIdx].soul;
          this.itemIdx = 0;
        }
        return true;
      }
      if (ev.name === 'enter' && current) {
        this.pane = 'workspace';
        return true;
      }
    } else if (current) {
      const ws = this.store.getProjectWorkspace(current.soul);
      const tabKey = TABS[this.tabIdx].key;
      const tabItems = ws[tabKey] || [];
      if (ev.name === 'j' || ev.name === 'down') {
        if (tabItems.length) this.itemIdx = Math.min(tabItems.length - 1, this.itemIdx + 1);
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        this.itemIdx = Math.max(0, this.itemIdx - 1);
        return true;
      }
      if (ev.name === 'enter' && tabItems[this.itemIdx]) {
        const it = tabItems[this.itemIdx];
        if (tabKey === 'notes') this.onNavigate?.('notes', it.soul);
        else if (tabKey === 'tasks') this.onNavigate?.('tasks', it.soul);
        else if (tabKey === 'events') this.onNavigate?.('calendar', it.soul);
        else if (tabKey === 'bookmarks') {
          const r = openUrl(it.url);
          this.toast(r.ok ? `Opened ${it.title || it.url}` : r.error, r.ok ? 'success' : 'error');
        }
        return true;
      }
    }

    if (!current) return false;

    if (ev.name === 'i') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'edit',
        name: current.name || '',
        status: current.status || 'active',
        due: current.dueDate ? new Date(current.dueDate).toISOString().slice(0, 10) : '',
        tags: (current.tags || []).join(', '),
        desc: current.desc || '',
        focus: 0
      };
      return true;
    }

    if (ev.name === 'e') {
      await this._editDescInEditor(current);
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
    if (this.searchMode) return 'Type to filter projects  ·  Enter: apply  ·  Esc: clear';
    return 'j/k:select  Tab:pane  m:switch tab  Enter:open item  n:new  i:edit  e:$EDITOR  f:status  d:trash';
  }

  _statusColor(status, theme) {
    if (status === 'active') return theme.green;
    if (status === 'on_hold') return theme.amber;
    if (status === 'completed') return theme.cyan;
    return theme.fgMuted;
  }

  render(screen, theme, area) {
    const list = this._getList();
    const current = this._currentProject(list);

    const wide = area.w >= 64;
    const listW = wide ? Math.max(26, Math.min(36, Math.floor(area.w * 0.35))) : area.w;
    const showList = wide || this.pane === 'list';
    const showWs = wide || this.pane === 'workspace';

    if (showList) {
      screen.box(area.x, area.y, listW, area.h, {
        title: `Projects (${list.length}) · ${this.statusFilter}`,
        rightTitle: this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[/]'),
        borderColor: this.pane === 'list' ? theme.borderFocus : theme.border,
        bg: theme.listBg
      });
      const iw = listW - 2;
      const ih = area.h - 2;
      const maxVis = Math.max(1, Math.floor(ih / 2));
      if (this.selectedIdx < this.listScroll) this.listScroll = this.selectedIdx;
      if (this.selectedIdx >= this.listScroll + maxVis) this.listScroll = this.selectedIdx - maxVis + 1;

      if (!list.length) {
        screen.text(area.x + 2, area.y + 2, 'No projects yet. Press n to create.', { fg: theme.fgMuted, bg: theme.listBg });
      } else {
        for (let i = 0; i < maxVis && this.listScroll + i < list.length; i++) {
          const p = list[this.listScroll + i];
          const sel = this.listScroll + i === this.selectedIdx;
          const bg = sel ? theme.selectedBg : theme.listBg;
          const ry = area.y + 1 + i * 2;
          screen.fill(area.x + 1, ry, iw, 2, ' ', { fg: theme.fg, bg });
          const icon = STATUS_ICON[(p.status || 'active').toLowerCase()] || '●';
          screen.text(area.x + 2, ry, icon + ' ', { fg: this._statusColor(p.status, theme), bg });
          screen.text(area.x + 4, ry, truncate(p.name, iw - 4), { fg: theme.fg, bg, bold: sel });

          const ws = this.store.getProjectWorkspace(p.soul);
          const meta = [
            p.dueDate ? `due ${formatShortDate(p.dueDate)}` : null,
            `${ws.notes.length}n · ${ws.tasks.length}t`
          ].filter(Boolean).join(' · ');
          screen.text(area.x + 4, ry + 1, truncate(meta, iw - 4), { fg: theme.fgMuted, bg });
        }
      }
    }

    if (showWs) {
      const wx = wide ? area.x + listW : area.x;
      const ww = wide ? area.w - listW : area.w;
      screen.box(wx, area.y, ww, area.h, {
        title: current ? current.name : 'Workspace',
        rightTitle: current ? (current.status || 'active') : '',
        borderColor: this.pane === 'workspace' ? theme.borderFocus : theme.border,
        bg: theme.panelBg,
        titleColor: theme.accent
      });

      const iw = ww - 4;
      if (!current) {
        screen.text(wx + 2, area.y + 2, 'Select a project or press n to create one.', { fg: theme.fgMuted, bg: theme.panelBg });
      } else {
        const ws = this.store.getProjectWorkspace(current.soul);
        let row = area.y + 1;
        const metaParts = [
          `Status: ${current.status || 'active'}`,
          current.dueDate ? `Due: ${formatShortDate(current.dueDate)}` : null,
          (current.tags || []).map((t) => '#' + t).join(' ')
        ].filter(Boolean);
        screen.text(wx + 2, row++, truncate(metaParts.join('  ·  '), iw), { fg: theme.fgDim, bg: theme.panelBg });
        if (current.desc) {
          screen.text(wx + 2, row++, truncate(current.desc, iw), { fg: theme.fg, bg: theme.panelBg });
        }
        row++;

        // Tab strip
        let tx = wx + 2;
        TABS.forEach((tab, idx) => {
          const cnt = (ws[tab.key] || []).length;
          const label = ` ${tab.label} (${cnt}) `;
          const active = idx === this.tabIdx;
          if (tx + label.length <= wx + ww - 2) {
            screen.text(tx, row, label, {
              fg: active ? theme.bg : theme.fgDim,
              bg: active ? theme.accent : theme.selectedBg,
              bold: active
            });
            tx += label.length + 1;
          }
        });
        row++;
        screen.hline(wx + 2, row++, iw, { fg: theme.border, bg: theme.panelBg });

        const tabKey = TABS[this.tabIdx].key;
        const items = ws[tabKey] || [];
        this.itemIdx = items.length ? Math.max(0, Math.min(items.length - 1, this.itemIdx)) : 0;
        const avail = area.y + area.h - 1 - row;
        if (!items.length) {
          screen.text(wx + 2, row + 1, `No linked ${TABS[this.tabIdx].label.toLowerCase()}.`, { fg: theme.fgMuted, bg: theme.panelBg });
        } else {
          const scroll = this.itemIdx >= avail ? this.itemIdx - avail + 1 : 0;
          for (let i = 0; i < avail && scroll + i < items.length; i++) {
            const it = items[scroll + i];
            const sel = this.pane === 'workspace' && scroll + i === this.itemIdx;
            const bg = sel ? theme.selectedBg : theme.panelBg;
            screen.fill(wx + 2, row + i, iw, 1, ' ', { fg: theme.fg, bg });
            const label = it.title || it.name || it.url || it.soul;
            const right = tabKey === 'tasks' ? `[${it.column || it.status || 'todo'}]`
              : tabKey === 'events' ? formatShortDate(it.start)
                : '';
            screen.text(wx + 2, row + i, (sel ? '▸ ' : '  ') + truncate(label, iw - right.length - 4), {
              fg: theme.fg,
              bg,
              bold: sel
            });
            if (right) {
              screen.text(wx + 2 + iw - right.length, row + i, right, { fg: theme.fgMuted, bg });
            }
          }
        }
      }
    }

    if (this.modal) this._renderModal(screen, theme);
  }

  _renderModal(screen, theme) {
    const m = this.modal;
    if (m.kind === 'new' || m.kind === 'edit') {
      const box = drawModal(screen, theme, {
        title: m.kind === 'new' ? 'New Project' : 'Edit Project',
        width: 60,
        height: 17,
        footer: 'Tab: field  ·  ←/→: status  ·  Enter: save  ·  Esc: cancel'
      });
      screen.text(box.x, box.y, 'Name', { fg: m.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 1, box.w, m.name, m.name.length, { focused: m.focus === 0, placeholder: 'Project name', theme });

      screen.text(box.x, box.y + 3, `Status (←/→): ${m.status}`, { fg: m.focus === 1 ? theme.accent : theme.fg, bg: theme.panelBg, bold: m.focus === 1 });

      screen.text(box.x, box.y + 5, 'Due Date (YYYY-MM-DD)', { fg: m.focus === 2 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 6, box.w, m.due, m.due.length, { focused: m.focus === 2, placeholder: '2026-12-31', theme });

      screen.text(box.x, box.y + 8, 'Tags (comma separated)', { fg: m.focus === 3 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 9, box.w, m.tags, m.tags.length, { focused: m.focus === 3, placeholder: 'work, q4', theme });

      screen.text(box.x, box.y + 11, 'Description', { fg: m.focus === 4 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 12, box.w, m.desc, m.desc.length, { focused: m.focus === 4, placeholder: 'Short summary', theme });
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Move Project to Trash?',
        width: 48,
        height: 8,
        footer: 'y/Enter: trash  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Move selected project to Trash?', { fg: theme.fg, bg: theme.panelBg });
    }
  }
}
