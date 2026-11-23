import { DEFAULT_SERVER, Orto, normalizeServer } from '../../orto.js';
import { copyToClipboard } from '../engine/clipboard.js';
import { truncate } from '../engine/screen.js';
import { drawTextInput } from '../engine/widgets.js';
import {
  DEFAULT_FREENET_NODE,
  generateFreenetSecret,
  installFreenetRuntime,
  normalizeFreenetNode,
  parseFreenetKeyInput,
  resolveFreenetIdentity
} from '../freenet.js';

export class LoginView {
  constructor({
    backend = 'server',
    server,
    freenetNode = DEFAULT_FREENET_NODE,
    freenetStore,
    offline = false,
    fnKeyMode = 'direct',
    personaIndex = 0,
    user = '',
    recentServers = [],
    locked = false,
    lockedIdentity = '',
    onSuccess,
    onQuit
  }) {
    this.locked = locked;
    this.lockedIdentity = lockedIdentity;
    this.backend = backend === 'freenet' ? 'freenet' : 'server';
    this.recentServers = recentServers.length ? [...recentServers] : [DEFAULT_SERVER];
    this.server = server || this.recentServers[0] || DEFAULT_SERVER;
    this.freenetNode = freenetNode || DEFAULT_FREENET_NODE;
    this.freenetStore = freenetStore;
    this.offline = !!offline;
    this.user = user || '';
    this.pass = '';
    this.fnKey = '';
    this.fnKeyMasked = true;
    this.fnKeyMode = fnKeyMode === 'viso-seed' ? 'viso-seed' : 'direct'; // 'direct' | 'viso-seed'
    this.fnPersonaIndex = Math.max(0, Number(personaIndex) || 0);
    this.fnPreview = '';
    this.mode = 'login'; // 'login' | 'register' (server mode only)
    // Server focus: 0=backend, 1=server, 2=user, 3=pass, 4=auth-mode, 5=submit
    // Freenet focus: 0=backend, 1=node, 2=fnKeyMode, 3=fnKey, 4=generate, 5=submit
    this.focus = locked ? (this.backend === 'freenet' ? 3 : 3) : (this.backend === 'freenet' ? 3 : (this.user ? 3 : 2));
    this.busy = false;
    this.error = '';
    this.info = locked ? 'Session locked due to inactivity or manual lock.' : '';
    this.onSuccess = onSuccess;
    this.onQuit = onQuit;
  }

  _toggleBackend() {
    if (this.locked) return;
    this.backend = this.backend === 'server' ? 'freenet' : 'server';
    this.error = '';
    this.info = this.backend === 'freenet'
      ? 'Use Direct Ed25519 key or Viso Master Seed (←/→ or Ctrl+V to switch).'
      : '';
    if (this.backend === 'freenet' && this.focus === 2) this.focus = 3;
    if (this.backend === 'server' && this.focus === 2 && this.user) this.focus = 3;
  }

  _toggleFnKeyMode(target = null) {
    if (this.locked || this.backend !== 'freenet') return;
    this.fnKeyMode = target || (this.fnKeyMode === 'direct' ? 'viso-seed' : 'direct');
    this.error = '';
    this.info = this.fnKeyMode === 'viso-seed'
      ? `Viso Seed mode (#${this.fnPersonaIndex}): derives persona + Orto delegated app key.`
      : 'Direct Ed25519 mode: uses 64-hex Orto keypair or Viso session JSON.';
    void this._refreshFnPreview();
  }

  _cycleServer(dir) {
    if (this.locked || this.backend !== 'server' || !this.recentServers.length) return;
    const idx = this.recentServers.indexOf(this.server);
    const nextIdx = idx < 0 ? 0 : (idx + dir + this.recentServers.length) % this.recentServers.length;
    this.server = this.recentServers[nextIdx];
  }

  _nextFocus(delta) {
    const order = this.locked
      ? [3, 5]
      : [0, 1, 2, 3, 4, 5];
    const idx = Math.max(0, order.indexOf(this.focus));
    this.focus = order[(idx + delta + order.length) % order.length];
  }

  async _refreshFnPreview() {
    const raw = this.fnKey.trim();
    if (!raw) {
      this.fnPreview = '';
      return;
    }
    try {
      const parsed = parseFreenetKeyInput(raw);
      if (!this.locked && parsed.detectedKind === 'viso-seed' && this.fnKeyMode !== 'viso-seed') {
        this.fnKeyMode = 'viso-seed';
      }
      const id = await resolveFreenetIdentity(raw, {
        keyMode: this.fnKeyMode === 'viso-seed' ? 'viso-seed' : 'auto',
        personaIndex: this.fnPersonaIndex
      });
      if (this.fnKey.trim() === raw) {
        if (id.kind === 'viso-seed' || id.kind === 'viso-session') {
          const tag = id.kind === 'viso-session' ? 'Viso Session' : `Viso #${id.personaIndex ?? 0}`;
          this.fnPreview = `${tag} · Persona ${id.persona.slice(0, 10)}… · App ${id.username}`;
        } else {
          this.fnPreview = `Direct · ${id.username} (Persona: ${id.persona.slice(0, 10)}…)`;
        }
        this.onRedraw?.();
      }
    } catch (_) {
      if (this.fnKey.trim() === raw) {
        this.fnPreview = '';
      }
    }
  }

  async _generateKey() {
    if (this.locked || this.busy || this.backend !== 'freenet') return;
    const sk = generateFreenetSecret();
    this.fnKeyMode = 'direct';
    this.fnKey = sk;
    this.error = '';
    copyToClipboard(sk, { clearAfterMs: 30000, stdout: process.stdout });
    await this._refreshFnPreview();
    this.info = 'Generated new 64-hex direct key & copied to clipboard (30s) — save it!';
    this.focus = 5;
  }

  async _tryDemo() {
    if (this.locked || this.busy || this.backend !== 'server') return;
    this.error = '';
    this.info = 'Checking server for demo account...';
    try {
      const s = normalizeServer(this.server);
      const r = await fetch(s + '/api/config');
      const cfg = await r.json().catch(() => ({}));
      if (cfg?.demo?.user && cfg?.demo?.pass) {
        this.user = cfg.demo.user;
        this.pass = cfg.demo.pass;
        this.mode = 'login';
        this.info = `Demo account filled (${cfg.demo.user})`;
        await this._submit();
      } else {
        this.info = '';
        this.error = 'Demo mode is not enabled on this server.';
      }
    } catch (e) {
      this.info = '';
      this.error = e.message || 'Could not contact server';
    }
  }

  async _submit() {
    if (this.busy) return;
    this.error = '';

    if (this.backend === 'freenet') {
      if (!this.fnKey.trim()) {
        this.error = this.fnKeyMode === 'viso-seed'
          ? 'Paste your 64-hex Viso master seed or backup file.'
          : 'Paste your 64-hex Ed25519 secret key (or press Ctrl+G to generate one).';
        return;
      }
      this.busy = true;
      this.info = this.fnKeyMode === 'viso-seed'
        ? 'Deriving Viso persona & delegated Orto keys...'
        : 'Deriving Ed25519 identity & AES-GCM keys...';
      this.onRedraw?.();
      try {
        const parsed = parseFreenetKeyInput(this.fnKey);
        if (!this.locked && parsed.detectedKind === 'viso-seed' && this.fnKeyMode !== 'viso-seed') {
          this.fnKeyMode = 'viso-seed';
        }
        const id = await resolveFreenetIdentity(this.fnKey, {
          keyMode: this.fnKeyMode === 'viso-seed' ? 'viso-seed' : 'auto',
          personaIndex: this.fnPersonaIndex
        });
        if (this.locked && this.lockedIdentity && id.username !== this.lockedIdentity) {
          throw new Error(`Key belongs to ${id.username}, expected ${this.lockedIdentity}.`);
        }
        const node = normalizeFreenetNode(this.freenetNode);
        const freenetRuntime = installFreenetRuntime({
          storePath: this.freenetStore,
          nodeUrl: node,
          connectNode: !this.offline
        });
        const client = new Orto({ mode: 'freenet' });
        await client.login(id.username, id.password, { delegation: id.delegation || null });
        this.fnKey = '';
        this.fnPreview = '';
        this.busy = false;
        this.info = '';
        await this.onSuccess({
          client,
          mode: 'freenet',
          freenetNode: node,
          freenetRuntime,
          freenetIdentity: {
            kind: id.kind,
            pubHex: id.pubHex,
            persona: id.persona,
            personaHex: id.personaHex || id.pubHex,
            personaIndex: id.personaIndex ?? null,
            secretHex: id.secretHex,
            hasDelegation: !!id.delegation
          },
          username: id.username
        });
      } catch (e) {
        this.busy = false;
        this.info = '';
        this.error = e.message || 'Invalid Freenet key';
      }
      return;
    }

    if (!this.user.trim() || !this.pass) {
      this.error = 'Username and password are required.';
      return;
    }
    this.busy = true;
    this.info = 'Deriving keys (PBKDF2 210k)...';
    this.onRedraw?.();

    try {
      const srv = normalizeServer(this.server);
      const client = new Orto({ server: srv });
      await client.login(this.user.trim(), this.pass, { create: this.mode === 'register' });
      this.pass = '';
      this.busy = false;
      this.info = '';
      await this.onSuccess({
        client,
        mode: 'server',
        server: srv,
        username: client.username
      });
    } catch (e) {
      this.busy = false;
      this.info = '';
      if (e.status === 404) {
        this.error = 'Unknown user. Switch Mode to Register to create it.';
      } else if (e.status === 401) {
        this.error = 'Wrong password.';
      } else if (e.status === 409) {
        this.error = 'Username already exists. Switch Mode to Login.';
      } else {
        this.error = e.message || 'Login failed';
      }
    }
  }

  async handleKey(ev) {
    if (this.busy) return false;
    if (ev.ctrl && ev.name === 'c') {
      this.onQuit?.();
      return true;
    }
    if (ev.ctrl && ev.name === 'f') {
      this._toggleBackend();
      return true;
    }
    if (ev.ctrl && ev.name === 'v' && this.backend === 'freenet') {
      this._toggleFnKeyMode();
      return true;
    }
    if (ev.ctrl && ev.name === 'g' && this.backend === 'freenet') {
      await this._generateKey();
      return true;
    }
    if (ev.ctrl && ev.name === 'e' && this.backend === 'freenet') {
      this.fnKeyMasked = !this.fnKeyMasked;
      return true;
    }
    if (ev.ctrl && ev.name === 'd') {
      await this._tryDemo();
      return true;
    }
    if (ev.ctrl && ev.name === 'r') {
      this._cycleServer(1);
      return true;
    }

    if (ev.name === 'tab' || ev.name === 'down') {
      this._nextFocus(ev.shift && ev.name === 'tab' ? -1 : 1);
      return true;
    }
    if (ev.name === 'up') {
      this._nextFocus(-1);
      return true;
    }

    if (ev.name === 'enter') {
      if (this.focus === 0 && !this.locked) {
        this._toggleBackend();
        return true;
      }
      if (this.backend === 'freenet' && this.focus === 2 && !this.locked) {
        this._toggleFnKeyMode();
        return true;
      }
      if (this.focus === 4 && !this.locked) {
        if (this.backend === 'freenet') await this._generateKey();
        else this.mode = this.mode === 'login' ? 'register' : 'login';
        return true;
      }
      if (this.focus < 3 && !this.locked) {
        this._nextFocus(1);
        return true;
      }
      await this._submit();
      return true;
    }

    if (this.focus === 0 && !this.locked) {
      if (ev.name === 'left' || ev.name === 'right' || ev.name === 'space') {
        this._toggleBackend();
        return true;
      }
    } else if (this.focus === 1 && !this.locked) {
      if (this.backend === 'server' && (ev.name === 'left' || ev.name === 'right')) {
        this._cycleServer(ev.name === 'right' ? 1 : -1);
        return true;
      }
      const key = this.backend === 'freenet' ? 'freenetNode' : 'server';
      if (ev.name === 'backspace') { this[key] = this[key].slice(0, -1); return true; }
      if (ev.name === 'paste') { this[key] += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this[key] += ev.ch; return true; }
    } else if (this.backend === 'freenet' && this.focus === 2 && !this.locked) {
      if (ev.name === 'left' || ev.name === 'right' || ev.name === 'space') {
        this._toggleFnKeyMode();
        return true;
      }
      if (this.fnKeyMode === 'viso-seed' && (ev.ch === '+' || ev.ch === ']' || ev.ch === '=')) {
        this.fnPersonaIndex = Math.min(99, this.fnPersonaIndex + 1);
        void this._refreshFnPreview();
        return true;
      }
      if (this.fnKeyMode === 'viso-seed' && (ev.ch === '-' || ev.ch === '[')) {
        this.fnPersonaIndex = Math.max(0, this.fnPersonaIndex - 1);
        void this._refreshFnPreview();
        return true;
      }
    } else if (this.backend === 'freenet' && this.focus === 3) {
      if (ev.name === 'backspace') { this.fnKey = this.fnKey.slice(0, -1); void this._refreshFnPreview(); return true; }
      if (ev.name === 'paste') { this.fnKey += ev.paste.replace(/\r?\n/g, ''); void this._refreshFnPreview(); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.fnKey += ev.ch; void this._refreshFnPreview(); return true; }
    } else if (this.backend === 'server' && this.focus === 2 && !this.locked) {
      if (ev.name === 'backspace') { this.user = this.user.slice(0, -1); return true; }
      if (ev.name === 'paste') { this.user += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.user += ev.ch; return true; }
    } else if (this.backend === 'server' && this.focus === 3) {
      if (ev.name === 'backspace') { this.pass = this.pass.slice(0, -1); return true; }
      if (ev.name === 'paste') { this.pass += ev.paste.replace(/\r?\n/g, ''); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.pass += ev.ch; return true; }
    } else if (this.focus === 4 && !this.locked) {
      if (ev.name === 'space' || ev.name === 'left' || ev.name === 'right') {
        if (this.backend === 'freenet') await this._generateKey();
        else this.mode = this.mode === 'login' ? 'register' : 'login';
        return true;
      }
    } else if (this.focus === 5 && ev.name === 'space') {
      await this._submit();
      return true;
    }

    if (ev.name === 'escape' && !this.locked) {
      this.onQuit?.();
      return true;
    }
    return false;
  }

  render(screen, theme) {
    screen.clear(theme.bg, theme.fg);
    const boxW = Math.min(72, screen.cols - 4);
    const boxH = Math.min(22, screen.rows - 2);
    const x = Math.floor((screen.cols - boxW) / 2);
    const y = Math.floor((screen.rows - boxH) / 2);

    screen.box(x, y, boxW, boxH, {
      title: this.locked ? 'Orto · Locked' : 'Orto · Encrypted Workspace',
      borderColor: theme.borderFocus,
      bg: theme.panelBg,
      titleColor: theme.accent
    });

    const ix = x + 3;
    const iw = boxW - 6;

    screen.text(ix, y + 1, truncate('End-to-end encrypted · Choose Server or Freenet P2P', iw), { fg: theme.fgMuted, bg: theme.panelBg });

    // Backend selector
    const srvChip = this.backend === 'server' ? '● Server (HTTP)' : '○ Server (HTTP)';
    const fnChip = this.backend === 'freenet' ? '● Freenet (P2P)' : '○ Freenet (P2P)';
    screen.text(ix, y + 3, 'Backend (←/→ or Ctrl+F):', {
      fg: this.focus === 0 ? theme.accentSoft : theme.fgDim,
      bg: theme.panelBg
    });
    screen.text(ix, y + 4, ` ${srvChip} `, {
      fg: this.backend === 'server' ? theme.bg : theme.fgDim,
      bg: this.backend === 'server' ? (this.focus === 0 ? theme.accent : theme.green) : theme.selectedBg,
      bold: this.backend === 'server'
    });
    screen.text(ix + srvChip.length + 3, y + 4, ` ${fnChip} `, {
      fg: this.backend === 'freenet' ? theme.bg : theme.fgDim,
      bg: this.backend === 'freenet' ? (this.focus === 0 ? theme.accent : theme.cyan) : theme.selectedBg,
      bold: this.backend === 'freenet'
    });

    if (this.backend === 'freenet') {
      screen.text(ix, y + 6, truncate('Freenet Node WebSocket (local-first if offline)', iw), {
        fg: this.focus === 1 ? theme.accentSoft : theme.fgDim,
        bg: theme.panelBg
      });
      drawTextInput(screen, ix, y + 7, iw, this.freenetNode, this.freenetNode.length, {
        focused: this.focus === 1 && !this.locked,
        theme
      });

      const directChip = this.fnKeyMode === 'direct' ? '● Direct Ed25519' : '○ Direct Ed25519';
      const visoChip = this.fnKeyMode === 'viso-seed'
        ? `● Viso Seed (#${this.fnPersonaIndex})`
        : `○ Viso Seed (#${this.fnPersonaIndex})`;
      screen.text(ix, y + 9, truncate('Identity (←/→ or Ctrl+V · +/- index):', iw), {
        fg: this.focus === 2 ? theme.accentSoft : theme.fgDim,
        bg: theme.panelBg
      });
      screen.text(ix, y + 10, ` ${directChip} `, {
        fg: this.fnKeyMode === 'direct' ? theme.bg : theme.fgDim,
        bg: this.fnKeyMode === 'direct' ? (this.focus === 2 ? theme.accent : theme.cyan) : theme.selectedBg,
        bold: this.fnKeyMode === 'direct'
      });
      screen.text(ix + directChip.length + 3, y + 10, ` ${visoChip} `, {
        fg: this.fnKeyMode === 'viso-seed' ? theme.bg : theme.fgDim,
        bg: this.fnKeyMode === 'viso-seed' ? (this.focus === 2 ? theme.accent : theme.green) : theme.selectedBg,
        bold: this.fnKeyMode === 'viso-seed'
      });

      const keyLabel = this.locked && this.lockedIdentity
        ? `Ed25519 Secret Key to unlock ${this.lockedIdentity} (Ctrl+E show)`
        : (this.fnKeyMode === 'viso-seed'
          ? 'Viso Master Seed (64 hex or backup file · Ctrl+E show)'
          : 'Ed25519 Secret Key / Keypair (64 hex, JSON, #sk=, or file · Ctrl+E show)');
      screen.text(ix, y + 12, truncate(keyLabel, iw), {
        fg: this.focus === 3 ? theme.accentSoft : theme.fgDim,
        bg: theme.panelBg
      });
      drawTextInput(screen, ix, y + 13, iw, this.fnKey, this.fnKey.length, {
        focused: this.focus === 3,
        masked: this.fnKeyMasked,
        placeholder: this.fnKeyMode === 'viso-seed'
          ? 'Paste 64-hex Viso seed or backup file path'
          : 'Paste 64-hex secret key or press Ctrl+G to generate',
        theme
      });

      if (this.fnPreview) {
        screen.text(ix, y + 15, truncate(this.fnPreview, iw), { fg: theme.green, bg: theme.panelBg });
      } else {
        const tip = this.fnKeyMode === 'viso-seed'
          ? 'Viso SSO: same seed/persona used in web Freenet Orto finds the same vault'
          : 'Direct key: same 64-hex Orto keypair (if you used Viso on web, press Ctrl+V)';
        screen.text(ix, y + 15, truncate(tip, iw), { fg: theme.fgMuted, bg: theme.panelBg });
      }

      if (!this.locked) {
        screen.text(ix, y + 17, '[ Generate New Key (Ctrl+G) ]', {
          fg: this.focus === 4 ? theme.bg : theme.cyan,
          bg: this.focus === 4 ? theme.accent : theme.selectedBg,
          bold: this.focus === 4
        });
      }
      const submitLabel = this.busy ? ' Unlocking... ' : (this.locked ? ' [ Unlock ] ' : ' [ Open Freenet ] ');
      screen.text(ix + iw - submitLabel.length, y + 17, submitLabel, {
        fg: this.focus === 5 || this.busy ? theme.bg : theme.fg,
        bg: this.focus === 5 ? theme.accent : theme.green,
        bold: true
      });
    } else {
      screen.text(ix, y + 6, truncate('Server' + (!this.locked && this.recentServers.length > 1 ? ' (←/→ or Ctrl+R recent)' : ''), iw), {
        fg: this.focus === 1 ? theme.accentSoft : theme.fgDim,
        bg: theme.panelBg
      });
      drawTextInput(screen, ix, y + 7, iw, this.server, this.server.length, {
        focused: this.focus === 1 && !this.locked,
        theme
      });

      screen.text(ix, y + 9, 'Username', {
        fg: this.focus === 2 ? theme.accentSoft : theme.fgDim,
        bg: theme.panelBg
      });
      drawTextInput(screen, ix, y + 10, iw, this.user, this.user.length, {
        focused: this.focus === 2 && !this.locked,
        placeholder: 'alice',
        theme
      });

      screen.text(ix, y + 12, 'Password', {
        fg: this.focus === 3 ? theme.accentSoft : theme.fgDim,
        bg: theme.panelBg
      });
      drawTextInput(screen, ix, y + 13, iw, this.pass, this.pass.length, {
        focused: this.focus === 3,
        masked: true,
        placeholder: '••••••••',
        theme
      });

      if (!this.locked) {
        const modeText = this.mode === 'register' ? '[ Register new account ]' : '[ Login ]';
        screen.text(ix, y + 17, modeText, {
          fg: this.focus === 4 ? theme.bg : theme.fgDim,
          bg: this.focus === 4 ? theme.accent : theme.selectedBg,
          bold: this.focus === 4
        });
      }
      const submitLabel = this.busy ? ' Unlocking... ' : (this.locked ? ' [ Unlock ] ' : ' [ Connect ] ');
      screen.text(ix + iw - submitLabel.length, y + 17, submitLabel, {
        fg: this.focus === 5 || this.busy ? theme.bg : theme.fg,
        bg: this.focus === 5 ? theme.accent : theme.green,
        bold: true
      });
    }

    if (this.error) {
      screen.text(ix, y + 19, truncate(this.error, iw), { fg: theme.danger, bg: theme.panelBg, bold: true });
    } else if (this.info) {
      screen.text(ix, y + 19, truncate(this.info, iw), { fg: theme.amber, bg: theme.panelBg });
    }

    const hint = this.locked
      ? 'Enter: unlock  ·  Ctrl+C: quit'
      : (this.backend === 'freenet'
        ? 'Tab: field · Ctrl+V: Direct/Viso · Ctrl+G: gen · Ctrl+E: show · Enter: open'
        : 'Tab/↑↓: field · Ctrl+F: Freenet · Ctrl+D: demo · Enter: submit');
    screen.text(ix, y + boxH - 2, truncate(hint, iw), { fg: theme.fgMuted, bg: theme.panelBg });
  }
}
