const CSI_KEY_MAP = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab'
};

const TILDE_MAP = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12'
};

const SS3_MAP = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4'
};

function decodeMod(modNum) {
  const m = Math.max(0, (modNum || 1) - 1);
  return {
    shift: !!(m & 1),
    alt: !!(m & 2),
    ctrl: !!(m & 4)
  };
}

export function parseKeySequence(input) {
  const str = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  const events = [];
  let i = 0;

  while (i < str.length) {
    const ch = str[i];

    // Bracketed paste
    if (str.startsWith('\x1b[200~', i)) {
      const end = str.indexOf('\x1b[201~', i + 6);
      if (end !== -1) {
        events.push({ name: 'paste', ch: '', ctrl: false, alt: false, shift: false, paste: str.slice(i + 6, end) });
        i = end + 6;
        continue;
      }
    }

    // ESC sequences
    if (ch === '\x1b') {
      if (i + 1 >= str.length) {
        events.push({ name: 'escape', ch: '', ctrl: false, alt: false, shift: false });
        i++;
        continue;
      }
      const next = str[i + 1];

      // CSI: ESC [
      if (next === '[') {
        // SGR mouse: ESC [ < b ; x ; y (M|m) -> skip safely or emit mouse
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(str.slice(i));
        if (mouse) {
          const btn = parseInt(mouse[1], 10);
          events.push({
            name: 'mouse',
            ch: '',
            ctrl: !!(btn & 16),
            alt: !!(btn & 8),
            shift: !!(btn & 4),
            button: btn & 3,
            scroll: btn === 64 ? 'up' : btn === 65 ? 'down' : null,
            x: parseInt(mouse[2], 10) - 1,
            y: parseInt(mouse[3], 10) - 1,
            release: mouse[4] === 'm'
          });
          i += mouse[0].length;
          continue;
        }

        const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(str.slice(i));
        if (csi) {
          const params = csi[1] ? csi[1].split(';').map((n) => parseInt(n, 10) || 0) : [];
          const final = csi[2];
          if (final === '~') {
            const name = TILDE_MAP[params[0]] || 'unknown';
            const mod = decodeMod(params[1]);
            events.push({ name, ch: '', ...mod });
          } else if (final === 'Z') {
            events.push({ name: 'tab', ch: '', ctrl: false, alt: false, shift: true });
          } else if (CSI_KEY_MAP[final]) {
            const mod = decodeMod(params[1]);
            events.push({ name: CSI_KEY_MAP[final], ch: '', ...mod });
          } else if (final >= 'P' && final <= 'S') {
            const mod = decodeMod(params[1]);
            events.push({ name: SS3_MAP[final], ch: '', ...mod });
          }
          i += csi[0].length;
          continue;
        }
      }

      // SS3: ESC O
      if (next === 'O' && i + 2 < str.length && SS3_MAP[str[i + 2]]) {
        events.push({ name: SS3_MAP[str[i + 2]], ch: '', ctrl: false, alt: false, shift: false });
        i += 3;
        continue;
      }

      // Alt + char
      if (next >= ' ' && next !== '\x7f') {
        events.push({
          name: next.toLowerCase(),
          ch: next,
          ctrl: false,
          alt: true,
          shift: next >= 'A' && next <= 'Z'
        });
        i += 2;
        continue;
      }

      events.push({ name: 'escape', ch: '', ctrl: false, alt: false, shift: false });
      i++;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (ch === '\r' || ch === '\n') {
      events.push({ name: 'enter', ch: '', ctrl: false, alt: false, shift: false });
      i++;
    } else if (ch === '\t') {
      events.push({ name: 'tab', ch: '\t', ctrl: false, alt: false, shift: false });
      i++;
    } else if (code === 0x7f || code === 0x08) {
      events.push({ name: 'backspace', ch: '', ctrl: false, alt: false, shift: false });
      i++;
    } else if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(code + 96);
      events.push({ name: letter, ch: '', ctrl: true, alt: false, shift: false });
      i++;
    } else if (code === 0) {
      events.push({ name: 'space', ch: ' ', ctrl: true, alt: false, shift: false });
      i++;
    } else {
      // Handle surrogate pairs / multi-codepoint chars
      const cp = str.codePointAt(i);
      const glyph = String.fromCodePoint(cp);
      const isUpper = glyph.length === 1 && glyph >= 'A' && glyph <= 'Z';
      events.push({
        name: glyph === ' ' ? 'space' : glyph,
        ch: glyph,
        ctrl: false,
        alt: false,
        shift: isUpper
      });
      i += glyph.length;
    }
  }

  return events;
}

export function attachInput(stdin, onKey) {
  let active = true;
  let pendingEscTimer = null;
  let pendingBuf = '';

  const flushPending = () => {
    if (pendingEscTimer) {
      clearTimeout(pendingEscTimer);
      pendingEscTimer = null;
    }
    if (!pendingBuf) return;
    const buf = pendingBuf;
    pendingBuf = '';
    for (const ev of parseKeySequence(buf)) {
      if (active) onKey(ev);
    }
  };

  const onData = (chunk) => {
    if (!active) return;
    const text = pendingBuf + chunk.toString('utf8');
    pendingBuf = '';
    if (pendingEscTimer) {
      clearTimeout(pendingEscTimer);
      pendingEscTimer = null;
    }

    // Wait briefly if chunk ends with lone ESC or incomplete bracketed paste
    if (text === '\x1b' || (text.startsWith('\x1b[200~') && !text.includes('\x1b[201~'))) {
      pendingBuf = text;
      pendingEscTimer = setTimeout(flushPending, text === '\x1b' ? 25 : 80);
      pendingEscTimer.unref?.();
      return;
    }

    for (const ev of parseKeySequence(text)) {
      if (active) onKey(ev);
    }
  };

  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.on('data', onData);

  return {
    pause() {
      active = false;
      flushPending();
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(false); } catch (_) {}
      }
      stdin.pause();
    },
    resume() {
      active = true;
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(true); } catch (_) {}
      }
      stdin.resume();
    },
    destroy() {
      active = false;
      if (pendingEscTimer) {
        clearTimeout(pendingEscTimer);
        pendingEscTimer = null;
      }
      stdin.off('data', onData);
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(false); } catch (_) {}
      }
    }
  };
}
