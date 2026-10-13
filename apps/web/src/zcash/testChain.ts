/**
 * Which chain the in-game wallet is on, and which faucets make sense for it.
 *
 * The public testnet faucets (fauzec.com, zcashfaucet.jinolabs.xyz, the ZecHub faucets guide) are wrong for this
 * build: the test-network wallet engine maps the "test" network to this project's OWN regtest chain, so its addresses
 * are `uregtest1…` — which every public faucet rejects, and whose coins would land on another chain anyway. So:
 *
 *  - a regtest wallet sees only this server's "Get test coins" faucet, with copy that says the game runs its own test
 *    chain (or that the faucet is not set up on this server);
 *  - public testnet faucets appear only for a public-testnet wallet (`utest1…`), which this build does not make;
 *  - a mainnet wallet sees no faucet at all.
 *
 * Pure: no DOM, no wallet engine.
 */

export type WalletChain = "regtest" | "testnet" | "mainnet";

/** The chain this build's wallet uses: "test" is the project's own regtest chain in the vendored WebZjs; "main" is mainnet. */
export function walletChain(network: "main" | "test"): WalletChain {
  return network === "main" ? "mainnet" : "regtest";
}

/** The chain an address belongs to, from its prefix (format only — the wallet engine validates the rest). */
export function addressChain(address: string): WalletChain | "unknown" {
  const a = address.trim().toLowerCase();
  if (/^(uregtest1|zregtestsapling1)/.test(a)) return "regtest";
  if (/^(utest1|ztestsapling1|tm)/.test(a)) return "testnet";
  if (/^(u1|zs1|t1|t3)/.test(a)) return "mainnet";
  return "unknown";
}

export interface PublicFaucet {
  readonly label: string;
  readonly url: string;
}

/** Public testnet faucets — only useful for a PUBLIC testnet wallet (utest1… addresses). */
export const PUBLIC_TESTNET_FAUCETS: readonly PublicFaucet[] = [
  { label: "fauzec.com", url: "https://fauzec.com/" },
  { label: "zcashfaucet.jinolabs.xyz", url: "https://zcashfaucet.jinolabs.xyz/" },
];

/** What the wallet panel shows about getting coins. */
export interface FaucetPlan {
  /** Show the coins section at all (never on mainnet). */
  readonly show: boolean;
  /** This server's own faucet: "ready" (a button), "missing" (say it isn't set up), "checking" (still asking). */
  readonly server: "ready" | "missing" | "checking";
  /** Public faucet links (public testnet only). */
  readonly publicFaucets: readonly PublicFaucet[];
  /** The ZecHub faucets guide (public testnet only — it lists public faucets). */
  readonly guide: boolean;
  /** The section's heading. */
  readonly heading: string;
  /** One or two sentences under the heading. */
  readonly intro: string;
  /** How the receive address is labelled. */
  readonly addressLabel: string;
}

export const REGTEST_FAUCET_COPY = "This game runs its own test chain; coins come from the in-game faucet.";
export const FAUCET_MISSING_COPY = "The faucet is not set up on this server.";

/** The coins section for a chain and what this server's `/zcash/info` said (null while it is still being asked). */
export function faucetPlan(chain: WalletChain, serverFaucet: { readonly available: boolean } | null): FaucetPlan {
  const server: FaucetPlan["server"] = serverFaucet === null ? "checking" : serverFaucet.available ? "ready" : "missing";
  if (chain === "mainnet") {
    return { show: false, server: "missing", publicFaucets: [], guide: false, heading: "Receive ZEC", intro: "Only you see this address; share it only with people you choose.", addressLabel: "Your receive address" };
  }
  if (chain === "regtest") {
    return {
      show: true,
      server,
      publicFaucets: [],
      guide: false,
      heading: "Get test coins",
      intro: `${REGTEST_FAUCET_COPY} They have no value and exist only in this game. Public testnet faucets can't send to this wallet.`,
      addressLabel: "Your test-chain receive address (this game's own chain — public testnet faucets and wallets reject it)",
    };
  }
  return {
    show: true,
    server,
    publicFaucets: PUBLIC_TESTNET_FAUCETS,
    guide: true,
    heading: "Get testnet coins",
    intro: "Free testnet coins (TAZ) from a public faucet, sent to your own receive address. They have no value.",
    addressLabel: "Your testnet receive address",
  };
}

/** The faucet's answer, in words to act on (a precise error instead of a generic failure). */
export function faucetErrorMessage(code: string | null, status: number): string {
  switch (code) {
    case "no_session":
      return "The faucet didn't recognise your game session. Wait for “Connected” at the top of the screen (or reload the page), then try again.";
    case "cooldown":
      return "You already got test coins recently: the faucet allows one claim per 10 minutes per session and one per wallet per day.";
    case "busy":
      return "The faucet is busy (too many claims this minute). Try again in a minute.";
    case "send_failed":
      return "The faucet couldn't send coins right now — its node may be out of funds or still syncing. Try again later.";
    case "faucet_disabled":
      return FAUCET_MISSING_COPY;
    case "bad_address":
      return "The faucet refused this address: it isn't a shielded address on this game's test chain.";
    case "bad_request":
      return "The faucet didn't understand the request. Reload the page and try again.";
    default:
      return status === 0 ? "The faucet couldn't be reached. Check your connection and try again." : `The faucet couldn't send right now (HTTP ${status}). Try again later.`;
  }
}
