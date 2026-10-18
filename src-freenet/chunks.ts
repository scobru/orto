import {
  ContractContainer,
  ContractKey,
  ContractType,
  FreenetWsApi,
  GetRequest,
  PutRequest,
  WasmContractV1,
  ResponseHandler,
} from "@freenetorg/freenet-stdlib";
import { ContractCodeT } from "@freenetorg/freenet-stdlib/common";
import { RelatedContractsT } from "@freenetorg/freenet-stdlib/client-request";
import { blake3 } from "@noble/hashes/blake3.js";

// ---------------------------------------------------------------- WebSocket connection
function getWsUrl(): URL {
  const loc = typeof globalThis.location !== "undefined" ? globalThis.location : null;
  if (!loc) return new URL("ws://127.0.0.1:7509/v1/contract/command");
  const isDefaultFreenet = loc.port === "7509" || loc.pathname.includes("/v1/contract/");
  const host = isDefaultFreenet ? (loc.host || "127.0.0.1:7509") : "127.0.0.1:7509";
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  return new URL(`${proto}://${host}/v1/contract/command`);
}

let apiP: Promise<FreenetWsApi> | undefined;

export function api(): Promise<FreenetWsApi> {
  return (apiP ??= new Promise((resolve, reject) => {
    const url = getWsUrl();
    const h: ResponseHandler = {
      onContractPut() {},
      onContractGet() {},
      onContractUpdate() {},
      onContractUpdateNotification() {},
      onContractNotFound() {
        console.warn("Freenet contract not found");
      },
      onDelegateResponse() {},
      onErr(e) {
        console.error("Freenet WS error:", e?.cause || e);
      },
      onOpen() {
        resolve(a);
      },
      onClose() {
        apiP = undefined;
        reject(new Error("Freenet WebSocket closed"));
      },
    };
    const a = new FreenetWsApi(url, h, "");
  }));
}

export async function resetSocket() {
  try {
    const a = (await api()) as unknown as { ws?: { close(): void } };
    a.ws?.close();
  } catch (_) {}
  apiP = undefined;
  await new Promise((r) => setTimeout(r, 300));
}

// ---------------------------------------------------------------- retrying & serialization
async function retrying<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries || !/closed|timeout/i.test(String(e))) throw e;
      console.warn(`Freenet connection retry (${i}/${tries - 1}):`, e);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const p = chain.then(f);
  chain = p.catch(() => {});
  return p;
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Freenet request timeout")), ms)),
  ]);

// ---------------------------------------------------------------- WASM Code & Keys
let wasmCache: Promise<{ code: Uint8Array; codeHash: Uint8Array }> | undefined;

export function getWasmCode(): Promise<{ code: Uint8Array; codeHash: Uint8Array }> {
  if (wasmCache) return wasmCache;
  wasmCache = (async () => {
    let u = "./chunk.wasm";
    if (typeof globalThis.location !== "undefined" && globalThis.location.pathname) {
      const base = globalThis.location.pathname.replace(/[^/]*$/, "");
      const origin = (globalThis.location.origin && globalThis.location.origin !== "null")
        ? globalThis.location.origin
        : "";
      u = `${origin}${base}chunk.wasm`;
    }
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Cannot load chunk.wasm from ${u}: HTTP ${r.status}`);
    const code = new Uint8Array(await r.arrayBuffer());
    const codeHash = blake3(code);
    return { code, codeHash };
  })();
  return wasmCache;
}

const keys = new Map<string, ContractKey>();
const fullKey = (instance: string) => keys.get(instance) ?? ContractKey.fromInstanceId(instance);

const PUT_TIMEOUT_MS = 10000;
const seen = new Set<string>();

// ---------------------------------------------------------------- Public Chunk API

/**
 * Publish one binary chunk (content-addressed) as a Freenet contract.
 * @param content Uint8Array
 * @returns Contract address string
 */
export async function putChunk(content: Uint8Array): Promise<string> {
  const { code, codeHash } = await getWasmCode();
  const params = blake3(content);
  const instanceId = blake3(new Uint8Array([...codeHash, ...params]));
  const key = new ContractKey(instanceId, codeHash);
  const addr = key.encode();
  keys.set(addr, key);

  if (seen.has(addr)) return addr;

  const contract = new WasmContractV1(
    new ContractCodeT(Array.from(code), Array.from(codeHash)),
    Array.from(params),
    key
  );

  const put = retrying(async () => {
    const client = await api();
    await client.put(
      new PutRequest(
        new ContractContainer(ContractType.WasmContractV1, contract),
        Array.from(content),
        new RelatedContractsT()
      )
    );
  });

  try {
    await withTimeout(put, PUT_TIMEOUT_MS);
  } catch (e) {
    put.catch(() => {});
    if (!/timeout/i.test(String(e))) throw e;
    // Freenet node silently drops PUT if contract is already stored.
    // Reset socket and verify it exists with a GET.
    await resetSocket();
    try {
      await withTimeout(getChunk(addr), PUT_TIMEOUT_MS);
    } catch {
      throw new Error("Freenet node did not accept chunk " + addr);
    }
  }

  seen.add(addr);
  return addr;
}

/**
 * Fetch a content-addressed chunk from Freenet by address.
 * @param addr string
 * @returns Uint8Array chunk content
 */
export async function getChunk(addr: string): Promise<Uint8Array> {
  return serial(() =>
    retrying(async () => {
      const client = await api();
      const r = await client.get(new GetRequest(fullKey(addr), false));
      if (r.key?.codePart()?.length === 32) {
        keys.set(addr, r.key);
      }
      return new Uint8Array(r.state);
    })
  );
}

/**
 * Check if the Freenet node WebSocket is responsive.
 */
export async function isFreenetAvailable(): Promise<boolean> {
  try {
    await withTimeout(api(), 3000);
    return true;
  } catch (_) {
    return false;
  }
}

// Export to globalThis for vanilla JS scripts in Orto
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).FreenetChunks = {
    putChunk,
    getChunk,
    isFreenetAvailable,
    resetSocket,
    getWasmCode,
    api,
  };
}
