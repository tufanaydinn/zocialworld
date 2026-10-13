import {
  NAME_DEV_ADDRESS,
  NAME_FEE_MAX_ZAT,
  NAME_MEMO_KEY_PREFIX_LENGTH,
  nameClaimMessage,
  parseNameMemo,
  type NameChallengeMessage,
  type NameKeyAlg,
  type NameQuoteMessage,
  type NameStatus,
  type NameStatusMessage,
} from "@project/shared";
import { NameConfirmationError, type NameConfirmation, type NameConfirmationStatus } from "./nameConfirmation.ts";
import { nicknameKey } from "./nicknameRules.ts";
import { engineErrorCode, walletErrorMessage } from "../zcash/engineErrors.ts";
import { approxUsdSuffix } from "../zcash/feeLabel.ts";

/**
 * ADR-016's fee-confirmed names, client side: the state machine behind the nickname step's
 * "Confirm & pay" and behind a returning player's automatic claim.
 *
 *   confirm:  reserve ──quote──▶ (check the quote) ──▶ pay with the in-game wallet ──▶ pending ──▶ seen ──▶ confirmed
 *                │                        │ not enough coins → "Get test coins", then try again (same reservation)
 *                │ taken ──▶ claim (it may be ours: a name registered with this wallet earlier) ──▶ confirmed | taken
 *                └ invalid / disabled / rate_limited
 *             expired (no payment in 30 min) and timeout (not confirmed 5 min after paying) offer "Try again".
 *   claim:    claim_request ──challenge──▶ sign with the name key ──▶ proof ──▶ confirmed | failed   (never pays)
 *
 * Money safety: a reservation id is paid at most once (remembered in sessionStorage across a reload; asking again
 * for the same name with the same key returns the same reservation); a quote is paid only if its memo carries THIS
 * wallet's key hash, its amount is the advertised fee (and at most NAME_FEE_MAX_ZAT), and its address is a
 * test-chain shielded address. The address is handed to the wallet and never shown. The `dev` registry's
 * placeholder address (NAME_DEV_ADDRESS) is never paid: the dev server confirms on its own.
 *
 * ADR-018 § 5: on a mainnet build the quote's address must be a mainnet shielded address (u1… / zs1…; normally the
 * registry's full UA, which the wallet pays as an Ironwood output), the fee is a fixed ZEC amount (about US$1 at the
 * default; a fiat label only when the operator publishes one; the per-transaction cap applies in the wallet adapter), there is
 * no faucet, and after paying the client reports the txid (`name_payment_sent`) — the server's lightwalletd backend
 * fetches that transaction and decrypts it with the registry's viewing key.
 */

/** What the fee flow needs from the outside (App wires the network client, the wallet adapter, the name key and the faucet). */
export interface FeeNameDeps {
  readonly network: {
    reserve(nickname: string, keyHash: string): void;
    claimRequest(nickname: string): void;
    claimProof(proof: { nickname: string; publicKey: string; signature: string; alg: NameKeyAlg }): void;
    /** ADR-018 § 5: the paid reservation's txid, for the server's lightwalletd backend (others ignore it). */
    paymentSent?(reservationId: string, txid: string): void;
    /** The socket is open (requests work before join too). */
    isOpen(): boolean;
  };
  /** The unlocked wallet's name key (null while locked or still deriving). */
  readonly nameKey: () => FeeNameKey | null;
  readonly subscribeNameKey: (listener: () => void) => () => void;
  readonly wallet: {
    /** What the wallet can spend now, in zatoshi — null when unknown (not synced yet). */
    spendableZat(): number | null;
    /** The wallet's shielded send with a memo; resolves with the txid. */
    sendShielded(address: string, amountZec: string, memo: string): Promise<string>;
  };
  /** Test coins from this server's faucet. `credential` proves a live connection: the voice capability once joined, else the pending reservation id. */
  readonly faucet?: (credential: string | null) => Promise<string>;
  /** The joined session's capability (null before join). */
  readonly capability?: () => string | null;
  /** The fee the server advertised (GET /zcash/info), in zatoshi. */
  readonly feeZat: number;
  /** The operator's approximate fiat value of that fee (GET /zcash/info → names.feeUsd); null shows ZEC only. */
  readonly feeUsd?: number | null;
  /** The chain this build's wallet is on (default "test"). Mainnet quotes must carry a mainnet address. */
  readonly chain?: "main" | "test";
  readonly replyTimeoutMs?: number;
  readonly confirmTimeoutMs?: number;
  readonly keyWaitMs?: number;
  /** Where paid reservation ids are remembered (default: sessionStorage, try/catch). Null: memory only. */
  readonly paidStore?: Pick<Storage, "getItem" | "setItem"> | null;
}

export interface FeeNameKey {
  readonly alg: NameKeyAlg;
  readonly publicKey: string;
  readonly keyHash: string;
  sign(message: string): Promise<string>;
}

type NameMessage = NameQuoteMessage | NameStatusMessage | NameChallengeMessage;

/** ZIP 317 for a typical shielded payment is 10,000 zat; the balance check leaves a little room above that. */
export const NETWORK_FEE_ESTIMATE_ZAT = 15_000;
const PAID_STORAGE_KEY = "name-paid-v1";
const PAID_MEMORY_MS = 2 * 60 * 60 * 1000;
const TEST_CHAIN_SHIELDED = /^(u(regtest|test)1[0-9a-z]{40,}|z(regtest|test)sapling1[0-9a-z]{40,})$/;
/** ADR-018 § 5: a mainnet shielded registry address (a UA's Sapling receiver keeps it payable by an older client too). */
const MAINNET_SHIELDED = /^(u1[0-9a-z]{40,}|zs1[0-9a-z]{60,90})$/;

/** 1000000 → "0.01" (exact; no floating point). */
export function formatZat(zat: number): string {
  const whole = Math.floor(zat / 1e8);
  const fraction = String(zat % 1e8).padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * Why a quote must not be paid, or null if it may: the memo must parse and carry this wallet's key-hash prefix, the
 * amount must be the advertised fee (when one was advertised) and at most NAME_FEE_MAX_ZAT, and the address a
 * test-chain shielded one (or the dev placeholder, which is never paid).
 */
export function quoteProblem(quote: NameQuoteMessage, keyHash: string, advertisedFeeZat: number, network: "main" | "test" = "test"): string | null {
  const memo = parseNameMemo(quote.memo);
  if (!memo || memo.keyHashPrefix !== keyHash.slice(0, NAME_MEMO_KEY_PREFIX_LENGTH)) return "memo";
  if (!Number.isSafeInteger(quote.amountZat) || quote.amountZat <= 0 || quote.amountZat > NAME_FEE_MAX_ZAT) return "amount";
  if (advertisedFeeZat > 0 && quote.amountZat !== advertisedFeeZat) return "amount";
  if (network === "main") return MAINNET_SHIELDED.test(quote.address) ? null : "address"; // never the dev placeholder on mainnet
  if (quote.address !== NAME_DEV_ADDRESS && !TEST_CHAIN_SHIELDED.test(quote.address)) return "address";
  return null;
}

const REFUSALS: Partial<Record<NameStatus, string>> = {
  invalid: "That name can't be registered (Guest names and system words are reserved).",
  disabled: "Name registration is unavailable on this server right now — you keep your guest name for the moment.",
  rate_limited: "Too many name requests — wait a minute and try again.",
};

export class FeeNameConfirmation implements NameConfirmation {
  readonly requiresFee = true;
  readonly confirmLabel = "Confirm & pay";
  readonly feeText: string;
  readonly explanation =
    "Why a fee? It stops bots. The name is then yours on any device with this wallet — no fee when you come back. It is not a purchase, and there are no refunds.";
  readonly unavailable = null;

  private readonly deps: FeeNameDeps;
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<{ match: (message: NameMessage) => unknown; resolve: (value: unknown) => void }>();
  /** The latest progress status per reservation id (name_status with a reservationId). */
  private readonly progress = new Map<string, NameStatus>();
  private readonly progressListeners = new Set<() => void>();
  private readonly paidMemory = new Map<string, number>();
  /** The reservation being paid for now (the faucet's credential before join). */
  private reservation: NameQuoteMessage | null = null;
  /** ADR-018 § 5: the txid of a paid reservation, re-reported after a reconnect (memory only). */
  private readonly paidTxids = new Map<string, string>();
  private running: { key: string; promise: Promise<void>; onStatus: ((status: NameConfirmationStatus) => void) | undefined } | null = null;
  private claiming = false;

  constructor(deps: FeeNameDeps) {
    this.deps = deps;
    const usd = deps.feeUsd ?? null;
    this.feeText = this.mainnet
      ? `Confirm with a small fee: ${formatZat(deps.feeZat)} ZEC${usd === null ? "" : ` (${approxUsdSuffix(usd).trim()})`} + network fee`
      : `Confirm with a small fee: ${formatZat(deps.feeZat)} TAZ + network fee`;
    deps.subscribeNameKey(() => this.notify());
  }

  /** A confirmation is running (reserving, paying or waiting for it): ADR-018 § 7's update prompt waits. */
  get busy(): boolean {
    return this.running !== null || this.claiming;
  }

  private get mainnet(): boolean {
    return this.deps.chain === "main";
  }

  canClaim(): boolean {
    return this.deps.nameKey() !== null && this.deps.network.isOpen();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Every name_* message from the network (App → NetworkClient.onName). */
  handle(message: NameMessage): void {
    if (message.type === "name_status" && message.reservationId) {
      this.progress.set(message.reservationId, message.status);
      for (const listener of [...this.progressListeners]) listener();
    }
    for (const waiter of [...this.waiters]) {
      const value = waiter.match(message);
      if (value !== null && value !== undefined) {
        this.waiters.delete(waiter);
        waiter.resolve(value);
      }
    }
  }

  confirm(nickname: string, onStatus?: (status: NameConfirmationStatus) => void): Promise<void> {
    const key = nicknameKey(nickname);
    if (this.running) {
      // The same name again (e.g. the modal was reopened): follow the flow that is already running.
      if (this.running.key === key) {
        this.running.onStatus = onStatus;
        return this.running.promise;
      }
      return Promise.reject(new NameConfirmationError("busy", "Another name is still being confirmed — wait for it to finish."));
    }
    const running = { key, promise: Promise.resolve(), onStatus };
    const report = (status: NameConfirmationStatus): void => running.onStatus?.(status);
    running.promise = this.runConfirm(nickname, report).finally(() => {
      if (this.running === running) this.running = null;
    });
    this.running = running;
    return running.promise;
  }

  async claim(nickname: string, onStatus?: (status: NameConfirmationStatus) => void): Promise<boolean> {
    if (this.claiming || this.running) return false;
    this.claiming = true;
    try {
      onStatus?.({ phase: "working", step: "claiming", text: `Checking that ${nickname} is yours…` });
      const key = this.deps.nameKey() ?? (await this.waitForKey());
      if (!key || !this.deps.network.isOpen()) {
        onStatus?.({ phase: "failed", text: "Your name couldn't be checked right now.", reason: key ? "offline" : "wallet", retry: true });
        return false;
      }
      const ok = await this.runClaim(nickname, key).catch(() => false);
      onStatus?.(ok ? { phase: "done", text: `${nickname} is yours.` } : { phase: "failed", text: `${nickname} isn't registered to this wallet here.`, reason: "taken" });
      return ok;
    } finally {
      this.claiming = false;
    }
  }

  /**
   * The socket reconnected — a new session on the server, so a paid reservation's updates would go to the old one.
   * Asking again for the same name with the same key re-binds the reservation to this session (same reservation id,
   * never a second payment); if the name was confirmed meanwhile it is registered now ("taken"), and a claim proves
   * it is ours.
   */
  resume(): void {
    const quote = this.reservation;
    const key = this.deps.nameKey();
    if (!this.running || !quote || !key || !this.isPaid(quote.reservationId)) return;
    const txid = this.paidTxids.get(quote.reservationId);
    void this.request(
      () => this.deps.network.reserve(quote.nickname, key.keyHash),
      (m) => (m.type === "name_quote" && m.reservationId === quote.reservationId ? m : m.type === "name_status" && !m.reservationId && m.nickname === quote.nickname ? m : null),
    )
      .then(async (answer) => {
        // The reservation is ours again on this connection: re-report the payment (a restarted server forgot it).
        if (answer.type === "name_quote" && txid) this.deps.network.paymentSent?.(quote.reservationId, txid);
        if (answer.type !== "name_status" || answer.status !== "taken") return;
        if (!(await this.runClaim(quote.nickname, key).catch(() => false))) return;
        this.progress.set(quote.reservationId, "confirmed");
        for (const listener of [...this.progressListeners]) listener();
      })
      .catch(() => undefined);
  }

  async getTestCoins(): Promise<string> {
    if (this.mainnet) return "There is no faucet on mainnet — add funds in the Wallet panel (Add funds), then shield them.";
    if (!this.deps.faucet) return "This server has no faucet — get test coins from the Wallet panel.";
    const pending = this.reservation && this.reservation.expiresAt > Date.now() ? this.reservation.reservationId : null;
    return this.deps.faucet(this.deps.capability?.() ?? pending);
  }

  // ------------------------------------------------------------------ the flows

  private async runConfirm(nickname: string, report: (status: NameConfirmationStatus) => void): Promise<void> {
    const key = this.deps.nameKey();
    if (!key) throw new NameConfirmationError("wallet", "Unlock your wallet first — the name is tied to it.", { retry: true });
    if (!this.deps.network.isOpen()) throw new NameConfirmationError("offline", "Not connected to the game server — try again in a moment.", { retry: true });

    report({ phase: "working", step: "reserving", text: `Reserving ${nickname}…`, progress: 0.1 });
    const answer = await this.request(
      () => this.deps.network.reserve(nickname, key.keyHash),
      (m) => (m.type === "name_quote" && nicknameKey(m.nickname) === nicknameKey(nickname) ? m : m.type === "name_status" && !m.reservationId && m.nickname === nickname ? m : null),
    );
    if (answer.type === "name_status") {
      if (answer.status === "taken") {
        // Registered names are taken for everyone — including their owner, who proves the key instead of paying again.
        report({ phase: "working", step: "claiming", text: `${nickname} is registered — checking whether it is yours…` });
        if (await this.runClaim(nickname, key).catch(() => false)) {
          report({ phase: "done", text: `${nickname} is yours again — no fee.` });
          return;
        }
        throw new NameConfirmationError("taken", `${nickname} is taken. Try another name.`);
      }
      throw new NameConfirmationError(answer.status === "invalid" || answer.status === "disabled" || answer.status === "rate_limited" ? answer.status : "error", REFUSALS[answer.status] ?? "The name couldn't be reserved.", {
        retry: answer.status === "rate_limited",
      });
    }

    const quote = answer;
    if (quoteProblem(quote, key.keyHash, this.deps.feeZat, this.deps.chain ?? "test") !== null) {
      throw new NameConfirmationError("error", "The server's payment request doesn't match this wallet or the advertised fee, so nothing was paid.");
    }
    // Kept after a failure too: before join, the faucet's proof of a live connection is this pending reservation.
    this.reservation = quote;
    if (!this.isPaid(quote.reservationId)) {
      if (quote.address === NAME_DEV_ADDRESS) {
        this.markPaid(quote.reservationId); // the dev registry confirms on its own: nothing to pay
      } else {
        await this.pay(quote, report);
      }
    }
    try {
      await this.awaitConfirmation(quote, report);
    } finally {
      this.reservation = null;
    }
    report({ phase: "done", text: `Confirmed — ${quote.nickname} is yours.` });
  }

  private async pay(quote: NameQuoteMessage, report: (status: NameConfirmationStatus) => void): Promise<void> {
    const unit = this.mainnet ? "ZEC" : "TAZ";
    const needed = quote.amountZat + NETWORK_FEE_ESTIMATE_ZAT;
    const spendable = this.deps.wallet.spendableZat();
    if (spendable !== null && spendable < needed) {
      throw new NameConfirmationError(
        "insufficient",
        this.mainnet
          ? `Your wallet needs about ${formatZat(needed)} shielded ZEC for this (fee + network fee). Add funds in the Wallet panel and shield them, then try again — your reservation is kept for 30 minutes.`
          : `Your wallet needs about ${formatZat(needed)} TAZ for this (fee + network fee). Get free test coins, then try again — your reservation is kept for 30 minutes.`,
        { faucet: !this.mainnet, retry: true },
      );
    }
    report({ phase: "working", step: "paying", text: `Paying ${formatZat(quote.amountZat)} ${unit} from your wallet — proving the payment takes 10–60 s…` });
    let txid: string;
    try {
      txid = await this.deps.wallet.sendShielded(quote.address, formatZat(quote.amountZat), quote.memo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = engineErrorCode(error);
      if (code === "insufficient_funds" || (!code && /insufficient|not enough|balance/i.test(message))) {
        throw new NameConfirmationError(
          "insufficient",
          this.mainnet ? "Not enough shielded ZEC for the fee and the network fee. Add funds (and shield them) in the Wallet panel, then try again." : "Not enough test coins in your wallet for the fee and the network fee. Get free test coins, then try again.",
          { faucet: !this.mainnet, retry: true },
        );
      }
      if (/not open|locked/i.test(message)) throw new NameConfirmationError("wallet", "Unlock your wallet to pay.", { retry: true });
      if (code) throw new NameConfirmationError("wallet", `${walletErrorMessage(error, { context: "name_fee" })} Nothing was paid.`.replace(/Nothing was sent\. Nothing was paid\./, "Nothing was paid."), { retry: true });
      throw new NameConfirmationError("wallet", "The payment couldn't be sent, so nothing was paid. Try again.", { retry: true });
    }
    this.markPaid(quote.reservationId);
    // ADR-018 § 5: the server's lightwalletd backend reads this transaction (other backends ignore the message).
    if (typeof txid === "string" && /^[0-9a-f]{64}$/.test(txid)) {
      this.paidTxids.set(quote.reservationId, txid);
      this.deps.network.paymentSent?.(quote.reservationId, txid);
    }
  }

  /** Waits for `confirmed` on this reservation (pending → seen on the way); expired and the timeout reject. */
  private awaitConfirmation(quote: NameQuoteMessage, report: (status: NameConfirmationStatus) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let last: NameStatus | null = null;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new NameConfirmationError("timeout", "Not confirmed yet — the test chain may be slow. Your payment is safe: check again in a minute (you won't pay twice).", { retry: true }));
      }, this.deps.confirmTimeoutMs ?? 5 * 60_000);
      const check = (): void => {
        const status = this.progress.get(quote.reservationId) ?? "pending";
        if (status === last) return;
        last = status;
        if (status === "confirmed") {
          cleanup();
          resolve();
        } else if (status === "expired") {
          cleanup();
          reject(new NameConfirmationError("expired", "The reservation expired before a payment arrived. A late payment can't be reused (there are no refunds). Try again for a new reservation.", { retry: true }));
        } else if (status === "seen") {
          report({ phase: "working", step: "seen", text: "Payment seen — confirming your name…", progress: 0.8 });
        } else {
          report({ phase: "working", step: "pending", text: "Payment sent — waiting for the game server to see it…", progress: 0.55 });
        }
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.progressListeners.delete(check);
      };
      this.progressListeners.add(check);
      check();
    });
  }

  private async runClaim(nickname: string, key: FeeNameKey): Promise<boolean> {
    const challenge = await this.request(
      () => this.deps.network.claimRequest(nickname),
      (m) => (m.type === "name_challenge" && m.nickname === nickname ? m : m.type === "name_status" && !m.reservationId && m.nickname === nickname ? m : null),
    );
    if (challenge.type !== "name_challenge") return false;
    const signature = await key.sign(nameClaimMessage(challenge.nonce, nickname));
    const result = await this.request(
      () => this.deps.network.claimProof({ nickname, publicKey: key.publicKey, signature, alg: key.alg }),
      (m) => (m.type === "name_status" && !m.reservationId && m.nickname !== undefined && nicknameKey(m.nickname) === nicknameKey(nickname) && (m.status === "confirmed" || m.status === "failed" || m.status === "disabled") ? m : null),
    );
    return result.type === "name_status" && result.status === "confirmed";
  }

  /** Sends, then waits for the first message `match` accepts (or rejects as offline after the reply timeout). */
  private request<T>(send: () => void, match: (message: NameMessage) => T | null): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        match,
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value as T);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new NameConfirmationError("offline", "The game server didn't answer — check your connection and try again.", { retry: true }));
      }, this.deps.replyTimeoutMs ?? 15_000);
      this.waiters.add(waiter);
      send();
    });
  }

  private waitForKey(): Promise<FeeNameKey | null> {
    return new Promise((resolve) => {
      const done = (key: FeeNameKey | null): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve(key);
      };
      const timer = setTimeout(() => done(null), this.deps.keyWaitMs ?? 10_000);
      const unsubscribe = this.deps.subscribeNameKey(() => {
        const key = this.deps.nameKey();
        if (key) done(key);
      });
    });
  }

  // ------------------------------------------------------------------ paid reservations (never pay one twice)

  private storage(): Pick<Storage, "getItem" | "setItem"> | null {
    if (this.deps.paidStore !== undefined) return this.deps.paidStore;
    try {
      return typeof window !== "undefined" ? window.sessionStorage : null;
    } catch {
      return null;
    }
  }

  private readPaid(): Record<string, number> {
    try {
      const raw = this.storage()?.getItem(PAID_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private isPaid(reservationId: string): boolean {
    return this.paidMemory.has(reservationId) || typeof this.readPaid()[reservationId] === "number";
  }

  private markPaid(reservationId: string): void {
    const now = Date.now();
    this.paidMemory.set(reservationId, now);
    try {
      const paid = this.readPaid();
      paid[reservationId] = now;
      for (const [id, at] of Object.entries(paid)) if (typeof at !== "number" || now - at > PAID_MEMORY_MS) delete paid[id];
      this.storage()?.setItem(PAID_STORAGE_KEY, JSON.stringify(paid));
    } catch {
      // Storage unavailable: this page still remembers it.
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
