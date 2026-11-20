// Radica feeds (https://github.com/scobru/radica), read only: one public, signed contract per persona with its profile,
// posts and the list of people it follows. The node checks every signature, so what it hands back is what the owner wrote.
import { ContractKey, GetRequest } from "@freenetorg/freenet-stdlib";
import { blake3 } from "@noble/hashes/blake3.js";
import { api } from "./chunks";

// shortcut: Radica's feed contract code (current + legacy generations) and app path are pinned here
const FEED_CODE_HASHES = [
  "e2809fdacbeeccd70a43a9651d6d59b8591a2d35ca0581ef709dd02f17a53367", // v3: length-prefixed signatures, PoW, caps
  "34c54f5687fa2807470907a05bd72070c03215505f8dcd1e35eb8c169e02343c", // v2
  "6eed3cbfb9e9931660dc86c13834a1e24c4e14e547cd66cd2eb1f7a59950d5b6", // v1
];
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
export function feedKey(ownerHex: string, codeHashHex = FEED_CODE_HASHES[0]): ContractKey {
  const hash = hexBytes(codeHashHex);
  const owner = hexBytes(ownerHex), app = new TextEncoder().encode(RADICA_PATH);
  const pre = new Uint8Array(hash.length + owner.length + app.length);
  pre.set(hash, 0);
  pre.set(owner, hash.length);
  pre.set(app, hash.length + owner.length);
  return new ContractKey(blake3(pre), hash);
}

/** A persona's feed, or null when it was never published (checks current and legacy Radica contract generations). */
export async function getFeed(ownerHex: string): Promise<RadicaFeed | null> {
  if (!/^[0-9a-f]{64}$/.test(ownerHex)) throw new Error("not a Radica key");
  const client = await api();
  let lastErr: unknown;
  for (const codeHash of FEED_CODE_HASHES) {
    let t: ReturnType<typeof setTimeout>;
    try {
      const r = await Promise.race([
        client.get(new GetRequest(feedKey(ownerHex, codeHash), false, false)),
        new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("Freenet request timeout")), TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(t));
      if (r.state.length) return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.state)));
    } catch (e) {
      if (!/not found/i.test(String(e))) lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).FreenetRadica = { getFeed, RADICA_PATH };
}
