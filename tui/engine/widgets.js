import { sliceByWidth, stringWidth, truncate, wrapText } from './screen.js';

export function extractTags(text) {
  if (!text) return [];
  const cleaned = String(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\r\n]+`/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/#orto-file=[a-zA-Z0-9_-]+/g, '');
  const seen = new Map();
  const re = /(^|[\s(])#([a-zA-Z0-9_/-]{1,40})/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const tag = m[2].replace(/\/+$/, '');
    if (!tag) continue;
    const low = tag.toLowerCase();
    if (!seen.has(low)) seen.set(low, tag);
  }
  return [...seen.values()];
}

export function extractWikiLinks(text) {
  if (!text) return [];
  const cleaned = String(text).replace(/```[\s\S]*?```/g, '').replace(/`[^`\r\n]+`/g, '');
  const seen = new Map();
  const re = /\[\[([^\[\]\r\n]+?)\]\]/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const inner = m[1];
    const pipe = inner.indexOf('|');
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    if (!target) continue;
    const label = (pipe >= 0 ? inner.slice(pipe + 1).trim() : '') || target;
    const key = target.toLowerCase();
    if (!seen.has(key)) seen.set(key, { target, label });
  }
  return [...seen.values()];
}

export function parseChecklists(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*[-*]\s+\[)([ xX])(\]\s*)(.*)$/.exec(lines[i]);
    if (m) {
      items.push({ lineIndex: i, done: m[2].toLowerCase() === 'x', text: m[4] });
    }
  }
  return items;
}

export function toggleChecklistLine(body, lineIndex) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return String(body ?? '');
  const m = /^(\s*[-*]\s+\[)([ xX])(\]\s*.*)$/.exec(lines[lineIndex]);
  if (!m) return String(body ?? '');
  const nextMark = m[2].toLowerCase() === 'x' ? ' ' : 'x';
  lines[lineIndex] = `${m[1]}${nextMark}${m[3]}`;
  return lines.join('\n');
}

function styleInlineSegments(line, theme, baseStyle) {
  const segs = [];
  const tokenRe = /(\[\[[^\[\]\r\n]+?\]\]|`[^`\r\n]+`|\*\*[^*\r\n]+\*\*|\[[^\]]+\]\(#orto-file=[^)]+\)|(^|\s)#[a-zA-Z0-9_/-]{1,40})/g;
  let last = 0;
  let m;
  while ((m = tokenRe.exec(line)) !== null) {
    let idx = m.index;
    let tok = m[0];
    if (m[2] !== undefined && m[2].length > 0) {
      idx += m[2].length;
      tok = tok.slice(m[2].length);
    }
    if (idx > last) segs.push({ text: line.slice(last, idx), style: baseStyle });

    if (tok.startsWith('[[')) {
      const inner = tok.slice(2, -2);
      const pipe = inner.indexOf('|');
      const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
      segs.push({ text: `[[${label}]]`, style: { ...baseStyle, fg: theme.cyan, underline: true } });
    } else if (tok.startsWith('`')) {
      segs.push({ text: tok.slice(1, -1), style: { ...baseStyle, fg: theme.amber, bg: theme.selectedBg } });
    } else if (tok.startsWith('**')) {
      segs.push({ text: tok.slice(2, -2), style: { ...baseStyle, bold: true } });
    } else if (tok.includes('#orto-file=')) {
      const lm = /^\[([^\]]+)\]/.exec(tok);
      segs.push({ text: `[file: ${lm ? lm[1] : 'attachment'}]`, style: { ...baseStyle, fg: theme.green, bold: true } });
    } else if (tok.startsWith('#')) {
      segs.push({ text: tok, style: { ...baseStyle, fg: theme.accentSoft, bold: true } });
    }
    last = idx + tok.length;
  }
  if (last < line.length) segs.push({ text: line.slice(last), style: baseStyle });
  return segs.length ? segs : [{ text: '', style: baseStyle }];
}

export function renderMarkdownLines(body, width, theme) {
  const w = Math.max(12, width);
  const rawLines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;

  for (const raw of rawLines) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      out.push([{ text: truncate(raw.trim() || '───', w), style: { fg: theme.fgMuted, bg: theme.panelBg, dim: true } }]);
      continue;
    }
    if (inCode) {
      for (const wl of wrapText(raw, Math.max(1, w - 2))) {
        out.push([{ text: '  ' + wl, style: { fg: theme.amber, bg: theme.selectedBg } }]);
      }
      continue;
    }

    const hMatch = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (hMatch) {
      const level = hMatch[1].length;
      const color = level === 1 ? theme.accent : level === 2 ? theme.fg : theme.accentSoft;
      for (const wl of wrapText(hMatch[2], w)) {
        out.push([{ text: wl, style: { fg: color, bg: theme.panelBg, bold: true, underline: level === 1 } }]);
      }
      continue;
    }

    const cbMatch = /^(\s*)[-*]\s+\[([ xX])\]\s*(.*)$/.exec(raw);
    if (cbMatch) {
      const done = cbMatch[2].toLowerCase() === 'x';
      const prefix = cbMatch[1] + (done ? '[x] ' : '[ ] ');
      const wrapped = wrapText(cbMatch[3], Math.max(4, w - prefix.length));
      wrapped.forEach((wl, idx) => {
        const segs = [];
        if (idx === 0) {
          segs.push({
            text: prefix,
            style: { fg: done ? theme.green : theme.accent, bg: theme.panelBg, bold: true }
          });
        } else {
          segs.push({ text: ' '.repeat(prefix.length), style: { fg: theme.fg, bg: theme.panelBg } });
        }
        segs.push(...styleInlineSegments(wl, theme, { fg: done ? theme.fgMuted : theme.fg, bg: theme.panelBg, dim: done }));
        out.push(segs);
      });
      continue;
    }

    if (/^\s*>\s?/.test(raw)) {
      const inner = raw.replace(/^\s*>\s?/, '');
      for (const wl of wrapText(inner, Math.max(4, w - 2))) {
        out.push([
          { text: '│ ', style: { fg: theme.accent, bg: theme.panelBg } },
          ...styleInlineSegments(wl, theme, { fg: theme.fgDim, bg: theme.panelBg, italic: true })
        ]);
      }
      continue;
    }

    if (/^\s*---+\s*$/.test(raw)) {
      out.push([{ text: theme.box.h.repeat(Math.min(w, 40)), style: { fg: theme.border, bg: theme.panelBg } }]);
      continue;
    }

    if (!raw.trim()) {
      out.push([{ text: '', style: { fg: theme.fg, bg: theme.panelBg } }]);
      continue;
    }

    for (const wl of wrapText(raw, w)) {
      out.push(styleInlineSegments(wl, theme, { fg: theme.fg, bg: theme.panelBg }));
    }
  }
  return out;
}

export function drawStyledLine(screen, x, y, maxW, segs, defaultBg) {
  let cx = x;
  let rem = maxW;
  for (const seg of segs) {
    if (rem <= 0) break;
    const txt = sliceByWidth(seg.text, rem);
    const used = screen.text(cx, y, txt, { bg: defaultBg, ...seg.style }, rem);
    cx += used;
    rem -= used;
  }
}

export function fuzzyScore(query, text) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 1;
  const t = String(text || '').toLowerCase();
  if (!t) return 0;
  if (t === q) return 200;
  if (t.startsWith(q)) return 140;
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) return 100 - Math.min(40, subIdx);

  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += 4 + streak * 3;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : 0;
}

export function drawModal(screen, theme, { title = '', width = 60, height = 14, footer = '' } = {}) {
  const w = Math.max(24, Math.min(screen.cols - 2, width));
  const h = Math.max(7, Math.min(screen.rows - 2, height));
  const x = Math.floor((screen.cols - w) / 2);
  const y = Math.floor((screen.rows - h) / 2);
  screen.box(x, y, w, h, {
    title,
    borderColor: theme.borderFocus,
    bg: theme.panelBg,
    titleColor: theme.accent
  });
  if (footer && w > 6) {
    screen.text(x + 2, y + h - 1, ' ' + truncate(footer, w - 6) + ' ', { fg: theme.fgMuted, bg: theme.panelBg });
  }
  return { x: x + 2, y: y + 1, w: w - 4, h: h - 2 };
}

export function drawTextInput(screen, x, y, w, value, cursor, { masked = false, placeholder = '', focused = false, theme } = {}) {
  const raw = String(value ?? '');
  const shown = masked ? '•'.repeat(raw.length) : raw;
  const bg = focused ? theme.selectedBg : theme.listBg;
  screen.fill(x, y, w, 1, ' ', { fg: theme.fg, bg });

  if (!shown && placeholder && !focused) {
    screen.text(x + 1, y, truncate(placeholder, w - 2), { fg: theme.fgMuted, bg });
    return;
  }

  const innerW = Math.max(4, w - 2);
  const pos = Math.max(0, Math.min(shown.length, cursor ?? shown.length));
  const start = pos >= innerW ? pos - innerW + 1 : 0;
  const slice = shown.slice(start, start + innerW);
  screen.text(x + 1, y, slice, { fg: theme.fg, bg }, innerW);

  if (focused) {
    const cx = x + 1 + stringWidth(shown.slice(start, pos));
    if (cx < x + w - 1) {
      screen.setCursor(cx, y, true);
    }
  }
}

export function formatRelativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  const diff = Math.max(0, now - Number(ms));
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatShortDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
