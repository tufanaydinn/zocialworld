import { ZcashWalletAdapter } from "./ZcashWalletAdapter.ts";
import { gameServerOrigin } from "../core/serverOrigin.ts";
import { addressChain, faucetErrorMessage } from "./testChain.ts";

/**
 * Test coins from this game server's own faucet (apps/server/src/zcash/faucet.ts), for the Wallet panel
 * and for the name-fee step (ADR-016: "Get test coins" when the wallet cannot pay the fee).
 *
 * The wallet's receive address goes only to our own server, never anywhere else. `credential` proves a live
 * connection: the session capability from `welcome` once joined — or, before join (onboarding), the connection's
 * pending name-reservation id. After a successful claim the wallet syncs again ~12 s later (the next block).
 *
 * Every answer is a precise sentence (no_session, cooldown, busy, send_failed, disabled — testChain.ts),
 * and a mainnet address is never sent to a test faucet.
 */
export async function claimTestCoins(credential: string | null): Promise<{ readonly ok: boolean; readonly message: string; readonly code: string | null }> {
  if (!credential) return { ok: false, code: "no_session", message: "Not connected to the game server yet — wait for “Connected” at the top of the screen, then try again." };
  let address: string;
  try {
    address = await ZcashWalletAdapter.getReceiveAddress();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "wallet_locked", message: /not open|locked/i.test(message) ? "Unlock your wallet first." : `Your wallet couldn't give a receive address (${message}).` };
  }
  if (addressChain(address) === "mainnet") return { ok: false, code: "mainnet", message: "This is a mainnet wallet — test faucets don't apply." };
  let response: Response;
  try {
    response = await fetch(`${gameServerOrigin()}/zcash/faucet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: credential, address }),
    });
  } catch {
    return { ok: false, code: null, message: faucetErrorMessage(null, 0) };
  }
  let body: { ok?: boolean; amount?: number; error?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A proxy's HTML error page: the status alone says enough.
  }
  if (response.ok && body.ok) {
    setTimeout(() => void ZcashWalletAdapter.sync().catch(() => undefined), 12_000);
    return { ok: true, code: null, message: `Sent ${body.amount} test coins on this game's test chain — they appear after the next block (a few seconds).` };
  }
  const code = typeof body.error === "string" ? body.error : null;
  return { ok: false, code, message: faucetErrorMessage(code, response.status) };
}
