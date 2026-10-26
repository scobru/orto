// Orto vault contract (contracts/vault) from the browser: the encrypted records of one identity, replicated on Freenet.
// Parameters = owner Ed25519 pubkey (32 bytes) || salt (16 bytes); state and delta are the same JSON of signed records.
import {
  ContractContainer,
  ContractKey,
  ContractType,
  DeltaUpdate,
  GetRequest,
  PutRequest,
  UpdateData,
  UpdateDataType,
  UpdateRequest,
  WasmContractV1,
} from "@freenetorg/freenet-stdlib";
import { ContractCodeT } from "@freenetorg/freenet-stdlib/common";
import { RelatedContractsT } from "@freenetorg/freenet-stdlib/client-request";
import { blake3 } from "@noble/hashes/blake3.js";
import { api, updateListeners } from "./chunks";
import "./delegate"; // exposes FreenetDelegate (node-kept identity values) from the same bundle

export type VaultRecord = { data: string; updated_at: number; deleted: boolean; sig: string; cert: null };
export type VaultState = { records: Record<string, VaultRecord>; updated_at: number };

const TIMEOUT_MS = 15000;
const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Freenet request timeout")), TIMEOUT_MS))]);

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

let codeP: Promise<{ code: Uint8Array; hash: Uint8Array }> | undefined;
function vaultCode() {
  return (codeP ??= (async () => {
    const base = globalThis.location?.pathname?.replace(/[^/]*$/, "") ?? "./";
    const origin = globalThis.location?.origin && globalThis.location.origin !== "null" ? globalThis.location.origin : "";
    const r = await fetch(`${origin}${base}orto_vault.wasm`);
    if (!r.ok) throw new Error(`Cannot load orto_vault.wasm: HTTP ${r.status}`);
    const code = new Uint8Array(await r.arrayBuffer());
    return { code, hash: blake3(code) };
  })());
}

async function vaultKey(paramsHex: string): Promise<ContractKey> {
  const { hash } = await vaultCode();
  return new ContractKey(blake3(new Uint8Array([...hash, ...hexBytes(paramsHex)])), hash);
}

/** The vault on the network (subscribing to its changes), or null when it was never published. */
export async function getVault(paramsHex: string): Promise<VaultState | null> {
  const client = await api();
  try {
    const r = await withTimeout(client.get(new GetRequest(await vaultKey(paramsHex), false, true)));
    return r.state.length ? JSON.parse(new TextDecoder().decode(Uint8Array.from(r.state))) : { records: {}, updated_at: 0 };
  } catch (e) {
    if (/not found/i.test(String(e))) return null;
    throw e;
  }
}

/** Send signed records: `exists` false publishes the contract with them as its first state. */
export async function pushVault(paramsHex: string, delta: VaultState, exists: boolean): Promise<void> {
  const client = await api();
  const key = await vaultKey(paramsHex);
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(delta)));
  if (exists) {
    await withTimeout(client.update(new UpdateRequest(key, new UpdateData(UpdateDataType.DeltaUpdate, new DeltaUpdate(bytes)))));
    return;
  }
  const { code, hash } = await vaultCode();
  const contract = new WasmContractV1(new ContractCodeT(Array.from(code), Array.from(hash)), Array.from(hexBytes(paramsHex)), key);
  await withTimeout(client.put(new PutRequest(new ContractContainer(ContractType.WasmContractV1, contract), bytes, new RelatedContractsT(), true)));
}

/** Call `fn` whenever the vault with these parameters changes on the network. Returns unsubscribe. */
export async function onVaultUpdate(paramsHex: string, fn: () => void): Promise<() => void> {
  const want = (await vaultKey(paramsHex)).encode();
  const l = (k: string) => k === want && fn();
  updateListeners.add(l);
  return () => updateListeners.delete(l);
}

if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).FreenetVault = { getVault, pushVault, onVaultUpdate };
}
