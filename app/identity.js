/**
 * FID identity: the one canonical alias + passphrase -> Zen keypair derivation.
 * Shared by FID, smollog, ZenVault and ZenOS so one login is one `pub` everywhere.
 * Dependency-free: pass in the ZEN constructor you already loaded.
 *
 * Browser: import { deriveMasterPair } from 'https://cdn.jsdelivr.net/gh/scobru/fid@7887fc3468a77943da8ef18a70c3936d1dc45a2a/identity.js';
 *
 * The rule is the portal's: seed = alias.trim() + ':' + passphrase.trim(). Both parts are case-sensitive.
 * Changing it re-keys every FID identity, so it is pinned by tests/identity.test.mjs.
 */
export function identitySeed(alias, passphrase) {
  const a = String(alias ?? '').trim(), p = String(passphrase ?? '').trim();
  if (!a || !p) throw new Error('alias and passphrase are required');
  return a + ':' + p;
}

/** @returns {Promise<{pub:string, priv:string}>} the Zen SEA keypair for this alias + passphrase */
export function deriveMasterPair(ZEN, alias, passphrase) {
  return ZEN.pair(null, { seed: identitySeed(alias, passphrase) });
}
