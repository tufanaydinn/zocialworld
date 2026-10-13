import { readFileSync } from "node:fs";
import { NAME_DEV_ADDRESS, NAME_FEE_MAX_ZAT } from "@project/shared";

/**
 * Name registry configuration (ADR-016; ADR-018 § 5), from the environment:
 *
 *   NAME_REGISTRY              off (default) | dev | zcashd | lightwalletd
 *   NAME_REGISTRY_ADDRESS      the registry's shielded address. zcashd/dev: a TEST-chain unified address
 *                              (uregtest1… / utest1…). lightwalletd: one of the viewing key's shielded addresses on
 *                              the server's network — preferably the full u1… (Orchard + Sapling + transparent
 *                              receivers) that scripts/tools/registry-keys.mjs prints; its shielded u1…, its
 *                              Stage 1 unified address (Sapling + transparent) or its zs1… also work. Each has a Sapling receiver.
 *   NAME_REGISTRY_UFVK         lightwalletd: the registry account's unified full viewing key (or NAME_REGISTRY_UFVK_FILE,
 *                              a file holding it). Never logged. The address must be one of the key's own addresses.
 *   NAME_REGISTRY_MAINNET_ACK  lightwalletd on mainnet: must be `accepted` (the operator's explicit opt-in, ADR-018 § 5),
 *                              else "disabled".
 *   NAME_FEE_ZEC               the confirmation fee: default 0.00075 on mainnet (≈ US$1, ADR-018 § 5), 0.01 on the
 *                              test chain (at most 0.1)
 *   NAME_MIN_CONF              lightwalletd: confirmations a payment needs (default 1)
 *   NAME_REGISTRY_FILE         the JSON store, default ./data/names.json (zcashd, lightwalletd); dev keeps names in
 *                              memory unless set
 *   NAME_DEV_CONFIRM_MS        dev only: how long until the fake payment confirms (default 2000)
 *   ZCASHD_RPC_*               the faucet's zcashd RPC settings (zcash/faucet.ts), reused by the zcashd scanner
 *
 * Modes the server runs in:
 *  - `off`: no registry — ADR-015's honour mode: holders name themselves with set_nickname (free, not owned,
 *    nothing stored). Local development and the default.
 *  - `dev`: fee flow with a fake scanner that confirms every reservation after ~2 s. Refuses to start with
 *    NODE_ENV=production.
 *  - `zcashd`: the real flow on a test chain run by the deployment.
 *  - `lightwalletd` (ADR-018 § 5): the paying client reports its txid (`name_payment_sent`); the server fetches that
 *    transaction through its own lightwalletd connection and trial-decrypts it with the registry's viewing key
 *    (vendor/zcash-tx-decrypt). The mainnet backend (zcashd no longer follows mainnet); works on a test chain too.
 *  - `disabled`: a registry was asked for but is not usable (zcashd without an address or RPC; lightwalletd without
 *    an address, key, bridge or — on mainnet — the operator's acknowledgement). Registration is off, holders keep
 *    Guest-style names and the client says why (ADR-016 § 3). Logged loudly at startup.
 * ZCASH_NETWORK=main refuses zcashd and dev before this runs (zcash/network.ts).
 */

export type NameRegistryMode = "off" | "disabled" | "dev" | "zcashd" | "lightwalletd";

export interface NameRegistryConfig {
  readonly mode: NameRegistryMode;
  /** The address quotes carry (dev: NAME_DEV_ADDRESS unless one is configured); null when there is no registry. */
  readonly address: string | null;
  readonly feeZat: number;
  /** The store file; null keeps registrations in memory (dev without NAME_REGISTRY_FILE). */
  readonly file: string | null;
  readonly devConfirmMs: number;
  /** Why the mode is `disabled` (for the startup log; never contains the address). */
  readonly problem?: string;
  /** lightwalletd: the registry's viewing key (never logged). */
  readonly ufvk?: string;
  /** lightwalletd: confirmations a payment needs (default 1). */
  readonly minConfirmations?: number;
}

export type NameConfigResult = { readonly ok: true; readonly config: NameRegistryConfig } | { readonly ok: false; readonly error: string };

/** A unified address on the test chains only (regtest or testnet HRP) — never mainnet. */
const TEST_CHAIN_UA = /^u(regtest|test)1[0-9a-z]{40,500}$/;
export const DEFAULT_NAME_REGISTRY_FILE = "./data/names.json";
const DEFAULT_FEE = "0.01";
/** ADR-018 § 5: about US$1 at the 2026-10-05/07 price (≈ US$1,310–1,335 per ZEC); the operator re-checks it. */
export const DEFAULT_MAINNET_NAME_FEE = "0.00075";
/** A shielded address on mainnet (u1… / zs1…) — the lightwalletd backend's registry; the startup check (txDecrypt.ts
 *  checkAddressAgainstKey) then requires one of the viewing key's own addresses, which all have a Sapling receiver. */
const MAINNET_SHIELDED = /^(u1[0-9a-z]{40,1000}|zs1[0-9a-z]{60,90})$/;
/** The same on the test chains (regtest or testnet HRPs). */
const TEST_CHAIN_SHIELDED = /^(u(regtest|test)1[0-9a-z]{40,1000}|z(regtest|test)sapling1[0-9a-z]{60,100})$/;
const UFVK = /^uview(test|regtest)?1[0-9a-z]{100,2000}$/;
const DEFAULT_DEV_CONFIRM_MS = 2_000;

/** "0.01" → 1_000_000 zatoshi, exactly (at most 8 decimals); null for anything else. */
export function parseZecToZat(text: string): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100_000_000 + Number((match[2] ?? "").padEnd(8, "0"));
}

/**
 * A viewing key from `name` or the first line of the file named by `${name}_FILE` (NAME_REGISTRY_UFVK,
 * PAYMENT_FEE_UFVK). Null when neither is set; an error names the variable, never the key.
 */
export function readViewingKey(env: Record<string, string | undefined>, name: string): { readonly ufvk: string | null } | { readonly error: string } {
  let value = env[name]?.trim() || null;
  const file = env[`${name}_FILE`]?.trim();
  if (value === null && file) {
    try {
      value = readFileSync(file, "utf8").split("\n")[0]?.trim() || null;
    } catch (error) {
      return { error: `${name}_FILE could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
    }
  }
  if (value !== null && !UFVK.test(value)) return { error: `${name} is not a unified full viewing key (uview1…)` };
  return { ufvk: value };
}

export function loadNameRegistryConfig(
  env: Record<string, string | undefined>,
  options: { readonly rpcConfigured: boolean; readonly network?: "main" | "test"; readonly lightwalletd?: boolean },
): NameConfigResult {
  const network = options.network ?? "test";
  const mode = (env.NAME_REGISTRY ?? "").trim().toLowerCase() || "off";
  if (mode !== "off" && mode !== "dev" && mode !== "zcashd" && mode !== "lightwalletd") return { ok: false, error: `NAME_REGISTRY must be off, dev, zcashd or lightwalletd (got "${mode.slice(0, 20)}")` };
  const feeZat = parseZecToZat(env.NAME_FEE_ZEC?.trim() || (network === "main" ? DEFAULT_MAINNET_NAME_FEE : DEFAULT_FEE));
  if (feeZat === null || feeZat <= 0 || feeZat > NAME_FEE_MAX_ZAT) return { ok: false, error: `NAME_FEE_ZEC must be a positive amount of at most ${NAME_FEE_MAX_ZAT / 1e8} ZEC` };
  const configuredAddress = env.NAME_REGISTRY_ADDRESS?.trim() || null;
  if (mode === "lightwalletd") return loadLightwalletdRegistry(env, { network, feeZat, address: configuredAddress, lightwalletd: options.lightwalletd ?? false });
  if (configuredAddress !== null && !TEST_CHAIN_UA.test(configuredAddress)) {
    return { ok: false, error: "NAME_REGISTRY_ADDRESS must be a test-chain unified address (uregtest1… or utest1…; mainnet is excluded by ADR-016)" };
  }
  const file = env.NAME_REGISTRY_FILE?.trim() || null;
  const base = { feeZat, devConfirmMs: DEFAULT_DEV_CONFIRM_MS };

  if (mode === "off") return { ok: true, config: { ...base, mode: "off", address: null, file: null } };

  if (mode === "dev") {
    if (env.NODE_ENV === "production") {
      return { ok: false, error: "refusing to start: NAME_REGISTRY=dev confirms names without any payment and is for local development and tests only (NODE_ENV=production)" };
    }
    const delay = Number(env.NAME_DEV_CONFIRM_MS ?? DEFAULT_DEV_CONFIRM_MS);
    const devConfirmMs = Number.isInteger(delay) && delay >= 200 && delay <= 600_000 ? delay : DEFAULT_DEV_CONFIRM_MS;
    return { ok: true, config: { ...base, mode: "dev", address: configuredAddress ?? NAME_DEV_ADDRESS, file, devConfirmMs } };
  }

  const problem = configuredAddress === null ? "NAME_REGISTRY_ADDRESS is not set" : !options.rpcConfigured ? "ZCASHD_RPC_URL / ZCASHD_RPC_USER are not set" : null;
  if (problem) return { ok: true, config: { ...base, mode: "disabled", address: null, file: null, problem } };
  return { ok: true, config: { ...base, mode: "zcashd", address: configuredAddress, file: file ?? DEFAULT_NAME_REGISTRY_FILE } };
}

/** NAME_REGISTRY=lightwalletd (ADR-018 § 5): address + viewing key + bridge (+ the operator's acknowledgement on mainnet). */
function loadLightwalletdRegistry(
  env: Record<string, string | undefined>,
  options: { readonly network: "main" | "test"; readonly feeZat: number; readonly address: string | null; readonly lightwalletd: boolean },
): NameConfigResult {
  const { network, feeZat, address } = options;
  const base = { feeZat, devConfirmMs: DEFAULT_DEV_CONFIRM_MS };
  if (address !== null && !(network === "main" ? MAINNET_SHIELDED : TEST_CHAIN_SHIELDED).test(address)) {
    return {
      ok: false,
      error:
        network === "main"
          ? "NAME_REGISTRY_ADDRESS must be a mainnet shielded address with a Sapling receiver (u1… or zs1…)"
          : "NAME_REGISTRY_ADDRESS must be a test-chain shielded address (uregtest1…, utest1…, zregtestsapling1…, ztestsapling1…)",
    };
  }
  const key = readViewingKey(env, "NAME_REGISTRY_UFVK");
  if ("error" in key) return { ok: false, error: key.error };
  const minConf = Number(env.NAME_MIN_CONF ?? 1);
  if (!Number.isInteger(minConf) || minConf < 0 || minConf > 100) return { ok: false, error: "NAME_MIN_CONF must be a whole number of confirmations (0–100)" };
  const disabled = (problem: string): NameConfigResult => ({ ok: true, config: { ...base, mode: "disabled", address: null, file: null, problem } });
  if (address === null) return disabled("NAME_REGISTRY_ADDRESS is not set");
  if (key.ufvk === null) return disabled("NAME_REGISTRY_UFVK (or NAME_REGISTRY_UFVK_FILE) is not set");
  if (!options.lightwalletd) return disabled("the wallet bridge is off (LIGHTWALLETD_URL=off), so payments cannot be read");
  if (network === "main" && env.NAME_REGISTRY_MAINNET_ACK?.trim() !== "accepted") {
    return disabled("NAME_REGISTRY_MAINNET_ACK is not set to accepted — mainnet name fees need the operator's explicit acknowledgement (ADR-018 § 5)");
  }
  return {
    ok: true,
    config: { ...base, mode: "lightwalletd", address, file: env.NAME_REGISTRY_FILE?.trim() || DEFAULT_NAME_REGISTRY_FILE, ufvk: key.ufvk, minConfirmations: minConf },
  };
}
