// Real Zcash key derivation (client-only, lazy WASM).
//
// What's REAL here:
//   • BIP-39 mnemonics via @scure/bip39 — valid checksum, standard wordlist,
//     interoperable with real wallets (a Zashi phrase imports/validates here).
//   • Unified Full Viewing Key derived from the seed via @chainsafe/webzjs-keys
//     (ChainSafe's WebZjs keys WASM crate, from npm) → a genuine Zcash credential
//     (uviewtest… on testnet).
//
// This module must only run in the browser. Import it dynamically.

import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export type ZNetwork = "main" | "test";

export type DerivedAccount = {
  mnemonic: string;
  /** Encoded Unified Full Viewing Key, e.g. uviewtest1… (real Zcash credential). */
  ufvk: string;
  network: ZNetwork;
};

// Pure-JS BIP-39 (no WASM) — always safe to call.
export function realGenerateMnemonic(): string {
  return generateMnemonic(wordlist, 256); // 24 words
}

export function realValidateMnemonic(phrase: string): boolean {
  return validateMnemonic(phrase.trim().toLowerCase(), wordlist);
}

// ── WebZjs keys WASM (lazy, init-once) ───────────────────────────────────────
type KeysModule = typeof import("@chainsafe/webzjs-keys");
let modPromise: Promise<KeysModule> | null = null;

async function loadKeys(): Promise<KeysModule> {
  if (!modPromise) {
    modPromise = (async () => {
      const m = await import("@chainsafe/webzjs-keys");
      await m.default(); // instantiate the WASM module
      return m;
    })();
  }
  return modPromise;
}

/** Derive a real UFVK from a mnemonic. Throws if the WASM can't load. */
export async function deriveAccount(mnemonic: string, network: ZNetwork): Promise<DerivedAccount> {
  const m = await loadKeys();
  const seed = mnemonicToSeedSync(mnemonic.trim().toLowerCase()); // 64-byte seed
  const usk = new m.UnifiedSpendingKey(network, seed, 0);
  const ufvk = usk.to_unified_full_viewing_key().encode(network);
  return { mnemonic, ufvk, network };
}

/** Validate an encoded UFVK string against the network (real checksum check). */
export async function validateUfvk(encoding: string, network: ZNetwork): Promise<boolean> {
  const m = await loadKeys();
  try {
    new m.UnifiedFullViewingKey(network, encoding.trim());
    return true;
  } catch {
    return false;
  }
}
