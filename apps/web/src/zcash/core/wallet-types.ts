/// <reference types="vite/client" />
import { isTexAddress } from "../texAddress.ts";

// Zcash wallet types shared by the wallet adapter and the UI.
// Framework-agnostic helpers for Zcash address/key format checks,
// recovery phrase validation, and support-payment request building.
// These checks are format-only (except TEX addresses, see texAddress.ts); the wallet engine
// decodes and validates every recipient for real before it builds a transaction.

export type AddressKind =
  | "unified" // u1…  — modern; bundles transparent + Sapling + Orchard
  | "sapling" // zs…  — shielded
  | "transparent" // t1…/t3… — public, Bitcoin-style
  | "tex" // tex1… — ZIP 320 transparent-source-only (exchange) address; payable as a withdrawal only
  | "sprout" // zc…  — legacy shielded (deprecated)
  | "unknown";

export type WalletSource = "external" | "created";

export type WalletAccount = {
  address: string;
  kind: AddressKind;
  /** Whether funds/activity on this address are private. */
  shielded: boolean;
  source: WalletSource;
  /** Human label, e.g. the external wallet name or "Zocial World wallet". */
  label: string;
  /** Watch-only (address- or viewing-key-imported) → cannot sign/spend. */
  watchOnly: boolean;
  /** Real encoded Unified Full Viewing Key (uviewtest1…) when keys are real. */
  ufvk?: string;
};

/** Retrieve and validate active Zcash network from environment.
 *  Must be exactly "test" or "main". Fails closed on unset or invalid value.
 *  "main" means real ZEC: a mainnet deployment is configured by its operator and is never used in dev/test.
 */
function getZcashNetwork(): "main" | "test" {
  // Support both Vite (import.meta.env) and Node test environment (process.env)
  const network = typeof import.meta !== "undefined" && import.meta.env?.VITE_ZCASH_NETWORK
    ? import.meta.env.VITE_ZCASH_NETWORK
    : process.env.VITE_ZCASH_NETWORK;

  if (!network) {
    throw new Error(
      "VITE_ZCASH_NETWORK not set. See apps/web/.env.example — must be 'test' or 'main'."
    );
  }
  if (network !== "test" && network !== "main") {
    throw new Error(
      `Invalid VITE_ZCASH_NETWORK="${network}". Must be exactly "test" or "main".`
    );
  }
  if (network === "main") {
    console.warn(
      "⚠️ VITE_ZCASH_NETWORK=main: Using mainnet with real ZEC. Use a fresh wallet with a small amount."
    );
  }
  return network as "main" | "test";
}

/** Active Zcash network: fail-closed configuration from VITE_ZCASH_NETWORK environment variable. */
export const ZCASH_NETWORK: "main" | "test" = getZcashNetwork();

// ── External wallets for payments ────────────────────────────────────────────
export type SupportedWallet = {
  id: string;
  name: string;
  note: string;
};

export const SUPPORTED_WALLETS: SupportedWallet[] = [
  { id: "zashi", name: "Zashi / Zodl", note: "ECC official · shielded-first" },
  { id: "ywallet", name: "YWallet", note: "Fast sync · power users" },
  { id: "zingo", name: "Zingo!", note: "Orchard + Unified Address" },
  { id: "zecwallet", name: "Zecwallet", note: "Desktop · Full & Lite" },
  { id: "keystone", name: "Keystone", note: "Hardware · cold storage" },
];

// ── Address detection & validation ──────────────────────────────────────────
// validateAddress() is a FORMAT check for immediate UI feedback:
// - it checks the prefix (u1, zs, t1, t3, zc, zt and their test-network forms), the length range and the character set;
// - it does NOT check bech32/bech32m or base58check checksums or the payload structure (ZIP 316), except for TEX
//   addresses, which are decoded for real (texAddress.ts).
//
// A mistyped address with a plausible prefix and length can therefore pass validateAddress(). It is caught one step
// later: the wallet engine decodes every recipient (checksum, payload, network) before it builds a transaction and
// refuses an invalid one with a coded error (`invalid_address`, `recipient_wrong_network`, … — see engineErrors.ts),
// so nothing is sent. The UI additionally gates player payments on isShieldedKind().

export function detectAddressKind(raw: string): AddressKind {
  const a = raw.trim();
  // The test-network wallet engine maps "test" to REGTEST (the project's own NU6.1 chain), so regtest HRPs must be
  // recognised too.
  if (/^u(test|regtest)?1[0-9a-z]{30,}$/i.test(a)) return "unified";
  if (/^(zs1|ztestsapling1|zregtestsapling1)[0-9a-z]{20,}$/i.test(a)) return "sapling";
  if (/^(zc|zt)[0-9a-zA-Z]{60,}$/.test(a)) return "sprout";
  // A TEX address is checked for real (bech32m checksum, 20-byte payload — zcash/texAddress.ts).
  if (isTexAddress(a)) return "tex";
  if (/^(t[123]|tm)[0-9a-zA-Z]{30,45}$/.test(a)) return "transparent";
  return "unknown";
}

export function isShieldedKind(kind: AddressKind): boolean {
  return kind === "unified" || kind === "sapling" || kind === "sprout";
}

export type AddressValidation = {
  ok: boolean;
  kind: AddressKind;
  message?: string;
};

export function validateAddress(raw: string): AddressValidation {
  const a = raw.trim();
  if (!a) return { ok: false, kind: "unknown", message: "Enter a Zcash address." };
  const kind = detectAddressKind(a);
  switch (kind) {
    case "unified":
    case "sapling":
      return { ok: true, kind };
    case "transparent":
      return {
        ok: true,
        kind,
        message: "Transparent address — activity is public. A shielded (u1…) address is recommended.",
      };
    case "tex":
      return {
        ok: true,
        kind,
        message: "TEX (exchange) address — the amount becomes public. Only a withdrawal can pay it.",
      };
    case "sprout":
      return {
        ok: false,
        kind,
        message: "Sprout (zc…) addresses are deprecated. Use a Unified Address (u1…).",
      };
    default:
      return {
        ok: false,
        kind: "unknown",
        message: "Not a recognized Zcash address (expected u1…, zs…, t1… or tex1…).",
      };
  }
}

/** Privacy-preserving display form, e.g. "u1qx…7f3a". */
export function maskAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

// ── Recovery phrase & key import validation ──────────────────────────────────
export function validateSeedPhrase(input: string): {
  ok: boolean;
  message?: string;
  words: string[];
} {
  const words = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { ok: false, message: "Enter your recovery phrase.", words };
  if (![12, 15, 18, 21, 24].includes(words.length))
    return { ok: false, message: `Expected 12–24 words (got ${words.length}).`, words };
  return { ok: true, words };
}

export type KeyValidation = { ok: boolean; message?: string; watchOnly: boolean };

export function validateKey(input: string): KeyValidation {
  const k = input.trim();
  if (!k) return { ok: false, message: "Enter a viewing or spending key.", watchOnly: true };
  if (/^uview[0-9a-z]{20,}$/i.test(k)) return { ok: true, watchOnly: true }; // Unified FVK
  if (/^uivk[0-9a-z]{20,}$/i.test(k)) return { ok: true, watchOnly: true }; // Unified IVK
  if (/^zxviews[0-9a-z]{20,}$/i.test(k)) return { ok: true, watchOnly: true }; // Sapling EFVK
  if (/^secret-extended-key[0-9a-z-]{20,}$/i.test(k)) return { ok: true, watchOnly: false }; // Sapling spend
  return {
    ok: false,
    watchOnly: true,
    message: "Not a recognized key (expected uview…, uivk… or zxviews…).",
  };
}

// ── ZIP-321 payment-request URI builder ──────────────────────────────────────
export type Zip321Request = {
  address: string;
  amountZecDecimal?: string; // exact decimal string, no floating point
  memo?: string;
  label?: string;
};

export function buildZip321Uri(req: Zip321Request): string {
  const params = new URLSearchParams();
  if (req.amountZecDecimal != null) params.set("amount", req.amountZecDecimal);
  if (req.label) params.set("label", req.label);
  if (req.memo) {
    const b64 =
      typeof btoa === "function"
        ? btoa(req.memo).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
        : req.memo;
    params.set("memo", b64);
  }
  const qs = params.toString();
  return `zcash:${req.address}${qs ? `?${qs}` : ""}`;
}
