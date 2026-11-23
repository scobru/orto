import { copyToClipboard } from '../engine/clipboard.js';
import { truncate } from '../engine/screen.js';
import { drawModal, drawTextInput, fuzzyScore } from '../engine/widgets.js';

export class CommandPalette {
  constructor({ store, commands, onSelectItem, onRunCommand, onClose }) {
    this.store = store;
    this.commands = commands;
    this.onSelectItem = onSelectItem;
    this.onRunCommand = onRunCommand;
    this.onClose = onClose;
    this.query = '';
    this.idx = 0;
  }

  _getEntries() {
    const q = this.query.trim();
    const cmdOnly = q.startsWith('>');
    const cleanQ = cmdOnly ? q.slice(1).trim() : q;

    const cmdEntries = this.commands
      .map((c) => ({
        kind: 'command',
        title: c.label,
        subtitle: c.shortcut ? `[${c.shortcut}]` : 'command',
        score: cleanQ ? fuzzyScore(cleanQ, c.label) : 10,
        command: c
      }))
      .filter((c) => c.score > 0);

    if (cmdOnly || !cleanQ) {
      return cmdEntries.slice(0, 12);
    }

    const itemEntries = this.store.globalSearch(cleanQ, 12).map((h) => ({
      kind: h.kind,
      view: h.view,
      soul: h.soul,
      title: h.title,
      subtitle: h.subtitle,
      score: h.score + 5
    }));

    return [...itemEntries, ...cmdEntries]
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }

  async handleKey(ev) {
    const entries = this._getEntries();
    this.idx = entries.length ? Math.max(0, Math.min(entries.length - 1, this.idx)) : 0;

    if (ev.name === 'escape') {
      this.onClose();
      return true;
    }
    if (ev.name === 'down' || (ev.ctrl && ev.name === 'n')) {
      if (entries.length) this.idx = (this.idx + 1) % entries.length;
      return true;
    }
    if (ev.name === 'up' || (ev.ctrl && ev.name === 'p')) {
      if (entries.length) this.idx = (this.idx - 1 + entries.length) % entries.length;
      return true;
    }
    if (ev.name === 'enter' && entries[this.idx]) {
      const sel = entries[this.idx];
      this.onClose();
      if (sel.kind === 'command') {
        await this.onRunCommand(sel.command.id);
      } else {
        await this.onSelectItem(sel);
      }
      return true;
    }
    if (ev.name === 'backspace') {
      this.query = this.query.slice(0, -1);
      this.idx = 0;
      return true;
    }
    if (ev.name === 'paste') {
      this.query += ev.paste.replace(/\r?\n/g, ' ');
      this.idx = 0;
      return true;
    }
    if (ev.ch && !ev.ctrl && !ev.alt) {
      this.query += ev.ch;
      this.idx = 0;
      return true;
    }
    return true;
  }

  render(screen, theme) {
    const entries = this._getEntries();
    this.idx = entries.length ? Math.max(0, Math.min(entries.length - 1, this.idx)) : 0;

    const box = drawModal(screen, theme, {
      title: 'Command Palette & Global Search',
      width: 68,
      height: 18,
      footer: 'Type to search or >command  ·  ↑/↓: select  ·  Enter: run  ·  Esc: close'
    });

    drawTextInput(screen, box.x, box.y, box.w, this.query, this.query.length, {
      focused: true,
      placeholder: 'Search notes, tasks, bookmarks, secrets... or >command',
      theme
    });
    screen.hline(box.x, box.y + 1, box.w, { fg: theme.border, bg: theme.panelBg });

    if (!entries.length) {
      screen.text(box.x, box.y + 3, 'No matching items or commands.', { fg: theme.fgMuted, bg: theme.panelBg });
      return;
    }

    const maxRows = box.h - 2;
    for (let i = 0; i < Math.min(maxRows, entries.length); i++) {
      const e = entries[i];
      const sel = i === this.idx;
      const bg = sel ? theme.selectedBg : theme.panelBg;
      const ry = box.y + 2 + i;
      screen.fill(box.x, ry, box.w, 1, ' ', { fg: theme.fg, bg });
      const badge = `[${e.kind}]`.padEnd(10);
      screen.text(box.x, ry, sel ? '▸ ' : '  ', { fg: theme.accent, bg });
      screen.text(box.x + 2, ry, badge, { fg: e.kind === 'command' ? theme.cyan : theme.amber, bg });
      screen.text(box.x + 12, ry, truncate(e.title, Math.max(10, box.w - 28)), { fg: theme.fg, bg, bold: sel });
      if (e.subtitle) {
        const sub = truncate(e.subtitle, 16);
        screen.text(box.x + box.w - sub.length, ry, sub, { fg: theme.fgMuted, bg });
      }
    }
  }
}

export class SpacesOverlay {
  constructor({ store, onClose, toast }) {
    this.store = store;
    this.onClose = onClose;
    this.toast = toast;
    this.idx = 0;
    this.mode = 'list'; // 'list' | 'create' | 'join' | 'invite' | 'members' | 'leave'
    this.input = '';
    this.input2 = '';
    this.role = 'editor';
    this.focus = 0;
    this.members = [];
    this.targetSpace = null;
  }

  _entries() {
    const activeId = this.store.activeSpace?.id || null;
    return [
      { id: null, name: 'Personal Workspace', role: 'owner', status: 'active', current: !activeId },
      ...this.store.spaces.map((s) => ({
        ...s,
        current: String(s.id) === String(activeId)
      }))
    ];
  }

  async handleKey(ev) {
    const list = this._entries();
    this.idx = list.length ? Math.max(0, Math.min(list.length - 1, this.idx)) : 0;

    if (this.mode === 'create' || this.mode === 'join') {
      if (ev.name === 'escape') { this.mode = 'list'; this.input = ''; return true; }
      if (ev.name === 'enter') {
        const val = this.input.trim();
        if (!val) return true;
        try {
          if (this.mode === 'create') {
            const sp = await this.store.createSpace(val);
            this.toast(`Created & opened "${sp.name}"`, 'success');
          } else {
            const sp = await this.store.joinSpaceLink(val);
            this.toast(`Joined "${sp.name}"`, 'success');
          }
          this.onClose();
        } catch (e) {
          this.toast(e.message || 'Space action failed', 'error');
        }
        return true;
      }
      if (ev.name === 'backspace') { this.input = this.input.slice(0, -1); return true; }
      if (ev.name === 'paste') { this.input += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.input += ev.ch; return true; }
      return true;
    }

    if (this.mode === 'invite') {
      if (ev.name === 'escape') { this.mode = 'list'; return true; }
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        this.focus = this.focus === 0 ? 1 : 0;
        return true;
      }
      if (this.focus === 1 && (ev.name === 'left' || ev.name === 'right' || ev.name === 'space')) {
        this.role = this.role === 'editor' ? 'viewer' : 'editor';
        return true;
      }
      if (ev.name === 'enter') {
        const target = this.input.trim();
        if (!target) { this.toast('Username or public key required', 'error'); return true; }
        try {
          const res = await this.store.inviteToSpace(target, this.role);
          this.mode = 'list';
          this.input = '';
          this.toast(res?.fingerprint ? `Invited (fp: ${res.fingerprint})` : `Invited ${target} (${this.role})`, 'success');
        } catch (e) {
          this.toast(e.message || 'Invite failed', 'error');
        }
        return true;
      }
      if (this.focus === 0) {
        if (ev.name === 'backspace') { this.input = this.input.slice(0, -1); return true; }
        if (ev.name === 'paste') { this.input += ev.paste.replace(/\r?\n/g, ''); return true; }
        if (ev.ch && !ev.ctrl && !ev.alt) { this.input += ev.ch; return true; }
      }
      return true;
    }

    if (this.mode === 'members') {
      if (ev.name === 'escape' || ev.name === 'enter' || ev.name === 'm') {
        this.mode = 'list';
        return true;
      }
      return true;
    }

    if (this.mode === 'leave') {
      if (ev.name === 'escape' || ev.name === 'n') { this.mode = 'list'; return true; }
      if (ev.name === 'y' || ev.name === 'enter') {
        try {
          await this.store.leaveSpace(this.targetSpace.id);
          this.toast(`Left "${this.targetSpace.name}"`, 'success');
        } catch (e) {
          this.toast(e.message || 'Could not leave space', 'error');
        }
        this.mode = 'list';
        return true;
      }
      return true;
    }

    if (ev.name === 'escape' || ev.name === 's') {
      this.onClose();
      return true;
    }
    if (ev.name === 'j' || ev.name === 'down') {
      this.idx = Math.min(list.length - 1, this.idx + 1);
      return true;
    }
    if (ev.name === 'k' || ev.name === 'up') {
      this.idx = Math.max(0, this.idx - 1);
      return true;
    }
    if (ev.name === 'c') {
      this.mode = 'create';
      this.input = '';
      return true;
    }
    if (ev.name === 'J' || (ev.alt && ev.name === 'j')) {
      this.mode = 'join';
      this.input = '';
      return true;
    }
    if (ev.name === 'i') {
      if (!this.store.activeSpace || this.store.activeSpace.role !== 'owner') {
        this.toast('Open a space you own to invite members', 'error');
        return true;
      }
      this.mode = 'invite';
      this.input = '';
      this.role = 'editor';
      this.focus = 0;
      return true;
    }
    if (ev.shift && ev.name === 'L') {
      if (!this.store.activeSpace || this.store.activeSpace.role !== 'owner') {
        this.toast('Open a space you own to create an invite link', 'error');
        return true;
      }
      try {
        const res = await this.store.createSpaceLink('viewer');
        copyToClipboard(res.url, { stdout: process.stdout });
        this.toast(`Copied viewer invite link`, 'success');
      } catch (e) {
        this.toast(e.message || 'Could not create link', 'error');
      }
      return true;
    }
    if (ev.name === 'm') {
      if (!this.store.activeSpace) {
        this.toast('Open a shared space first', 'error');
        return true;
      }
      try {
        this.members = await this.store.listSpaceMembers();
        this.mode = 'members';
      } catch (e) {
        this.toast(e.message || 'Could not load members', 'error');
      }
      return true;
    }
    if (ev.name === 'x' && list[this.idx] && list[this.idx].id !== null) {
      if (list[this.idx].role === 'owner') {
        this.toast('Owners cannot leave their own space', 'error');
        return true;
      }
      this.targetSpace = list[this.idx];
      this.mode = 'leave';
      return true;
    }
    if (ev.name === 'enter' && list[this.idx]) {
      const sel = list[this.idx];
      this.onClose();
      try {
        if (sel.status === 'pending') {
          await this.store.acceptSpaceInvite(sel.id);
          this.toast(`Accepted & opened "${sel.name}"`, 'success');
        } else {
          await this.store.switchSpace(sel.id);
          this.toast(`Switched to ${sel.name}`, 'success');
        }
      } catch (e) {
        this.toast(e.message || 'Space switch failed', 'error');
      }
      return true;
    }
    return true;
  }

  render(screen, theme) {
    if (this.mode === 'create' || this.mode === 'join') {
      const box = drawModal(screen, theme, {
        title: this.mode === 'create' ? 'Create Shared Space' : 'Join Space via Invite Link',
        width: 60,
        height: 9,
        footer: 'Enter: submit  ·  Esc: back'
      });
      screen.text(box.x, box.y + 1, this.mode === 'create' ? 'Space Name' : 'Invite URL (#join=...)', { fg: theme.accentSoft, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, this.input, this.input.length, { focused: true, theme });
      return;
    }

    if (this.mode === 'invite') {
      const box = drawModal(screen, theme, {
        title: `Invite to ${this.store.activeSpace?.name || 'Space'}`,
        width: 58,
        height: 11,
        footer: 'Tab: field  ·  ←/→: role  ·  Enter: invite  ·  Esc: back'
      });
      screen.text(box.x, box.y + 1, 'Username or Public Key', { fg: this.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, this.input, this.input.length, { focused: this.focus === 0, theme });
      screen.text(box.x, box.y + 4, `Role (←/→): ${this.role}`, { fg: this.focus === 1 ? theme.accent : theme.fg, bg: theme.panelBg, bold: this.focus === 1 });
      return;
    }

    if (this.mode === 'members') {
      const box = drawModal(screen, theme, {
        title: `Members · ${this.store.activeSpace?.name || ''}`,
        width: 62,
        height: Math.min(18, Math.max(8, this.members.length + 5)),
        footer: 'Esc/Enter: back'
      });
      for (let i = 0; i < Math.min(box.h, this.members.length); i++) {
        const m = this.members[i];
        const line = `${m.name} (${m.role} · ${m.status})${m.fingerprint ? '  ' + m.fingerprint : ''}`;
        screen.text(box.x, box.y + i, truncate(line, box.w), { fg: theme.fg, bg: theme.panelBg });
      }
      return;
    }

    if (this.mode === 'leave' && this.targetSpace) {
      const box = drawModal(screen, theme, {
        title: 'Leave Space?',
        width: 48,
        height: 8,
        footer: 'y/Enter: leave  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, truncate(`Leave "${this.targetSpace.name}"?`, box.w), { fg: theme.danger, bg: theme.panelBg });
      return;
    }

    const list = this._entries();
    const box = drawModal(screen, theme, {
      title: 'Workspaces & Shared Spaces',
      width: 66,
      height: Math.min(18, Math.max(10, list.length + 6)),
      footer: 'Enter:switch  c:create  J:join link  i:invite  L:link  m:members  x:leave'
    });

    for (let i = 0; i < Math.min(box.h, list.length); i++) {
      const s = list[i];
      const sel = i === this.idx;
      const bg = sel ? theme.selectedBg : theme.panelBg;
      screen.fill(box.x, box.y + i, box.w, 1, ' ', { fg: theme.fg, bg });
      const marker = s.current ? '● ' : (sel ? '▸ ' : '  ');
      const status = s.status === 'pending' ? 'pending invite' : s.role;
      screen.text(box.x, box.y + i, marker, { fg: s.current ? theme.green : theme.accent, bg });
      screen.text(box.x + 2, box.y + i, truncate(s.name, box.w - 18), { fg: theme.fg, bg, bold: sel || s.current });
      screen.text(box.x + box.w - status.length, box.y + i, status, {
        fg: s.status === 'pending' ? theme.amber : theme.fgMuted,
        bg
      });
    }
  }
}

export class HelpOverlay {
  constructor({ viewTitle, viewHints, onClose }) {
    this.viewTitle = viewTitle;
    this.viewHints = viewHints;
    this.onClose = onClose;
  }

  handleKey(ev) {
    if (ev.name === 'escape' || ev.name === '?' || ev.name === 'enter' || ev.name === 'q') {
      this.onClose();
      return true;
    }
    return true;
  }

  render(screen, theme) {
    const box = drawModal(screen, theme, {
      title: 'Orto TUI · Keybindings',
      width: 66,
      height: 19,
      footer: 'Press ? or Esc to close'
    });
    const rows = [
      ['Global Navigation', ''],
      ['  1..9 / 0 / G / T', 'Jump directly to view (Notes..Blog / Garden / Trash)'],
      ['  [ / ]', 'Previous / Next view'],
      ['  Ctrl+B / Esc', 'Focus Sidebar (use ↑↓ + Enter to browse views)'],
      ['  \\', 'Toggle Sidebar visibility'],
      ['  Ctrl+K', 'Command Palette & Global Search ("Go to ...")'],
      ['  s', 'Switch / Manage Shared Spaces'],
      ['  Ctrl+L / q', 'Lock session / Quit Orto TUI'],
      ['', ''],
      [`Active View: ${this.viewTitle}`, ''],
      ['  Hints', this.viewHints || 'j/k navigate']
    ];
    for (let i = 0; i < Math.min(box.h, rows.length); i++) {
      const [k, v] = rows[i];
      if (!v && k) {
        screen.text(box.x, box.y + i, k, { fg: theme.accent, bg: theme.panelBg, bold: true });
      } else if (k) {
        screen.text(box.x, box.y + i, k.padEnd(20), { fg: theme.cyan, bg: theme.panelBg });
        screen.text(box.x + 20, box.y + i, truncate(v, box.w - 20), { fg: theme.fg, bg: theme.panelBg });
      }
    }
  }
}
