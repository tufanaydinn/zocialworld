import type { NameRegistryConfig } from "../identity/nameConfig.js";
import { loadNameRegistryConfig } from "../identity/nameConfig.js";
import { createNameService, type NameService } from "../identity/nameService.js";
import { TransferFees, loadTransferFeeConfig } from "../transferFees.js";
import type { RpcFn } from "./faucet.js";
import { LightwalletdClient, type ChainSource } from "./lightwalletdClient.js";
import { loadZcashServerConfig, type ZcashServerConfig } from "./network.js";
import { ShieldedPaymentReader, helperDecrypt } from "./shieldedPayments.js";
import { checkAddressAgainstKey, helperNetworkForAddress, loadTxDecryptHelper, type TxDecryptHelper } from "./txDecrypt.js";

/**
 * Everything the game server runs for Zcash beyond the wallet bridge (ADR-018), built from the
 * environment in one place so the startup rules are testable:
 *
 *  - the network (ZCASH_NETWORK) with its refusals on main (faucet, zcashd/dev registries — zcash/network.ts);
 *  - the name registry (ADR-016 / ADR-018 § 5), its `lightwalletd` backend reading reported transactions;
 *  - the transfer fee (ADR-018 § 6);
 *  - a startup check that each fee/registry address belongs to its viewing key and has a Sapling receiver, so no fee
 *    is ever paid to an address the server cannot see. A mismatch refuses to start (the log names the variable,
 *    never the address or the key).
 */

export interface WalletServices {
  readonly zcash: ZcashServerConfig;
  readonly nameConfig: NameRegistryConfig;
  readonly names: NameService;
  readonly fees: TransferFees | null;
  /** Why there is no transfer fee (startup log), or null when it is on. */
  readonly feeProblem: string | null;
  /** The server's own lightwalletd connection (fee checks), or null when nothing needs one. */
  readonly chain: ChainSource | null;
  /**
   * Startup warnings for the log (never an address or a key) — on mainnet, a registry or fee address
   * without an Orchard-family receiver (a Stage 1 unified address or a zs1…).
   */
  readonly warnings: readonly string[];
}

/**
 * A Stage-2 wallet pays an address without an Orchard-family receiver as SAPLING, funded from its
 * Ironwood notes — every fee then crosses pools and shows on chain as an exact Sapling value balance of the fee (a game
 * fingerprint; for names, linkable by timing to the `nickname_updated` broadcast). The full unified address
 * (scripts/tools/registry-keys.mjs) is paid as Ironwood and avoids it; Stage-1 clients still pay its Sapling receiver.
 */
export const SAPLING_ONLY_FEE_ADDRESS_WARNING =
  "has no Orchard-family receiver: Stage-2 wallets pay it as Sapling from Ironwood funds, which makes every fee paid to it public on the chain (an exact Sapling value balance). Switch to the full unified address scripts/tools/registry-keys.mjs prints.";

export interface WalletServicesDeps {
  readonly rpc: RpcFn | null;
  readonly now?: () => number;
  /** Test seams. */
  readonly helper?: () => TxDecryptHelper;
  readonly chain?: (url: string) => ChainSource;
}

export type WalletServicesResult = { readonly ok: true; readonly services: WalletServices } | { readonly ok: false; readonly error: string };

export function createWalletServices(env: Record<string, string | undefined>, deps: WalletServicesDeps): WalletServicesResult {
  const zcashResult = loadZcashServerConfig(env);
  if (!zcashResult.ok) return zcashResult;
  const zcash = zcashResult.config;
  const now = deps.now ?? Date.now;
  const helper = deps.helper ?? loadTxDecryptHelper;
  let chain: ChainSource | null = null;
  const chainSource = (): ChainSource => {
    // Every configured upstream, in failover order.
    if (!chain) chain = deps.chain ? deps.chain(zcash.lightwalletdUrl!) : new LightwalletdClient({ upstream: zcash.lightwalletdUrls });
    return chain;
  };

  const nameResult = loadNameRegistryConfig(env, { rpcConfigured: deps.rpc !== null, network: zcash.network, lightwalletd: zcash.lightwalletdUrl !== null });
  if (!nameResult.ok) return nameResult;
  const nameConfig = nameResult.config;
  const warnings: string[] = [];
  let paymentReader: ShieldedPaymentReader | null = null;
  if (nameConfig.mode === "lightwalletd" && nameConfig.address && nameConfig.ufvk) {
    const problem = checkKey(helper, nameConfig.address, nameConfig.ufvk);
    if (problem) return { ok: false, error: `refusing to start: NAME_REGISTRY_ADDRESS / NAME_REGISTRY_UFVK: ${problem}` };
    if (zcash.network === "main" && lacksOrchardReceiver(helper, nameConfig.address)) warnings.push(`NAME_REGISTRY_ADDRESS ${SAPLING_ONLY_FEE_ADDRESS_WARNING}`);
    paymentReader = new ShieldedPaymentReader(chainSource(), helperDecrypt(helper(), helperNetworkForAddress(nameConfig.address)!, nameConfig.ufvk));
  }
  let names: NameService;
  try {
    names = createNameService(nameConfig, { rpc: deps.rpc, now, paymentReader });
  } catch (error) {
    return { ok: false, error: `refusing to start: the name store could not be loaded (${error instanceof Error ? error.message : "error"})` };
  }

  const feeResult = loadTransferFeeConfig(env, { network: zcash.network, lightwalletd: zcash.lightwalletdUrl !== null });
  if (!feeResult.ok) {
    names.dispose();
    return feeResult;
  }
  let fees: TransferFees | null = null;
  if (feeResult.config) {
    const { address, ufvk } = feeResult.config;
    const network = helperNetworkForAddress(address);
    const wrongNetwork = network === null || (zcash.network === "main") !== (network === "main");
    const problem = wrongNetwork ? `the address is not a shielded address on this server's network (${zcash.network})` : checkKey(helper, address, ufvk);
    if (problem) {
      names.dispose();
      return { ok: false, error: `refusing to start: PAYMENT_FEE_ADDRESS / PAYMENT_FEE_UFVK (or the registry's, by default): ${problem}` };
    }
    const reader = new ShieldedPaymentReader(chainSource(), helperDecrypt(helper(), network!, ufvk));
    fees = new TransferFees({ config: feeResult.config, reader, now, nu7ActivationHeight: zcash.nu7ActivationHeight });
    if (zcash.network === "main" && lacksOrchardReceiver(helper, address)) warnings.push(`PAYMENT_FEE_ADDRESS (or the registry's, by default) ${SAPLING_ONLY_FEE_ADDRESS_WARNING}`);
  }
  return { ok: true, services: { zcash, nameConfig, names, fees, feeProblem: feeResult.config ? null : (feeResult.problem ?? "off"), chain, warnings } };
}

/** Whether a (checked) shielded address has no Orchard-family receiver; false when the helper cannot tell. */
function lacksOrchardReceiver(helper: () => TxDecryptHelper, address: string): boolean {
  try {
    return !helper().describeAddress(address).hasOrchard;
  } catch {
    return false;
  }
}

function checkKey(helper: () => TxDecryptHelper, address: string, ufvk: string): string | null {
  try {
    return checkAddressAgainstKey(address, ufvk, helper());
  } catch (error) {
    return `the decryption helper could not be loaded (${error instanceof Error ? error.message.slice(0, 120) : "error"})`;
  }
}
