/**
 * Address-type recognition for the learning simulators — prefix based, for
 * teaching only (real wallets also verify checksums and encodings).
 */

export type Network = "mainnet" | "testnet";
export type AddressPool = "unified" | "sapling" | "transparent";

export interface AddressInfo {
  readonly network: Network;
  readonly pool: AddressPool;
  readonly shielded: boolean;
}

const PREFIXES: readonly [string, AddressInfo][] = [
  // Longest prefixes first so "utest1" is not read as "u1"-ish, "ztestsapling1" before "z".
  ["ztestsapling1", { network: "testnet", pool: "sapling", shielded: true }],
  ["utest1", { network: "testnet", pool: "unified", shielded: true }],
  ["zs1", { network: "mainnet", pool: "sapling", shielded: true }],
  ["u1", { network: "mainnet", pool: "unified", shielded: true }],
  ["tm", { network: "testnet", pool: "transparent", shielded: false }],
  ["t2", { network: "testnet", pool: "transparent", shielded: false }],
  ["t1", { network: "mainnet", pool: "transparent", shielded: false }],
  ["t3", { network: "mainnet", pool: "transparent", shielded: false }],
];

export function classifyAddress(address: string): AddressInfo | null {
  const value = address.trim();
  if (value.length < 20 || !/^[a-z0-9]+$/i.test(value)) return null;
  for (const [prefix, info] of PREFIXES) if (value.startsWith(prefix)) return info;
  return null;
}

/** ZIP-317 conventional fee for a transaction with this many logical actions (inputs/outputs), in ZEC. */
export function conventionalFeeZec(logicalActions: number): number {
  return (5000 * Math.max(2, logicalActions)) / 1e8;
}

export type SendCheck =
  | { readonly ok: true; readonly info: AddressInfo; readonly fee: number }
  | { readonly ok: false; readonly reason: "invalid-address" | "wrong-network" | "insufficient-funds" | "bad-amount"; readonly message: string };

/** The checks a careful wallet runs before letting you send. */
export function checkSend(walletNetwork: Network, balance: number, address: string, amount: number): SendCheck {
  const info = classifyAddress(address);
  if (!info) return { ok: false, reason: "invalid-address", message: "This does not look like a Zcash address." };
  if (info.network !== walletNetwork) {
    return { ok: false, reason: "wrong-network", message: `That is a ${info.network} address, but this wallet is on ${walletNetwork}. Coins cannot cross networks.` };
  }
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "bad-amount", message: "Enter an amount greater than zero." };
  const fee = conventionalFeeZec(2);
  if (amount + fee > balance + 1e-9) {
    return { ok: false, reason: "insufficient-funds", message: `Amount + fee (${(amount + fee).toFixed(4)}) is more than your balance (${balance.toFixed(4)}).` };
  }
  return { ok: true, info, fee };
}
