import { truncate } from '../engine/screen.js';
import { drawModal, formatRelativeTime } from '../engine/widgets.js';

export class TrashView {
  constructor({ store, toast }) {
    this.store = store;
    this.toast = toast;
    this.idx = 0;
    this.confirm = null; // null | { kind: 'purge'|'empty', item? }
  }

  async handleKey(ev) {
    const items = this.store.getTrashItems();
    this.idx = items.length ? Math.max(0, Math.min(items.length - 1, this.idx)) : 0;
    const current = items[this.idx] || null;

    if (this.confirm) {
      if (ev.name === 'escape' || ev.name === 'n') {
        this.confirm = null;
        return true;
      }
      if (ev.name === 'y' || ev.name === 'enter') {
        const act = this.confirm;
        this.confirm = null;
        try {
          if (act.kind === 'purge' && act.item) {
            await this.store.purgeTrashItem(act.item.kind, act.item.soul);
            this.toast('Permanently deleted', 'success');
          } else if (act.kind === 'empty') {
            const count = await this.store.emptyTrash();
            this.toast(`Emptied ${count} item(s)`, 'success');
          }
        } catch (e) {
          this.toast(e.message, 'error');
        }
        return true;
      }
      return true;
    }

    if (ev.name === 'j' || ev.name === 'down') {
      if (items.length) this.idx = Math.min(items.length - 1, this.idx + 1);
      return true;
    }
    if (ev.name === 'k' || ev.name === 'up') {
      this.idx = Math.max(0, this.idx - 1);
      return true;
    }

    if ((ev.name === 'u' || ev.name === 'enter') && current) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      try {
        await this.store.restoreTrashItem(current.kind, current.soul);
        this.toast(`Restored ${current.kindLabel}: ${current.title}`, 'success');
      } catch (e) {
        this.toast(e.message, 'error');
      }
      return true;
    }

    if (ev.shift && ev.name === 'D' && current) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.confirm = { kind: 'purge', item: current };
      return true;
    }

    if (ev.shift && ev.name === 'X' && items.length) {
      if (this.store.isReadOnly()) { this.toast('Read-only space (viewer)', 'error'); return true; }
      this.confirm = { kind: 'empty' };
      return true;
    }

    return false;
  }

  getHints() {
    return 'j/k:select  u/Enter:restore  D:delete forever  X:empty trash';
  }

  render(screen, theme, area) {
    const items = this.store.getTrashItems();
    this.idx = items.length ? Math.max(0, Math.min(items.length - 1, this.idx)) : 0;

    screen.box(area.x, area.y, area.w, area.h, {
      title: `Trash (${items.length})`,
      borderColor: theme.borderFocus,
      bg: theme.listBg
    });

    const iw = area.w - 4;
    const ih = area.h - 2;
    if (!items.length) {
      screen.text(area.x + 2, area.y + 2, 'Trash is empty.', { fg: theme.fgMuted, bg: theme.listBg });
    } else {
      const scroll = this.idx >= ih ? this.idx - ih + 1 : 0;
      for (let i = 0; i < ih && scroll + i < items.length; i++) {
        const it = items[scroll + i];
        const sel = scroll + i === this.idx;
        const bg = sel ? theme.selectedBg : theme.listBg;
        const ry = area.y + 1 + i;
        screen.fill(area.x + 1, ry, area.w - 2, 1, ' ', { fg: theme.fg, bg });
        const badge = `[${it.kindLabel}]`.padEnd(10);
        const age = formatRelativeTime(it.updatedAt);
        screen.text(area.x + 2, ry, sel ? '▸ ' : '  ', { fg: theme.accent, bg });
        screen.text(area.x + 4, ry, badge, { fg: theme.amber, bg });
        screen.text(area.x + 14, ry, truncate(it.title, Math.max(10, iw - 20)), { fg: theme.fg, bg, bold: sel });
        if (age) {
          screen.text(area.x + area.w - 2 - age.length, ry, age, { fg: theme.fgMuted, bg });
        }
      }
    }

    if (this.confirm) {
      const box = drawModal(screen, theme, {
        title: this.confirm.kind === 'empty' ? 'Empty All Trash?' : 'Delete Forever?',
        width: 52,
        height: 8,
        footer: 'y/Enter: confirm  ·  n/Esc: cancel'
      });
      const msg = this.confirm.kind === 'empty'
        ? `Permanently delete all ${items.length} trashed item(s)?`
        : `Permanently delete "${truncate(this.confirm.item.title, 30)}"?`;
      screen.text(box.x, box.y + 1, msg, { fg: theme.danger, bg: theme.panelBg, bold: true });
      screen.text(box.x, box.y + 3, 'This action cannot be undone.', { fg: theme.fgMuted, bg: theme.panelBg });
    }
  }
}
