/* tslint:disable */
/* eslint-disable */
/**
 * Trial-decrypts every Sapling, Orchard and Ironwood output of a raw transaction with a unified
 * full viewing key. `height` is the block height the transaction was mined at (or the chain tip
 * + 1 for an unmined one). Returns the outputs the key can see (empty when none).
 * Throws an Error whose `code` is `invalid_hex`, `invalid_height`, `invalid_transaction`,
 * `invalid_network` or `invalid_ufvk`.
 */
export function decryptTransaction(raw_tx_hex: string, height: number, network: ZwNetwork, ufvk: string): ZwDecryptedOutput[];
/**
 * One-time operator setup: derives the project's registry keys from its seed phrase.
 * Returns `{ ufvk, unifiedAddress (Orchard-family + Sapling + transparent), unifiedShieldedAddress
 * (Orchard-family + Sapling), unifiedSaplingTransparentAddress (Sapling + transparent: the Stage-1
 * address), saplingAddress, transparentAddress, diversifierIndex }`. The seed is never logged or
 * returned.
 * Throws with `code` `invalid_seed_phrase`, `invalid_network` or `invalid_account`.
 */
export function registryKeysFromSeed(seed_phrase: string, network: ZwNetwork, account: number): ZwRegistryKeys;
/**
 * The fee/registry addresses that belong to a viewing key (what `registryKeysFromSeed` returns,
 * without the seed and the key): `{ unifiedAddress, unifiedShieldedAddress,
 * unifiedSaplingTransparentAddress, saplingAddress, transparentAddress, diversifierIndex }`.
 */
export function addressesFromUfvk(ufvk: string, network: ZwNetwork): ZwKeyAddresses;
/**
 * The shape of a raw transaction: version, consensus branch, bundle sizes.
 */
export function inspectTransaction(raw_tx_hex: string, height: number, network: ZwNetwork): ZwTxShape;
/**
 * Describes an encoded Zcash address: `{ network, kind, receivers, hasSapling, hasOrchard,
 * hasTransparent }`. Throws with `code` `invalid_address`.
 */
export function describeAddress(address: string): ZwAddressInfo;
/**
 * The librustzcash / orchard revisions this helper was built from (must match the wallet's).
 */
export function buildInfo(): string;

export type ZwNetwork = "main" | "test" | "regtest";
export interface ZwDecryptedOutput {
  pool: "sapling" | "orchard" | "ironwood";
  outputIndex: number;
  valueZat: number;
  memoText: string | null;
  memoHex: string;
  /** true only for a payment received on the key's external address. */
  incoming: boolean;
  transferType: "incoming" | "internal" | "outgoing";
}
export interface ZwKeyAddresses {
  /** Full unified address: Orchard-family + Sapling + transparent receivers (the Stage-2 engine's `unified`). */
  unifiedAddress: string;
  /** Orchard-family + Sapling receivers, no transparent one (the engine's `unifiedShielded`). */
  unifiedShieldedAddress: string;
  /** Sapling + transparent receivers, no Orchard-family one: the Stage-1 main address (the engine's `unifiedSaplingTransparent`). */
  unifiedSaplingTransparentAddress: string;
  /** The Sapling receiver alone (zs1…). */
  saplingAddress: string;
  /** The transparent receiver alone (t1… / tm…). */
  transparentAddress: string | null;
  diversifierIndex: string;
}
export interface ZwRegistryKeys extends ZwKeyAddresses { ufvk: string; }
export interface ZwAddressInfo {
  network: ZwNetwork;
  kind: "sprout" | "sapling" | "unified" | "transparent-p2pkh" | "transparent-p2sh" | "tex";
  receivers: string[];
  hasSapling: boolean; hasOrchard: boolean; hasTransparent: boolean;
}
export interface ZwTxShape {
  txid: string; version: string; consensusBranchId: string;
  transparentInputs: number; transparentOutputs: number;
  saplingSpends: number; saplingOutputs: number;
  orchardActions: number; ironwoodActions: number;
  hasOrchardBundle: boolean; hasIronwoodBundle: boolean; hasSproutBundle: boolean;
  expiryHeight: number;
}


