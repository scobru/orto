import { openInEditor } from '../engine/editor.js';
import { truncate } from '../engine/screen.js';
import { drawModal, drawTextInput, formatShortDate } from '../engine/widgets.js';

const COLUMNS = [
  { id: 'todo', label: 'TODO' },
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'blocked', label: 'BLOCKED' },
  { id: 'done', label: 'DONE' }
];

const PRIO_BADGE = {
  urgent: '[!]',
  high: '[▲]',
  medium: '[●]',
  low: '[·]'
};

const PRIORITY_LIST = ['low', 'medium', 'high', 'urgent'];

export class TasksView {
  constructor({ store, config, suspend, resume, toast }) {
    this.store = store;
    this.config = config;
    this.suspend = suspend;
    this.resume = resume;
    this.toast = toast;

    this.colIdx = 0;
    this.rowIdx = 0;
    this.listIdx = 0;
    this.viewMode = 'auto'; // 'auto' | 'kanban' | 'list'
    this.query = '';
    this.searchMode = false;
    this.modal = null;
    this._lastHits = null;
  }

  async handleMouse(ev) {
    if (this.modal || !this._lastHits || ev.button !== 0 || ev.release) return false;
    for (const h of this._lastHits.cards) {
      if (ev.x >= h.x0 && ev.x <= h.x1 && ev.y >= h.y0 && ev.y <= h.y1) {
        if (h.colIdx !== undefined) this.colIdx = h.colIdx;
        if (h.rowIdx !== undefined) this.rowIdx = h.rowIdx;
        if (h.listIdx !== undefined) this.listIdx = h.listIdx;
        return true;
      }
    }
    for (const c of this._lastHits.cols) {
      if (ev.x >= c.x0 && ev.x <= c.x1 && ev.y >= c.y0 && ev.y <= c.y1) {
        this.colIdx = c.colIdx;
        this.rowIdx = 0;
        return true;
      }
    }
    return false;
  }

  selectBySoul(soul) {
    const cols = this.store.getKanbanColumns(this.query);
    for (let c = 0; c < COLUMNS.length; c++) {
      const r = cols[COLUMNS[c].id].findIndex((t) => t.soul === soul);
      if (r >= 0) {
        this.colIdx = c;
        this.rowIdx = r;
        return;
      }
    }
  }

  _currentTask(areaW = 100) {
    const useKanban = this.viewMode === 'kanban' || (this.viewMode === 'auto' && areaW >= 72);
    if (useKanban) {
      const cols = this.store.getKanbanColumns(this.query);
      const list = cols[COLUMNS[this.colIdx].id] || [];
      this.rowIdx = list.length ? Math.max(0, Math.min(list.length - 1, this.rowIdx)) : 0;
      return { task: list[this.rowIdx] || null, cols, useKanban };
    }
    const all = this.store.getTasks({ query: this.query });
    this.listIdx = all.length ? Math.max(0, Math.min(all.length - 1, this.listIdx)) : 0;
    return { task: all[this.listIdx] || null, all, useKanban };
  }

  async _editDescriptionInEditor(task) {
    if (this.store.isReadOnly()) {
      this.toast('Read-only space (viewer)', 'error');
      return;
    }
    const initial = `# ${task.title}\n\n${task.desc || ''}`;
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
      const lines = res.text.split('\n');
      let title = task.title;
      let bodyStart = 0;
      if (lines[0]?.startsWith('# ')) {
        title = lines[0].slice(2).trim() || task.title;
        bodyStart = lines[1] === '' ? 2 : 1;
      }
      const desc = lines.slice(bodyStart).join('\n').trimEnd();
      await this.store.updateTask(task.soul, { title, desc });
      this.toast('Task updated', 'success');
    } catch (e) {
      this.toast(e.message || 'Editor failed', 'error');
    }
  }

  async _handleModalKey(ev, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') {
      this.modal = null;
      return true;
    }

    if (m.kind === 'new' || m.kind === 'edit') {
      const fields = m.kind === 'new' ? 4 : 5;
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? fields - 1 : 1)) % fields;
        return true;
      }
      if (m.focus === 1 && (ev.name === 'left' || ev.name === 'right' || ev.name === 'space')) {
        const i = PRIORITY_LIST.indexOf(m.priority);
        m.priority = PRIORITY_LIST[(i + (ev.name === 'left' ? 3 : 1)) % PRIORITY_LIST.length];
        return true;
      }
      if (m.kind === 'edit' && m.focus === 4 && (ev.name === 'left' || ev.name === 'right' || ev.name === 'space')) {
        const i = COLUMNS.findIndex((c) => c.id === m.column);
        m.column = COLUMNS[(i + (ev.name === 'left' ? 3 : 1)) % COLUMNS.length].id;
        return true;
      }
      if (ev.name === 'enter') {
        const title = m.title.trim();
        if (!title) {
          this.toast('Title is required', 'error');
          return true;
        }
        const tags = m.tags.split(/[,\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
        try {
          if (m.kind === 'new') {
            const res = await this.store.saveTask({
              title,
              priority: m.priority,
              dueDate: m.due.trim() || null,
              tags,
              status: m.column,
              column: m.column
            });
            this.selectBySoul(res.soul);
            this.toast(`Added "${title}"`, 'success');
          } else if (current) {
            await this.store.updateTask(current.soul, {
              title,
              priority: m.priority,
              dueDate: m.due.trim() || null,
              tags,
              status: m.column,
              column: m.column,
              completedAt: m.column === 'done' ? (current.completedAt || Date.now()) : null
            });
            this.selectBySoul(current.soul);
            this.toast('Task updated', 'success');
          }
          this.modal = null;
        } catch (e) {
          this.toast(e.message || 'Invalid task input', 'error');
        }
        return true;
      }
      const key = m.focus === 0 ? 'title' : m.focus === 2 ? 'due' : m.focus === 3 ? 'tags' : null;
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
          await this.store.trashTask(current.soul);
          this.toast('Moved task to Trash', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      if (ev.name === 'n') { this.modal = null; return true; }
      return true;
    }

    return true;
  }

  async handleKey(ev, area = { w: 100 }) {
    const { task: current, cols, all, useKanban } = this._currentTask(area.w);

    if (this.modal) {
      return this._handleModalKey(ev, current);
    }

    if (this.searchMode) {
      if (ev.name === 'escape') { this.query = ''; this.searchMode = false; return true; }
      if (ev.name === 'enter') { this.searchMode = false; return true; }
      if (ev.name === 'backspace') { this.query = this.query.slice(0, -1); return true; }
      if (ev.name === 'paste') { this.query += ev.paste.replace(/\r?\n/g, ' '); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.query += ev.ch; return true; }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) { this.searchMode = true; return true; }
    if (ev.name === 'escape' && this.query) { this.query = ''; return true; }

    if (ev.name === 'v') {
      this.viewMode = useKanban ? 'list' : 'kanban';
      return true;
    }

    if (ev.name === 'n' && !ev.ctrl) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'new',
        title: '',
        priority: 'medium',
        due: '',
        tags: '',
        column: COLUMNS[this.colIdx].id,
        focus: 0
      };
      return true;
    }

    if (useKanban) {
      if ((ev.shift && ev.name === 'H') || (ev.shift && ev.name === 'left')) {
        if (!current) return true;
        if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
        const nextColIdx = Math.max(0, this.colIdx - 1);
        if (nextColIdx !== this.colIdx) {
          try {
            await this.store.moveTaskColumn(current.soul, COLUMNS[nextColIdx].id);
            this.colIdx = nextColIdx;
            this.selectBySoul(current.soul);
            this.toast(`Moved to ${COLUMNS[nextColIdx].label}`, 'success');
          } catch (e) { this.toast(e.message, 'error'); }
        }
        return true;
      }
      if ((ev.shift && ev.name === 'L') || (ev.shift && ev.name === 'right')) {
        if (!current) return true;
        if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
        const nextColIdx = Math.min(COLUMNS.length - 1, this.colIdx + 1);
        if (nextColIdx !== this.colIdx) {
          try {
            await this.store.moveTaskColumn(current.soul, COLUMNS[nextColIdx].id);
            this.colIdx = nextColIdx;
            this.selectBySoul(current.soul);
            this.toast(`Moved to ${COLUMNS[nextColIdx].label}`, 'success');
          } catch (e) { this.toast(e.message, 'error'); }
        }
        return true;
      }
      if (ev.name === 'h' || ev.name === 'left') {
        this.colIdx = Math.max(0, this.colIdx - 1);
        const list = cols[COLUMNS[this.colIdx].id];
        this.rowIdx = list.length ? Math.min(this.rowIdx, list.length - 1) : 0;
        return true;
      }
      if (ev.name === 'l' || ev.name === 'right' || ev.name === 'tab') {
        this.colIdx = (this.colIdx + 1) % COLUMNS.length;
        const list = cols[COLUMNS[this.colIdx].id];
        this.rowIdx = list.length ? Math.min(this.rowIdx, list.length - 1) : 0;
        return true;
      }
      if (ev.name === 'j' || ev.name === 'down') {
        const list = cols[COLUMNS[this.colIdx].id];
        if (list.length) this.rowIdx = Math.min(list.length - 1, this.rowIdx + 1);
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        this.rowIdx = Math.max(0, this.rowIdx - 1);
        return true;
      }
    } else {
      if (ev.name === 'j' || ev.name === 'down') {
        if (all.length) this.listIdx = Math.min(all.length - 1, this.listIdx + 1);
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        this.listIdx = Math.max(0, this.listIdx - 1);
        return true;
      }
    }

    if (!current) return false;

    if (ev.name === 'space') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      const isDone = (current.column || current.status) === 'done';
      const next = isDone ? 'todo' : 'done';
      try {
        await this.store.moveTaskColumn(current.soul, next);
        this.selectBySoul(current.soul);
        this.toast(next === 'done' ? 'Task completed' : 'Reopened task', 'success');
      } catch (e) { this.toast(e.message, 'error'); }
      return true;
    }

    if (ev.name === 'p') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      try {
        await this.store.cycleTaskPriority(current.soul);
        this.toast('Priority updated', 'success');
      } catch (e) { this.toast(e.message, 'error'); }
      return true;
    }

    if (ev.name === 'i' || ev.name === 'enter') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'edit',
        title: current.title || '',
        priority: current.priority || 'medium',
        due: current.dueDate ? new Date(current.dueDate).toISOString().slice(0, 10) : '',
        tags: (current.tags || []).join(', '),
        column: current.column || current.status || 'todo',
        focus: 0
      };
      return true;
    }

    if (ev.name === 'e') {
      await this._editDescriptionInEditor(current);
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
    if (this.searchMode) return 'Type to filter tasks  ·  Enter: apply  ·  Esc: clear';
    return 'h/l:col  j/k:task  H/L:move col  Space:done  n:new  i:edit  e:$EDITOR  p:prio  v:list/kanban  d:trash';
  }

  _prioColor(prio, theme) {
    const p = (prio || 'medium').toLowerCase();
    if (p === 'urgent') return theme.danger;
    if (p === 'high') return theme.accent;
    if (p === 'medium') return theme.amber;
    return theme.fgMuted;
  }

  render(screen, theme, area) {
    const { cols, all, useKanban } = this._currentTask(area.w);
    const now = Date.now();
    const hitCols = [];
    const hitCards = [];

    if (useKanban) {
      const colW = Math.floor(area.w / 4);
      COLUMNS.forEach((col, cIdx) => {
        const x = area.x + cIdx * colW;
        const w = cIdx === 3 ? area.w - colW * 3 : colW;
        const items = cols[col.id];
        const focused = cIdx === this.colIdx;
        hitCols.push({ x0: x, x1: x + w - 1, y0: area.y, y1: area.y + area.h - 1, colIdx: cIdx });

        screen.box(x, area.y, w, area.h, {
          title: `${col.label} (${items.length})`,
          rightTitle: cIdx === 0 && (this.searchMode || this.query) ? `/${this.query}` : '',
          borderColor: focused ? theme.borderFocus : theme.border,
          bg: theme.listBg,
          titleColor: col.id === 'done' ? theme.green : col.id === 'blocked' ? theme.danger : theme.fg
        });

        const iw = w - 2;
        const ih = area.h - 2;
        const cardH = 2;
        const maxCards = Math.max(1, Math.floor(ih / cardH));
        const scroll = focused && this.rowIdx >= maxCards ? this.rowIdx - maxCards + 1 : 0;

        for (let i = 0; i < maxCards && scroll + i < items.length; i++) {
          const t = items[scroll + i];
          const isSel = focused && scroll + i === this.rowIdx;
          const bg = isSel ? theme.selectedBg : theme.listBg;
          const ry = area.y + 1 + i * cardH;
          screen.fill(x + 1, ry, iw, cardH, ' ', { fg: theme.fg, bg });
          hitCards.push({ x0: x + 1, x1: x + iw, y0: ry, y1: ry + cardH - 1, colIdx: cIdx, rowIdx: scroll + i });

          const badge = PRIO_BADGE[(t.priority || 'medium').toLowerCase()] || '[●]';
          const badgeColor = this._prioColor(t.priority, theme);
          screen.text(x + 1, ry, (isSel ? '▸ ' : '  ') + badge + ' ', { fg: badgeColor, bg, bold: isSel });
          screen.text(x + 7, ry, truncate(t.title, iw - 6), {
            fg: col.id === 'done' ? theme.fgMuted : theme.fg,
            bg,
            bold: isSel
          });

          const overdue = t.dueDate && t.dueDate < now && col.id !== 'done';
          const dueTxt = t.dueDate ? `${overdue ? '!' : ''}${formatShortDate(t.dueDate)}` : '';
          const tagTxt = (t.tags || []).slice(0, 2).map((x) => '#' + x).join(' ');
          const meta = [dueTxt, tagTxt].filter(Boolean).join(' ');
          if (meta) {
            screen.text(x + 3, ry + 1, truncate(meta, iw - 2), {
              fg: overdue ? theme.danger : theme.fgMuted,
              bg
            });
          }
        }
      });
    } else {
      screen.box(area.x, area.y, area.w, area.h, {
        title: `Tasks (${all.length})`,
        rightTitle: this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[v] Kanban'),
        borderColor: theme.borderFocus,
        bg: theme.listBg
      });
      const iw = area.w - 2;
      const ih = area.h - 2;
      const scroll = this.listIdx >= ih ? this.listIdx - ih + 1 : 0;
      for (let i = 0; i < ih && scroll + i < all.length; i++) {
        const t = all[scroll + i];
        const isSel = scroll + i === this.listIdx;
        const bg = isSel ? theme.selectedBg : theme.listBg;
        const ry = area.y + 1 + i;
        screen.fill(area.x + 1, ry, iw, 1, ' ', { fg: theme.fg, bg });
        hitCards.push({ x0: area.x + 1, x1: area.x + iw, y0: ry, y1: ry, listIdx: scroll + i });
        const col = t.column || t.status || 'todo';
        const badge = PRIO_BADGE[(t.priority || 'medium').toLowerCase()] || '[●]';
        screen.text(area.x + 1, ry, `${isSel ? '▸' : ' '} ${badge} [${col}] ${truncate(t.title, iw - 22)}`, {
          fg: col === 'done' ? theme.fgMuted : theme.fg,
          bg,
          bold: isSel
        });
      }
    }

    this._lastHits = { cols: hitCols, cards: hitCards };
    if (this.modal) {
      this._renderModal(screen, theme);
    }
  }

  _renderModal(screen, theme) {
    const m = this.modal;
    if (m.kind === 'new' || m.kind === 'edit') {
      const box = drawModal(screen, theme, {
        title: m.kind === 'new' ? 'New Task' : 'Edit Task',
        width: 58,
        height: m.kind === 'new' ? 15 : 17,
        footer: 'Tab: field  ·  ←/→: cycle option  ·  Enter: save  ·  Esc: cancel'
      });
      screen.text(box.x, box.y, 'Title', { fg: m.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 1, box.w, m.title, m.title.length, { focused: m.focus === 0, placeholder: 'Task title', theme });

      screen.text(box.x, box.y + 3, `Priority (←/→): ${m.priority.toUpperCase()}`, {
        fg: m.focus === 1 ? theme.accent : theme.fg,
        bg: theme.panelBg,
        bold: m.focus === 1
      });

      screen.text(box.x, box.y + 5, 'Due Date (YYYY-MM-DD)', { fg: m.focus === 2 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 6, box.w, m.due, m.due.length, { focused: m.focus === 2, placeholder: '2026-12-01', theme });

      screen.text(box.x, box.y + 8, 'Tags (comma separated)', { fg: m.focus === 3 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 9, box.w, m.tags, m.tags.length, { focused: m.focus === 3, placeholder: 'tui, urgent', theme });

      if (m.kind === 'edit') {
        screen.text(box.x, box.y + 11, `Column (←/→): ${m.column}`, {
          fg: m.focus === 4 ? theme.accent : theme.fg,
          bg: theme.panelBg,
          bold: m.focus === 4
        });
      }
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Move Task to Trash?',
        width: 48,
        height: 8,
        footer: 'y/Enter: trash  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Move selected task to Trash?', { fg: theme.fg, bg: theme.panelBg });
    }
  }
}
