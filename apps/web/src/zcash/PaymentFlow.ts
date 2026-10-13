import { PAY_FEE_DEADLINE_MS, PAY_FEE_MAX_ZAT, buildPayFeeMemo, type PayAcceptRelay, type PayCancelRelay, type PayDeclineMessage, type PayDeclineReason, type PayDeclineRelay, type PayErrorMessage, type PayErrorReason, type PayFeeQuote, type PayNoticeRelay, type PayRequestRelay } from "@project/shared";
import type { WalletStatus } from "./WalletTypes.ts";
import { injectUiStyles } from "../ui/styles.ts";
import { ZcashWalletAdapter, subscribeToWalletState, transactionCapZat, type SendRequest } from "./ZcashWalletAdapter.ts";
import { ZCASH_NETWORK, detectAddressKind, isShieldedKind, validateAddress } from "./core/wallet-types";
import { createPaymentKeys, deriveSealKey, newRequestId, seal, securityCode, unseal, type PaymentKeys } from "./paymentCrypto.ts";
import { addressChain } from "./testChain.ts";
import { SENDING_PAUSED, engineErrorCode, engineErrorTxid, isSendingPaused, walletErrorMessage } from "./engineErrors.ts";
import { formatZatBig, parseZecAmount } from "./txCap.ts";
import { approxUsdSuffix } from "./feeLabel.ts";
import { rememberPlayerAddress } from "./playerAddresses.ts";
import { saplingCrossingPaymentNote, saplingOutputCrossesPools } from "./poolCrossing.ts";

/**
 * Private player-to-player ZEC (ADR-013) — "Send ZEC" in the
 * player menu.
 *
 *   sender                         server (relay only)            recipient
 *   pay_request(senderKey)  ───────────────────────────────▶  "Ada wants to send you ZEC"
 *                                                               accept → own address,
 *   unseal address  ◀────────────  pay_accept(recipientKey, sealed address)
 *   amount + memo → wallet sends (address never displayed)
 *   pay_notice(sealed amount/txid) ───────────────────────▶  "Ada sent you 0.5"
 *
 * Neither player ever SEES the other's address; the server never sees an
 * address, amount or memo. Both see a 4-emoji security code derived from
 * the two keys (equal codes = no key swap in transit). The recipient must
 * accept every request; blocked players are declined automatically.
 *
 * ADR-018 § 4, § 6 on a mainnet build:
 *  - the request declares the wallet's per-transaction cap (`capZat`); the adapter refuses a larger amount;
 *  - when the server charges the transfer fee, the acceptance it relays carries a fee quote (address, amount,
 *    nonce): the confirmation card shows "Recipient gets X", "Project fee (≈ the operator's fiat label) Y ZEC" and
 *    "Network fee Z", and
 *    ONE transaction pays the recipient and the fee output; the txid then goes to the server (`pay_sent`) for the fee
 *    check, before the sealed notice;
 *  - engine errors are plain sentences (sending paused for an upgrade, not enough shielded ZEC, …).
 *
 * Mainnet money and privacy rules:
 *  - the recipient seals an address WITHOUT a transparent receiver on mainnet — its shielded-only unified address
 *    (Orchard-family + Sapling; a Stage 2 sender pays it as Ironwood, an older client as Sapling), never the full
 *    unified address whose transparent receiver is its public exchange address;
 *  - every sender-side exit without a payment (Cancel while waiting, a bad or fee-less acceptance, the card
 *    expiring) sends `pay_cancel`, so the server owes no fee for it and the recipient's card closes;
 *  - a `pay_cancel` relay also tells a side that the other one left;
 *  - an accepted card expires (cancelled) before the server's fee deadline, so a late send cannot be punished;
 *  - a broadcast whose answer was lost (`broadcast_uncertain`) may have paid: the txid still goes to the server
 *    for the fee check, the recipient is told it may arrive, and there is no immediate retry (it could pay twice).
 */

type Send = (message: Parameters<PaymentFlowOptions["send"]>[0]) => void;

export interface PaymentFlowOptions {
  readonly send: (
    message:
      | { type: "pay_request"; to: string; requestId: string; senderKey: string; capZat?: number }
      | { type: "pay_accept"; requestId: string; recipientKey: string; sealed: string; iv: string }
      | PayDeclineMessage
      | { type: "pay_notice"; requestId: string; sealed: string; iv: string }
      | { type: "pay_sent"; requestId: string; txid: string }
      | { type: "pay_cancel"; requestId: string },
  ) => void;
  readonly openWallet: () => void;
  readonly isBlocked: (playerId: string) => boolean;
  /** A line for the chat log (e.g. "Ada sent you 0.5 TAZ"). */
  readonly announce: (text: string) => void;
  /** The transfer fee this server advertised (GET /zcash/info → payments.feeZat), or null while unknown. */
  readonly advertisedFeeZat?: () => number | null;
  /** The operator's approximate fiat value of that fee (GET /zcash/info → payments.feeUsd), or null: ZEC only. */
  readonly feeUsd?: () => number | null;
}

interface Outgoing {
  readonly requestId: string;
  readonly to: string;
  readonly nickname: string;
  readonly keys: PaymentKeys;
  readonly card: Card;
  /** A transaction is being built or broadcast for this request (a cancel or an expiry must not interrupt it). */
  sending: boolean;
  /** Closes the accepted card before the server's fee deadline. */
  expiry: ReturnType<typeof setTimeout> | null;
  acceptedAt: number | null;
}

interface Incoming {
  readonly requestId: string;
  readonly from: string;
  readonly nickname: string;
  readonly senderKey: string;
  readonly card: Card;
  key: CryptoKey | null;
}

const UNIT = ZCASH_NETWORK === "main" ? "ZEC" : "TAZ";
const MAINNET = ZCASH_NETWORK === "main";
const MEMO_MAX_BYTES = 512;
/** A mainnet fee address: shielded (u1… / zs1…) — usually the registry's full UA, paid as Ironwood. */
const MAINNET_FEE_ADDRESS = /^(u1[0-9a-z]{40,1000}|zs1[0-9a-z]{60,90})$/;
/**
 * An accepted request's card expires this long after the acceptance — 5 minutes before the server's fee deadline
 * (PAY_FEE_DEADLINE_MS) and its notice expiry, so a payment is never sent too late to count.
 */
export const PAYMENT_CARD_EXPIRY_MS = PAY_FEE_DEADLINE_MS - 5 * 60 * 1000;

export class PaymentFlow {
  private readonly stack: HTMLDivElement;
  private readonly options: PaymentFlowOptions;
  private readonly send: Send;
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly incoming = new Map<string, Incoming>();
  private walletReady = false;
  /** A new mainnet wallet whose backup is unconfirmed neither pays nor receives (ADR-018 § 1). */
  private backupPending = ZcashWalletAdapter.state.backupPending;
  /** A payment is being built or broadcast (the update prompt never reloads then). */
  private sending = 0;
  /** ADR-015: the wallet's lifecycle status — `idle` (no wallet on this device) declines incoming requests with `no_wallet`. */
  private walletStatus: WalletStatus = ZcashWalletAdapter.state.status;

  constructor(container: HTMLElement, options: PaymentFlowOptions) {
    injectUiStyles();
    injectPaymentStyles();
    this.options = options;
    this.send = options.send;
    this.stack = document.createElement("div");
    this.stack.className = "zw-ui zw-pay-stack";
    container.appendChild(this.stack);
    subscribeToWalletState((state) => {
      this.walletStatus = state.status;
      this.walletReady = state.status === "ready" || state.status === "syncing";
      this.backupPending = state.backupPending;
      for (const entry of this.incoming.values()) if (!entry.key) this.renderIncoming(entry);
    });
  }

  /** True while a payment is being built or sent (ADR-018 § 7: never reload during a send). */
  get busy(): boolean {
    return this.sending > 0;
  }

  /** Sender side: "Send ZEC" on a player. */
  async start(playerId: string, nickname: string): Promise<void> {
    if (!this.walletReady) {
      const card = this.card(`Send ZEC to ${nickname}`);
      card.text("Unlock (or create) your wallet first — then try again.");
      card.actions([["Open wallet", () => (card.close(), this.options.openWallet()), true], ["Close", () => card.close()]]);
      return;
    }
    if (this.backupPending) {
      const card = this.card(`Send ZEC to ${nickname}`);
      card.text("Confirm your seed-phrase backup first (Wallet → Back up seed…) — then try again.");
      card.actions([["Open wallet", () => (card.close(), this.options.openWallet()), true], ["Close", () => card.close()]]);
      return;
    }
    const requestId = newRequestId();
    const keys = await createPaymentKeys();
    const card = this.card(`Send ZEC to ${nickname}`);
    card.text(`Waiting for ${nickname} to accept… Their address will reach your wallet encrypted — neither of you will see the other's.`);
    const entry: Outgoing = { requestId, to: playerId, nickname, keys, card, sending: false, expiry: null, acceptedAt: null };
    // The server (and the recipient's card) learn about the cancel — a late acceptance then owes no fee.
    card.actions([["Cancel", () => this.cancelOutgoing(entry)]]);
    this.outgoing.set(requestId, entry);
    // ADR-018 § 4: the cap this wallet enforces (the amount itself stays sealed between the two of you).
    const cap = transactionCapZat();
    this.send({ type: "pay_request", to: playerId, requestId, senderKey: keys.publicKey, ...(cap !== null ? { capZat: Number(cap) } : {}) });
  }

  /** Every relayed payment message from the network. */
  handle(message: PayRequestRelay | PayAcceptRelay | PayDeclineRelay | PayNoticeRelay | PayCancelRelay | PayErrorMessage): void {
    switch (message.type) {
      case "pay_request":
        return this.onRequest(message);
      case "pay_accept":
        return void this.onAccept(message);
      case "pay_decline":
        return this.onDecline(message);
      case "pay_notice":
        return void this.onNotice(message);
      case "pay_cancel":
        return this.onCancel(message);
      case "pay_error":
        return this.onError(message);
    }
  }

  /** The sender cancelled (or left) — to the recipient; the recipient left — to the sender. */
  private onCancel(message: PayCancelRelay): void {
    const incoming = this.incoming.get(message.requestId);
    if (incoming && incoming.from === message.from) {
      this.incoming.delete(message.requestId);
      incoming.card.clear();
      incoming.card.reopen();
      incoming.card.title(`${incoming.nickname} cancelled`);
      incoming.card.text("No payment was sent.");
      incoming.card.actions([["Close", () => incoming.card.close()]]);
      return;
    }
    const outgoing = this.outgoing.get(message.requestId);
    if (!outgoing || outgoing.to !== message.from || outgoing.sending) return; // a send in flight finishes on its own
    this.endOutgoing(outgoing, false);
    outgoing.card.clear();
    outgoing.card.text(`${outgoing.nickname} left — nothing was sent.`);
    outgoing.card.actions([["Close", () => outgoing.card.close()]]);
  }

  // ------------------------------------------------------------------ recipient

  private onRequest(message: PayRequestRelay): void {
    if (this.options.isBlocked(message.from)) return this.decline(message.requestId, "declined");
    // ADR-015: no wallet on this device at all (e.g. it was just forgotten) — nothing could ever receive this.
    if (this.walletStatus === "idle") return this.decline(message.requestId, "no_wallet");
    if (this.incoming.size >= 3) return this.decline(message.requestId, "busy");
    const card = this.card(`${message.fromNickname} wants to send you ZEC`);
    const entry: Incoming = { requestId: message.requestId, from: message.from, nickname: message.fromNickname, senderKey: message.senderKey, card, key: null };
    this.incoming.set(message.requestId, entry);
    this.renderIncoming(entry);
  }

  private renderIncoming(entry: Incoming): void {
    const { card } = entry;
    card.clear();
    card.text(`If you accept, your wallet sends ${entry.nickname}'s wallet a receive address, encrypted end-to-end. It is never shown to ${entry.nickname}, to other players or to the game server.`);
    if (this.walletReady && this.backupPending) {
      card.text("Confirm your seed-phrase backup first (Wallet → Back up seed…) to receive.", "zw-pay-warn");
      card.actions([
        ["Open wallet", () => this.options.openWallet(), true],
        ["Decline", () => this.finishIncoming(entry, "declined")],
      ]);
      return;
    }
    if (!this.walletReady) {
      card.text("Your wallet is locked — unlock it to receive.", "zw-pay-warn");
      card.actions([
        ["Open wallet", () => this.options.openWallet(), true],
        ["Decline", () => this.finishIncoming(entry, "declined")],
      ]);
      return;
    }
    card.actions([
      ["Accept", () => void this.accept(entry), true],
      ["Decline", () => this.finishIncoming(entry, "declined")],
    ]);
  }

  private async accept(entry: Incoming): Promise<void> {
    const live = (): boolean => this.incoming.get(entry.requestId) === entry; // the sender may cancel meanwhile
    try {
      entry.card.clear();
      entry.card.text("Sharing your address securely…");
      const keys = await createPaymentKeys();
      const key = await deriveSealKey(keys, entry.senderKey, entry.requestId);
      entry.key = key;
      // On mainnet the shielded-only unified address — the sender never learns this wallet's transparent receiver.
      const address = await ZcashWalletAdapter.getPaymentAddress();
      const box = await seal(key, { address });
      if (!live()) return;
      this.send({ type: "pay_accept", requestId: entry.requestId, recipientKey: keys.publicKey, ...box });
      const code = await securityCode(entry.senderKey, keys.publicKey);
      if (!live()) return;
      entry.card.clear();
      entry.card.text(`Waiting for ${entry.nickname} to send…`);
      entry.card.code(code);
      entry.card.actions([["Hide", () => entry.card.close()]]);
    } catch (error) {
      console.warn("[pay] accept failed:", error instanceof Error ? error.name : "error");
      if (live()) this.finishIncoming(entry, "failed");
    }
  }

  private async onNotice(message: PayNoticeRelay): Promise<void> {
    const entry = this.incoming.get(message.requestId);
    if (!entry || !entry.key || entry.from !== message.from) return;
    this.incoming.delete(message.requestId);
    try {
      const notice = await unseal<{ status: "sent" | "uncertain" | "cancelled"; amount?: string; txid?: string; memo?: boolean }>(entry.key, message.sealed, message.iv);
      const card = entry.card;
      card.clear();
      card.reopen();
      if (notice.status === "uncertain" && notice.amount) {
        // The sender's wallet lost the network's answer — the payment may still arrive.
        card.title(`${entry.nickname}'s payment may be on its way`);
        card.text(`${notice.amount} ${UNIT} may arrive in your wallet after the next block — ${entry.nickname}'s wallet couldn't confirm it was sent.`);
        setTimeout(() => void ZcashWalletAdapter.sync().catch(() => undefined), 12_000);
      } else if (notice.status === "sent" && notice.amount) {
        card.title(`${entry.nickname} sent you ${notice.amount} ${UNIT}`);
        card.text(`It appears in your wallet after the next block${notice.memo ? " (with a private memo)" : ""}.`);
        if (notice.txid) card.text(`Transaction ${notice.txid.slice(0, 10)}…`, "zw-pay-muted");
        this.options.announce(`${entry.nickname} sent you ${notice.amount} ${UNIT} privately.`);
        setTimeout(() => void ZcashWalletAdapter.sync().catch(() => undefined), 12_000);
      } else {
        card.title(`${entry.nickname} cancelled`);
        card.text("No payment was sent.");
      }
      card.actions([["Close", () => card.close()]]);
    } catch {
      entry.card.close();
    }
  }

  private finishIncoming(entry: Incoming, reason: PayDeclineReason): void {
    this.incoming.delete(entry.requestId);
    this.decline(entry.requestId, reason);
    entry.card.close();
  }

  private decline(requestId: string, reason: PayDeclineReason): void {
    this.send({ type: "pay_decline", requestId, reason });
  }

  // ------------------------------------------------------------------ sender

  private async onAccept(message: PayAcceptRelay): Promise<void> {
    const entry = this.outgoing.get(message.requestId);
    if (!entry || entry.to !== message.from || entry.acceptedAt !== null) return;
    const { card } = entry;
    entry.acceptedAt = Date.now();
    // The card ends (and cancels) before the server's fee deadline — a send can never be too late to count.
    entry.expiry = setTimeout(() => this.expireOutgoing(entry), PAYMENT_CARD_EXPIRY_MS);
    let address: string;
    let key: CryptoKey;
    try {
      key = await deriveSealKey(entry.keys, message.recipientKey, entry.requestId);
      ({ address } = await unseal<{ address: string }>(key, message.sealed, message.iv));
      const own = await ZcashWalletAdapter.getReceiveAddress();
      if (!acceptableAddress(address, own)) throw new Error("not a shielded address on this network");
    } catch (error) {
      // A bad acceptance (a hostile recipient, or this wallet locked meanwhile) cancels at once — no fee is owed.
      console.warn("[pay] bad acceptance:", error instanceof Error ? error.message : "error");
      this.endOutgoing(entry, true);
      card.clear();
      card.text(`${entry.nickname}'s wallet answered with something that isn't a valid shielded address on this network — nothing was sent.`, "zw-pay-warn");
      card.actions([["Close", () => card.close()]]);
      return;
    }
    if (this.outgoing.get(entry.requestId) !== entry) return; // cancelled while unsealing
    // Withdraw recognises this player's address for the rest of the session (it pays players fee-free otherwise).
    rememberPlayerAddress(address);
    // ADR-018 § 6: the server's transfer-fee quote, checked before anything is paid.
    const fee = message.fee ?? null;
    const advertised = this.options.advertisedFeeZat?.() ?? null;
    if (!fee && MAINNET && advertised !== null && advertised > 0) {
      // This server advertises a fee but sent no quote — never pay fee-free behind its back.
      this.endOutgoing(entry, true);
      card.clear();
      card.text("The game server didn't attach its transfer fee to this payment, so nothing was sent. Try again in a moment.", "zw-pay-warn");
      card.actions([["Close", () => card.close()]]);
      return;
    }
    if (fee) {
      const problem = this.feeProblem(fee);
      if (problem) {
        this.endOutgoing(entry, true);
        card.clear();
        card.text(problem, "zw-pay-warn");
        card.actions([["Close", () => card.close()]]);
        return;
      }
    }
    const code = await securityCode(entry.keys.publicKey, message.recipientKey);
    card.clear();
    card.text(`${entry.nickname} accepted. Their address is in your wallet, encrypted — it is never shown.`);
    card.code(code);
    if (MAINNET) return this.mainnetAmountStep(entry, key, address, fee);
    const amount = card.input("Amount", `0.1`, "decimal");
    const memo = card.input("Private memo (optional)", "", "text");
    const status = card.text("", "zw-pay-warn");
    const balance = ZcashWalletAdapter.getBalance();
    if (balance) card.text(`Available: ${balance.totalZec} ${UNIT}`, "zw-pay-muted");
    const sendNow = async (): Promise<void> => {
      const value = amount.value.trim();
      if (!/^\d+(\.\d{1,8})?$/.test(value) || Number(value) <= 0) return void (status.textContent = "Enter an amount like 0.1 (up to 8 decimals).");
      if (new TextEncoder().encode(memo.value).length > MEMO_MAX_BYTES) return void (status.textContent = "The memo is too long (512 bytes max).");
      if (this.outgoing.get(entry.requestId) !== entry) return; // expired or cancelled meanwhile
      status.textContent = "Building the shielded transaction and its proof… this can take a little while.";
      card.disable(true);
      entry.sending = true;
      try {
        const txid = await ZcashWalletAdapter.sendShielded(address, value, memo.value);
        const notice = await seal(key, { status: "sent", amount: value, txid, memo: memo.value.length > 0 });
        this.send({ type: "pay_notice", requestId: entry.requestId, ...notice });
        this.endOutgoing(entry, false);
        card.clear();
        card.title(`Sent ${value} ${UNIT} to ${entry.nickname}`);
        card.text(`Shielded transaction ${txid.slice(0, 10)}… is on its way. ${entry.nickname} was told privately.`);
        card.actions([["Close", () => card.close()]]);
        this.options.announce(`You sent ${value} ${UNIT} to ${entry.nickname} privately.`);
      } catch (error) {
        entry.sending = false;
        card.disable(false);
        status.textContent = `Couldn't send: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    card.actions([
      [`Send privately`, () => void sendNow(), true],
      ["Cancel", () => this.cancelOutgoing(entry)],
    ]);
    amount.focus();
    amount.select();
  }

  // ------------------------------------------------------------------ mainnet (ADR-018)

  /** Why a fee quote must not be paid, or null: a mainnet Sapling address, at most PAY_FEE_MAX_ZAT, the advertised fee. */
  private feeProblem(fee: PayFeeQuote): string | null {
    const advertised = this.options.advertisedFeeZat?.() ?? null;
    const addressOk = MAINNET ? MAINNET_FEE_ADDRESS.test(fee.address) : isShieldedKind(detectAddressKind(fee.address)) && addressChain(fee.address) !== "mainnet";
    if (!addressOk || !Number.isSafeInteger(fee.zat) || fee.zat <= 0 || fee.zat > PAY_FEE_MAX_ZAT || (advertised !== null && fee.zat !== advertised)) {
      return "The game server's transfer-fee request doesn't match what it advertised, so nothing was sent.";
    }
    if (!MAINNET) return "This server charges a transfer fee that this wallet build can't add to a payment, so nothing was sent.";
    return null;
  }

  /**
   * The sender cancels — waiting for the acceptance or after it. `pay_cancel` needs no key: the server drops the
   * request and any fee entry without a reported transaction (no fee owed), and closes the recipient's card.
   */
  private cancelOutgoing(entry: Outgoing): void {
    if (entry.sending) return;
    this.endOutgoing(entry, true);
    entry.card.close();
  }

  /** Ends the request on this side (timers, map); `notify` tells the server and the recipient (`pay_cancel`). */
  private endOutgoing(entry: Outgoing, notify: boolean): void {
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = null;
    if (this.outgoing.get(entry.requestId) !== entry) return;
    this.outgoing.delete(entry.requestId);
    if (notify) this.send({ type: "pay_cancel", requestId: entry.requestId });
  }

  /** The accepted card ran out of time before anything was sent — cancelled, so no fee is owed. */
  private expireOutgoing(entry: Outgoing): void {
    if (entry.expiry) clearTimeout(entry.expiry); // when a late Review/Send found it out of time, before its timer fired
    entry.expiry = null;
    if (entry.sending || this.outgoing.get(entry.requestId) !== entry) return;
    this.endOutgoing(entry, true);
    entry.card.clear();
    entry.card.text(`This payment request to ${entry.nickname} expired — nothing was sent. Start again from the player menu.`);
    entry.card.actions([["Close", () => entry.card.close()]]);
  }

  /** Whether the accepted card is still in time to send; expires it otherwise. */
  private inTime(entry: Outgoing): boolean {
    if (this.outgoing.get(entry.requestId) !== entry) return false;
    if (entry.acceptedAt !== null && Date.now() - entry.acceptedAt >= PAYMENT_CARD_EXPIRY_MS) {
      this.expireOutgoing(entry);
      return false;
    }
    return true;
  }

  /** ADR-018 § 4/§ 6: amount and memo → Review (fees, cap, upgrade guard) → Send privately (one transaction). */
  private mainnetAmountStep(entry: Outgoing, key: CryptoKey, address: string, fee: PayFeeQuote | null): void {
    const { card } = entry;
    const cap = transactionCapZat();
    const amount = card.input(`Amount (${UNIT}) — the amount ${entry.nickname} gets`, "0.001", "decimal");
    const memo = card.input("Private memo (optional)", "", "text");
    const status = card.text("", "zw-pay-warn");
    status.dataset.role = "payment-status";
    const balance = ZcashWalletAdapter.getBalance();
    if (balance) card.text(`Shielded balance: ${balance.totalZec} ${UNIT}`, "zw-pay-muted");
    // The project fee's amount before Review, so a short balance is no surprise.
    const feeWords = fee ? `${formatZatBig(BigInt(fee.zat))} ${UNIT}${approxUsdSuffix(this.options.feeUsd?.() ?? null)}` : null;
    if (feeWords) card.text(`Project fee: ${feeWords}, on top of the amount (plus the network fee).`, "zw-pay-muted").dataset.role = "project-fee-note";
    if (cap !== null) card.text(`Beta limit: ${formatZatBig(cap)} ${UNIT} per payment${fee ? " (the project fee comes on top)" : ""}.`, "zw-pay-muted");
    const request = (): SendRequest | string => {
      const amountZat = parseZecAmount(amount.value);
      if (amountZat === null) return "Enter an amount like 0.001 (up to 8 decimals).";
      if (cap !== null && amountZat > cap) return `The beta limit is ${formatZatBig(cap)} ${UNIT} per payment${fee ? " (plus the project fee)" : ""}.`;
      if (new TextEncoder().encode(memo.value).length > MEMO_MAX_BYTES) return "The memo is too long (512 bytes max).";
      return {
        purpose: "payment",
        to: address,
        amountZat,
        ...(memo.value ? { memo: memo.value } : {}),
        ...(fee ? { projectFee: { address: fee.address, amountZat: BigInt(fee.zat), memo: buildPayFeeMemo(fee.nonce) } } : {}),
      };
    };
    const review = async (): Promise<void> => {
      const built = request();
      if (typeof built === "string") return void (status.textContent = built);
      if (!this.inTime(entry)) return;
      card.disable(true);
      status.textContent = "Working out the network fee…";
      this.sending++;
      try {
        const guard = await ZcashWalletAdapter.sendingStatus();
        if (!guard.allowed) throw Object.assign(new Error(SENDING_PAUSED), { code: guard.code ?? "consensus_branch_mismatch" });
        const preview = await ZcashWalletAdapter.previewSend(built);
        if (this.outgoing.get(entry.requestId) !== entry) return; // cancelled or expired meanwhile
        this.confirmStep(entry, key, built, preview.networkFeeZat, preview.recipientPool);
      } catch (error) {
        card.disable(false);
        status.textContent = walletErrorMessage(error, { context: "payment", transparentWaiting: (ZcashWalletAdapter.getBalance()?.shieldableZec ?? 0) > 0, ...(feeWords ? { projectFee: feeWords } : {}) });
      } finally {
        this.sending--;
      }
    };
    card.actions([
      ["Review", () => void review(), true],
      ["Cancel", () => this.cancelOutgoing(entry)],
    ]);
    amount.focus();
    amount.select();
  }

  /** The three lines of ADR-018 § 6, then ONE transaction for the recipient and the project fee. */
  private confirmStep(entry: Outgoing, key: CryptoKey, request: SendRequest, networkFeeZat: number, recipientPool: string | null): void {
    const { card } = entry;
    card.clear();
    card.title(`Send ZEC to ${entry.nickname}`);
    const rows: [string, string][] = [[`${entry.nickname} gets`, `${formatZatBig(request.amountZat)} ${UNIT}`]];
    const feeUsd = this.options.feeUsd?.() ?? null;
    if (request.projectFee) rows.push([`Project fee${approxUsdSuffix(feeUsd)}`, `${formatZatBig(request.projectFee.amountZat)} ${UNIT}`]);
    rows.push(["Network fee", `${formatZatBig(BigInt(networkFeeZat))} ${UNIT}`]);
    const total = request.amountZat + (request.projectFee?.amountZat ?? 0n) + BigInt(networkFeeZat);
    rows.push(["Total from your wallet", `${formatZatBig(total)} ${UNIT}`]);
    card.lines(rows);
    // A Sapling recipient (an older client's zs1…) paid from Ironwood funds crosses pools, which makes
    // the amount public — and readable by a fee-checking server from the transaction. Never "never the amount" then.
    const crossing = saplingOutputCrossesPools(recipientPool, total, ZcashWalletAdapter.getBalance()?.shieldedPools);
    card.text(paymentPrivacyLine(Boolean(request.projectFee), crossing), "zw-pay-muted");
    if (crossing) card.text(saplingCrossingPaymentNote(entry.nickname), "zw-pay-warn").dataset.role = "payment-pool-crossing";
    const status = card.text("", "zw-pay-warn");
    status.dataset.role = "payment-status";
    const sendNow = async (): Promise<void> => {
      if (!this.inTime(entry)) return; // Too close to the server's fee deadline — expired instead
      card.disable(true);
      status.textContent = "Building the shielded transaction and its proof… this can take up to a minute.";
      this.sending++;
      entry.sending = true;
      const amountText = formatZatBig(request.amountZat);
      try {
        const txid = await ZcashWalletAdapter.sendRequest(request);
        // ADR-018 § 6: the txid goes to the server for the fee check (then it is dropped there) — before the notice.
        if (request.projectFee) this.send({ type: "pay_sent", requestId: entry.requestId, txid });
        const notice = await seal(key, { status: "sent", amount: amountText, txid, memo: Boolean(request.memo) });
        this.send({ type: "pay_notice", requestId: entry.requestId, ...notice });
        this.endOutgoing(entry, false);
        card.clear();
        card.title(`Sent ${amountText} ${UNIT} to ${entry.nickname}`);
        card.text(`Shielded transaction ${txid.slice(0, 10)}… is on its way. ${entry.nickname} was told privately.`);
        card.actions([["Close", () => card.close()]]);
        this.options.announce(`You sent ${amountText} ${UNIT} to ${entry.nickname} privately.`);
      } catch (error) {
        entry.sending = false;
        const code = engineErrorCode(error);
        if (code === "broadcast_uncertain") {
          // Built and maybe on the network — never an immediate retry (it could pay twice). The txid still
          // goes to the server, so the fee check runs on the real transaction, and the recipient is told it may arrive.
          const txid = engineErrorTxid(error);
          if (txid && request.projectFee) this.send({ type: "pay_sent", requestId: entry.requestId, txid });
          if (txid) {
            const notice = await seal(key, { status: "uncertain", amount: amountText, txid, memo: Boolean(request.memo) }).catch(() => null);
            if (notice) this.send({ type: "pay_notice", requestId: entry.requestId, ...notice });
            this.endOutgoing(entry, false);
          } else {
            this.endOutgoing(entry, true);
          }
          card.clear();
          card.title(`Payment to ${entry.nickname} may have been sent`);
          card.text(walletErrorMessage(error, { context: "payment" }), "zw-pay-warn");
          card.actions([["Close", () => card.close()]]);
        } else if (code === "broadcast_failed") {
          // The network refused it: nothing was paid, so the request is cancelled (no fee is owed).
          this.endOutgoing(entry, true);
          card.clear();
          card.text(walletErrorMessage(error, { context: "payment" }), "zw-pay-warn");
          card.actions([["Close", () => card.close()]]);
        } else {
          card.disable(false);
          const projectFee = request.projectFee ? `${formatZatBig(request.projectFee.amountZat)} ${UNIT}${approxUsdSuffix(feeUsd)}` : null;
          status.textContent = walletErrorMessage(error, { context: "payment", transparentWaiting: (ZcashWalletAdapter.getBalance()?.shieldableZec ?? 0) > 0, ...(projectFee ? { projectFee } : {}) });
          if (isSendingPaused(error)) status.textContent = SENDING_PAUSED;
        }
      } finally {
        this.sending--;
      }
    };
    card.actions([
      ["Send privately", () => void sendNow(), true],
      ["Cancel", () => this.cancelOutgoing(entry)],
    ]);
  }

  private onDecline(message: PayDeclineRelay): void {
    const entry = this.outgoing.get(message.requestId);
    if (!entry || entry.to !== message.from) return;
    const why: Record<PayDeclineReason, string> = {
      declined: `${entry.nickname} declined.`,
      no_wallet: `${entry.nickname} has no unlocked wallet right now.`,
      busy: `${entry.nickname} has other payment requests open — try again in a moment.`,
      expired: "The request expired.",
      failed: `${entry.nickname}'s wallet couldn't answer.`,
    };
    this.endOutgoing(entry, false);
    entry.card.clear();
    entry.card.text(why[message.reason]);
    entry.card.actions([["Close", () => entry.card.close()]]);
  }

  private onError(message: PayErrorMessage): void {
    const incoming = this.incoming.get(message.requestId);
    if (incoming && !this.outgoing.has(message.requestId)) {
      // The server could not pass on this acceptance (a fee-charging server that cannot quote) — nothing was sent.
      this.incoming.delete(message.requestId);
      incoming.card.clear();
      incoming.card.reopen();
      incoming.card.text(message.reason === "rate_limited" ? "The game server is busy and couldn't pass on your answer. Nothing was sent — try again later." : "The request ended. Nothing was sent.");
      incoming.card.actions([["Close", () => incoming.card.close()]]);
      return;
    }
    const entry = this.outgoing.get(message.requestId);
    if (!entry || entry.sending) return;
    const texts: Record<PayErrorReason, string> = {
      unknown_recipient: `${entry.nickname} isn't online any more.`,
      self: "You can't pay yourself.",
      rate_limited: "Too many requests — wait a few seconds.",
      unknown_request: "The request expired.",
      // ADR-015: payments travel only between wallet holders (the server checks both ends).
      no_wallet: `${entry.nickname} has no wallet, so there is nowhere to send ZEC. Nothing was sent.`,
      sender_no_wallet: "Only players with a wallet can send ZEC — connect your wallet first. Nothing was sent.",
      // ADR-018 § 4, § 6.
      over_cap: "This server's beta limit per payment is lower than your game's — reload the page to update the game. Nothing was sent.",
      fee_unpaid: "A recent payment of yours didn't include the project's transfer fee, so this server refuses further payments from you for this session. Reload to start a new session. Nothing was sent.",
    };
    const text = texts[message.reason];
    this.endOutgoing(entry, false);
    entry.card.clear();
    entry.card.text(text);
    entry.card.actions([["Close", () => entry.card.close()]]);
  }

  private card(title: string): Card {
    return new Card(this.stack, title);
  }
}

/** Address prefix ("utest", "uregtest", "u", "ztestsapling", …) — both sides must be on the same network. */
function hrp(address: string): string {
  return address.slice(0, address.lastIndexOf("1"));
}

/**
 * The confirmation card's privacy line (ADR-018 § 6). When the recipient's Sapling output is paid from Ironwood funds
 * (`crossing`), the amount is public on the chain, so the card does not say "never the amount".
 */
export function paymentPrivacyLine(withProjectFee: boolean, crossing: boolean): string {
  if (crossing) {
    return withProjectFee
      ? "One shielded transaction pays both. The game server can check the project fee — and, because this payment crosses pools, read its amount; never anyone's address."
      : "One shielded transaction. Because it crosses pools its amount is public on the chain; the addresses stay private.";
  }
  return withProjectFee
    ? "One shielded transaction pays both. The game server can check only the project fee — never the amount or anyone's address."
    : "One shielded transaction. The game server never sees the amount or the address.";
}

/**
 * The address a recipient sealed is one this wallet may pay: a valid shielded address on this wallet's own chain.
 * On mainnet the recipient seals its shielded-only u1… (an older client its zs1…) while this
 * wallet's own address is the full u1…, so the chain decides there; on the test chains both sides keep the same format.
 * A t1…/TEX address is never acceptable here (a player payment is always shielded).
 */
export function acceptableAddress(address: string, own: string): boolean {
  const kind = detectAddressKind(address);
  if (!validateAddress(address).ok || !isShieldedKind(kind) || kind === "sprout") return false;
  if (addressChain(address) !== addressChain(own) || addressChain(address) === "unknown") return false;
  return addressChain(own) === "mainnet" ? hrp(address) === "u" || hrp(address) === "zs" : hrp(address) === hrp(own);
}

class Card {
  private readonly element: HTMLDivElement;
  private readonly heading: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly parent: HTMLElement;

  constructor(parent: HTMLElement, title: string) {
    this.parent = parent;
    this.element = document.createElement("div");
    this.element.className = "zw-panel zw-pay-card";
    this.heading = document.createElement("div");
    this.heading.className = "zw-pay-title";
    this.heading.textContent = title;
    this.body = document.createElement("div");
    this.body.className = "zw-pay-body";
    this.element.append(this.heading, this.body);
    parent.appendChild(this.element);
    document.exitPointerLock();
  }

  title(text: string): void {
    this.heading.textContent = text;
  }

  clear(): void {
    this.body.replaceChildren();
  }

  text(content: string, className = ""): HTMLParagraphElement {
    const p = document.createElement("p");
    p.className = `zw-pay-text ${className}`;
    p.textContent = content; // textContent ONLY
    this.body.appendChild(p);
    return p;
  }

  code(code: string): void {
    const row = document.createElement("div");
    row.className = "zw-pay-code";
    row.title = "Both of you see the same four symbols unless someone tampered with the exchange. Compare them by voice or chat if you like.";
    const label = document.createElement("span");
    label.textContent = "Security code";
    const value = document.createElement("b");
    value.textContent = code;
    row.append(label, value);
    this.body.appendChild(row);
  }

  input(label: string, value: string, mode: "decimal" | "text"): HTMLInputElement {
    const wrap = document.createElement("label");
    wrap.className = "zw-pay-field";
    wrap.textContent = label;
    const input = document.createElement("input");
    input.className = "zw-input";
    input.value = value;
    input.inputMode = mode;
    input.maxLength = mode === "decimal" ? 20 : 400;
    input.autocomplete = "off";
    input.addEventListener("keydown", (event) => event.stopPropagation());
    wrap.appendChild(input);
    this.body.appendChild(wrap);
    return input;
  }

  actions(buttons: [string, () => void, boolean?][]): void {
    const row = document.createElement("div");
    row.className = "zw-pay-actions";
    for (const [label, onClick, primary] of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `zw-button${primary ? " zw-button-primary" : ""}`;
      b.textContent = label;
      b.addEventListener("click", onClick);
      row.appendChild(b);
    }
    this.body.appendChild(row);
  }

  /** The confirmation lines ("Recipient gets X" / "Project fee …" / "Network fee …"). */
  lines(rows: readonly [string, string][]): void {
    const box = document.createElement("div");
    box.className = "zw-pay-lines";
    box.dataset.role = "payment-lines";
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "zw-pay-line";
      const name = document.createElement("span");
      name.textContent = label;
      const amount = document.createElement("b");
      amount.textContent = value;
      row.append(name, amount);
      box.appendChild(row);
    }
    this.body.appendChild(box);
  }

  disable(disabled: boolean): void {
    for (const control of Array.from(this.body.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input"))) control.disabled = disabled;
  }

  reopen(): void {
    if (!this.element.isConnected) this.parent.appendChild(this.element);
  }

  close(): void {
    this.element.remove();
  }
}

let paymentStylesInjected = false;
function injectPaymentStyles(): void {
  if (paymentStylesInjected) return;
  paymentStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-pay-stack { position: absolute; right: 16px; top: 50%; transform: translateY(-50%); z-index: 22; display: flex; flex-direction: column; gap: 10px; width: min(340px, 92vw); pointer-events: none; }
.zw-pay-card { pointer-events: auto; padding: 12px 14px; border-radius: 14px; border: 1px solid rgba(244,183,40,0.55); background: rgba(24,20,12,0.96); box-shadow: 0 10px 30px rgba(0,0,0,0.45); }
.zw-pay-title { font: 700 15px "Segoe UI", system-ui, sans-serif; color: #ffd36a; margin-bottom: 6px; display: flex; gap: 8px; align-items: center; }
.zw-pay-title::before { content: "ⓩ"; display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #f4b728; color: #241a05; font-size: 13px; font-weight: 800; }
.zw-pay-body { display: flex; flex-direction: column; gap: 8px; }
.zw-pay-text { margin: 0; font-size: 13px; line-height: 1.45; color: #efe6d2; }
.zw-pay-text:empty { display: none; }
.zw-pay-warn { color: #ffb3a9; }
.zw-pay-muted { color: #b8ac93; font-size: 12px; }
.zw-pay-code { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.06); font-size: 12px; color: #cdbf9e; }
.zw-pay-code b { font-size: 18px; letter-spacing: 4px; }
.zw-pay-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #cdbf9e; }
.zw-pay-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.zw-pay-lines { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,0.05); }
.zw-pay-line { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; color: #efe6d2; }
.zw-pay-line b { color: #fff6dc; }
`;
  document.head.appendChild(style);
}
