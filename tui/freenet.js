import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

export const ORTO_CONTRACT_KEY = '9eBjDkH6ZXA6ehUyWBBjT6Xg4tQE4ALZjSsgXERds4yZ';
export const ORTO_APP_PATH = `/v1/contract/web/${ORTO_CONTRACT_KEY}/`;
export const ORTO_APP_SCOPE = `contract/web/${ORTO_CONTRACT_KEY}`;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const enc = new TextEncoder();

function toBase58(bytes) {
  const d = [];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < d.length; i++) {
      carry += d[i] << 8;
      d[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      d.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte) break;
    out += '1';
  }
  return out + d.reverse().map((x) => B58[x]).join('');
}

function fromBase58(str) {
  let n = 0n;
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('Invalid base58 string');
    n = n * 58n + BigInt(v);
  }
  const hex = n ? n.toString(16) : '';
  const body = hex ? hexToBytes(hex.length % 2 ? '0' + hex : hex) : new Uint8Array(0);
  const zeros = str.match(/^1*/)[0].length;
  return concatBytes(new Uint8Array(zeros), body);
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/\s+/g, '').toLowerCase();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error('Invalid hex string');
  }
  return Uint8Array.from(clean.match(/../g), (b) => parseInt(b, 16));
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function u32le(n) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, n >>> 0, true);
  return new Uint8Array(buf);
}

function u64le(n) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(n), true);
  return new Uint8Array(buf);
}

function concatBytes(...parts) {
  const len = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function importEd25519Key(secretBytes) {
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(secretBytes, 16);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
}

async function ed25519PubFromSecret(secretBytes) {
  const priv = await importEd25519Key(secretBytes);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  const pubBytes = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  return {
    priv,
    pubBytes,
    pubHex: bytesToHex(pubBytes),
    persona: toBase58(pubBytes)
  };
}

function withTimeout(promise, ms = 15000, msg = 'Freenet request timeout') {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(msg)), ms);
      t.unref?.();
    })
  ]).finally(() => clearTimeout(t));
}

export function generateFreenetSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeDelegation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const persona = typeof raw.persona === 'string' ? raw.persona.trim().toLowerCase() : '';
  const appPath = typeof raw.appPath === 'string' ? raw.appPath.trim() : '';
  const cert = raw.cert && typeof raw.cert === 'object' ? raw.cert : null;
  if (!/^[0-9a-f]{64}$/.test(persona) || !appPath || !cert) return null;
  if (typeof cert.challenge !== 'string' || typeof cert.sig !== 'string' || typeof cert.base !== 'string') return null;
  if (!/^[0-9a-f]{128}$/i.test(cert.sig)) return null;
  return {
    persona,
    appPath,
    cert: {
      base: cert.base,
      challenge: cert.challenge,
      ts: Number(cert.ts),
      sig: cert.sig.toLowerCase()
    }
  };
}

export function parseDelegationInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!s.startsWith('{') && s.length < 512) {
    try {
      if (fs.existsSync(s) && fs.statSync(s).isFile()) {
        s = fs.readFileSync(s, 'utf8').trim();
      }
    } catch (_) {}
  }
  const obj = JSON.parse(s);
  const cand = obj.delegation || (typeof obj.orto_viso_session === 'string' ? JSON.parse(obj.orto_viso_session) : obj.orto_viso_session) || obj;
  const del = normalizeDelegation(cand);
  if (!del) throw new Error('Invalid Viso delegation JSON (expected { persona, appPath, cert }).');
  return del;
}

export function parseFreenetKeyInput(raw, _depth = 0) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Freenet secret key is required (64 hex chars or keypair JSON).');

  // If it looks like a local file path, read it once
  if (_depth < 2 && !s.startsWith('{') && !/^[0-9a-f\s]{64,}$/i.test(s) && s.length < 512) {
    try {
      if (fs.existsSync(s) && fs.statSync(s).isFile()) {
        return parseFreenetKeyInput(fs.readFileSync(s, 'utf8'), 1);
      }
    } catch (_) {}
  }

  // Viso session JSON ({ orto_freenet_secret, orto_viso_session } or { secret, delegation })
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      const delSrc = obj.delegation || (typeof obj.orto_viso_session === 'string'
        ? JSON.parse(obj.orto_viso_session)
        : obj.orto_viso_session);
      const delegation = normalizeDelegation(delSrc);
      // Viso persona private key ("Export private key" in Viso), wrapped by --viso-persona
      if (typeof obj.personaSecret === 'string') {
        return { ...parseFreenetKeyInput(obj.personaSecret, _depth + 1), detectedKind: 'viso-persona' };
      }
      const cand = obj.secret || obj.secretHex || obj.sk || obj.privateKey || obj.orto_freenet_secret || obj.seed;
      if (typeof cand === 'string') {
        const res = parseFreenetKeyInput(cand, _depth + 1);
        if (typeof obj.pub === 'string' && /^[0-9a-f]{64}$/i.test(obj.pub.trim())) {
          res.expectedPubHex = obj.pub.trim().toLowerCase();
        }
        if (delegation) {
          res.delegation = delegation;
          res.detectedKind = 'viso-session';
        } else if (typeof obj.seed === 'string' && !obj.secret && !obj.secretHex && !obj.sk) {
          res.detectedKind = 'viso-seed';
        }
        return res;
      }
    } catch (_) {}
  }

  const isVisoBackup = /\bviso master seed\b/i.test(s);

  // URL fragment or query param (#sk=...)
  const skFrag = /(?:^|[#&?])sk=([0-9a-f]{64,128})/i.exec(s);
  if (skFrag) s = skFrag[1];

  const compact = s.replace(/\s+/g, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(compact)) {
    return {
      secretHex: compact,
      expectedPubHex: null,
      delegation: null,
      detectedKind: isVisoBackup ? 'viso-seed' : 'hex64'
    };
  }
  if (/^[0-9a-f]{128}$/.test(compact)) {
    return {
      secretHex: compact.slice(0, 64),
      expectedPubHex: compact.slice(64),
      delegation: null,
      detectedKind: 'hex128'
    };
  }

  // Base58 32-byte secret: only Viso's "copy base58" export produces this, so it is a persona key
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) {
    try {
      const b = fromBase58(s);
      if (b.length === 32) {
        return { secretHex: bytesToHex(b), expectedPubHex: null, delegation: null, detectedKind: 'viso-persona' };
      }
    } catch (_) {}
  }

  // Backup text file ("Orto Sovereign Freenet Key: ...\n<64hex>" or "viso master seed ...\nhex:\n<64hex>")
  const lineHit = s.match(/\b([0-9a-f]{64})\b/i);
  if (lineHit) {
    return {
      secretHex: lineHit[1].toLowerCase(),
      expectedPubHex: null,
      delegation: null,
      detectedKind: isVisoBackup ? 'viso-seed' : 'text64'
    };
  }

  throw new Error('Invalid Freenet key: expected a 64-hex Ed25519 secret key, Viso master seed, or session JSON.');
}

export async function ed25519KeyPair(rawInput) {
  const { secretHex, expectedPubHex } = parseFreenetKeyInput(rawInput);
  const secretBytes = hexToBytes(secretHex);
  const { pubHex, persona } = await ed25519PubFromSecret(secretBytes);
  if (expectedPubHex && expectedPubHex !== pubHex) {
    throw new Error('Public key does not match the secret key.');
  }
  return {
    secretHex,
    pubHex,
    persona,
    username: 'fn_' + pubHex.slice(0, 16),
    password: secretHex
  };
}

export function buildVisoConnectMessage(personaPubBytes, returnBase, challenge, ts) {
  const baseBytes = enc.encode(returnBase);
  const chalBytes = enc.encode(challenge);
  return concatBytes(
    enc.encode('whoiam-connect-v1'),
    personaPubBytes,
    u32le(baseBytes.length),
    baseBytes,
    u32le(chalBytes.length),
    chalBytes,
    u64le(ts)
  );
}

export async function signVisoConnect(personaSecretBytes, returnBase, challenge, ts) {
  const { priv, pubBytes } = await ed25519PubFromSecret(personaSecretBytes);
  const msg = buildVisoConnectMessage(pubBytes, returnBase, challenge, ts);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', priv, msg));
  return bytesToHex(sig);
}

export async function deriveVisoPersonaKey(seedHex, index = 0) {
  const { blake3 } = await import('@noble/hashes/blake3.js');
  const seedBytes = hexToBytes(seedHex);
  if (seedBytes.length !== 32) throw new Error('Viso seed must be 32 bytes (64 hex chars).');
  const idx = Math.max(0, Number(index) || 0) >>> 0;
  const ikm = concatBytes(seedBytes, u32le(idx));
  const secretBytes = blake3(ikm, { context: enc.encode('whoiam identity v1') });
  const { pubBytes, pubHex, persona } = await ed25519PubFromSecret(secretBytes);
  return {
    index: idx,
    secretBytes,
    secretHex: bytesToHex(secretBytes),
    pubBytes,
    pubHex,
    persona
  };
}

export async function deriveVisoAppSecret(personaSecretBytes, appScope = ORTO_APP_SCOPE) {
  const { blake3 } = await import('@noble/hashes/blake3.js');
  if (!(personaSecretBytes instanceof Uint8Array) || personaSecretBytes.length !== 32) {
    throw new Error('Persona secret must be 32 bytes.');
  }
  const ikm = concatBytes(personaSecretBytes, enc.encode(appScope));
  const secretBytes = blake3(ikm, { context: enc.encode('viso app secret v1') });
  const { pubBytes, pubHex } = await ed25519PubFromSecret(secretBytes);
  return {
    secretBytes,
    secretHex: bytesToHex(secretBytes),
    pubBytes,
    pubHex
  };
}

export async function deriveVisoIdentity(
  rawSeedInput,
  { index = 0, isPersonaKey = false, appKey = ORTO_CONTRACT_KEY, baseOrigin = 'http://127.0.0.1:7509' } = {}
) {
  const parsed = parseFreenetKeyInput(rawSeedInput);
  const persona = isPersonaKey
    ? (() => {
        const sb = hexToBytes(parsed.secretHex);
        return ed25519PubFromSecret(sb).then((p) => ({ index: 0, secretBytes: sb, secretHex: parsed.secretHex, ...p }));
      })()
    : deriveVisoPersonaKey(parsed.secretHex, index);
  const resolvedPersona = await persona;

  const appScope = `contract/web/${appKey}`;
  const appPath = `/v1/${appScope}/`;
  const app = await deriveVisoAppSecret(resolvedPersona.secretBytes, appScope);
  const cleanOrigin = String(baseOrigin || 'http://127.0.0.1:7509').replace(/\/$/, '');
  const base = `${cleanOrigin}${appPath}`;
  const challenge = `wd1.${app.pubHex}.${crypto.randomBytes(16).toString('hex')}`;
  const ts = Date.now();
  const sig = await signVisoConnect(resolvedPersona.secretBytes, base, challenge, ts);

  return {
    kind: isPersonaKey ? 'viso-persona' : 'viso-seed',
    secretHex: app.secretHex,
    pubHex: app.pubHex,
    persona: resolvedPersona.persona,
    personaHex: resolvedPersona.pubHex,
    personaIndex: resolvedPersona.index,
    username: 'fn_' + app.pubHex.slice(0, 16),
    password: app.secretHex,
    delegation: {
      persona: resolvedPersona.pubHex,
      appPath,
      cert: { base, challenge, ts, sig }
    }
  };
}

export async function resolveFreenetIdentity(
  rawInput,
  { keyMode = 'auto', personaIndex = 0, delegationRaw = null } = {}
) {
  const parsed = parseFreenetKeyInput(rawInput);
  const explicitDelegation = delegationRaw ? parseDelegationInput(delegationRaw) : null;
  const delegation = explicitDelegation || parsed.delegation || null;

  if (delegation) {
    const { pubBytes, pubHex } = await ed25519PubFromSecret(hexToBytes(parsed.secretHex));
    if (parsed.expectedPubHex && parsed.expectedPubHex !== pubHex) {
      throw new Error('Public key does not match the secret key.');
    }
    const personaBytes = hexToBytes(delegation.persona);
    return {
      kind: 'viso-session',
      secretHex: parsed.secretHex,
      pubHex,
      persona: toBase58(personaBytes),
      personaHex: delegation.persona,
      personaIndex: null,
      username: 'fn_' + pubHex.slice(0, 16),
      password: parsed.secretHex,
      delegation,
      detectedKind: parsed.detectedKind || 'viso-session'
    };
  }

  // Persona private key exported from Viso: derive the same delegated Orto app key the web connect flow gets
  if (keyMode === 'viso-persona' || (keyMode === 'auto' && parsed.detectedKind === 'viso-persona')) {
    const id = await deriveVisoIdentity(parsed.secretHex, { isPersonaKey: true });
    return { ...id, detectedKind: parsed.detectedKind };
  }

  if (keyMode === 'viso-seed' || (keyMode === 'auto' && parsed.detectedKind === 'viso-seed')) {
    const id = await deriveVisoIdentity(parsed.secretHex, { index: personaIndex });
    return { ...id, detectedKind: parsed.detectedKind };
  }

  const kp = await ed25519KeyPair(rawInput);
  return {
    kind: 'direct',
    ...kp,
    personaHex: kp.pubHex,
    personaIndex: null,
    delegation: null,
    detectedKind: parsed.detectedKind
  };
}

export const DEFAULT_FREENET_NODE = 'ws://127.0.0.1:7509/v1/contract/command';

export function normalizeFreenetNode(raw) {
  const s = String(raw || '').trim();
  if (!s) return DEFAULT_FREENET_NODE;
  let u;
  try {
    u = new URL(s.includes('://') ? s : `ws://${s}`);
  } catch (_) {
    throw new Error('Invalid Freenet node URL: ' + s);
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error('Freenet node URL must be ws(s) or http(s): ' + s);
  }
  if (!u.pathname || u.pathname === '/') {
    u.pathname = '/v1/contract/command';
  }
  return u.toString().replace(/\/$/, '');
}

export function getFreenetStorePath(overridePath) {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.ORTO_FREENET_STORE) return path.resolve(process.env.ORTO_FREENET_STORE);
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Orto', 'freenet-store.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Orto', 'freenet-store.json');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'orto', 'freenet-store.json');
}

function findVaultWasm() {
  const candidates = [
    process.env.ORTO_VAULT_WASM,
    path.join(ROOT_DIR, 'web', 'orto_vault.wasm'),
    path.join(ROOT_DIR, 'contracts', 'orto_vault.wasm'),
    path.join(ROOT_DIR, 'contracts', 'vault', 'build', 'freenet', 'orto_vault')
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function installFreenetRuntime({
  storePath,
  nodeUrl = DEFAULT_FREENET_NODE,
  authToken = '',
  connectNode = true,
  onStatusChange = null
} = {}) {
  const file = getFreenetStorePath(storePath);
  const normNode = normalizeFreenetNode(nodeUrl);
  const mem = new Map();

  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          mem.set(k, String(v));
        }
      }
    }
  } catch (_) {}

  const persist = () => {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(dir, 0o700); } catch (_) {}
    }
    const obj = Object.fromEntries(mem.entries());
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch (_) {}
    }
  };

  globalThis.safeStore = {
    getItem(k) {
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem(k, v) {
      mem.set(String(k), String(v));
      persist();
    },
    removeItem(k) {
      mem.delete(String(k));
      persist();
    },
    keys(prefix = '') {
      const p = String(prefix || '');
      return [...mem.keys()].filter((k) => k.startsWith(p));
    }
  };

  let nodeStatus = connectNode ? 'connecting' : 'local-only';
  let syncState = connectNode ? 'idle' : 'local-only';
  let lastRecordCount = 0;
  let lastSyncError = '';
  let lastVaultId = '';
  let wsApi = null;
  let wsApiPromise = null;
  let closed = false;
  const updateListeners = new Set();
  const statusListeners = new Set();
  if (typeof onStatusChange === 'function') statusListeners.add(onStatusChange);

  const getSyncInfo = () => ({ nodeStatus, syncState, lastRecordCount, lastSyncError, lastVaultId });
  const emitStatus = () => {
    const info = getSyncInfo();
    for (const fn of statusListeners) {
      try { fn(info); } catch (_) {}
    }
  };

  let vaultCodeCache = null;
  async function loadVaultCode() {
    if (vaultCodeCache) return vaultCodeCache;
    const wasmPath = findVaultWasm();
    if (!wasmPath) throw new Error('orto_vault.wasm not found');
    const [{ blake3 }] = await Promise.all([import('@noble/hashes/blake3.js')]);
    let raw = new Uint8Array(fs.readFileSync(wasmPath));
    // contracts/orto_vault.wasm has a 40-byte header if not stripped like web/orto_vault.wasm
    if (path.basename(path.dirname(wasmPath)) === 'contracts' && raw.length > 40 && raw[0] !== 0x00) {
      raw = raw.subarray(40);
    }
    const hash = blake3(raw);
    vaultCodeCache = { codeArr: Array.from(raw), hash, hashArr: Array.from(hash) };
    return vaultCodeCache;
  }

  async function computeVaultKey(paramsHex) {
    const [{ ContractKey }, { blake3 }] = await Promise.all([
      import('@freenetorg/freenet-stdlib'),
      import('@noble/hashes/blake3.js')
    ]);
    const { hash } = await loadVaultCode();
    const pb = Uint8Array.from(paramsHex.match(/../g) ?? [], (b) => parseInt(b, 16));
    const pre = new Uint8Array(hash.length + pb.length);
    pre.set(hash, 0);
    pre.set(pb, hash.length);
    return new ContractKey(blake3(pre), hash);
  }

  function closeSocket() {
    if (wsApi?.ws && typeof wsApi.ws.close === 'function') {
      try { wsApi.ws.close(); } catch (_) {}
    }
    wsApi = null;
    wsApiPromise = null;
  }

  async function getApi() {
    if (!connectNode || closed) throw new Error('Freenet node disabled');
    if (wsApi) return wsApi;
    if (wsApiPromise) return wsApiPromise;

    wsApiPromise = (async () => {
      const { FreenetWsApi } = await import('@freenetorg/freenet-stdlib');
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            nodeStatus = 'local-only';
            emitStatus();
            closeSocket();
            reject(new Error('Freenet node timeout'));
          }
        }, 2500);
        timer.unref?.();

        const handler = {
          onContractPut() {},
          onContractGet() {},
          onContractUpdate() {},
          onContractUpdateNotification(n) {
            const encKey = n?.key?.encode?.();
            if (encKey) for (const fn of updateListeners) fn(encKey);
          },
          onContractNotFound() {},
          onDelegateResponse() {},
          onErr() {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              nodeStatus = 'local-only';
              emitStatus();
              closeSocket();
              reject(new Error('Freenet node unreachable'));
            }
          },
          onOpen() {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              nodeStatus = 'connected';
              wsApi = api;
              emitStatus();
              resolve(api);
            }
          },
          onClose() {
            wsApi = null;
            wsApiPromise = null;
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              nodeStatus = 'local-only';
              emitStatus();
              reject(new Error('Freenet WebSocket closed'));
            }
          }
        };
        const api = new FreenetWsApi(new URL(normNode), handler, authToken || '');
      });
    })().catch((err) => {
      wsApiPromise = null;
      throw err;
    });

    return wsApiPromise;
  }

  if (connectNode) {
    globalThis.FreenetVault = {
      async getVault(paramsHex) {
        const { GetRequest } = await import('@freenetorg/freenet-stdlib');
        const key = await computeVaultKey(paramsHex);
        lastVaultId = key.encode();
        syncState = 'syncing';
        lastSyncError = '';
        emitStatus();
        try {
          const client = await getApi();
          const r = await withTimeout(client.get(new GetRequest(key, false, true)), 15000);
          const state = r.state.length ? JSON.parse(new TextDecoder().decode(Uint8Array.from(r.state))) : { records: {}, updated_at: 0 };
          lastRecordCount = Object.values(state.records || {}).filter((rec) => rec && !rec.deleted).length;
          syncState = 'synced';
          emitStatus();
          return state;
        } catch (e) {
          if (/not found/i.test(String(e))) {
            syncState = 'empty';
            lastRecordCount = 0;
            emitStatus();
            return null;
          }
          syncState = 'error';
          lastSyncError = e?.message || String(e);
          emitStatus();
          throw e;
        }
      },
      async pushVault(paramsHex, delta, exists) {
        const [stdlib, stdCommon, stdClient] = await Promise.all([
          import('@freenetorg/freenet-stdlib'),
          import('@freenetorg/freenet-stdlib/common'),
          import('@freenetorg/freenet-stdlib/client-request')
        ]);
        const client = await getApi();
        const key = await computeVaultKey(paramsHex);
        lastVaultId = key.encode();
        const bytes = Array.from(new TextEncoder().encode(JSON.stringify(delta)));
        if (exists) {
          await withTimeout(client.update(new stdlib.UpdateRequest(
            key,
            new stdlib.UpdateData(stdlib.UpdateDataType.DeltaUpdate, new stdlib.DeltaUpdate(bytes))
          )), 15000);
          return;
        }
        const { codeArr, hashArr } = await loadVaultCode();
        const pb = Array.from(Uint8Array.from(paramsHex.match(/../g) ?? [], (b) => parseInt(b, 16)));
        const contract = new stdlib.WasmContractV1(new stdCommon.ContractCodeT(codeArr, hashArr), pb, key);
        await withTimeout(client.put(new stdlib.PutRequest(
          new stdlib.ContractContainer(stdlib.ContractType.WasmContractV1, contract),
          bytes,
          new stdClient.RelatedContractsT(),
          true
        )), 15000);
      },
      async onVaultUpdate(paramsHex, fn) {
        try {
          const want = (await computeVaultKey(paramsHex)).encode();
          const l = (k) => k === want && fn();
          updateListeners.add(l);
          return () => updateListeners.delete(l);
        } catch (_) {
          return () => {};
        }
      }
    };
  } else {
    delete globalThis.FreenetVault;
  }

  return {
    storePath: file,
    nodeUrl: normNode,
    getStatus: () => nodeStatus,
    getSyncInfo,
    onStatusChange(fn) {
      if (typeof fn !== 'function') return () => {};
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    async waitForVaultSync(client, timeoutMs = 15000) {
      if (!connectNode || !client?._vaults || client._vaults.size === 0) return getSyncInfo();
      const pending = [...client._vaults.values()].map((v) => v.syncing).filter(Boolean);
      if (pending.length) {
        await withTimeout(Promise.allSettled(pending), timeoutMs, 'Freenet sync timeout').catch(() => {});
      }
      return getSyncInfo();
    },
    async forceSync(client) {
      if (!connectNode || !client?._vaults || typeof client._vaultSync !== 'function') return getSyncInfo();
      const jobs = [...client._vaults.values()].map((v) => client._vaultSync(v).catch(() => {}));
      await Promise.allSettled(jobs);
      return getSyncInfo();
    },
    async flushVaults(client, timeoutMs = 1500) {
      if (!client?._vaults || nodeStatus !== 'connected') return;
      for (const v of client._vaults.values()) {
        clearTimeout(v.timer);
        if (v.pending.size > 0 && typeof client._vaultFlush === 'function') {
          let t;
          await Promise.race([
            client._vaultFlush(v),
            new Promise((r) => {
              t = setTimeout(r, timeoutMs);
              t.unref?.();
            })
          ]).catch(() => {}).finally(() => clearTimeout(t));
        }
      }
    },
    close() {
      closed = true;
      updateListeners.clear();
      statusListeners.clear();
      closeSocket();
    }
  };
}
