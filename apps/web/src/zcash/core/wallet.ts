// In-browser Zcash wallet (WebZjs WASM) — REAL on-chain wallet (network: see ZCASH_NETWORK).
//
// What this does, entirely in the user's browser (no server holds keys):
//   • build a spend-capable wallet from a BIP-39 seed
//   • sync via grpc-web proxy only (→ testnet lightwalletd)
//   • read the shielded balance + the unified receive address
//   • SEND a shielded payment carrying a ZIP-302 MEMO to a recipient
//
// Built on @chainsafe/webzjs-wallet (a vendored WebZjs build, patched to accept a memo on propose_transfer). ADR-018 § 3
// (Stage 2): with VITE_ZCASH_NETWORK=main the alias points at the Stage 2 "Ironwood" mainnet engine (NU6.3, upstream
// zcash_client_sqlite in wasm; its build scripts and API reference are published separately), whose extra API (the five addresses, per-pool zatoshi balances, the general multi-output send with TEX withdrawals,
// shielding into Ironwood, the upgrade guard) is exposed below as the optional `mainnetEngine` part of ZecWallet.
// CLIENT-ONLY: import dynamically (await import) — never on the server / SSR.
//
// Gotchas baked in here:
//   • initWasm + initThreadPool exactly ONCE per page load (guarded singletons)
//   • requires cross-origin isolation (COOP + COEP credentialless headers)
//   • new wallets use birthday = current tip → fast sync (full history would be ~tens of minutes)
//   • proving a send spawns a worker and takes ~25–45 s on the Stage-2 engine — callers should show progress
//   • the Stage-2 engine refuses a Stage-1 save (`wallet_format_unsupported`, thrown by the constructor): the adapter
//     restores the wallet from the seed and its birthday (ZcashWalletAdapter, zcash/stage1Save.ts)

import { ZCASH_NETWORK } from "./wallet-types";
import { mnemonicToSeedSync } from "@scure/bip39";

const ZAT = 100_000_000; // zatoshis per ZEC
/** The shielding threshold the game passes (wasm-bindgen `Option<u64>` takes a bigint). */
export const SHIELD_THRESHOLD_ZAT = 1n;

// TEST SEAM: Allow overriding wallet factory for unit tests
// In production: null (use real openWallet). In tests: provide a mock factory.
export const __testSeam = {
  walletFactory: null as ((opts: any) => Promise<ZecWallet>) | null,
};

export type WalletBalances = {
  /** spendable total across pools, in ZEC. Mainnet: the SHIELDED spendable balance (Ironwood + Sapling + legacy Orchard). */
  totalZec: number;
  /** received-but-not-yet-spendable (awaiting confirmations) + pending change, in ZEC */
  pendingZec: number;
  /** confirmed TRANSPARENT (unshielded) balance, in ZEC — what can be shielded */
  transparentZec: number;
  raw: unknown;
  chainTipHeight: number;
  fullyScannedHeight: number;
  /** Confirmed transparent funds `shield` can spend now, in ZEC. */
  shieldableZec?: number;
  /** The spendable shielded balance per pool, in ZEC (display only). */
  shieldedPools?: { ironwoodZec: number; saplingZec: number; orchardZec: number };
};

/** One output of the mainnet engine's `send` (amount in whole zatoshis, as a decimal string). */
export type SendOutput = { to: string; amountZat: string; memo?: string; withdrawal?: boolean };
/** How the engine paid one output — `ironwood` for a UA with an Orchard-family receiver; `tex` for a ZIP 320 withdrawal. */
export type ResolvedOutput = { to: string; pool: "ironwood" | "sapling" | "transparent"; amountZat: number; hasMemo: boolean; tex?: boolean };
/** `txids`: ONE transaction, or TWO for a TEX withdrawal (broadcast order); `feeZat` covers all of them. */
export type SendResult = { txids: string[]; feeZat: number; amountZat: number; outputs: ResolvedOutput[] };
export type ShieldResult = { txid: string; utxos: number; transparentInZat: number; feeZat: number; shieldedZat: number; pool?: "ironwood" };
export type SendingStatus = { allowed: boolean; expectedBranch: string; chainBranch: string | null; code: string | null; reason: string | null; pendingUpgrade: { name: string; height: number } | null };
/**
 * ADR-018 § 1 (Stage 2): the owner's addresses — one diversifier index, so all carry
 * the same Sapling and transparent receivers.
 */
export type ReceiveAddresses = {
  /** The main address: Orchard-family + Sapling + transparent receivers — any Zcash wallet can pay it. */
  unified: string;
  /** Orchard-family + Sapling, no transparent receiver: what a recipient seals in a player payment (no public receiver). */
  unifiedShielded: string;
  /** Sapling + transparent (the Stage-1 main address; still received). */
  unifiedSaplingTransparent: string;
  sapling: string;
  /** The "exchange address" (public on chain). */
  transparent: string;
};

/** ADR-018 § 1–3: what only the mainnet (Stage 2) engine can do. Absent on the test-chain engine. */
export type MainnetEngine = {
  addresses: () => Promise<ReceiveAddresses>;
  sendingStatus: () => Promise<SendingStatus>;
  previewSend: (outputs: SendOutput[]) => Promise<SendResult>;
  /** ONE transaction for all outputs (a player payment + the project fee output, a name fee, a withdrawal); two for a TEX withdrawal. */
  send: (outputs: SendOutput[]) => Promise<SendResult>;
  previewShield: () => Promise<ShieldResult>;
  shield: () => Promise<ShieldResult>;
};

export type ZecWallet = {
  accountId: number;
  createdWithBirthday: number | null;
  sync: () => Promise<void>;
  address: () => Promise<string>;
  transparentAddress: () => Promise<string>;
  balances: () => Promise<WalletBalances>;
  tip: () => Promise<number>;
  /** Send shielded transaction with memo. amountZatoshi must be positive integer. */
  sendWithMemo: (toAddress: string, amountZatoshi: bigint, memo: string) => Promise<string>;
  /** Send transaction. amountZatoshi must be positive integer. */
  send: (toAddress: string, amountZatoshi: bigint) => Promise<string>;
  shield: () => Promise<boolean>;
  exportDb: () => Promise<Uint8Array>;
  /** Query transaction history to check transaction status. */
  getTransactionHistory: (limit?: number, offset?: number) => Promise<any>;
  /** The Stage 2 engine's extra API (mainnet only). */
  mainnetEngine?: MainnetEngine;
};

/** Parse decimal ZEC string to exact integer zatoshi. Rejects invalid input. */
export function parseZecToZatoshi(zecString: string): bigint {
  const trimmed = zecString.trim();
  if (!trimmed) throw new Error("Empty amount");

  // Check for invalid formats
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Invalid format: must be decimal number");
  }

  const parts = trimmed.split(".");
  const integer = parts[0] || "0";
  const rawFractional = parts[1] || "";

  if (rawFractional.length > 8) {
    throw new Error("Too many decimal places: maximum 8");
  }

  const fractional = rawFractional.padEnd(8, "0");

  const zatoshi = BigInt(integer) * BigInt(ZAT) + BigInt(fractional);

  if (zatoshi <= 0n) {
    throw new Error("Amount must be positive");
  }

  if (zatoshi > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount too large");
  }

  return zatoshi;
}

// @ts-ignore - @chainsafe/webzjs-wallet is the vendored wallet engine build, not an npm package
type WalletMod = typeof import("@chainsafe/webzjs-wallet");
let modPromise: Promise<WalletMod> | null = null;
let proxyUrl: string | null = null;

export function setProxyUrl(url: string): void {
  proxyUrl = url;
}

async function getProxyUrl(): Promise<string> {
  if (!proxyUrl) {
    throw new Error(
      "Proxy URL not configured. Call setProxyUrl() before opening wallet."
    );
  }
  return proxyUrl;
}

/** Load + init the WASM module and the rayon thread pool — exactly once per page load. */
async function loadWallet(): Promise<WalletMod> {
  if (typeof window === "undefined") {
    throw new Error("WebZjs wallet is browser-only");
  }
  if (!modPromise) {
    modPromise = (async () => {
      // Dev: the Vite alias resolves the vendored package. Production: the engine is copied verbatim to
      // /webzjs/ (see vite.config.ts copyWalletEngine) and loaded as plain browser modules — Vite can't
      // bundle wasm-bindgen-rayon's self-spawning workers.
      const m: WalletMod = import.meta.env.PROD
        ? await import(/* @vite-ignore */ new URL("webzjs/webzjs_wallet.js", document.baseURI).href)
        : // @ts-ignore - @chainsafe/webzjs-wallet is the vendored wallet engine build, not an npm package
          await import("@chainsafe/webzjs-wallet");
      await m.default(); // instantiate WASM
      const threads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
      await m.initThreadPool(threads);
      return m;
    })();
  }
  return modPromise;
}

/** Diagnostic: construct a wallet and do ONE unary call (get_latest_block) — no account, no sync.
 *  Isolates whether the grpc-web proxy → testnet lightwalletd path works for a real gRPC call. */
export async function probeTip(): Promise<number> {
  const m = await loadWallet();
  const proxy = await getProxyUrl();
  const w = new m.WebWallet(ZCASH_NETWORK, proxy, 1, 1, null);
  const tip = await w.get_latest_block();
  return Number(tip);
}

const num = (v: any): number =>
  typeof v === "bigint"
    ? Number(v)
    : typeof v === "string"
      ? Number(v)
      : typeof v === "number"
        ? v
        : 0;

/**
 * The Stage 2 engine's balances as the game shows them — spendable = `shieldedSpendableZat`
 * (Ironwood + Sapling + legacy Orchard: what `send` can use; Stage 1 showed `saplingSpendableZat`, which now excludes
 * Ironwood, where change and shielded funds go), pending = `shieldedPendingZat`, "waiting to be shielded" = the
 * transparent balance (`transparentShieldableZat` is what Shield moves now). Exported for the unit tests.
 */
export function mainnetBalances(b: any): WalletBalances {
  return {
    totalZec: num(b?.shieldedSpendableZat) / ZAT,
    pendingZec: num(b?.shieldedPendingZat) / ZAT,
    transparentZec: num(b?.transparentTotalZat) / ZAT,
    shieldableZec: num(b?.transparentShieldableZat) / ZAT,
    shieldedPools: {
      ironwoodZec: num(b?.ironwoodSpendableZat) / ZAT,
      saplingZec: num(b?.saplingSpendableZat) / ZAT,
      orchardZec: num(b?.orchardSpendableZat) / ZAT,
    },
    raw: b,
    chainTipHeight: num(b?.chainTipHeight),
    fullyScannedHeight: num(b?.fullyScannedHeight),
  };
}

/** The engine's `get_addresses()` as the game uses it; throws when a field is missing. */
export function mainnetAddresses(a: any): ReceiveAddresses {
  const field = (name: string): string => {
    const value = a?.[name];
    if (typeof value !== "string" || value.length === 0) throw new Error(`the wallet engine returned no ${name} address`);
    return value;
  };
  return {
    unified: field("unified"),
    unifiedShielded: field("unifiedShielded"),
    unifiedSaplingTransparent: field("unifiedSaplingTransparent"),
    sapling: field("sapling"),
    transparent: field("transparent"),
  };
}

export async function openWallet(opts: {
  seedPhrase: string;
  hdIndex?: number;
  dbBytes?: Uint8Array | null;
  birthdayHeight?: number | null;
  knownAccountId?: number | null;
}): Promise<ZecWallet> {
  // TEST SEAM: use mock factory if provided (for unit tests)
  if (__testSeam.walletFactory) {
    return __testSeam.walletFactory(opts);
  }

  const m = await loadWallet();
  const proxy = await getProxyUrl();
  const seed = opts.seedPhrase.trim().toLowerCase();
  const hd = opts.hdIndex ?? 0;
  const net = ZCASH_NETWORK;

  // The Stage 2 engine's constructor throws `wallet_format_unsupported` (with `e.code`) for a Stage-1
  // save or damaged bytes — it propagates to the adapter, which restores from the seed + birthday.
  let w = new m.WebWallet(net, proxy, 1, 1, opts.dbBytes ?? null);
  let accountId = 0;

  let usable = false;
  if (opts.dbBytes) {
    const tryId = opts.knownAccountId ?? 0;
    try {
      await w.get_current_address(tryId);
      usable = true;
      accountId = tryId;
    } catch {
      usable = false;
    }
  }
  let createdWithBirthday: number | null = null;
  if (!usable) {
    w = new m.WebWallet(net, proxy, 1, 1, null);
    let birthday = opts.birthdayHeight ?? null;
    if (birthday == null) {
      const tip = await w.get_latest_block();
      birthday = Math.max(1, Number(tip) - 100);
    }
    accountId = Number(await w.create_account("Zocial World", seed, hd, birthday));
    createdWithBirthday = birthday;
  }

  const parseBalances = (summary: any): { spendableZat: number; pendingZat: number; transparentZat: number } => {
    let spendableZat = 0, pendingZat = 0, transparentZat = 0;
    const ab = summary?.account_balances;
    if (Array.isArray(ab)) {
      for (const entry of ab) {
        const b = (Array.isArray(entry) ? entry[1] : entry) as any;
        if (!b) continue;
        const t = num(b.unshielded_balance);
        spendableZat += num(b.sapling_balance) + num(b.orchard_balance) + t;
        pendingZat += num(b.pending_change) + num(b.pending_spendable);
        transparentZat += t;
      }
    }
    return { spendableZat, pendingZat, transparentZat };
  };

  // ADR-018 § 3: the Stage 2 engine — the five addresses (main = full UA), spends from Ironwood, Sapling
  // and legacy Orchard notes in v6 transactions (one per send, two for a TEX withdrawal), shielding into Ironwood and
  // the consensus-branch guard. Typed loosely: the TypeScript types resolve to the test-chain engine's declarations
  // (the mainnet engine's own .d.ts has the real ones).
  const engine: any = w;
  // The addresses never change for an account (one diversifier index): asked once. The engine answers them under the
  // database lock, so the cache also keeps a player payment from waiting for a long sync (a migration rescan).
  let addressesOnce: Promise<ReceiveAddresses> | null = null;
  const mainnetEngine: MainnetEngine | undefined =
    net === "main"
      ? {
          addresses: () => {
            if (!addressesOnce) {
              addressesOnce = (async () => mainnetAddresses(await engine.get_addresses(accountId)))();
              addressesOnce.catch(() => {
                addressesOnce = null; // a failed answer is asked again next time
              });
            }
            return addressesOnce;
          },
          sendingStatus: async () => (await engine.sending_status()) as SendingStatus,
          previewSend: async (outputs) => (await engine.preview_send(accountId, outputs)) as SendResult,
          send: async (outputs) => (await engine.send(accountId, outputs, seed, hd)) as SendResult,
          // Threshold 1 zat — every confirmed transparent deposit that can pay the network fee (plus a
          // non-dust remainder) shields; the engine's old 100,000-zat default left deposits under 0.001 ZEC stuck.
          previewShield: async () => (await engine.preview_shield(accountId, SHIELD_THRESHOLD_ZAT)) as ShieldResult,
          shield: async () => (await engine.shield(accountId, seed, hd, SHIELD_THRESHOLD_ZAT)) as ShieldResult,
        }
      : undefined;
  const sendOne = async (toAddress: string, amountZatoshi: bigint, memo: string | undefined): Promise<string> => {
    const result = await mainnetEngine!.send([{ to: toAddress, amountZat: amountZatoshi.toString(), ...(memo ? { memo } : {}) }]);
    return result.txids[0]!;
  };

  return {
    accountId,
    createdWithBirthday,
    ...(mainnetEngine ? { mainnetEngine } : {}),
    sync: async () => {
      await w.sync();
    },
    address: async () => w.get_current_address(accountId),
    transparentAddress: async () => w.get_current_address_transparent(accountId),
    tip: async () => Number(await w.get_latest_block()),
    balances: async () => {
      if (mainnetEngine) return mainnetBalances(await engine.get_balances(accountId));
      const s: any = await w.get_wallet_summary();
      const { spendableZat, pendingZat, transparentZat } = parseBalances(s);
      return {
        totalZec: spendableZat / ZAT,
        pendingZec: pendingZat / ZAT,
        transparentZec: transparentZat / ZAT,
        raw: s,
        chainTipHeight: Number(s?.chain_tip_height ?? 0),
        fullyScannedHeight: Number(s?.fully_scanned_height ?? 0),
      };
    },
    sendWithMemo: async (toAddress, amountZatoshi, memo) => {
      if (mainnetEngine) return sendOne(toAddress, amountZatoshi, memo);
      const proposal = await w.propose_transfer(accountId, toAddress, amountZatoshi, memo);
      const txids = await w.create_proposed_transactions(proposal, seed, hd);
      await w.send_authorized_transactions(txids);
      return txidToHex(txids.slice(0, 32) as Uint8Array);
    },
    send: async (toAddress, amountZatoshi) => {
      if (mainnetEngine) return sendOne(toAddress, amountZatoshi, undefined);
      const proposal = await w.propose_transfer(accountId, toAddress, amountZatoshi, undefined);
      const txids = await w.create_proposed_transactions(proposal, seed, hd);
      await w.send_authorized_transactions(txids);
      return txidToHex(txids.slice(0, 32) as Uint8Array);
    },
    shield: async () => {
      if (mainnetEngine) {
        await mainnetEngine.shield();
        return true;
      }
      const pczt0 = await w.pczt_shield(accountId);
      const seedBytes = mnemonicToSeedSync(seed);
      const usk = new m.UnifiedSpendingKey(net, seedBytes, hd);
      const fp = new m.SeedFingerprint(seedBytes);
      const signed = await m.pczt_sign(net, pczt0, usk, fp);
      const proved = await w.pczt_prove(signed, undefined);
      await w.pczt_send(proved);
      return true;
    },
    exportDb: async () => new Uint8Array(await w.db_to_bytes()),
    getTransactionHistory: async (limit = 50, offset = 0) => {
      return await w.get_transaction_history(accountId, limit, offset);
    },
  };
}

/**
 * A transaction id as explorers, RPC (`getrawmempool`) and WebZjs's own transaction history print
 * it: the 32 raw bytes in reverse order, as hex. `create_proposed_transactions` returns them in
 * internal (little-endian) order.
 */
export function txidToHex(raw: Uint8Array): string {
  return Array.from(raw, (b: number) => b.toString(16).padStart(2, "0")).reverse().join("");
}
