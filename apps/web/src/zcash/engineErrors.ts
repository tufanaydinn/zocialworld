/**
 * Plain sentences for the wallet engine's coded errors (the Stage 2 "Ironwood" engine's `e.code`, as its API reference
 * lists them — every Stage 1 code is kept, `pool_policy_violation` is new, `recipient_no_sapling_receiver` / `sapling_only_violation` are
 * retired but still mapped). Shown to the wallet's owner only — never sent anywhere. A message never repeats an
 * address, a txid or an amount from the engine's own text.
 *
 * Pure: no DOM, no wallet engine.
 */

export type WalletErrorContext = "payment" | "withdrawal" | "name_fee" | "shield" | "general";

export const SENDING_PAUSED = "Sending is paused until the game updates for the network upgrade — your balance is safe.";

const MESSAGES: Record<string, string> = {
  invalid_address: "That is not a Zcash address.",
  // Retired in Stage 2 (an Orchard-only u1 is payable now); kept in case an old engine answers.
  recipient_no_sapling_receiver: "This wallet can't pay that address. Ask for a unified address (u1…) or a Sapling address (zs1…).",
  recipient_transparent_not_allowed: "A transparent (t1…) or TEX (tex1…) address can only receive a withdrawal to your own wallet, not a payment to a player.",
  recipient_unsupported: "This address type is not supported (Sprout, or a unified address without a shielded receiver).",
  recipient_wrong_network: "This address is for another network.",
  memo_not_allowed: "A transparent or TEX address can't receive a memo — leave the memo empty.",
  memo_too_long: "The memo is too long (512 bytes at most).",
  invalid_amount: "That amount isn't valid.",
  invalid_outputs: "The payment couldn't be prepared (an internal error). Nothing was sent.",
  insufficient_funds: "Not enough shielded ZEC for this amount and its network fee.",
  // The engine's shielding threshold is 1 zatoshi; what remains is the network fee rule.
  nothing_to_shield:
    "There is nothing to shield yet: transparent funds appear after one confirmation, and must be more than the network fee (about 0.0001–0.00015 ZEC).",
  wallet_not_synced: "The wallet hasn't synced yet — wait for it to finish, then try again.",
  consensus_branch_mismatch: SENDING_PAUSED,
  consensus_upgrade_pending: SENDING_PAUSED,
  consensus_branch_unknown: "Can't reach the Zcash network right now — your balance is safe. Try again in a minute.",
  sapling_only_violation: "The wallet stopped this transaction because it didn't match its safety rules. Nothing was sent — please report it.",
  // The Stage 2 engine's internal pool-policy check (replaces sapling_only_violation).
  pool_policy_violation: "The wallet stopped this transaction because it didn't match its safety rules. Nothing was sent — please report it.",
  // A Stage 1 save the adapter restores from the seed (normally handled before anything is shown).
  wallet_format_unsupported:
    "This wallet was saved by an older version of the game. It is being restored from your seed phrase on this device — wait for the rescan to finish.",
  wallet_migrating: "Your wallet is being upgraded (a one-time rescan). Sending works again when it finishes — your funds are safe.",
  migration_birthday_unknown: "To upgrade this wallet, choose roughly when you created it (month and year), then unlock again.",
  proposal_failed: "The wallet couldn't prepare this transaction. Nothing was sent.",
  transaction_build_failed: "The wallet couldn't build this transaction. Nothing was sent.",
  broadcast_failed:
    "The network refused the transaction, so nothing was sent. Your funds stay reserved until it expires (about 50 minutes) — sync later and try again.",
  // Built and stored, but the answer to sending it was lost — it may be on its way. Never "nothing was sent".
  broadcast_uncertain:
    "The transaction may have been sent — the network's answer was lost. Check your balance after the next block (about 75 seconds) before trying again.",
  over_cap: "",
  backup_pending: "Confirm your seed-phrase backup first (Wallet → Back up seed…).",
  // A test-network build made without the engine binary loads a stand-in engine that only reports this.
  engine_not_installed: "The wallet engine is not installed in this build, so the wallet can't open here.",
};

const CODE = /^([a-z_]{3,40}):/;

/** The engine's stable code: `e.code`, else the `code:` prefix of the message; null for errors without one. */
export function engineErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z_]{3,40}$/.test(code)) return code;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = CODE.exec(message);
  return match ? match[1]! : null;
}

/**
 * The transaction a broadcast error is about (`error.txid`, else the `[txid=…]` marker of the message),
 * for a payment that may have reached the network. Never shown; the payment flow reports it for the fee check.
 */
export function engineErrorTxid(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const txid = (error as { txid?: unknown }).txid;
    if (typeof txid === "string" && /^[0-9a-f]{64}$/.test(txid)) return txid;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = /\[txid=([0-9a-f]{64})\]/.exec(message);
  return match ? match[1]! : null;
}

/**
 * A broadcast error about the SECOND (or later) transaction of a TEX withdrawal — the first one was already accepted by
 * the network. The engine says so in its `broadcast_failed` / `broadcast_uncertain` message (`… (transaction 2 of 2;
 * transaction 1 <txid> was sent)`); a first-transaction failure says `(transaction 1 of 2)`.
 */
export function laterTransactionOfPairFailed(error: unknown): boolean {
  const code = engineErrorCode(error);
  if (code !== "broadcast_failed" && code !== "broadcast_uncertain") return false;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown } | null)?.message ?? "");
  const match = /\(transaction (\d+) of (\d+)[;)]/.exec(message);
  return match !== null && Number(match[1]) >= 2 && Number(match[2]) >= 2;
}

/** The first transaction of a TEX pair left, the second was refused: where the ZEC is, and how it comes back. */
export const TEX_SECOND_REFUSED =
  "The first of the two TEX transactions was sent, but the network refused the second, so nothing reached the exchange. The ZEC (the amount plus the second network fee) is on a one-time transparent address of this wallet — don't withdraw again. Once the second transaction expires (about 50 minutes), the wallet finds that ZEC at its next check of that address (usually within a day) and shows it under \"Waiting to be shielded\"; Shield then brings it back into your shielded balance.";

/** The first transaction of a TEX pair left, the answer about the second was lost. */
export const TEX_SECOND_UNCERTAIN =
  "The first of the two TEX transactions was sent; the network's answer about the second was lost, so it may still reach the exchange. Don't withdraw again. If it did not go through, the ZEC stays on a one-time transparent address of this wallet: once that transaction expires (about 50 minutes), the wallet finds it at its next check (usually within a day) and shows it under \"Waiting to be shielded\", where Shield brings it back.";

/** The transaction exists and was handed to the network (or tried to be): never offer an immediate retry. */
export function isBroadcastPhaseError(error: unknown): boolean {
  const code = engineErrorCode(error);
  return code === "broadcast_uncertain" || code === "broadcast_failed";
}

/** Whether an error means "sending is paused by the upgrade guard". */
export function isSendingPaused(error: unknown): boolean {
  const code = engineErrorCode(error);
  return code === "consensus_branch_mismatch" || code === "consensus_upgrade_pending";
}

/**
 * A sentence for the wallet's owner. `insufficient_funds` while transparent funds wait means "shield first". Errors
 * without a known code fall back to `fallback` (the engine's raw text is never shown: it can carry addresses).
 */
export function walletErrorMessage(
  error: unknown,
  options: {
    readonly context?: WalletErrorContext;
    readonly transparentWaiting?: boolean;
    readonly fallback?: string;
    /** The payment also carries the project fee (e.g. "0.00075 ZEC ≈ US$1") — a short balance names it too. */
    readonly projectFee?: string;
  } = {},
): string {
  const code = engineErrorCode(error);
  if (code === "over_cap") {
    const message = error instanceof Error ? error.message : "";
    return message.replace(/^over_cap:\s*/, "").replace(/^the/, "The") + ".";
  }
  if (code === "insufficient_funds" && options.transparentWaiting) {
    return "Not enough shielded ZEC: your transparent funds must be shielded first (Wallet → Shield), then try again.";
  }
  if (code === "insufficient_funds" && options.projectFee) {
    return `Not enough shielded ZEC for this amount, the project fee (${options.projectFee}) and the network fee.`;
  }
  if (code === "recipient_unsupported" && options.context === "withdrawal") {
    // A u1 without a shielded receiver is never paid through its public transparent receiver.
    return "This address has no shielded part, so the wallet doesn't pay it (a unified address's transparent receiver is never used). Use your wallet's unified (u1…) or Sapling (zs1…) address — or, public on the chain, its t1… or tex1… address.";
  }
  // Never "nothing was sent" once the first transaction of a TEX pair has left.
  if (laterTransactionOfPairFailed(error)) return code === "broadcast_failed" ? TEX_SECOND_REFUSED : TEX_SECOND_UNCERTAIN;
  if (code === "broadcast_uncertain" && options.context === "shield") {
    return "Shielding may have gone through — the network's answer was lost. Check your balance after the next block (about 75 seconds) before shielding again.";
  }
  if (code && MESSAGES[code]) return MESSAGES[code]!;
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/not open|locked/i.test(raw)) return "Unlock your wallet first.";
  if (/SharedArrayBuffer|crossOriginIsolated|Atomics/i.test(raw)) return "This page isn't cross-origin isolated, so the wallet engine can't start (server configuration).";
  if (/failed to fetch|network|unavailable|status 14/i.test(raw)) return "Couldn't reach the Zcash network through the game server. Try again in a moment.";
  return options.fallback ?? (options.context === "shield" ? "Shielding failed. Nothing was sent." : "The transaction couldn't be sent. Nothing was sent.");
}
