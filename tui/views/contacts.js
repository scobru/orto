import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyToClipboard } from '../engine/clipboard.js';
import { openInEditor } from '../engine/editor.js';
import { truncate, wrapText } from '../engine/screen.js';
import { drawModal, drawTextInput } from '../engine/widgets.js';

function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

export class ContactsView {
  constructor({ store, config, suspend, resume, toast }) {
    this.store = store;
    this.config = config;
    this.suspend = suspend;
    this.resume = resume;
    this.toast = toast;

    this.idx = 0;
    this.selectedSoul = null;
    this.scroll = 0;
    this.query = '';
    this.searchMode = false;
    this.modal = null;
  }

  selectBySoul(soul) {
    this.query = '';
    this.selectedSoul = soul;
    const list = this._getList();
    const i = list.findIndex((c) => c.soul === soul);
    if (i >= 0) this.idx = i;
  }

  _getList() {
    return this.store.getContacts({ query: this.query });
  }

  _current(list) {
    if (!list.length) {
      this.idx = 0;
      this.selectedSoul = null;
      return null;
    }
    if (this.selectedSoul) {
      const i = list.findIndex((c) => c.soul === this.selectedSoul);
      if (i >= 0) { this.idx = i; return list[i]; }
    }
    this.idx = Math.max(0, Math.min(list.length - 1, this.idx));
    this.selectedSoul = list[this.idx].soul;
    return list[this.idx];
  }

  async _editNotesInEditor(contact) {
    if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return; }
    try {
      const res = openInEditor(contact.notes || '', {
        ext: '.md',
        editorCmd: this.config?.editor,
        suspend: this.suspend,
        resume: this.resume
      });
      if (!res.changed) { this.toast('No changes'); return; }
      await this.store.saveContact({ ...contact, soul: contact.soul, notes: res.text.trimEnd() });
      this.toast('Saved contact notes', 'success');
    } catch (e) {
      this.toast(e.message || 'Editor failed', 'error');
    }
  }

  async _handleModalKey(ev, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') { this.modal = null; return true; }

    if (m.kind === 'new' || m.kind === 'edit') {
      const fields = 6; // name, emails, phones, org, pub, tags
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = (m.focus + (ev.name === 'up' || ev.shift ? fields - 1 : 1)) % fields;
        return true;
      }
      if (ev.name === 'enter') {
        const name = m.name.trim();
        if (!name) { this.toast('Name is required', 'error'); return true; }
        const splitCsv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
        try {
          const res = await this.store.saveContact({
            ...(m.kind === 'edit' && current ? current : {}),
            soul: m.kind === 'edit' && current ? current.soul : null,
            name,
            emails: splitCsv(m.emails),
            phones: splitCsv(m.phones),
            org: m.org.trim(),
            pub: m.pub.trim().toLowerCase(),
            tags: splitCsv(m.tags).map((t) => t.replace(/^#/, ''))
          });
          this.selectBySoul(res.soul);
          this.modal = null;
          this.toast(m.kind === 'new' ? `Added ${name}` : 'Contact updated', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      const keys = ['name', 'emails', 'phones', 'org', 'pub', 'tags'];
      const key = keys[m.focus];
      if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
      if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ' '); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'vcf-import' || m.kind === 'vcf-export') {
      if (ev.name === 'enter') {
        const filePath = expandHome(m.path);
        this.modal = null;
        try {
          if (m.kind === 'vcf-import') {
            const text = fs.readFileSync(filePath, 'utf8');
            const res = await this.store.importContactsVcf(text);
            this.toast(`Imported ${res.imported} contact(s)`, 'success');
          } else {
            const vcf = await this.store.exportContactsVcf();
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, vcf, 'utf8');
            this.toast(`Exported vCard to ${filePath}`, 'success');
          }
        } catch (e) { this.toast(e.message || 'vCard error', 'error'); }
        return true;
      }
      if (ev.name === 'backspace') { m.path = m.path.slice(0, -1); return true; }
      if (ev.name === 'paste') { m.path += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m.path += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'delete' && current) {
      if (ev.name === 'y' || ev.name === 'enter') {
        this.modal = null;
        try {
          await this.store.trashContact(current.soul);
          this.selectedSoul = null;
          this.toast('Moved contact to Trash', 'success');
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
      if (ev.name === 'paste') { this.query += ev.paste.replace(/\r?\n/g, ' '); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.query += ev.ch; this.idx = 0; this.selectedSoul = null; return true; }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) { this.searchMode = true; return true; }
    if (ev.name === 'escape' && this.query) { this.query = ''; this.idx = 0; this.selectedSoul = null; return true; }

    if (ev.name === 'n' && !ev.ctrl) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'new', name: '', emails: '', phones: '', org: '', pub: '', tags: '', focus: 0 };
      return true;
    }
    if (ev.shift && ev.name === 'I') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = { kind: 'vcf-import', path: '~/contacts.vcf' };
      return true;
    }
    if (ev.shift && ev.name === 'E') {
      this.modal = { kind: 'vcf-export', path: '~/contacts.vcf' };
      return true;
    }

    if (ev.name === 'j' || ev.name === 'down') {
      if (list.length) { this.idx = Math.min(list.length - 1, this.idx + 1); this.selectedSoul = list[this.idx].soul; }
      return true;
    }
    if (ev.name === 'k' || ev.name === 'up') {
      if (list.length) { this.idx = Math.max(0, this.idx - 1); this.selectedSoul = list[this.idx].soul; }
      return true;
    }

    if (!current) return false;

    if (ev.name === 'y' || ev.name === 'enter') {
      const val = (current.emails || [])[0] || (current.phones || [])[0] || current.name;
      copyToClipboard(val, { stdout: process.stdout });
      this.toast(`Copied: ${val}`, 'success');
      return true;
    }
    if (ev.name === 'i') {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.modal = {
        kind: 'edit',
        name: current.name || '',
        emails: (current.emails || []).join(', '),
        phones: (current.phones || []).join(', '),
        org: current.org || '',
        pub: current.pub || '',
        tags: (current.tags || []).join(', '),
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
    if (this.searchMode) return 'Type to filter contacts  ·  Enter: apply  ·  Esc: clear';
    return 'j/k:select  y:copy email/phone  n:new  i:edit  e:$EDITOR notes  I/E:vCard  d:trash  /:search';
  }

  render(screen, theme, area) {
    const list = this._getList();
    const current = this._current(list);

    const wide = area.w >= 62;
    const listW = wide ? Math.max(24, Math.min(36, Math.floor(area.w * 0.36))) : area.w;

    screen.box(area.x, area.y, listW, area.h, {
      title: `Contacts (${list.length})`,
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
      screen.text(area.x + 2, area.y + 2, 'No contacts yet. Press n to add one.', { fg: theme.fgMuted, bg: theme.listBg });
    } else {
      for (let i = 0; i < maxVis && this.scroll + i < list.length; i++) {
        const c = list[this.scroll + i];
        const sel = this.scroll + i === this.idx;
        const bg = sel ? theme.selectedBg : theme.listBg;
        const ry = area.y + 1 + i * 2;
        screen.fill(area.x + 1, ry, iw, 2, ' ', { fg: theme.fg, bg });
        screen.text(area.x + 2, ry, (sel ? '▸ ' : '  ') + truncate(c.name, iw - 4), { fg: theme.fg, bg, bold: sel });
        const sub = [(c.emails || [])[0], c.org].filter(Boolean).join(' · ');
        if (sub) screen.text(area.x + 4, ry + 1, truncate(sub, iw - 4), { fg: theme.fgMuted, bg });
      }
    }

    if (wide) {
      const dx = area.x + listW;
      const dw = area.w - listW;
      screen.box(dx, area.y, dw, area.h, {
        title: current ? current.name : 'Contact Card',
        rightTitle: current?.org || '',
        borderColor: theme.border,
        bg: theme.panelBg,
        titleColor: theme.accent
      });

      const diw = dw - 4;
      if (!current) {
        screen.text(dx + 2, area.y + 2, 'Select a contact.', { fg: theme.fgMuted, bg: theme.panelBg });
      } else {
        let r = area.y + 2;
        const row = (lbl, val, color = theme.fg) => {
          if (r >= area.y + area.h - 2) return;
          screen.text(dx + 2, r, lbl.padEnd(10), { fg: theme.fgDim, bg: theme.panelBg });
          screen.text(dx + 12, r, truncate(val || '—', Math.max(8, diw - 10)), { fg: val ? color : theme.fgMuted, bg: theme.panelBg });
          r += 2;
        };
        row('Org:', current.org);
        row('Email:', (current.emails || []).join(', '), theme.cyan);
        row('Phone:', (current.phones || []).join(', '));
        row('Orto user:', current.pub ? `@${current.pub}` : '', theme.green);
        row('Tags:', (current.tags || []).map((t) => '#' + t).join(' '), theme.accentSoft);
        if (current.notes && r < area.y + area.h - 2) {
          screen.text(dx + 2, r++, 'Notes:', { fg: theme.fgDim, bg: theme.panelBg });
          for (const nl of wrapText(current.notes, diw)) {
            if (r >= area.y + area.h - 1) break;
            screen.text(dx + 2, r++, nl, { fg: theme.fg, bg: theme.panelBg });
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
        title: m.kind === 'new' ? 'New Contact' : 'Edit Contact',
        width: 60,
        height: 19,
        footer: 'Tab: field  ·  Enter: save  ·  Esc: cancel'
      });
      const fields = [
        ['Name', 'name', 'Alice Rossi'],
        ['Emails (comma separated)', 'emails', 'alice@example.com'],
        ['Phones (comma separated)', 'phones', '+39 333 000000'],
        ['Organization', 'org', 'Acme'],
        ['Orto Username', 'pub', 'alice'],
        ['Tags', 'tags', 'friends, work']
      ];
      fields.forEach(([lbl, key, ph], i) => {
        screen.text(box.x, box.y + i * 3, lbl, { fg: m.focus === i ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
        drawTextInput(screen, box.x, box.y + i * 3 + 1, box.w, m[key], m[key].length, { focused: m.focus === i, placeholder: ph, theme });
      });
    } else if (m.kind === 'vcf-import' || m.kind === 'vcf-export') {
      const box = drawModal(screen, theme, {
        title: m.kind === 'vcf-import' ? 'Import Contacts (.vcf)' : 'Export Contacts (.vcf)',
        width: 58,
        height: 9,
        footer: 'Enter: run  ·  Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'vCard File Path', { fg: theme.accentSoft, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, m.path, m.path.length, { focused: true, theme });
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Move Contact to Trash?',
        width: 48,
        height: 8,
        footer: 'y/Enter: trash  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Move selected contact to Trash?', { fg: theme.fg, bg: theme.panelBg });
    }
  }
}
