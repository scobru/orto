const PALETTES = {
  dark: {
    name: 'dark',
    bg: '#14161b',
    sidebarBg: '#14161b',
    listBg: '#1b1d23',
    panelBg: '#20232a',
    selectedBg: '#2a2e39',
    hoverBg: '#252832',
    border: '#2c303a',
    borderFocus: '#c4532f',
    accent: '#c4532f',
    accentSoft: '#e07a5f',
    green: '#4f8f2f',
    amber: '#e0a020',
    cyan: '#00b4d8',
    danger: '#e05252',
    fg: '#f2f4f7',
    fgDim: '#a2a8b4',
    fgMuted: '#7d8492',
    badgeBg: '#2c303a'
  },
  light: {
    name: 'light',
    bg: '#f8f9fb',
    sidebarBg: '#1b1d22',
    listBg: '#f8f9fb',
    panelBg: '#ffffff',
    selectedBg: '#eef1f5',
    hoverBg: '#f3f5f8',
    border: '#d8dce3',
    borderFocus: '#c4532f',
    accent: '#c4532f',
    accentSoft: '#a8431f',
    green: '#3f7a24',
    amber: '#b87b00',
    cyan: '#0088a8',
    danger: '#c43131',
    fg: '#1a1d23',
    fgDim: '#535863',
    fgMuted: '#767d89',
    badgeBg: '#e6e8ec'
  }
};

const ANSI16_MAP = {
  // Dark
  '#14161b': { fg: 30, bg: 40 },
  '#1b1d23': { fg: 30, bg: 40 },
  '#20232a': { fg: 30, bg: 40 },
  '#2a2e39': { fg: 90, bg: 100 },
  '#252832': { fg: 90, bg: 100 },
  '#2c303a': { fg: 90, bg: 100 },
  // Light
  '#f8f9fb': { fg: 97, bg: 107 },
  '#1b1d22': { fg: 30, bg: 40 },
  '#ffffff': { fg: 97, bg: 107 },
  '#eef1f5': { fg: 37, bg: 47 },
  '#f3f5f8': { fg: 37, bg: 47 },
  '#d8dce3': { fg: 37, bg: 47 },
  '#e6e8ec': { fg: 37, bg: 47 },
  '#1a1d23': { fg: 30, bg: 40 },
  '#535863': { fg: 90, bg: 100 },
  '#767d89': { fg: 90, bg: 100 },
  // Accents & semantics
  '#c4532f': { fg: 31, bg: 41 },
  '#e07a5f': { fg: 91, bg: 101 },
  '#a8431f': { fg: 31, bg: 41 },
  '#4f8f2f': { fg: 32, bg: 42 },
  '#3f7a24': { fg: 32, bg: 42 },
  '#e0a020': { fg: 33, bg: 43 },
  '#b87b00': { fg: 33, bg: 43 },
  '#00b4d8': { fg: 36, bg: 46 },
  '#0088a8': { fg: 36, bg: 46 },
  '#e05252': { fg: 91, bg: 101 },
  '#c43131': { fg: 31, bg: 41 },
  '#f2f4f7': { fg: 97, bg: 107 },
  '#a2a8b4': { fg: 37, bg: 47 },
  '#7d8492': { fg: 90, bg: 100 }
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function detectColorMode(env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.TERM === 'dumb') return 'none';
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  if (env.WT_SESSION || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty' || env.KITTY_WINDOW_ID) {
    return 'truecolor';
  }
  return 'ansi16';
}

export function fgSeq(color, mode = 'truecolor') {
  if (!color || mode === 'none') return '';
  if (mode === 'truecolor') {
    const rgb = hexToRgb(color);
    if (rgb) return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  }
  const hit = ANSI16_MAP[String(color).toLowerCase()];
  return hit ? String(hit.fg) : '39';
}

export function bgSeq(color, mode = 'truecolor') {
  if (!color || mode === 'none') return '';
  if (mode === 'truecolor') {
    const rgb = hexToRgb(color);
    if (rgb) return `48;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  }
  const hit = ANSI16_MAP[String(color).toLowerCase()];
  return hit ? String(hit.bg) : '49';
}

export function boxChars(ascii = false) {
  if (ascii) {
    return { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', lt: '+', rt: '+', tt: '+', bt: '+', cross: '+' };
  }
  return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', lt: '├', rt: '┤', tt: '┬', bt: '┴', cross: '┼' };
}

export function resolveTheme(name = 'dark', { colorMode = detectColorMode(), ascii = false } = {}) {
  const base = PALETTES[name === 'light' ? 'light' : 'dark'];
  return {
    ...base,
    colorMode,
    ascii: !!ascii,
    box: boxChars(!!ascii)
  };
}
