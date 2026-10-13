import { createRequire } from "node:module";

/**
 * The vendored decryption helper (vendor/zcash-tx-decrypt, ADR-018 § 5/§ 6; zw-tx-decrypt 0.2 since
 * Stage 2): trial-decrypts a raw transaction with a viewing key (Sapling, Orchard and Ironwood outputs).
 * Built from exactly the librustzcash/orchard revisions of the wallet engine (PROVENANCE.md there). CommonJS +
 * WebAssembly, synchronous, no network, no logging — loaded lazily on first use, so a server without fee checks never
 * instantiates it.
 */

export type HelperNetwork = "main" | "test" | "regtest";

export interface DecryptedOutput {
  readonly pool: "sapling" | "orchard" | "ironwood";
  readonly outputIndex: number;
  readonly valueZat: number;
  readonly memoText: string | null;
  readonly memoHex: string;
  /** true only for a payment received on the key's EXTERNAL address (a payment to the project). */
  readonly incoming: boolean;
  readonly transferType: "incoming" | "internal" | "outgoing";
}

/**
 * A viewing key's addresses (zw-tx-decrypt 0.2 = the Stage-2 engine's `get_addresses()`, one diversifier index): all
 * five carry the same Sapling (and transparent) receiver, so a payment to any shielded one is visible to the key.
 */
export interface KeyAddresses {
  /** The FULL unified address: Orchard-family + Sapling + transparent receivers (0.1: the Sapling + transparent one). */
  readonly unifiedAddress: string;
  /** Orchard-family + Sapling, no transparent receiver. */
  readonly unifiedShieldedAddress: string;
  /** Sapling + transparent, no Orchard (the Stage-1 address). */
  readonly unifiedSaplingTransparentAddress: string;
  readonly saplingAddress: string;
  readonly transparentAddress: string | null;
  readonly diversifierIndex: string;
}

export interface AddressInfo {
  readonly network: HelperNetwork;
  readonly kind: string;
  readonly receivers: string[];
  readonly hasSapling: boolean;
  readonly hasOrchard: boolean;
  readonly hasTransparent: boolean;
}

export interface TxDecryptHelper {
  decryptTransaction(rawTxHex: string, height: number, network: HelperNetwork, ufvk: string): DecryptedOutput[];
  registryKeysFromSeed(seedPhrase: string, network: HelperNetwork, account: number): KeyAddresses & { readonly ufvk: string };
  addressesFromUfvk(ufvk: string, network: HelperNetwork): KeyAddresses;
  describeAddress(address: string): AddressInfo;
  buildInfo(): string;
}

/** Path of the helper relative to this file (apps/server/src/zcash → the repository's vendor/). */
const HELPER_PATH = "../../../../vendor/zcash-tx-decrypt/zw_tx_decrypt.js";

let helper: TxDecryptHelper | null = null;

export function loadTxDecryptHelper(): TxDecryptHelper {
  if (!helper) helper = createRequire(import.meta.url)(HELPER_PATH) as TxDecryptHelper;
  return helper;
}

/** The helper's network for an address, from its prefix (u1/zs1 → main, utest/ztestsapling → test, uregtest/zregtestsapling → regtest). */
export function helperNetworkForAddress(address: string): HelperNetwork | null {
  const a = address.trim().toLowerCase();
  if (/^(uregtest1|zregtestsapling1)/.test(a)) return "regtest";
  if (/^(utest1|ztestsapling1)/.test(a)) return "test";
  if (/^(u1|zs1)/.test(a)) return "main";
  return null;
}

/**
 * The key's shielded addresses a fee/registry address may be: the full UA (what
 * scripts/tools/registry-keys.mjs prints), the shielded UA, the Stage 1 UA and the zs1. Never the bare t1.
 */
export function keyShieldedAddresses(own: KeyAddresses): string[] {
  return [own.unifiedAddress, own.unifiedShieldedAddress, own.unifiedSaplingTransparentAddress, own.saplingAddress].filter((a): a is string => typeof a === "string" && a.length > 0);
}

/**
 * Startup check for a fee/registry address and its viewing key: the address must be one of the key's own shielded
 * addresses (`keyShieldedAddresses`), so every fee paid to it is visible to the server, and have a Sapling receiver —
 * every one of the key's shielded addresses has one, and it keeps the address payable by a Stage-1 client that has not
 * reloaded yet (it pays Sapling; a Stage-2 wallet pays the Orchard-family receiver as Ironwood). Returns null when they
 * match, else why not (never the address or the key).
 */
export function checkAddressAgainstKey(address: string, ufvk: string, h: TxDecryptHelper = loadTxDecryptHelper()): string | null {
  const network = helperNetworkForAddress(address);
  if (network === null) return "the address is not a shielded Zcash address (u1… or zs1…)";
  let info: AddressInfo;
  try {
    info = h.describeAddress(address);
  } catch {
    return "the address could not be decoded";
  }
  if (!info.hasSapling) return "the address has no Sapling receiver (use the address registry-keys.mjs prints: a unified address with Orchard, Sapling and transparent receivers)";
  let own: KeyAddresses;
  try {
    own = h.addressesFromUfvk(ufvk, network);
  } catch {
    return `the viewing key is not a valid unified full viewing key for the ${network} network`;
  }
  if (!keyShieldedAddresses(own).includes(address)) return "the address does not belong to the viewing key (fees paid to it would never be seen)";
  return null;
}
