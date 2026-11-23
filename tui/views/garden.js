import { truncate } from '../engine/screen.js';
import { formatShortDate } from '../engine/widgets.js';

function iconsFor(ascii) {
  if (ascii) {
    return {
      sun: '*',
      moon: 'C',
      cloud: '~',
      rain: '/',
      tulip: 'T',
      sprout: ',',
      young: 'y',
      blocked: 'B',
      wilted: '!',
      harvest: '*',
      weeds: '#',
      leaf: 'f',
      rock: 'o',
      butterfly: 'b',
      bee: 'z'
    };
  }
  return {
    sun: '☀',
    moon: '🌙',
    cloud: '☁',
    rain: '💧',
    tulip: '🌷',
    sprout: '🌱',
    young: '🌿',
    blocked: '🐌',
    wilted: '🥀',
    harvest: '🌻',
    weeds: '~',
    leaf: '🍂',
    rock: '🪨',
    butterfly: '🦋',
    bee: '🐝'
  };
}

export class GardenView {
  constructor({ store, onNavigate }) {
    this.store = store;
    this.onNavigate = onNavigate;
    this.focus = 'items'; // 'items' | 'tips'
    this.itemIdx = 0;
    this.tipIdx = 0;
  }

  _selectableItems(state) {
    return [
      ...state.tulips.map((e) => ({ kind: 'event', soul: e.soul, title: e.title, meta: formatShortDate(e.start), targetView: 'calendar' })),
      ...state.plants.map((p) => ({
        kind: 'plant',
        plantKind: p.kind,
        weedy: p.weedy,
        soul: p.soul,
        title: p.title,
        meta: p.kind === 'wilted' && p.dueDate ? `overdue (${formatShortDate(p.dueDate)})` : p.kind,
        targetView: 'tasks'
      }))
    ];
  }

  handleKey(ev) {
    const state = this.store.getGardenState();
    const items = this._selectableItems(state);
    const tips = state.tips;

    if (ev.name === 'tab') {
      if (tips.length) this.focus = this.focus === 'items' ? 'tips' : 'items';
      return true;
    }

    if (this.focus === 'tips' && tips.length) {
      if (ev.name === 'j' || ev.name === 'down') { this.tipIdx = Math.min(tips.length - 1, this.tipIdx + 1); return true; }
      if (ev.name === 'k' || ev.name === 'up') { this.tipIdx = Math.max(0, this.tipIdx - 1); return true; }
      if (ev.name === 'enter' && tips[this.tipIdx]) {
        this.onNavigate?.(tips[this.tipIdx].targetView, null);
        return true;
      }
      return false;
    }

    if (ev.name === 'j' || ev.name === 'down' || ev.name === 'l' || ev.name === 'right') {
      if (items.length) this.itemIdx = Math.min(items.length - 1, this.itemIdx + 1);
      return true;
    }
    if (ev.name === 'k' || ev.name === 'up' || ev.name === 'h' || ev.name === 'left') {
      if (items.length) this.itemIdx = Math.max(0, this.itemIdx - 1);
      return true;
    }
    if (ev.name === 'enter' && items[this.itemIdx]) {
      const sel = items[this.itemIdx];
      this.onNavigate?.(sel.targetView, sel.soul);
      return true;
    }
    return false;
  }

  getHints() {
    return 'hjkl:inspect plant/tulip  Tab:tips  Enter:open task/event/tip';
  }

  _plantColor(kind, theme) {
    if (kind === 'harvest') return theme.green;
    if (kind === 'wilted') return theme.danger;
    if (kind === 'blocked') return theme.amber;
    if (kind === 'young') return theme.cyan;
    return theme.green;
  }

  render(screen, theme, area) {
    const state = this.store.getGardenState();
    const ic = iconsFor(theme.ascii);
    const items = this._selectableItems(state);
    this.itemIdx = items.length ? Math.max(0, Math.min(items.length - 1, this.itemIdx)) : 0;
    this.tipIdx = state.tips.length ? Math.max(0, Math.min(state.tips.length - 1, this.tipIdx)) : 0;

    const healthColor = state.health >= 75 ? theme.green : state.health >= 45 ? theme.amber : theme.danger;
    const barW = 16;
    const filled = Math.round((state.health / 100) * barW);
    const meter = (theme.ascii ? '#' : '█').repeat(filled) + (theme.ascii ? '-' : '░').repeat(barW - filled);

    screen.box(area.x, area.y, area.w, area.h, {
      title: `Garden · ${state.mood} [${meter}] ${state.health}%`,
      rightTitle: state.sky,
      borderColor: theme.borderFocus,
      bg: theme.panelBg,
      titleColor: healthColor
    });

    const ix = area.x + 2;
    const iw = area.w - 4;
    let row = area.y + 1;

    // Sky line
    const skyGlyph = state.sky === 'night' ? ic.moon : state.sky === 'stormy' ? `${ic.cloud} ${ic.cloud}` : `${ic.sun} ${ic.cloud}`;
    const weatherNote = state.raining
      ? `${ic.rain} raining (you wrote a note recently)`
      : state.dry
        ? 'dry soil (no notes for 7+ days)'
        : `${state.sky} sky`;
    screen.text(ix, row++, truncate(`${skyGlyph}   ${weatherNote}`, iw), {
      fg: state.sky === 'stormy' ? theme.amber : state.sky === 'night' ? theme.cyan : theme.fgDim,
      bg: theme.panelBg
    });

    // Fence + Tulips (upcoming events)
    const sign = '[ ORTO ]';
    const fenceLeft = Math.max(4, Math.floor((iw - sign.length) / 2));
    const fenceLine = theme.box.h.repeat(fenceLeft) + sign + theme.box.h.repeat(Math.max(4, iw - fenceLeft - sign.length));
    screen.text(ix, row++, truncate(fenceLine, iw), { fg: theme.amber, bg: theme.panelBg });

    if (state.tulips.length && row + 2 < area.y + area.h) {
      let tx = ix;
      for (let i = 0; i < state.tulips.length; i++) {
        const t = state.tulips[i];
        const sel = this.focus === 'items' && i === this.itemIdx;
        const lbl = `${ic.tulip} ${truncate(t.title, 12)} `;
        if (tx + lbl.length > ix + iw) break;
        screen.text(tx, row, lbl, {
          fg: sel ? theme.bg : theme.accentSoft,
          bg: sel ? theme.accent : theme.panelBg,
          bold: sel
        });
        tx += lbl.length + 1;
      }
      row++;
    }

    // Raised beds for task plants (up to 3 rows)
    const slotW = 16;
    const perBed = Math.max(1, Math.floor((iw - 4) / slotW));
    const beds = Math.min(3, Math.max(1, Math.ceil(Math.max(1, state.plants.length) / perBed)));
    for (let b = 0; b < beds; b++) {
      if (row + 3 >= area.y + area.h - 4) break;
      const bedPlants = state.plants.slice(b * perBed, (b + 1) * perBed);
      screen.box(ix, row, iw, 3, {
        borderColor: state.dry ? theme.amber : theme.green,
        bg: theme.listBg
      });
      if (!state.plants.length && b === 0) {
        screen.text(ix + 2, row + 1, 'Add a task to plant your first seed.', { fg: theme.fgMuted, bg: theme.listBg });
      } else {
        bedPlants.forEach((p, j) => {
          const globalIdx = state.tulips.length + b * perBed + j;
          const sel = this.focus === 'items' && globalIdx === this.itemIdx;
          const glyph = ic[p.kind] || ic.sprout;
          const txt = `${glyph}${p.weedy ? ic.weeds : ' '} ${truncate(p.title, slotW - 5)}`;
          screen.text(ix + 2 + j * slotW, row + 1, txt, {
            fg: sel ? theme.bg : this._plantColor(p.kind, theme),
            bg: sel ? theme.accent : theme.listBg,
            bold: sel
          });
        });
      }
      row += 3;
    }

    // Life & paths summary line
    if (row < area.y + area.h - 3) {
      const life = [
        `${ic.butterfly} ${state.counts.notesWeek} notes/wk`,
        `${ic.bee} ${state.counts.doneToday} done today`,
        `${ic.leaf} ${state.counts.unreadFeeds} unread`,
        `${ic.rock} ${state.counts.oldSecrets} old secrets`
      ].join('   ');
      screen.text(ix, row++, truncate(life, iw), { fg: theme.fgDim, bg: theme.panelBg });
    }

    // Selected item inspector
    if (row < area.y + area.h - 2 && items[this.itemIdx]) {
      const sel = items[this.itemIdx];
      screen.text(ix, row++, truncate(`Selected: ${sel.title} (${sel.meta})  [Enter: open]`, iw), {
        fg: theme.cyan,
        bg: theme.panelBg,
        bold: true
      });
    }

    // Actionable tips
    if (row < area.y + area.h - 1) {
      screen.hline(ix, row++, iw, { fg: theme.border, bg: theme.panelBg });
      if (!state.tips.length) {
        if (row < area.y + area.h - 1) {
          screen.text(ix, row, 'Everything is thriving. Enjoy the view.', { fg: theme.green, bg: theme.panelBg });
        }
      } else {
        for (let i = 0; i < state.tips.length && row < area.y + area.h - 1; i++) {
          const tip = state.tips[i];
          const sel = this.focus === 'tips' && i === this.tipIdx;
          screen.text(ix, row++, truncate(`${sel ? '▸ ' : '• '}${tip.text} [-> ${tip.targetView}]`, iw), {
            fg: sel ? theme.accent : theme.fgDim,
            bg: sel ? theme.selectedBg : theme.panelBg,
            bold: sel
          });
        }
      }
    }
  }
}
