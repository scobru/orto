// Radica feeds (https://github.com/scobru/radica), read only: one public, signed contract per persona with its profile,
// posts and the list of people it follows. The node checks every signature, so what it hands back is what the owner wrote.
import { ContractKey, GetRequest } from "@freenetorg/freenet-stdlib";
import { blake3 } from "@noble/hashes/blake3.js";
import { api } from "./chunks";

// shortcut: Radica's feed contract code and app path are pinned here; update both when Radica publishes a new contract or web key
const FEED_CODE_HASH = "6eed3cbfb9e9931660dc86c13834a1e24c4e14e547cd66cd2eb1f7a59950d5b6"; // blake3(radica/ui/src/wasm/contract.wasm)
export const RADICA_PATH = "/v1/contract/web/Ex88TLL48HQPA6CuYQuhc2zKFjcEdUeHbreNBrfVL2Sw/";

export type RadicaPost = { id: string; author: string; category: string; caption: string; media_uri?: string | null; location?: string | null; event_date?: string | null; is_nsfw: boolean; timestamp: number };
export type RadicaFeed = {
  owner: string;
  profile?: { display_name: string; bio: string; avatar_url: string } | null;
  posts: Record<string, RadicaPost>;
  following: string[];
  deleted?: Record<string, unknown>;
};

const TIMEOUT_MS = 15000;
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Contract key of a persona's feed: the same parameters Radica uses (owner key || its app path). */
export function feedKey(ownerHex: string): ContractKey {
  const hash = hexBytes(FEED_CODE_HASH);
  const params = new Uint8Array([...hexBytes(ownerHex), ...new TextEncoder().encode(RADICA_PATH)]);
  return new ContractKey(blake3(new Uint8Array([...hash, ...params])), hash);
}

/** A persona's feed, or null when it was never published. */
export async function getFeed(ownerHex: string): Promise<RadicaFeed | null> {
  if (!/^[0-9a-f]{64}$/.test(ownerHex)) throw new Error("not a Radica key");
  const client = await api();
  try {
    const r = await Promise.race([
      client.get(new GetRequest(feedKey(ownerHex), false, false)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Freenet request timeout")), TIMEOUT_MS)),
    ]);
    return r.state.length ? JSON.parse(new TextDecoder().decode(Uint8Array.from(r.state))) : null;
  } catch (e) {
    if (/not found/i.test(String(e))) return null;
    throw e;
  }
}

if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).FreenetRadica = { getFeed, RADICA_PATH };
}
