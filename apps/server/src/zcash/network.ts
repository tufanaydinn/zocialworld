import { parseZecToZat } from "../identity/nameConfig.js";
import type { NameRegistryInfo } from "../identity/nameService.js";

/**
 * Which Zcash network this game server serves (ADR-018), from the environment:
 *
 *   ZCASH_NETWORK     test (default) | main
 *   LIGHTWALLETD_URL  the wallet bridge's upstream (and the fee checks' transaction source).
 *                     Default: https://zec.rocks:443 on main, https://testnet.zec.rocks:443 on test; `off` disables it.
 *                     An ordered, comma-separated list (at most 5) is tried in order with health-based
 *                     failover (zcash/upstreamPool.ts), e.g. `https://zec.rocks:443,https://eu.zec.rocks:443`.
 *   PAYMENT_CAP_ZEC   ADR-018 § 4 per-transaction cap on relayed payment requests. Default 0.01 on main, off on
 *                     test; `off` removes it.
 *   NU7_ACTIVATION_HEIGHT  the NU7 activation height of this network once it is announced (optional). The
 *                     fee checks then wait out NU7's longer transaction expiry (ZIP 218) near and after it.
 *   PAYMENT_FEE_USD   the operator's approximate US-dollar value of the transfer fee (e.g. `1`), shown by
 *   NAME_FEE_USD      clients as "≈ US$1" next to the ZEC amount; likewise for the name fee. Unset: no fiat label (the
 *                     fees are fixed ZEC amounts — re-check the label whenever the price or PAYMENT_FEE_ZEC /
 *                     NAME_FEE_ZEC changes). At most 2 decimals, above 0 and at most 1000.
 *
 * Fail closed on main with test-chain-only settings: the test-coin faucet (ZCASHD_RPC_URL) and the zcashd/dev name
 * registries (zcashd stopped following mainnet; dev confirms names without payment). The web client must be built
 * for the same network (VITE_ZCASH_NETWORK) — a mismatched client refuses the server's quotes.
 */

export type ZcashNetwork = "main" | "test";

export interface ZcashServerConfig {
  readonly network: ZcashNetwork;
  /** The primary upstream; null = the bridge is off (`LIGHTWALLETD_URL=off`). */
  readonly lightwalletdUrl: string | null;
  /** Every upstream in failover order (the primary first); empty when the bridge is off. */
  readonly lightwalletdUrls: readonly string[];
  /** ADR-018 § 4: the cap in zatoshis, or null without one. */
  readonly paymentCapZat: number | null;
  /** The operator's approximate fiat labels for the fees (PAYMENT_FEE_USD / NAME_FEE_USD), or null. */
  readonly paymentFeeUsd: number | null;
  readonly nameFeeUsd: number | null;
  /** NU7_ACTIVATION_HEIGHT, or null while it is not known. */
  readonly nu7ActivationHeight: number | null;
}

export type ZcashConfigResult = { readonly ok: true; readonly config: ZcashServerConfig } | { readonly ok: false; readonly error: string };

export const MAINNET_LIGHTWALLETD_URL = "https://zec.rocks:443";
export const TESTNET_LIGHTWALLETD_URL = "https://testnet.zec.rocks:443";
/** How many upstreams LIGHTWALLETD_URL may list. */
export const MAX_LIGHTWALLETD_URLS = 5;
/** ADR-018 § 4: a 0.01 ZEC cap by default, which the operator can lift (PAYMENT_CAP_ZEC=off). */
export const DEFAULT_MAINNET_CAP_ZEC = "0.01";

export function loadZcashServerConfig(env: Record<string, string | undefined>): ZcashConfigResult {
  const raw = (env.ZCASH_NETWORK ?? "").trim().toLowerCase() || "test";
  if (raw !== "main" && raw !== "test") return { ok: false, error: `ZCASH_NETWORK must be test or main (got "${raw.slice(0, 20)}")` };
  const network: ZcashNetwork = raw;

  if (network === "main") {
    if (env.ZCASHD_RPC_URL?.trim()) {
      return { ok: false, error: "refusing to start: ZCASH_NETWORK=main with the test-coin faucet configured (ZCASHD_RPC_URL) — the faucet exists only on the project's test chain (ADR-018 § 4)" };
    }
    const registry = (env.NAME_REGISTRY ?? "").trim().toLowerCase();
    if (registry === "zcashd" || registry === "dev") {
      return { ok: false, error: `refusing to start: ZCASH_NETWORK=main with NAME_REGISTRY=${registry} — on mainnet the registry is "lightwalletd" (ADR-018 § 5) or off` };
    }
  }

  const configuredUrl = env.LIGHTWALLETD_URL?.trim();
  const lightwalletdUrls =
    configuredUrl === "off"
      ? []
      : configuredUrl
        ? configuredUrl.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")
        : [network === "main" ? MAINNET_LIGHTWALLETD_URL : TESTNET_LIGHTWALLETD_URL];
  if (configuredUrl && configuredUrl !== "off" && lightwalletdUrls.length === 0) return { ok: false, error: "LIGHTWALLETD_URL must be an http(s) URL, a comma-separated list of them, or off" };
  if (lightwalletdUrls.length > MAX_LIGHTWALLETD_URLS) return { ok: false, error: `LIGHTWALLETD_URL lists more than ${MAX_LIGHTWALLETD_URLS} upstreams` };
  for (const entry of lightwalletdUrls) {
    try {
      const url = new URL(entry);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    } catch {
      return { ok: false, error: "LIGHTWALLETD_URL must be an http(s) URL, a comma-separated list of them, or off" };
    }
  }
  if (new Set(lightwalletdUrls).size !== lightwalletdUrls.length) return { ok: false, error: "LIGHTWALLETD_URL lists the same upstream twice" };
  const lightwalletdUrl = lightwalletdUrls[0] ?? null;

  const capText = env.PAYMENT_CAP_ZEC?.trim() || (network === "main" ? DEFAULT_MAINNET_CAP_ZEC : "off");
  let paymentCapZat: number | null = null;
  if (capText.toLowerCase() !== "off") {
    paymentCapZat = parseZecToZat(capText);
    if (paymentCapZat === null || paymentCapZat <= 0) return { ok: false, error: "PAYMENT_CAP_ZEC must be a positive ZEC amount (at most 8 decimals) or off" };
  }
  const paymentFeeUsd = parseFeeUsd(env.PAYMENT_FEE_USD);
  if (paymentFeeUsd === "invalid") return { ok: false, error: "PAYMENT_FEE_USD must be an approximate US-dollar amount above 0 and at most 1000, with at most 2 decimals (e.g. 1), or unset" };
  const nameFeeUsd = parseFeeUsd(env.NAME_FEE_USD);
  if (nameFeeUsd === "invalid") return { ok: false, error: "NAME_FEE_USD must be an approximate US-dollar amount above 0 and at most 1000, with at most 2 decimals (e.g. 1), or unset" };
  const nu7Text = env.NU7_ACTIVATION_HEIGHT?.trim() ?? "";
  const nu7ActivationHeight = nu7Text === "" ? null : /^\d{1,9}$/.test(nu7Text) && Number(nu7Text) > 0 ? Number(nu7Text) : NaN;
  if (Number.isNaN(nu7ActivationHeight)) return { ok: false, error: "NU7_ACTIVATION_HEIGHT must be a block height (a positive whole number) or unset" };
  return { ok: true, config: { network, lightwalletdUrl, lightwalletdUrls, paymentCapZat, paymentFeeUsd, nameFeeUsd, nu7ActivationHeight } };
}

/** "1" → 1, "1.25" → 1.25; unset/empty → null; anything else (or ≤ 0, > 1000) → "invalid". */
export function parseFeeUsd(raw: string | undefined): number | null | "invalid" {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return "invalid";
  const value = Number(text);
  return value > 0 && value <= 1000 ? value : "invalid";
}

/**
 * GET /zcash/info's non-secret fields (ADR-016, ADR-018 § 4/§ 6): the network, the name mode and fee, the
 * transfer fee and cap, and the operator's fiat labels — a label only next to a fee that is actually charged. Never an
 * address or a key.
 */
export function publicZcashInfo(config: ZcashServerConfig, names: NameRegistryInfo, paymentFeeZat: number): Record<string, unknown> {
  return {
    names: { ...names, feeUsd: names.mode === "fee" && names.feeZat > 0 ? config.nameFeeUsd : null },
    network: config.network,
    payments: { feeZat: paymentFeeZat, capZat: config.paymentCapZat, feeUsd: paymentFeeZat > 0 ? config.paymentFeeUsd : null },
  };
}

/** For the startup log (no secrets here, but kept short). */
export function describeZcashServerConfig(config: ZcashServerConfig): string {
  const cap = config.paymentCapZat === null ? "no payment cap" : `payment cap ${config.paymentCapZat / 1e8} ZEC per transaction`;
  return `${config.network === "main" ? "MAINNET (real ZEC — ADR-018 beta, Stage 2 wallet)" : "test chain"}; ${cap}`;
}
