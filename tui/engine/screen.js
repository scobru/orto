import { fgSeq, bgSeq, resolveTheme } from './theme.js';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const ZERO_WIDTH_RE = /^[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f]+$/;
const COMBINING_RE = /\p{Mark}/u;
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u;

function isFullWidthCodePoint(cp) {
  return (
    cp >= 0x1100 && (
      cp <= 0x115f ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1b000 && cp <= 0x1b001) ||
      (cp >= 0x1f200 && cp <= 0x1f251) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )
  );
}

export function graphemeWidth(g) {
  if (!g || ZERO_WIDTH_RE.test(g)) return 0;
  // Single combining mark without base
  const cps = [...g];
  if (cps.length === 1 && COMBINING_RE.test(g)) return 0;
  if (EMOJI_RE.test(g) || g.includes('\uFE0F')) {
    // Common BMP symbol icons without emoji presentation unless VS16 present
    const cp = g.codePointAt(0);
    if (cp < 0x1f000 && !g.includes('\uFE0F')) {
      // e.g. ★ ● ✓ × ▸ are width 1 in terminals
      return isFullWidthCodePoint(cp) ? 2 : 1;
    }
    return 2;
  }
  const cp = g.codePointAt(0);
  return isFullWidthCodePoint(cp) ? 2 : 1;
}

export function splitGraphemes(str) {
  const s = String(str ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, '  ');
  const out = [];
  for (const { segment } of segmenter.segment(s)) {
    out.push(segment);
  }
  return out;
}

export function stringWidth(str) {
  let w = 0;
  for (const g of splitGraphemes(str)) w += graphemeWidth(g);
  return w;
}

export function sliceByWidth(str, maxW) {
  if (maxW <= 0) return '';
  let out = '';
  let w = 0;
  for (const g of splitGraphemes(str)) {
    const gw = graphemeWidth(g);
    if (w + gw > maxW) break;
    out += g;
    w += gw;
  }
  return out;
}

export function truncate(str, maxW, ellipsis = '…') {
  if (maxW <= 0) return '';
  const s = String(str ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, '  ');
  if (stringWidth(s) <= maxW) return s;
  const ew = stringWidth(ellipsis);
  if (maxW <= ew) return sliceByWidth(ellipsis, maxW);
  return sliceByWidth(s, maxW - ew) + ellipsis;
}

export function wrapText(str, maxW) {
  const w = Math.max(1, maxW);
  const rawLines = String(str ?? '').split(/\r?\n/);
  const out = [];
  for (const raw of rawLines) {
    if (!raw) { out.push(''); continue; }
    let line = '';
    let lw = 0;
    const words = raw.split(/(\s+)/);
    for (const tok of words) {
      if (!tok) continue;
      const tw = stringWidth(tok);
      if (lw + tw <= w) {
        line += tok;
        lw += tw;
      } else if (tw > w) {
        if (line.trimEnd()) { out.push(line.trimEnd()); line = ''; lw = 0; }
        for (const g of splitGraphemes(tok)) {
          const gw = graphemeWidth(g);
          if (lw + gw > w) { out.push(line); line = ''; lw = 0; }
          line += g;
          lw += gw;
        }
      } else {
        out.push(line.trimEnd());
        line = tok.trimStart();
        lw = stringWidth(line);
      }
    }
    if (line || !words.length) out.push(line.trimEnd());
  }
  return out;
}

function makeCell(ch = ' ', style = {}) {
  return {
    ch,
    fg: style.fg || '',
    bg: style.bg || '',
    bold: !!style.bold,
    dim: !!style.dim,
    italic: !!style.italic,
    underline: !!style.underline,
    inverse: !!style.inverse,
    wide: !!style.wide,
    cont: !!style.cont
  };
}

function sameCell(a, b) {
  return a.ch === b.ch
    && a.fg === b.fg
    && a.bg === b.bg
    && a.bold === b.bold
    && a.dim === b.dim
    && a.italic === b.italic
    && a.underline === b.underline
    && a.inverse === b.inverse
    && a.cont === b.cont;
}

function styleKey(c) {
  return `${c.fg}|${c.bg}|${c.bold ? 1 : 0}${c.dim ? 1 : 0}${c.italic ? 1 : 0}${c.underline ? 1 : 0}${c.inverse ? 1 : 0}`;
}

function sgrFor(c, mode) {
  if (mode === 'none') {
    const codes = ['0'];
    if (c.bold) codes.push('1');
    if (c.dim) codes.push('2');
    if (c.underline) codes.push('4');
    if (c.inverse) codes.push('7');
    return `\x1b[${codes.join(';')}m`;
  }
  const codes = ['0'];
  if (c.bold) codes.push('1');
  if (c.dim) codes.push('2');
  if (c.italic) codes.push('3');
  if (c.underline) codes.push('4');
  if (c.inverse) codes.push('7');
  const fg = fgSeq(c.fg, mode);
  const bg = bgSeq(c.bg, mode);
  if (fg) codes.push(fg);
  if (bg) codes.push(bg);
  return `\x1b[${codes.join(';')}m`;
}

export class Screen {
  constructor(cols = 80, rows = 24, theme = resolveTheme('dark')) {
    this.cols = Math.max(10, cols);
    this.rows = Math.max(5, rows);
    this.theme = theme;
    this.cursor = { x: 0, y: 0, visible: false };
    this._alloc();
  }

  _alloc() {
    const n = this.cols * this.rows;
    this.prev = new Array(n);
    this.next = new Array(n);
    for (let i = 0; i < n; i++) {
      this.prev[i] = makeCell(' ', { __dirty: true });
      this.prev[i].ch = '\u0000'; // force initial paint
      this.next[i] = makeCell(' ', { fg: this.theme.fg, bg: this.theme.bg });
    }
  }

  resize(cols, rows) {
    const nc = Math.max(10, cols);
    const nr = Math.max(5, rows);
    if (nc === this.cols && nr === this.rows) return;
    this.cols = nc;
    this.rows = nr;
    this._alloc();
  }

  invalidate() {
    for (let i = 0; i < this.prev.length; i++) {
      this.prev[i].ch = '\u0000';
    }
  }

  setCursor(x, y, visible = true) {
    this.cursor = {
      x: Math.max(0, Math.min(this.cols - 1, Math.floor(x))),
      y: Math.max(0, Math.min(this.rows - 1, Math.floor(y))),
      visible: !!visible
    };
  }

  clear(bg = this.theme.bg, fg = this.theme.fg) {
    for (let i = 0; i < this.next.length; i++) {
      const c = this.next[i];
      c.ch = ' ';
      c.fg = fg;
      c.bg = bg;
      c.bold = false;
      c.dim = false;
      c.italic = false;
      c.underline = false;
      c.inverse = false;
      c.wide = false;
      c.cont = false;
    }
  }

  put(x, y, ch = ' ', style = {}) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return 0;
    const gw = graphemeWidth(ch);
    if (gw === 0) return 0;
    const idx = y * this.cols + x;
    const prevCell = this.next[idx];
    // If overwriting right half of a wide char, clear its left half
    if (prevCell.cont && x > 0) {
      const left = this.next[idx - 1];
      left.ch = ' ';
      left.wide = false;
    }
    if (gw === 2 && x + 1 >= this.cols) {
      this.next[idx] = makeCell(' ', { fg: style.fg ?? prevCell.fg, bg: style.bg ?? prevCell.bg });
      return 1;
    }
    this.next[idx] = makeCell(ch, {
      fg: style.fg ?? this.theme.fg,
      bg: style.bg ?? prevCell.bg,
      bold: style.bold,
      dim: style.dim,
      italic: style.italic,
      underline: style.underline,
      inverse: style.inverse,
      wide: gw === 2
    });
    if (gw === 2) {
      this.next[idx + 1] = makeCell('', {
        fg: style.fg ?? this.theme.fg,
        bg: style.bg ?? prevCell.bg,
        bold: style.bold,
        dim: style.dim,
        italic: style.italic,
        underline: style.underline,
        inverse: style.inverse,
        cont: true
      });
    } else if (x + 1 < this.cols && this.next[idx + 1].cont) {
      this.next[idx + 1] = makeCell(' ', { fg: this.theme.fg, bg: prevCell.bg });
    }
    return gw;
  }

  text(x, y, str, style = {}, maxW = this.cols - x) {
    if (y < 0 || y >= this.rows || maxW <= 0) return 0;
    let cx = x;
    let used = 0;
    for (const g of splitGraphemes(str)) {
      const gw = graphemeWidth(g);
      if (gw === 0) continue;
      if (used + gw > maxW) break;
      if (cx >= 0 && cx < this.cols) {
        this.put(cx, y, g, style);
      }
      cx += gw;
      used += gw;
    }
    return used;
  }

  fill(x, y, w, h, ch = ' ', style = {}) {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.cols, x + w), y1 = Math.min(this.rows, y + h);
    for (let row = y0; row < y1; row++) {
      for (let col = x0; col < x1; col++) {
        this.put(col, row, ch, style);
      }
    }
  }

  hline(x, y, w, style = {}, ch = this.theme.box.h) {
    if (y < 0 || y >= this.rows) return;
    for (let i = 0; i < w; i++) this.put(x + i, y, ch, style);
  }

  vline(x, y, h, style = {}, ch = this.theme.box.v) {
    if (x < 0 || x >= this.cols) return;
    for (let i = 0; i < h; i++) this.put(x, y + i, ch, style);
  }

  box(x, y, w, h, opts = {}) {
    if (w < 2 || h < 2) return;
    const b = this.theme.box;
    const bg = opts.bg ?? this.theme.panelBg;
    const borderFg = opts.borderColor ?? this.theme.border;
    const borderStyle = { fg: borderFg, bg };
    if (opts.fill !== false) this.fill(x, y, w, h, ' ', { fg: this.theme.fg, bg });

    this.put(x, y, b.tl, borderStyle);
    this.hline(x + 1, y, w - 2, borderStyle, b.h);
    this.put(x + w - 1, y, b.tr, borderStyle);

    for (let row = 1; row < h - 1; row++) {
      this.put(x, y + row, b.v, borderStyle);
      this.put(x + w - 1, y + row, b.v, borderStyle);
    }

    this.put(x, y + h - 1, b.bl, borderStyle);
    this.hline(x + 1, y + h - 1, w - 2, borderStyle, b.h);
    this.put(x + w - 1, y + h - 1, b.br, borderStyle);

    if (opts.title && w > 4) {
      const t = ' ' + truncate(opts.title, w - 6) + ' ';
      this.text(x + 2, y, t, { fg: opts.titleColor ?? this.theme.fg, bg, bold: true });
    }
    if (opts.rightTitle && w > 8) {
      const rt = ' ' + truncate(opts.rightTitle, Math.floor(w / 2)) + ' ';
      const rw = stringWidth(rt);
      this.text(x + w - 2 - rw, y, rt, { fg: opts.rightTitleColor ?? this.theme.fgDim, bg });
    }
  }

  render(stream = null) {
    const mode = this.theme.colorMode;
    let out = '';
    let lastStyle = '';

    for (let y = 0; y < this.rows; y++) {
      let x = 0;
      while (x < this.cols) {
        const idx = y * this.cols + x;
        const c = this.next[idx];
        const p = this.prev[idx];
        if (c.cont || sameCell(c, p)) {
          x++;
          continue;
        }
        out += `\x1b[${y + 1};${x + 1}H`;
        while (x < this.cols) {
          const ci = y * this.cols + x;
          const nc = this.next[ci];
          const pc = this.prev[ci];
          if (nc.cont) {
            this.prev[ci] = { ...nc };
            x++;
            continue;
          }
          if (sameCell(nc, pc)) break;
          const sk = styleKey(nc);
          if (sk !== lastStyle) {
            out += sgrFor(nc, mode);
            lastStyle = sk;
          }
          out += nc.ch;
          this.prev[ci] = { ...nc };
          if (nc.wide && x + 1 < this.cols) {
            this.prev[ci + 1] = { ...this.next[ci + 1] };
            x += 2;
          } else {
            x += 1;
          }
        }
      }
    }

    if (out) {
      out = `\x1b[?2026h${out}\x1b[0m`;
      if (this.cursor.visible) {
        out += `\x1b[${this.cursor.y + 1};${this.cursor.x + 1}H\x1b[?25h`;
      } else {
        out += `\x1b[?25l`;
      }
      out += `\x1b[?2026l`;
    } else if (this.cursor.visible) {
      out = `\x1b[${this.cursor.y + 1};${this.cursor.x + 1}H\x1b[?25h`;
    }

    if (stream && out) stream.write(out);
    return out;
  }
}
