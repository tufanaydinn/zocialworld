/**
 * How a wallet holder's chosen nickname is applied (ADR-015 § 3 and ADR-016).
 *
 * Three implementations, chosen by what the game server says it runs (GET /zcash/info → `names.mode`):
 *  - `immediateNameConfirmation` — no registry (NAME_REGISTRY=off, ADR-015's honour mode): `set_nickname`, nothing
 *    else; the name is not owned.
 *  - `FeeNameConfirmation` (feeNameConfirmation.ts) — ADR-016: reserve → a small shielded payment from the in-game
 *    wallet → the server confirms; a returning player claims instead (a challenge signed with the name key).
 *  - `disabledNameConfirmation` — the server's registry is misconfigured: holders keep a Guest-style name and the
 *    nickname step says why.
 * `NameConfirmationSwitch` lets App hand onboarding one object and change the implementation once the server's
 * mode is known.
 *
 * Nothing here ever shows an address or a balance.
 */

export type NameConfirmationStep = "reserving" | "paying" | "pending" | "seen" | "claiming";

/** Why a confirmation stopped (the nickname step words it and offers the matching action). */
export type NameConfirmationFailure = "taken" | "invalid" | "disabled" | "rate_limited" | "expired" | "timeout" | "insufficient" | "wallet" | "offline" | "busy" | "error";

export type NameConfirmationStatus =
  | { readonly phase: "working"; readonly text: string; readonly step?: NameConfirmationStep; /** 0–1, or omitted when unknown. */ readonly progress?: number }
  | { readonly phase: "done"; readonly text?: string }
  | {
      readonly phase: "failed";
      readonly text: string;
      readonly reason?: NameConfirmationFailure;
      /** Offer "Try again" (expired, timeout, offline, a wallet error). */
      readonly retry?: boolean;
      /** Offer "Get test coins" (not enough in the wallet for the fee). */
      readonly faucet?: boolean;
    };

/** A confirmation that stopped: `confirm()` rejects with this (OnboardingFlow turns it into a failed status). */
export class NameConfirmationError extends Error {
  readonly reason: NameConfirmationFailure;
  readonly retry: boolean;
  readonly faucet: boolean;

  constructor(reason: NameConfirmationFailure, message: string, options: { retry?: boolean; faucet?: boolean } = {}) {
    super(message);
    this.name = "NameConfirmationError";
    this.reason = reason;
    this.retry = options.retry ?? false;
    this.faucet = options.faucet ?? false;
  }
}

/** The failed status for whatever a confirmation rejected with. */
export function failedStatus(reason: unknown, fallback = "The name couldn't be applied."): NameConfirmationStatus {
  if (reason instanceof NameConfirmationError) return { phase: "failed", text: reason.message, reason: reason.reason, retry: reason.retry, faucet: reason.faucet };
  return { phase: "failed", text: reason instanceof Error && reason.message ? reason.message : fallback, reason: "error", retry: true };
}

export interface NameConfirmation {
  /** Whether confirming a name costs a fee (ADR-016): the nickname step then shows the fee box and "Confirm & pay". */
  readonly requiresFee: boolean;
  /** The nickname step's confirm button ("Use this name"; ADR-016: "Confirm & pay"). */
  readonly confirmLabel: string;
  /** The fee line, e.g. "Confirm with a small fee: 0.01 TAZ + network fee" ("" without a fee). */
  readonly feeText: string;
  /** Why (and what it means), under the fee line ("" for none). */
  readonly explanation: string;
  /** Set when this server cannot confirm names now: the reason, shown on the nickname step (holders keep a Guest-style name). */
  readonly unavailable: string | null;
  /** Whether `claim` can run now (the fee flow needs the unlocked wallet's name key). */
  canClaim(): boolean;
  /**
   * Applies `nickname` to this session — before join too (the server applies it at join). Resolves when the request
   * is on its way (honour mode) or confirmed (fee); rejects with a NameConfirmationError when it cannot be applied.
   */
  confirm(nickname: string, onStatus?: (status: NameConfirmationStatus) => void): Promise<void>;
  /** A returning player gets an owned name back without paying (fee mode: a signed challenge). Resolves false when it isn't theirs here. */
  claim(nickname: string, onStatus?: (status: NameConfirmationStatus) => void): Promise<boolean>;
  /** Fee mode, after a `faucet` failure: test coins from this server's faucet. Resolves with a sentence for the status line. */
  getTestCoins?(): Promise<string>;
  /** Told whenever anything above may have changed (the server's mode arrived, the name key became ready). */
  subscribe(listener: () => void): () => void;
}

const noSubscription = (): (() => void) => () => undefined;

/** No registry on this server (ADR-015 honour mode): a `set_nickname` and nothing else. */
export function immediateNameConfirmation(sendNickname: (nickname: string) => void): NameConfirmation {
  return {
    requiresFee: false,
    confirmLabel: "Use this name",
    feeText: "",
    explanation: "",
    unavailable: null,
    canClaim: () => true,
    confirm(nickname, onStatus) {
      sendNickname(nickname);
      onStatus?.({ phase: "done" });
      return Promise.resolve();
    },
    claim(nickname, onStatus) {
      sendNickname(nickname);
      onStatus?.({ phase: "done" });
      return Promise.resolve(true);
    },
    subscribe: noSubscription,
  };
}

/** The server's registry is misconfigured (ADR-016 § 3): no names for now — holders keep a Guest-style name. */
export function disabledNameConfirmation(): NameConfirmation {
  const text = "Name registration is unavailable on this server right now, so wallet holders keep their guest name for the moment. Your wallet, voice and ZEC still work.";
  return {
    requiresFee: false,
    confirmLabel: "Continue with a guest name",
    feeText: "",
    explanation: "",
    unavailable: text,
    canClaim: () => false,
    confirm: () => Promise.reject(new NameConfirmationError("disabled", text)),
    claim: () => Promise.resolve(false),
    subscribe: noSubscription,
  };
}

/** One NameConfirmation whose implementation App swaps once the server's mode is known (subscribers are told). */
export class NameConfirmationSwitch implements NameConfirmation {
  private current: NameConfirmation;
  private unsubscribeCurrent: () => void;
  private readonly listeners = new Set<() => void>();

  constructor(initial: NameConfirmation) {
    this.current = initial;
    this.unsubscribeCurrent = initial.subscribe(() => this.notify());
  }

  use(next: NameConfirmation): void {
    if (next === this.current) return;
    this.unsubscribeCurrent();
    this.current = next;
    this.unsubscribeCurrent = next.subscribe(() => this.notify());
    this.notify();
  }

  get implementation(): NameConfirmation {
    return this.current;
  }

  get requiresFee(): boolean {
    return this.current.requiresFee;
  }
  get confirmLabel(): string {
    return this.current.confirmLabel;
  }
  get feeText(): string {
    return this.current.feeText;
  }
  get explanation(): string {
    return this.current.explanation;
  }
  get unavailable(): string | null {
    return this.current.unavailable;
  }
  canClaim(): boolean {
    return this.current.canClaim();
  }
  confirm(nickname: string, onStatus?: (status: NameConfirmationStatus) => void): Promise<void> {
    return this.current.confirm(nickname, onStatus);
  }
  claim(nickname: string, onStatus?: (status: NameConfirmationStatus) => void): Promise<boolean> {
    return this.current.claim(nickname, onStatus);
  }
  getTestCoins(): Promise<string> {
    return this.current.getTestCoins?.() ?? Promise.resolve("No faucet here.");
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
