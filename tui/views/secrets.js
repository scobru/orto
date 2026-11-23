import { generatePassword } from '../../orto.js';
import { copyToClipboard } from '../engine/clipboard.js';
import { truncate } from '../engine/screen.js';
import { drawModal, drawTextInput, formatShortDate } from '../engine/widgets.js';

const KIND_FILTERS = [null, 'password', 'api', 'note'];
const KIND_EDIT = ['password', 'api', 'note'];
const KIND_BADGE = { password: '[pwd]', api: '[api]', note: '[sec]' };

export class SecretsView {
  constructor({ store, toast }) {
    this.store = store;
    this.toast = toast;

    this.kindFilter = null;
    this.query = '';
    this.searchMode = false;
    this.idx = 0;
    this.selectedSoul = null;
    this.scroll = 0;

    this.revealedSoul = null;
    this._revealTimer = null;
    this.modal = null;
  }

  _clearReveal() {
    this.revealedSoul = null;
    if (this._revealTimer) {
      clearTimeout(this._revealTimer);
      this._revealTimer = null;
    }
  }

  onBlur() {
    this._clearReveal();
  }

  destroy() {
    this._clearReveal();
  }

  selectBySoul(soul) {
    this._clearReveal();
    this.kindFilter = null;
    this.query = '';
    this.selectedSoul = soul;
    const list = this._getList();
    const idx = list.findIndex((s) => s.soul === soul);
    if (idx >= 0) this.idx = idx;
  }

  _getList() {
    return this.store.getSecrets({ kind: this.kindFilter, query: this.query });
  }

  _current(list) {
    if (!list.length) {
      this.idx = 0;
      this.selectedSoul = null;
      return null;
    }
    if (this.selectedSoul) {
      const idx = list.findIndex((s) => s.soul === this.selectedSoul);
      if (idx >= 0) {
        this.idx = idx;
        return list[idx];
      }
    }
    this.idx = Math.max(0, Math.min(list.length - 1, this.idx));
    this.selectedSoul = list[this.idx].soul;
    return list[this.idx];
  }

  _toggleReveal(current) {
    if (!current) return;
    if (this.revealedSoul === current.soul) {
      this._clearReveal();
      return;
    }
    this._clearReveal();
    this.revealedSoul = current.soul;
    this._revealTimer = setTimeout(() => {
      this._revealTimer = null;
      this.revealedSoul = null;
    }, 15000);
    this._revealTimer.unref?.();
  }

  async _handleModalKey(ev, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') { this.modal = null; return true; }

    if (m.kind === 'new' || m.kind === 'edit') {
      const fields = 6; // name, kind, username, secret, url, tags
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? fields - 1 : 1)) % fields;
        return true;
      }
      if (m.focus === 1 && (ev.name === 'left' || ev.name === 'right' || ev.name === 'space')) {
        const i = KIND_EDIT.indexOf(m.secKind);
        m.secKind = KIND_EDIT[(i + (ev.name === 'left' ? KIND_EDIT.length - 1 : 1)) % KIND_EDIT.length];
        return true;
      }
      if (ev.ctrl && ev.name === 'g') {
        m.secret = generatePassword(24);
        this.toast('Generated 24-char password into secret field', 'success');
        return true;
      }
      if (ev.name === 'enter') {
        const name = m.name.trim();
        if (!name) { this.toast('Name is required', 'error'); return true; }
        if (!m.secret) { this.toast('Secret value is required', 'error'); return true; }
        const tags = m.tags.split(/[,\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
        try {
          const res = await this.store.saveSecret({
            ...(m.kind === 'edit' && current ? current : {}),
            soul: m.kind === 'edit' && current ? current.soul : null,
            name,
            kind: m.secKind,
            username: m.username.trim(),
            secret: m.secret,
            url: m.url.trim(),
            tags
          });
          m.secret = '';
          this.selectBySoul(res.soul);
          this.modal = null;
          this.toast(m.kind === 'new' ? `Saved secret "${name}"` : 'Secret updated', 'success');
        } catch (e) {
          this.toast(e.message || 'Save failed', 'error');
        }
        return true;
      }
      const key = m.focus === 0 ? 'name'
        : m.focus === 2 ? 'username'
          : m.focus === 3 ? 'secret'
            : m.focus === 4 ? 'url'
              : m.focus === 5 ? 'tags' : null;
      if (key) {
        if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
        if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ''); return true; }
        if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      }
      return true;
    }

    if (m.kind === 'delete' && current) {
      if (ev.name === 'y' || ev.name === 'enter') {
        this.modal = null;
        this._clearReveal();
        try {
          await this.store.trashSecret(current.soul);
          this.selectedSoul = null;
          this.toast('Moved secret to Trash', 'success');
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
    const current = this._current(list);

    if (this.modal) return this._handleModalKey(ev, current);

    if (this.searchMode) {
      if (ev.name === 'escape') { this.query = ''; this.searchMode = false; this.idx = 0; this.selectedSoul = null; return true; }
      if (ev.name === 'enter') { this.searchMode = false; return true; }
      if (ev.name === 'backspace') { this.query = this.query.slice(0, -1); this.idx = 0; this.selectedSoul = null; return true; }
      if (ev.name === 'paste') { this.query += ev.paste.replace(/\r?\n/g, ' '); this.idx = 0; this.selectedSoul = null; return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.query += ev.ch; this.idx = 0; this.selectedSoul = null; return true; }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) { this.searchMode = true; return true; }
    if (ev.name === 'escape' && this.query) { this.query = ''; this.idx = 0; this.selectedSoul = null; return true; }

    if (ev.name === 'f') {
      const i = KIND_FILTERS.indexOf(this.kindFilter);
      this.kindFilter = KIND_FILTERS[(i + 1) % KIND_FILTERS.length];
      this.idx = 0;
      this.selectedSoul = null;
      this._clearReveal();
      return true;
    }

    if (ev.name === 'g') {
      const pw = generatePassword(24);
      copyToClipboard(pw, { clearAfterMs: 20000, stdout: process.stdout });
      this.toast('Generated & copied 24-char password (clears in 20s)', 'success');
      return true;
    }

    if (ev.name === 'n' && !ev.ctrl) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'new', name: '', secKind: 'password', username: '', secret: '', url: '', tags: '', focus: 0 };
      return true;
    }

    if (ev.name === 'j' || ev.name === 'down') {
      if (list.length) {
        this.idx = Math.min(list.length - 1, this.idx + 1);
        this.selectedSoul = list[this.idx].soul;
        this._clearReveal();
      }
      return true;
    }
    if (ev.name === 'k' || ev.name === 'up') {
      if (list.length) {
        this.idx = Math.max(0, this.idx - 1);
        this.selectedSoul = list[this.idx].soul;
        this._clearReveal();
      }
      return true;
    }

    if (!current) return false;

    if (ev.name === 'r') {
      this._toggleReveal(current);
      return true;
    }
    if (ev.name === 'y' || ev.name === 'enter') {
      copyToClipboard(current.secret, { clearAfterMs: 20000, stdout: process.stdout });
      this.toast(`Copied "${current.name}" secret (clears in 20s)`, 'success');
      return true;
    }
    if (ev.name === 'u') {
      if (!current.username) { this.toast('No username on this secret'); return true; }
      copyToClipboard(current.username, { stdout: process.stdout });
      this.toast(`Copied username: ${current.username}`, 'success');
      return true;
    }
    if (ev.name === 'i') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'edit',
        name: current.name || '',
        secKind: current.kind || 'password',
        username: current.username || '',
        secret: current.secret || '',
        url: current.url || '',
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
    if (this.searchMode) return 'Type to filter secrets (values excluded)  ·  Enter: apply  ·  Esc: clear';
    return 'y/Enter:copy secret (20s)  u:copy user  r:reveal (15s)  g:gen password  n:new  i:edit  f:kind  d:trash';
  }

  render(screen, theme, area) {
    const list = this._getList();
    const current = this._current(list);

    const wide = area.w >= 62;
    const listW = wide ? Math.max(24, Math.min(36, Math.floor(area.w * 0.38))) : area.w;

    screen.box(area.x, area.y, listW, area.h, {
      title: `Secrets (${list.length}) · ${this.kindFilter || 'all'}`,
      rightTitle: this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[/]'),
      borderColor: theme.borderFocus,
      bg: theme.listBg
    });

    const iw = listW - 2;
    const ih = area.h - 2;
    const maxVis = Math.max(1, Math.floor(ih / 2));
    if (this.idx < this.scroll) this.scroll = this.idx;
    if (this.idx >= this.scroll + maxVis) this.scroll = this.idx - maxVis + 1;

    if (!list.length) {
      screen.text(area.x + 2, area.y + 2, 'No secrets. Press n to add one.', { fg: theme.fgMuted, bg: theme.listBg });
    } else {
      for (let i = 0; i < maxVis && this.scroll + i < list.length; i++) {
        const s = list[this.scroll + i];
        const sel = this.scroll + i === this.idx;
        const bg = sel ? theme.selectedBg : theme.listBg;
        const ry = area.y + 1 + i * 2;
        screen.fill(area.x + 1, ry, iw, 2, ' ', { fg: theme.fg, bg });
        const badge = KIND_BADGE[s.kind] || '[sec]';
        screen.text(area.x + 2, ry, (sel ? '▸ ' : '  ') + badge + ' ', { fg: theme.amber, bg });
        screen.text(area.x + 10, ry, truncate(s.name, Math.max(6, iw - 10)), { fg: theme.fg, bg, bold: sel });
        if (s.username || s.url) {
          screen.text(area.x + 4, ry + 1, truncate(s.username || s.url, iw - 4), { fg: theme.fgMuted, bg });
        }
      }
    }

    if (wide) {
      const dx = area.x + listW;
      const dw = area.w - listW;
      screen.box(dx, area.y, dw, area.h, {
        title: current ? current.name : 'Secret Details',
        rightTitle: current ? (current.kind || 'password') : '',
        borderColor: theme.border,
        bg: theme.panelBg,
        titleColor: theme.accent
      });

      const diw = dw - 4;
      if (!current) {
        screen.text(dx + 2, area.y + 2, 'Select a secret to copy or inspect.', { fg: theme.fgMuted, bg: theme.panelBg });
      } else {
        const revealed = this.revealedSoul === current.soul;
        const secretDisplay = revealed ? String(current.secret || '') : '••••••••••••••••';
        let r = area.y + 2;
        const row = (lbl, val, color = theme.fg) => {
          if (r >= area.y + area.h - 2) return;
          screen.text(dx + 2, r, lbl.padEnd(11), { fg: theme.fgDim, bg: theme.panelBg });
          screen.text(dx + 13, r, truncate(val, Math.max(8, diw - 11)), { fg: color, bg: theme.panelBg, bold: color === theme.danger });
          r += 2;
        };
        row('Username:', current.username || '—');
        row('Secret:', secretDisplay + (revealed ? '  (auto-hides in 15s)' : '  [r: reveal]'), revealed ? theme.danger : theme.amber);
        row('URL:', current.url || '—', current.url ? theme.cyan : theme.fgMuted);
        row('Tags:', (current.tags || []).map((t) => '#' + t).join(' ') || '—');
        row('Updated:', formatShortDate(current.updatedAt || current.createdAt) || '—');
        if (current.notes && r < area.y + area.h - 2) {
          screen.text(dx + 2, r, 'Notes:', { fg: theme.fgDim, bg: theme.panelBg });
          screen.text(dx + 2, r + 1, truncate(current.notes, diw), { fg: theme.fg, bg: theme.panelBg });
        }
      }
    }

    if (this.modal) this._renderModal(screen, theme);
  }

  _renderModal(screen, theme) {
    const m = this.modal;
    if (m.kind === 'new' || m.kind === 'edit') {
      const box = drawModal(screen, theme, {
        title: m.kind === 'new' ? 'New Secret' : 'Edit Secret',
        width: 60,
        height: 19,
        footer: 'Tab: field  ·  Ctrl+G: generate password  ·  Enter: save  ·  Esc: cancel'
      });
      screen.text(box.x, box.y, 'Name', { fg: m.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 1, box.w, m.name, m.name.length, { focused: m.focus === 0, placeholder: 'GitHub / OpenAI key', theme });

      screen.text(box.x, box.y + 3, `Kind (←/→): ${m.secKind}`, { fg: m.focus === 1 ? theme.accent : theme.fg, bg: theme.panelBg, bold: m.focus === 1 });

      screen.text(box.x, box.y + 5, 'Username / Account', { fg: m.focus === 2 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 6, box.w, m.username, m.username.length, { focused: m.focus === 2, placeholder: 'Optional', theme });

      screen.text(box.x, box.y + 8, 'Secret Value (masked · Ctrl+G to generate)', { fg: m.focus === 3 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 9, box.w, m.secret, m.secret.length, { focused: m.focus === 3, masked: true, placeholder: '••••••••', theme });

      screen.text(box.x, box.y + 11, 'URL', { fg: m.focus === 4 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 12, box.w, m.url, m.url.length, { focused: m.focus === 4, placeholder: 'https://...', theme });

      screen.text(box.x, box.y + 14, 'Tags', { fg: m.focus === 5 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 15, box.w, m.tags, m.tags.length, { focused: m.focus === 5, placeholder: 'work, dev', theme });
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Move Secret to Trash?',
        width: 48,
        height: 8,
        footer: 'y/Enter: trash  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Move selected secret to Trash?', { fg: theme.fg, bg: theme.panelBg });
    }
  }
}
