// Node-side identity delegate (same one as Radica and freetunes): keeps a few small private values per app where a
// sandboxed page cannot lose them (no storage, URL hash dropped by a redirect). Optional: callers fall back to page storage.
// The delegate's keys may only hold letters, digits, ':' and '-' (no underscore), and are namespaced per web app by the node.
import { FreenetWsApi, DelegateRequest, type DelegateResponse } from "@freenetorg/freenet-stdlib";
import { ApplicationMessageT } from "@freenetorg/freenet-stdlib/common";
import {
  ApplicationMessagesT, ClientRequestT, ClientRequestType, DelegateCodeT, DelegateContainerT, DelegateKeyT,
  DelegateRequestType, DelegateType, InboundDelegateMsgT, InboundDelegateMsgType, RegisterDelegateT, WasmDelegateV1T,
} from "@freenetorg/freenet-stdlib/client-request";
import { blake3 } from "@noble/hashes/blake3.js";

const TIMEOUT_MS = 8000;
let waiters: { resolve(r: DelegateResponse): void; reject(e: Error): void }[] = [];
let apiP: Promise<FreenetWsApi> | undefined;
let chain: Promise<unknown> = Promise.resolve();
let key: Promise<DelegateKeyT> | undefined;

function api(): Promise<FreenetWsApi> {
  return (apiP ??= new Promise((resolve, reject) => {
    const loc = globalThis.location;
    const onNode = loc.port === "7509" || loc.pathname.includes("/v1/contract/");
    const url = new URL(`${loc.protocol === "https:" ? "wss" : "ws"}://${onNode ? loc.host : "127.0.0.1:7509"}/v1/contract/command`);
    const a: FreenetWsApi = new FreenetWsApi(url, {
      onContractPut() {}, onContractGet() {}, onContractUpdate() {}, onContractUpdateNotification() {}, onContractNotFound() {},
      onDelegateResponse: (r) => waiters.shift()?.resolve(r), // replies carry no id: one request at a time
      onErr: (e) => console.warn("[Freenet delegate]", e?.cause ?? e),
      onOpen: () => resolve(a),
      onClose: () => {
        apiP = key = undefined;
        waiters.splice(0).forEach((w) => w.reject(new Error("socket closed")));
        reject(new Error("socket closed"));
      },
    }, new URLSearchParams(loc.search).get("authToken") ?? "");
  }));
}

function send(req: DelegateRequest): Promise<DelegateResponse> {
  const run = async () => {
    const reply = new Promise<DelegateResponse>((resolve, reject) => {
      const w = { resolve, reject };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) { waiters.splice(i, 1); reject(new Error("delegate timeout")); }
      }, TIMEOUT_MS);
    });
    (await api() as unknown as { sendRequest(r: ClientRequestT): void }).sendRequest(new ClientRequestT(ClientRequestType.DelegateRequest, req));
    return reply;
  };
  const p = chain.then(run);
  chain = p.catch(() => {});
  return p;
}

async function register(): Promise<DelegateKeyT> {
  const loc = globalThis.location;
  const base = loc?.pathname?.replace(/[^/]*$/, "") ?? "./";
  const origin = loc?.origin && loc.origin !== "null" ? loc.origin : "";
  const r = await fetch(`${origin}${base}identity.wasm`);
  if (!r.ok) throw new Error(`Cannot load identity.wasm: HTTP ${r.status}`);
  const code = new Uint8Array(await r.arrayBuffer());
  const hash = blake3(code);
  const k = new DelegateKeyT(Array.from(blake3(hash)), Array.from(hash));
  const wasm = new WasmDelegateV1T([], new DelegateCodeT(Array.from(code), Array.from(hash)), k);
  await send(new DelegateRequest(DelegateRequestType.RegisterDelegate,
    new RegisterDelegateT(new DelegateContainerT(DelegateType.WasmDelegateV1, wasm), new Array(32).fill(0), new Array(24).fill(0)))); // node ignores cipher and nonce
  return k;
}

async function call(payload: object): Promise<Record<string, unknown>> {
  const k = await (key ??= register()).catch((e) => {
    key = undefined; // try again next time instead of keeping the failure
    throw e;
  });
  const msg = new InboundDelegateMsgT(InboundDelegateMsgType.common_ApplicationMessage,
    new ApplicationMessageT(Array.from(new TextEncoder().encode(JSON.stringify(payload))), [], false));
  const r = await send(new DelegateRequest(DelegateRequestType.ApplicationMessages, new ApplicationMessagesT(k, [], [msg])));
  // duck-typed: bundlers can duplicate the SDK classes, which breaks instanceof
  const m = r.values.map((v) => v.inbound).find((x) => Array.isArray((x as ApplicationMessageT | null)?.payload)) as ApplicationMessageT | undefined;
  if (!m) throw new Error("empty delegate reply");
  const out = JSON.parse(new TextDecoder().decode(new Uint8Array(m.payload)));
  if (out.err) throw new Error(out.err);
  return out;
}

/** A small private value kept by the node for this app; null when it is missing or no delegate answers. */
export async function nodeGet(name: string): Promise<string | null> {
  try {
    return ((await call({ op: "get", key: name })).value as string | null) ?? null;
  } catch (e) {
    console.warn("identity delegate unavailable:", e);
    return null;
  }
}

/** Keep `value` at the node ("" forgets it). Resolves false when no delegate answered. */
export async function nodePut(name: string, value: string): Promise<boolean> {
  try {
    await call({ op: "put", key: name, value });
    return true;
  } catch (e) {
    console.warn("identity delegate unavailable:", e);
    return false;
  }
}

if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).FreenetDelegate = { nodeGet, nodePut };
}
