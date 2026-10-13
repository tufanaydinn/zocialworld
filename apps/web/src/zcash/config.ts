// Zcash wallet network configuration for Zocial World.
// Fail-closed: unknown configs are rejected, no fallback to defaults.

import { isShieldedKind, validateAddress } from "./core/wallet-types";
import type { ProjectSupportTarget } from "./WalletTypes";
import { gameServerOrigin } from "../core/serverOrigin.ts";

export interface ZcashNetworkConfig {
  network: "main" | "test";
  proxyUrl: string;
  /** Maximum supported project count per game instance */
  maxProjects: number;
}

// Network configuration keyed by environment/network type
const NETWORK_CONFIGS: Record<string, ZcashNetworkConfig> = {
  test: {
    network: "test",
    // Resolved at runtime (see getNetworkConfig): VITE_LWD_URL, else this game's own server bridge
    // `<page host>:8787/zcash/lwd` (apps/server/src/zcash/lwdProxy.ts) — never a third-party proxy,
    // so the lightwalletd operator never sees a player's IP.
    proxyUrl: "",
    maxProjects: 1000,
  },
  // ADR-018: real ZEC through the same game-server bridge (the server's LIGHTWALLETD_URL defaults to zec.rocks on
  // ZCASH_NETWORK=main). A mainnet build uses the mainnet wallet engine (the Stage 2 "Ironwood" engine); consent, the
  // backup check and the per-transaction cap apply.
  main: {
    network: "main",
    proxyUrl: "",
    maxProjects: 1000,
  },
};

/** Testnet support recipients (real validated addresses).
 *  Each entry is an approved support recipient for a project.
 *  Only test-network addresses here; mainnet recipients live in their own registry below.
 */
export const TESTNET_SUPPORT_RECIPIENTS: Record<string, string> = {
  // NOTE: Currently empty. No real testnet support recipient configured.
  // To add: validate address format and confirm it's shielded-capable.
  // Example (do not use — mock for testing only):
  // "test-project-id": "utest1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
};

/** Mainnet support recipients (real validated addresses; real ZEC).
 *  Only the operator of a mainnet deployment adds entries here, after checking each address.
 *  No mainnet funds should be used in test/dev.
 */
export const MAINNET_SUPPORT_RECIPIENTS: Record<string, string> = {
  // Empty: project support on mainnet is not configured.
};

// Determine which network to use (from ZCASH_NETWORK env var)
function getNetworkName(): "main" | "test" {
  // Network is determined by ZCASH_NETWORK which is already fail-closed in wallet-types.ts
  // This function validates it for config use
  // (process.env: node unit tests, where import.meta.env does not exist — as in wallet-types.ts)
  const network = ((import.meta.env as any)?.VITE_ZCASH_NETWORK ?? (typeof process !== "undefined" ? process.env.VITE_ZCASH_NETWORK : undefined)) as string | undefined;
  if (network === "main" || network === "test") return network;
  throw new Error(`FAIL_CLOSED: Invalid or unset VITE_ZCASH_NETWORK. Must be exactly "test" or "main", got: ${network}`);
}

let cachedConfig: ZcashNetworkConfig | null = null;

function resolveBridgeUrl(): string {
  const configured = (import.meta.env as Record<string, string | undefined>)?.VITE_LWD_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window === "undefined") return "http://localhost:8787/zcash/lwd";
  return `${gameServerOrigin()}/zcash/lwd`;
}

export function getNetworkConfig(): ZcashNetworkConfig {
  if (!cachedConfig) {
    const netName = getNetworkName();
    const config = NETWORK_CONFIGS[netName];
    if (!config) {
      // Fail closed: reject unknown network
      throw new Error(
        `FAIL_CLOSED: Network '${netName}' not configured. Available: ${Object.keys(NETWORK_CONFIGS).join(", ")}`
      );
    }
    cachedConfig = { ...config, proxyUrl: config.proxyUrl || resolveBridgeUrl() };
  }
  return cachedConfig;
}

/** Get approved support recipient for a project.
 *  Fails closed: throws if no recipient configured for this project/network.
 */
export function getSupportRecipient(projectId: string, network: "main" | "test"): string {
  const recipients = network === "main" ? MAINNET_SUPPORT_RECIPIENTS : TESTNET_SUPPORT_RECIPIENTS;
  const address = recipients[projectId];
  if (!address) {
    throw new Error(
      `SUPPORT_TARGET_NOT_CONFIGURED: No support recipient configured for projectId='${projectId}' on ${network}`
    );
  }
  return address;
}

export function validateSupportTarget(target: ProjectSupportTarget): {
  ok: boolean;
  error?: string;
} {
  const config = getNetworkConfig();

  if (target.network !== config.network) {
    return {
      ok: false,
      error: `Network mismatch: support target requires '${target.network}' but wallet is on '${config.network}'`,
    };
  }

  // Validate address format and ensure it's shielded-capable
  const addrValidation = validateAddress(target.recipientAddress);
  if (!addrValidation.ok || !isShieldedKind(addrValidation.kind)) {
    return {
      ok: false,
      error: `Support recipient must be a shielded Zcash address (received: ${addrValidation.kind})`,
    };
  }

  return { ok: true };
}
