import { openInEditor } from '../engine/editor.js';
import { truncate } from '../engine/screen.js';
import { drawModal, drawTextInput, formatShortDate } from '../engine/widgets.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toHm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseLocalDateTime(dateStr, timeStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr || '').trim());
  if (!m) throw new Error('Date must be YYYY-MM-DD');
  const y = Number(m[1]), mo = Number(m[2]) - 1, day = Number(m[3]);
  if (!timeStr || !String(timeStr).trim()) {
    const start = new Date(y, mo, day, 0, 0, 0, 0).getTime();
    const end = new Date(y, mo, day, 23, 59, 59, 999).getTime();
    return { start, end, allDay: true };
  }
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr).trim());
  if (!tm) throw new Error('Time must be HH:MM');
  const start = new Date(y, mo, day, Number(tm[1]), Number(tm[2]), 0, 0).getTime();
  return { start, end: start + 3600000, allDay: false };
}

export class CalendarView {
  constructor({ store, config, suspend, resume, toast }) {
    this.store = store;
    this.config = config;
    this.suspend = suspend;
    this.resume = resume;
    this.toast = toast;

    const now = new Date();
    this.selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    this.pane = 'grid'; // 'grid' | 'agenda'
    this.agendaIdx = 0;
    this.query = '';
    this.searchMode = false;
    this.modal = null;
  }

  selectBySoul(soul) {
    const ev = this.store.calendar.get(soul);
    if (!ev || ev.trash) return;
    const d = new Date(ev.start);
    this.selectedDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayEvents = this._dayEvents();
    const idx = dayEvents.findIndex((x) => x.soul === soul);
    if (idx >= 0) {
      this.agendaIdx = idx;
      this.pane = 'agenda';
    }
  }

  _dayEvents() {
    const y = this.selectedDate.getFullYear();
    const m = this.selectedDate.getMonth();
    const d = this.selectedDate.getDate();
    const dStart = new Date(y, m, d, 0, 0, 0, 0).getTime();
    const dEnd = new Date(y, m, d, 23, 59, 59, 999).getTime();
    return this.store.getEvents({ from: dStart, to: dEnd, query: this.query });
  }

  _upcomingEvents() {
    const dStart = new Date(
      this.selectedDate.getFullYear(),
      this.selectedDate.getMonth(),
      this.selectedDate.getDate(),
      0, 0, 0, 0
    ).getTime();
    return this.store.getEvents({ from: dStart, to: dStart + 14 * 86400000, query: this.query });
  }

  _moveDays(delta) {
    const d = this.selectedDate;
    this.selectedDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
    this.agendaIdx = 0;
  }

  _moveMonths(delta) {
    const d = this.selectedDate;
    const targetMonth = d.getMonth() + delta;
    const maxDay = new Date(d.getFullYear(), targetMonth + 1, 0).getDate();
    this.selectedDate = new Date(d.getFullYear(), targetMonth, Math.min(d.getDate(), maxDay));
    this.agendaIdx = 0;
  }

  async _editNotesInEditor(evItem) {
    if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return; }
    const initial = `# ${evItem.title}\n\n${evItem.notes || ''}`;
    try {
      const res = openInEditor(initial, {
        ext: '.md',
        editorCmd: this.config?.editor,
        suspend: this.suspend,
        resume: this.resume
      });
      if (!res.changed) { this.toast('No changes'); return; }
      const lines = res.text.split('\n');
      let title = evItem.title;
      let start = 0;
      if (lines[0]?.startsWith('# ')) {
        title = lines[0].slice(2).trim() || evItem.title;
        start = lines[1] === '' ? 2 : 1;
      }
      const notes = lines.slice(start).join('\n').trimEnd();
      await this.store.saveEvent({ ...evItem, soul: evItem.soul, title, notes });
      this.toast('Event notes saved', 'success');
    } catch (e) {
      this.toast(e.message || 'Editor failed', 'error');
    }
  }

  async _handleModalKey(ev, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') { this.modal = null; return true; }

    if (m.kind === 'new' || m.kind === 'edit') {
      const fields = 5; // title, date, start, end, location
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? fields - 1 : 1)) % fields;
        return true;
      }
      if (ev.name === 'enter') {
        const title = m.title.trim();
        if (!title) { this.toast('Title is required', 'error'); return true; }
        try {
          const parsed = parseLocalDateTime(m.date, m.startTime);
          let end = parsed.end;
          if (!parsed.allDay && m.endTime.trim()) {
            const eParsed = parseLocalDateTime(m.date, m.endTime);
            end = Math.max(parsed.start, eParsed.start);
          }
          const payload = {
            ...(m.kind === 'edit' && current ? current : {}),
            soul: m.kind === 'edit' && current ? current.soul : null,
            title,
            start: parsed.start,
            end,
            allDay: parsed.allDay,
            location: m.location.trim()
          };
          const res = await this.store.saveEvent(payload);
          this.selectBySoul(res.soul);
          this.modal = null;
          this.toast(m.kind === 'new' ? `Added "${title}"` : 'Event updated', 'success');
        } catch (e) {
          this.toast(e.message || 'Invalid event date/time', 'error');
        }
        return true;
      }
      const keys = ['title', 'date', 'startTime', 'endTime', 'location'];
      const key = keys[m.focus];
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
          await this.store.trashEvent(current.soul);
          this.toast('Moved event to Trash', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      if (ev.name === 'n') { this.modal = null; return true; }
      return true;
    }

    return true;
  }

  async handleKey(ev) {
    const agendaList = this._dayEvents().length ? this._dayEvents() : this._upcomingEvents();
    this.agendaIdx = agendaList.length ? Math.max(0, Math.min(agendaList.length - 1, this.agendaIdx)) : 0;
    const current = agendaList[this.agendaIdx] || null;

    if (this.modal) return this._handleModalKey(ev, current);

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

    if (ev.name === 'tab') {
      this.pane = this.pane === 'grid' ? 'agenda' : 'grid';
      return true;
    }
    if (ev.name === 't') {
      const now = new Date();
      this.selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      this.agendaIdx = 0;
      return true;
    }
    if (ev.name === '<' || (ev.shift && ev.name === 'H')) {
      this._moveMonths(-1);
      return true;
    }
    if (ev.name === '>' || (ev.shift && ev.name === 'L')) {
      this._moveMonths(1);
      return true;
    }
    if (ev.name === 'n' && !ev.ctrl) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'new',
        title: '',
        date: toYmd(this.selectedDate),
        startTime: '10:00',
        endTime: '11:00',
        location: '',
        focus: 0
      };
      return true;
    }

    if (this.pane === 'grid') {
      if (ev.name === 'h' || ev.name === 'left') { this._moveDays(-1); return true; }
      if (ev.name === 'l' || ev.name === 'right') { this._moveDays(1); return true; }
      if (ev.name === 'j' || ev.name === 'down') { this._moveDays(7); return true; }
      if (ev.name === 'k' || ev.name === 'up') { this._moveDays(-7); return true; }
      if (ev.name === 'enter') { this.pane = 'agenda'; return true; }
    } else {
      if (ev.name === 'j' || ev.name === 'down') {
        if (agendaList.length) this.agendaIdx = Math.min(agendaList.length - 1, this.agendaIdx + 1);
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        this.agendaIdx = Math.max(0, this.agendaIdx - 1);
        return true;
      }
      if (ev.name === 'h' || ev.name === 'left') { this.pane = 'grid'; return true; }
    }

    if (!current) return false;

    if (ev.name === 'i' || (this.pane === 'agenda' && ev.name === 'enter')) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'edit',
        title: current.title || '',
        date: toYmd(new Date(current.start)),
        startTime: current.allDay ? '' : toHm(current.start),
        endTime: current.allDay ? '' : toHm(current.end || current.start),
        location: current.location || '',
        focus: 0
      };
      return true;
    }
    if (ev.name === 'e') {
      await this._editNotesInEditor(current);
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
    if (this.searchMode) return 'Type to filter events  ·  Enter: apply  ·  Esc: clear';
    return 'hjkl:day  H/L:month  t:today  Tab:agenda  n:new  i:edit  e:$EDITOR  d:trash  /:search';
  }

  render(screen, theme, area) {
    const y = this.selectedDate.getFullYear();
    const m = this.selectedDate.getMonth();
    const selDay = this.selectedDate.getDate();
    const now = new Date();
    const isTodayMonth = now.getFullYear() === y && now.getMonth() === m;
    const todayDay = now.getDate();

    const byDay = this.store.getEventsForMonth(y, m);
    const wide = area.w >= 68;
    const gridW = wide ? 34 : area.w;
    const gridH = wide ? area.h : Math.min(12, Math.floor(area.h * 0.48));

    screen.box(area.x, area.y, gridW, gridH, {
      title: `${MONTHS[m]} ${y}`,
      rightTitle: '</> month',
      borderColor: this.pane === 'grid' ? theme.borderFocus : theme.border,
      bg: theme.listBg,
      titleColor: theme.accent
    });

    const gx = area.x + 3;
    let gy = area.y + 2;
    WEEKDAYS.forEach((wd, i) => {
      screen.text(gx + i * 4, gy, wd, { fg: theme.fgMuted, bg: theme.listBg, bold: true });
    });
    gy += 1;

    const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // Mon=0..Sun=6
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let col = firstDow;
    for (let d = 1; d <= daysInMonth; d++) {
      if (gy >= area.y + gridH - 1) break;
      const evCount = (byDay.get(d) || []).length;
      const isSel = d === selDay;
      const isToday = isTodayMonth && d === todayDay;
      const label = String(d).padStart(2, ' ') + (evCount ? '·' : ' ');
      screen.text(gx + col * 4, gy, label, {
        fg: isSel ? theme.bg : (isToday ? theme.green : (evCount ? theme.accentSoft : theme.fg)),
        bg: isSel ? theme.accent : theme.listBg,
        bold: isSel || isToday || evCount > 0,
        underline: isToday && !isSel
      });
      col++;
      if (col === 7) { col = 0; gy += 1; }
    }

    // Agenda pane
    const ax = wide ? area.x + gridW : area.x;
    const ay = wide ? area.y : area.y + gridH;
    const aw = wide ? area.w - gridW : area.w;
    const ah = wide ? area.h : area.h - gridH;

    const dayEvents = this._dayEvents();
    const upcoming = this._upcomingEvents();
    const usingDay = dayEvents.length > 0;
    const items = usingDay ? dayEvents : upcoming;
    this.agendaIdx = items.length ? Math.max(0, Math.min(items.length - 1, this.agendaIdx)) : 0;

    screen.box(ax, ay, aw, ah, {
      title: usingDay ? `${toYmd(this.selectedDate)} (${dayEvents.length})` : `Upcoming from ${formatShortDate(this.selectedDate)} (${upcoming.length})`,
      rightTitle: this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[/]'),
      borderColor: this.pane === 'agenda' ? theme.borderFocus : theme.border,
      bg: theme.panelBg
    });

    const iw = aw - 4;
    const ih = ah - 2;
    if (!items.length) {
      screen.text(ax + 2, ay + 2, 'No events scheduled. Press n to add one.', { fg: theme.fgMuted, bg: theme.panelBg });
    } else {
      const maxVis = Math.max(1, Math.floor(ih / 2));
      const scroll = this.agendaIdx >= maxVis ? this.agendaIdx - maxVis + 1 : 0;
      for (let i = 0; i < maxVis && scroll + i < items.length; i++) {
        const ev = items[scroll + i];
        const sel = this.pane === 'agenda' && scroll + i === this.agendaIdx;
        const bg = sel ? theme.selectedBg : theme.panelBg;
        const ry = ay + 1 + i * 2;
        screen.fill(ax + 1, ry, aw - 2, 2, ' ', { fg: theme.fg, bg });
        const timeStr = ev.allDay ? 'all-day' : toHm(ev.start);
        const datePrefix = usingDay ? timeStr : `${formatShortDate(ev.start)} ${timeStr}`;
        screen.text(ax + 2, ry, (sel ? '▸ ' : '  ') + datePrefix + '  ', { fg: theme.cyan, bg });
        screen.text(ax + 6 + datePrefix.length, ry, truncate(ev.title, Math.max(8, iw - datePrefix.length - 4)), {
          fg: theme.fg,
          bg,
          bold: sel
        });
        const sub = [ev.location, ev.notes].filter(Boolean).join(' · ');
        if (sub) {
          screen.text(ax + 4, ry + 1, truncate(sub, iw - 2), { fg: theme.fgMuted, bg });
        }
      }
    }

    if (this.modal) this._renderModal(screen, theme);
  }

  _renderModal(screen, theme) {
    const m = this.modal;
    if (m.kind === 'new' || m.kind === 'edit') {
      const box = drawModal(screen, theme, {
        title: m.kind === 'new' ? 'New Calendar Event' : 'Edit Event',
        width: 58,
        height: 17,
        footer: 'Tab: field  ·  Enter: save  ·  Esc: cancel'
      });
      const drawF = (idx, label, val, ph, yOff) => {
        screen.text(box.x, box.y + yOff, label, { fg: m.focus === idx ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
        drawTextInput(screen, box.x, box.y + yOff + 1, box.w, val, val.length, { focused: m.focus === idx, placeholder: ph, theme });
      };
      drawF(0, 'Title', m.title, 'Meeting / Appointment', 0);
      drawF(1, 'Date (YYYY-MM-DD)', m.date, '2026-11-24', 3);
      drawF(2, 'Start Time (HH:MM, empty = all day)', m.startTime, '10:00', 6);
      drawF(3, 'End Time (HH:MM)', m.endTime, '11:00', 9);
      drawF(4, 'Location', m.location, 'Optional', 12);
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Move Event to Trash?',
        width: 48,
        height: 8,
        footer: 'y/Enter: trash  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Move selected event to Trash?', { fg: theme.fg, bg: theme.panelBg });
    }
  }
}
