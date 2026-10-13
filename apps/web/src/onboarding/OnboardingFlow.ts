import {
  MAX_NICKNAME_LENGTH,
  PLAYER_AVATAR_COLOR_COUNT,
  PLAYER_AVATAR_MODELS,
  type NicknameCheckResultMessage,
  type NicknameCheckStatus,
  type PlayerAvatar,
  type PlayerAvatarModel,
} from "@project/shared";
import type { WalletStatus } from "../zcash/WalletTypes.ts";
import { injectUiStyles } from "../ui/styles.ts";
import { HAS_BRAND_ART, brandBackground } from "../ui/brand.ts";
import { AVATAR_COLOR_NAMES, avatarColorCss } from "../player/avatarPalette.ts";
import type { CharacterPreviewHandle } from "./CharacterPreview.ts";
import { failedStatus, type NameConfirmation, type NameConfirmationStatus } from "./nameConfirmation.ts";
import { checkNicknameLocally, nicknameProblemText } from "./nicknameRules.ts";
import type { PlayerProfile } from "./profileStore.ts";

/**
 * The start-of-game flow (ADR-015 § 7), shown BEFORE the player joins the world
 * (NetworkClient defers the join until `onComplete`):
 *
 *   Welcome ("Connect a wallet" / "Continue as guest", TESTNET chip)
 *     → wallet (the existing WalletPanel, opened above this overlay — no second seed UI)
 *     → character (wallet holders: 5 models × 8 colours, live turntable preview)
 *     → nickname (wallet holders: local rules + a debounced `nickname_check`)
 *     → Enter (disabled until the world is loaded and warm)
 *   Guests go Welcome → Enter: a Guest-#### name, the default character (ADR-015: guests get the default character).
 *   Returning players see "Welcome back" (profileStore), with an inline unlock for a locked wallet.
 *
 * ADR-016 (fee-confirmed names, when the server runs a name registry): the nickname step shows the fee box ("Confirm
 * with a small fee: 0.01 TAZ + network fee", why, no refunds) and "Confirm & pay"; the name is confirmed BEFORE the
 * join (live status: reserving → paying → pending → seen → confirmed, with "Get test coins" and "Try again"), or the
 * player skips and enters with a Guest-style name. A returning holder's name is claimed automatically after the
 * unlock (a signed challenge — no fee) and "Welcome back, <name>" confirms it.
 *
 * The same overlay opens later as a small modal for "Change character" and "Change name" (and the
 * name prompt after a guest connects a wallet).
 *
 * Accessibility and input safety: `role="dialog"`, `aria-modal`, a focus trap, radio groups with
 * arrow keys, and every key stops at the overlay (the game's InputManager listens on window).
 * Escape never closes the start-of-game flow (App also skips its Esc handling while it is open);
 * in a mid-session modal it cancels. All text is set with textContent.
 */

export type OnboardingStep = "checking" | "welcome" | "returning" | "wallet" | "character" | "nickname" | "enter";
export type OnboardingMode = "holder" | "guest";

export interface OnboardingResult {
  readonly mode: OnboardingMode;
  /** The chosen character (holders), or null (guests get the server default). */
  readonly avatar: PlayerAvatar | null;
  /**
   * The chosen name (holders), applied after joining through NameConfirmation; null for guests. ADR-016 (fee mode):
   * only a name this connection confirmed or claimed during onboarding (the server applies it at join); null when the
   * holder skipped (a Guest-style name until confirmed).
   */
  readonly nickname: string | null;
}

/** What onboarding needs from the wallet: its status and the sticky holder flag — booleans and a status, never wallet data. */
export interface OnboardingWallet {
  status(): WalletStatus;
  subscribe(listener: (status: WalletStatus) => void): () => void;
  isHolder(): boolean;
  subscribeHolder(listener: (holder: boolean) => void): () => void;
  /** Opens the wallet panel above onboarding; `onReady` fires once the wallet is unlocked and any new seed words were acknowledged. */
  open(onReady: () => void): void;
  close(): void;
  /** The wallet panel is showing a freshly created seed phrase (do not close it under the player). */
  isBusy(): boolean;
  /** The inline unlock of "Welcome back" (a passphrase field, not a second seed UI). */
  unlock(passphrase: string): Promise<void>;
}

export interface OnboardingOptions {
  readonly container: HTMLElement;
  readonly profile: PlayerProfile | null;
  readonly wallet: OnboardingWallet;
  /** Sends `nickname_check` (allowed before join). Answers come back through `handleNicknameCheckResult`. */
  readonly checkNickname: (nickname: string) => void;
  /** Resolves when the world is loaded and its shaders compiled (App.worldReadyAndWarm). */
  readonly worldReady: Promise<void>;
  /** Creates the character preview (App: the WebGL turntable; tests: a stub). */
  readonly createPreview: () => CharacterPreviewHandle;
  readonly nameConfirmation: NameConfirmation;
  readonly onComplete: (result: OnboardingResult) => void;
  /** Debounce before a nickname check is sent (default 400 ms). */
  readonly checkDebounceMs?: number;
  /** The network this build's wallet is on (default "test") — the chip and the copy follow it. */
  readonly network?: "main" | "test";
}

/** Display names for the character picker (wire ids are PLAYER_AVATAR_MODELS). */
export const AVATAR_MODEL_LABELS: Readonly<Record<PlayerAvatarModel, string>> = {
  rogue_hooded: "Hooded Rogue",
  rogue: "Rogue",
  knight: "Knight",
  mage: "Mage",
  barbarian: "Barbarian",
};

const STEP_LABELS: Record<"welcome" | "wallet" | "character" | "nickname" | "enter", string> = {
  welcome: "Welcome",
  wallet: "Wallet",
  character: "Character",
  nickname: "Name",
  enter: "Enter",
};

type Modal = { readonly kind: "character"; readonly onDone: (avatar: PlayerAvatar) => void } | { readonly kind: "nickname"; readonly onDone: (nickname: string) => void; readonly title: string };

interface NameCheck {
  readonly nickname: string;
  readonly status: NicknameCheckStatus;
  readonly suggestion?: string;
}

export class OnboardingFlow {
  private readonly options: OnboardingOptions;
  private readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly stepsList: HTMLOListElement;
  private readonly body: HTMLDivElement;
  /** The step's buttons, pinned under the scrolling body (the header with the steps is pinned above it). */
  private readonly footer: HTMLDivElement;
  private stepValue: OnboardingStep = "checking";
  private path: OnboardingMode | null = null;
  private avatarValue: PlayerAvatar;
  private nicknameValue = "";
  /** The remembered holder name ("Welcome back, X"); dropped when the wallet is gone. */
  private rememberedName: string | null;
  private worldIsReady = false;
  private preview: CharacterPreviewHandle | null = null;
  private modal: Modal | null = null;
  private started = false;
  private finished = false;
  private lastCheckSent: string | null = null;
  private check: NameCheck | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private returningError = "";
  private confirmStatus: NameConfirmationStatus | null = null;
  /** ADR-016: a confirmation is running (the nickname step's input and buttons wait). */
  private confirmBusy = false;
  /** ADR-016: the name this onboarding confirmed or claimed (fee mode) — what Enter joins with. */
  private confirmedName: string | null = null;
  /** ADR-016: the returning holder's automatic claim. */
  private claimState: "idle" | "claiming" | "claimed" | "failed" = "idle";
  /** The fee/mode the nickname step was last rendered with (it re-renders when the server's mode arrives). */
  private nameModeKey = "";
  private readonly unsubscribes: (() => void)[] = [];
  /** Where "← Back" on the character step goes (the wallet step, or "Welcome back"). */
  private characterBack: OnboardingStep = "welcome";

  constructor(options: OnboardingOptions) {
    injectUiStyles();
    injectOnboardingStyles();
    this.options = options;
    this.avatarValue = options.profile?.avatar ? { ...options.profile.avatar } : randomAvatar();
    this.rememberedName = options.profile?.nickname ?? null;

    this.root = el("div", "zw-ui zw-onboarding");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "zw-onb-title");
    this.card = el("div", "zw-onb-card");
    const head = el("div", "zw-onb-head");
    const brand = el("span", "zw-onb-brand");
    if (HAS_BRAND_ART) {
      const brandIcon = document.createElement("img");
      brandIcon.className = "zw-onb-brand-icon";
      brandIcon.src = "/brand/favicon-32.png";
      brandIcon.alt = "";
      brand.append(brandIcon);
    }
    brand.append(document.createTextNode("Zocial World"));
    const chip = el("span", "zw-onb-chip");
    if (options.network === "main") {
      // ADR-018: real money, experimental beta.
      chip.textContent = "MAINNET BETA";
      chip.dataset.network = "main";
      chip.title = "Real ZEC — experimental, unaudited beta. Use a fresh wallet with a small amount.";
    } else {
      chip.textContent = "TESTNET";
      chip.title = "Test coins only — no real value.";
    }
    this.stepsList = el("ol", "zw-onb-steps");
    this.stepsList.setAttribute("aria-label", "Steps");
    head.append(brand, chip, this.stepsList);
    this.body = el("div", "zw-onb-body");
    this.footer = el("div", "zw-onb-footer");
    this.card.append(head, this.body, this.footer);
    this.root.appendChild(this.card);
    this.root.addEventListener("keydown", this.onKeyDown);
    // Keys never reach the game while the overlay has focus (InputManager listens on window).
    this.root.addEventListener("keyup", (event) => event.stopPropagation());
    options.container.appendChild(this.root);
    this.nameModeKey = this.currentNameModeKey();
    // ADR-016: the server's name mode arrives after startup, and the name key after an unlock.
    this.unsubscribes.push(options.nameConfirmation.subscribe(() => this.onNameConfirmationChange()));

    options.worldReady.then(
      () => {
        this.worldIsReady = true;
        if (this.isOpen && this.stepValue === "enter") this.render();
      },
      () => {
        this.worldIsReady = true; // the world failed to load fully: entering is still better than a dead end
        if (this.isOpen && this.stepValue === "enter") this.render();
      },
    );
  }

  // ------------------------------------------------------------------ public API

  /** Opens the start-of-game flow. Waits for the wallet check (a localStorage read) before choosing Welcome or Welcome back. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.show();
    this.unsubscribes.push(
      this.options.wallet.subscribe(() => this.onWalletChange()),
      this.options.wallet.subscribeHolder((holder) => this.onHolderChange(holder)),
    );
    this.chooseFirstStep();
  }

  /** "Change character" (wallet holders, mid-session): the character step alone. */
  openCharacter(current: PlayerAvatar, onDone: (avatar: PlayerAvatar) => void): void {
    if (this.isOpen) return;
    this.modal = { kind: "character", onDone };
    this.avatarValue = { ...current };
    this.stepValue = "character";
    this.show();
    this.render();
  }

  /** "Change name", or the name prompt right after a guest connects a wallet: the nickname step alone, applied through NameConfirmation. */
  openNickname(prefill: string, onDone: (nickname: string) => void, title = "Choose your name"): void {
    if (this.isOpen) return;
    this.modal = { kind: "nickname", onDone, title };
    this.nicknameValue = prefill;
    this.check = null;
    this.lastCheckSent = null;
    this.confirmStatus = null;
    this.confirmBusy = false;
    this.stepValue = "nickname";
    this.show();
    this.render();
  }

  /** A `nickname_check_result` from the network. Applied only if it answers what the input holds now. */
  handleNicknameCheckResult(message: NicknameCheckResultMessage): void {
    if (message.nickname !== this.lastCheckSent) return;
    this.check = { nickname: message.nickname, status: message.status, ...(message.suggestion ? { suggestion: message.suggestion } : {}) };
    if (this.stepValue === "nickname" && this.isOpen) this.renderNicknameStatus();
  }

  get isOpen(): boolean {
    return this.root.classList.contains("visible");
  }

  /** Whether the start-of-game flow (not a mid-session modal) is showing. App skips Esc and the join until it finishes. */
  get isOnboarding(): boolean {
    return this.isOpen && this.modal === null;
  }

  /** The open mid-session modal, if any. */
  get modalKind(): "character" | "nickname" | null {
    return this.isOpen ? (this.modal?.kind ?? null) : null;
  }

  get step(): OnboardingStep {
    return this.stepValue;
  }

  /** Closes a mid-session modal (e.g. the name was applied some other way). The start-of-game flow only closes by completing. */
  closeModal(): void {
    if (!this.modal || !this.isOpen) return;
    this.hide();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.preview?.dispose();
    this.preview = null;
    this.root.remove();
  }

  // ------------------------------------------------------------------ flow

  private chooseFirstStep(): void {
    const status = this.options.wallet.status();
    if (status === "initializing") {
      this.go("checking");
      return;
    }
    const profile = this.options.profile;
    if (!profile || profile.autoEnter) return this.go("welcome");
    // A remembered holder whose wallet is gone from this device is a guest now: the name is dropped.
    if (status === "idle" && profile.lastMode === "holder") this.rememberedName = null;
    this.go("returning");
  }

  private onWalletChange(): void {
    if (!this.isOnboarding) return;
    if (this.stepValue === "checking" && this.options.wallet.status() !== "initializing") return this.chooseFirstStep();
    if (this.stepValue === "wallet" || this.stepValue === "returning") this.render();
  }

  private currentNameModeKey(): string {
    const nc = this.options.nameConfirmation;
    return `${nc.requiresFee}|${nc.feeText}|${nc.unavailable ?? ""}|${nc.confirmLabel}`;
  }

  /** The name mode or the name key changed: re-render what depends on it (never under a running confirmation). */
  private onNameConfirmationChange(): void {
    if (!this.isOpen) return;
    const modeKey = this.currentNameModeKey();
    const modeChanged = modeKey !== this.nameModeKey;
    this.nameModeKey = modeKey;
    if (this.stepValue === "nickname" && modeChanged && !this.confirmBusy) this.render();
    else if (this.stepValue === "returning" && this.claimState === "idle") this.render();
  }

  /** ADR-016: the returning holder's name comes back by a signed challenge (no fee), automatically after the unlock. */
  private startClaim(name: string): void {
    this.claimState = "claiming";
    this.options.nameConfirmation
      .claim(name)
      .then((ok) => {
        this.claimState = ok ? "claimed" : "failed";
        if (ok) this.confirmedName = name;
      })
      .catch(() => {
        this.claimState = "failed";
      })
      .finally(() => {
        if (this.isOnboarding && this.stepValue === "returning") this.render();
      });
  }

  private onHolderChange(holder: boolean): void {
    if (!holder || !this.isOnboarding) return;
    // The wallet reached ready (created, restored or unlocked — or a test flipped participation). If the panel is showing
    // a fresh seed phrase, wait for its "Done" (onReady) instead of closing it under the player.
    if (this.stepValue === "wallet" && !this.options.wallet.isBusy()) {
      this.options.wallet.close();
      this.go("character");
    } else if (this.stepValue === "returning") {
      this.render();
    }
  }

  private go(step: OnboardingStep): void {
    if (step === "character" && this.stepValue !== "character" && this.stepValue !== "nickname") {
      this.characterBack = this.stepValue === "returning" ? "returning" : this.stepValue === "wallet" ? "wallet" : "welcome";
    }
    this.stepValue = step;
    this.render();
  }

  private chooseHolder(): void {
    this.path = "holder";
    this.go(this.options.wallet.isHolder() ? "character" : "wallet");
  }

  private chooseGuest(): void {
    this.path = "guest";
    this.options.wallet.close();
    this.go("enter");
  }

  private complete(result: OnboardingResult): void {
    if (this.finished) return;
    this.finished = true;
    this.hide();
    this.options.onComplete(result);
  }

  private show(): void {
    this.root.classList.add("visible");
    this.root.classList.toggle("zw-onb-modal", this.modal !== null);
    document.exitPointerLock?.();
  }

  private hide(): void {
    this.root.classList.remove("visible");
    this.modal = null;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    this.preview?.dispose();
    this.preview = null;
    this.body.replaceChildren();
    this.footer.replaceChildren();
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) document.activeElement.blur();
  }

  // ------------------------------------------------------------------ rendering

  private render(): void {
    this.body.replaceChildren();
    this.footer.replaceChildren();
    this.body.scrollTop = 0;
    this.body.dataset.step = this.stepValue;
    this.root.dataset.step = this.stepValue;
    // Each step gets a width that its content fills (two choice cards or the character preview need room;
    // a form or a summary doesn't), instead of one wide card with the content huddled on its left.
    this.card.dataset.size = this.stepValue === "welcome" || this.stepValue === "character" ? "wide" : this.stepValue === "enter" || this.stepValue === "nickname" ? "medium" : "narrow";
    this.renderSteps();
    switch (this.stepValue) {
      case "checking":
        return this.renderChecking();
      case "welcome":
        return this.renderWelcome();
      case "returning":
        return this.renderReturning();
      case "wallet":
        return this.renderWallet();
      case "character":
        return this.renderCharacter();
      case "nickname":
        return this.renderNickname();
      case "enter":
        return this.renderEnter();
    }
  }

  private renderSteps(): void {
    this.stepsList.replaceChildren();
    if (this.modal || this.stepValue === "checking" || this.stepValue === "returning") {
      this.stepsList.hidden = true;
      return;
    }
    this.stepsList.hidden = false;
    const steps: (keyof typeof STEP_LABELS)[] = this.path === "guest" ? ["welcome", "enter"] : ["welcome", "wallet", "character", "nickname", "enter"];
    const current = steps.indexOf(this.stepValue as keyof typeof STEP_LABELS);
    steps.forEach((step, index) => {
      const item = el("li", index === current ? "current" : index < current ? "done" : "");
      item.textContent = `${index + 1}. ${STEP_LABELS[step]}`;
      if (index === current) item.setAttribute("aria-current", "step");
      this.stepsList.appendChild(item);
    });
  }

  private renderChecking(): void {
    this.title("Welcome to Zocial World");
    this.lead("Checking this device…");
  }

  private renderWelcome(): void {
    if (HAS_BRAND_ART) {
      const logo = document.createElement("img");
      logo.className = "zw-onb-logo";
      logo.src = "/brand/logo.webp";
      logo.alt = "Zocial World";
      this.body.appendChild(logo);
    }
    this.title(this.options.profile ? "Welcome back to Zocial World" : "Welcome to Zocial World");
    this.lead("A 3D place to meet the Zcash community: explore, chat, watch talks together and learn. How do you want to come in?");
    const choices = el("div", "zw-onb-choices");
    const wallet = this.choice("Connect a wallet", ["Choose your own name and character", "Talk in voice and present on the Watch Hall stage", "Send and receive ZEC privately — your address is never shown"], "Connect a wallet →", true, () => this.chooseHolder());
    wallet.dataset.choice = "wallet";
    const guest = this.choice("Continue as guest", ["Explore, chat and whisper, watch and learn", "Listen to voices nearby (guests can't talk)", "You appear as Guest-#### — connect a wallet any time"], "Continue as guest →", false, () => this.chooseGuest());
    guest.dataset.choice = "guest";
    choices.append(wallet, guest);
    this.body.appendChild(choices);
    this.note(
      this.options.network === "main"
        ? "Mainnet beta: the wallet holds real ZEC — experimental software, so use a fresh wallet with a small amount. Your wallet lives only in this browser; the game server never sees your seed. Your wallet syncs through the game server, which passes its network queries on without logging them."
        : "This game runs its own Zcash test chain: test coins only (from the in-game faucet), with no real value. Your wallet lives only in this browser; the game server never sees your seed. Your wallet syncs through the game server, which passes its network queries on without logging them.",
    );
    wallet.focus();
  }

  private renderReturning(): void {
    const profile = this.options.profile;
    const status = this.options.wallet.status();
    const holderProfile = profile?.lastMode === "holder" && status !== "idle";
    const name = this.rememberedName;
    const fee = this.options.nameConfirmation.requiresFee;
    const claimFailed = fee && this.claimState === "failed";
    this.title(holderProfile && name && !claimFailed ? `Welcome back, ${name}` : "Welcome back");
    const actions = el("div", "zw-onb-actions");
    if (!holderProfile) {
      this.lead(profile?.lastMode === "holder" ? "The wallet you used here is no longer on this device, so you'll come in as a guest — connect or restore a wallet any time to choose a name again." : "Come in as a guest again, or connect a wallet to choose your name and character.");
      const enter = this.button("Enter as a guest", true, () => this.chooseGuest());
      enter.dataset.action = "enter-guest";
      actions.append(enter, this.button("Connect a wallet", false, () => this.chooseHolder()));
      this.footer.appendChild(actions);
      enter.focus();
      return;
    }
    const preview = el("div", "zw-onb-returning");
    const card = el("div", "zw-onb-returning-card");
    const swatch = el("span", "zw-onb-returning-swatch");
    swatch.style.background = avatarColorCss(this.avatarValue.color);
    const who = el("div", "");
    const line1 = el("div", "zw-onb-returning-name");
    line1.textContent = name ?? "Your character";
    const line2 = el("div", "zw-onb-note");
    line2.textContent = `${AVATAR_MODEL_LABELS[this.avatarValue.model]} · ${AVATAR_COLOR_NAMES[this.avatarValue.color]}`;
    who.append(line1, line2);
    card.append(swatch, who);
    preview.appendChild(card);
    this.body.appendChild(preview);
    const enterLabel = name ? `Enter as ${name}` : "Enter";
    if (this.options.wallet.isHolder() && fee && name && this.claimState !== "claimed") {
      // ADR-016: prove the remembered name with the wallet's name key — automatically, no fee (the claim waits for the
      // key, which is derived right after the unlock).
      if (this.claimState === "idle") this.startClaim(name);
      const checking = el("div", "zw-onb-status");
      checking.dataset.claim = this.claimState;
      if (this.claimState === "failed") {
        checking.dataset.tone = "warn";
        checking.textContent = `${name} isn't confirmed on this server yet. Confirm it with a small fee, or come in with a guest name for now.`;
        this.body.appendChild(checking);
        const confirm = this.button(`Confirm ${name}`, true, () => {
          this.path = "holder";
          this.nicknameValue = name;
          this.go("nickname");
        });
        confirm.dataset.action = "confirm-remembered";
        const guestName = this.button("Enter with a guest name for now", false, () => {
          this.path = "holder";
          this.confirmedName = null;
          this.nicknameValue = "";
          this.go("enter");
        });
        guestName.dataset.action = "enter-unconfirmed";
        actions.append(confirm, guestName);
        confirm.focus();
      } else {
        checking.textContent = this.claimState === "claiming" ? `Your wallet is unlocked — checking that ${name} is yours…` : "Your wallet is unlocked — getting your name key ready…";
        this.body.appendChild(checking);
      }
    } else if (this.options.wallet.isHolder()) {
      this.lead(fee && name ? `Your wallet is unlocked and ${name} is yours — confirmed with this wallet, no fee needed.` : "Your wallet is unlocked.");
      const enter = this.button(enterLabel, true, () => this.go("enter"));
      enter.dataset.action = "enter-holder";
      actions.append(enter);
      enter.focus();
    } else if (status === "locked") {
      this.lead("Unlock your wallet to come in with your name. Your passphrase never leaves this browser.");
      const field = el("label", "zw-onb-field");
      field.textContent = "Wallet passphrase";
      const input = document.createElement("input");
      input.type = "password";
      input.className = "zw-input";
      input.autocomplete = "current-password";
      field.appendChild(input);
      const error = el("div", "zw-onb-status");
      error.dataset.tone = "error";
      error.textContent = this.returningError;
      const unlock = this.button(name ? `Unlock & enter as ${name}` : "Unlock & enter", true, () => {
        unlock.disabled = true;
        this.returningError = "";
        error.textContent = "Unlocking… (the first time, the browser downloads the wallet engine, about 60 MB)";
        error.dataset.tone = "";
        this.options.wallet
          .unlock(input.value)
          .then(() => {
            input.value = "";
            // ADR-016: with fee-confirmed names the returning card stays up while the name is claimed.
            if (this.options.wallet.isHolder() && !(this.options.nameConfirmation.requiresFee && name)) this.go("enter");
            else this.render();
          })
          .catch((reason: unknown) => {
            input.value = "";
            this.returningError = reason instanceof Error && /passphrase/i.test(reason.message) ? "Wrong passphrase." : "The wallet couldn't be unlocked. Try again, or enter now and unlock later.";
            this.render();
          });
      });
      unlock.dataset.action = "unlock";
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") unlock.click();
      });
      this.body.append(field, error);
      actions.append(unlock);
      input.focus();
    } else {
      this.lead("Open your wallet to come in with your name.");
      actions.append(this.button("Open wallet", true, () => this.chooseHolder()));
    }
    const later = this.button("Enter now — unlock later", false, () => this.complete({ mode: "guest", avatar: null, nickname: null }));
    later.dataset.action = "enter-later";
    if (!this.options.wallet.isHolder()) actions.append(later);
    actions.append(
      this.button("Enter as guest", false, () => this.complete({ mode: "guest", avatar: null, nickname: null })),
      this.button("Change character", false, () => {
        this.path = "holder";
        this.go("character");
      }),
    );
    this.footer.appendChild(actions);
  }

  private renderWallet(): void {
    this.title("Connect your wallet");
    const status = this.options.wallet.status();
    const holder = this.options.wallet.isHolder();
    this.lead(
      holder
        ? "Your wallet is ready."
        : status === "locked"
          ? "This browser already has a wallet. Unlock it with your passphrase."
          : status === "initializing"
            ? "Opening the wallet… The first time, the browser downloads the wallet engine (about 60 MB)."
            : this.options.network === "main"
              ? "Create a new wallet (real ZEC, mainnet beta), or restore one from its 24-word seed phrase. The seed is made in your browser and stored only here, encrypted with your passphrase. A new wallet asks you to check your backup before it can be used."
              : "Create a new wallet for this game's own test chain, or restore one from its 24-word seed phrase. The seed is made in your browser and stored only here, encrypted with your passphrase.",
    );
    const actions = el("div", "zw-onb-actions");
    if (holder) {
      actions.appendChild(this.button("Continue", true, () => this.go("character")));
    } else {
      const open = this.button(status === "locked" ? "Unlock wallet" : "Create or restore a wallet", true, () =>
        this.options.wallet.open(() => {
          if (this.isOnboarding && this.stepValue === "wallet") this.go("character");
        }),
      );
      open.dataset.action = "open-wallet";
      open.disabled = status === "initializing";
      actions.appendChild(open);
    }
    actions.append(el("span", "zw-onb-spacer"), this.button("← Back", false, () => this.go("welcome")));
    const guest = this.link("Continue as guest instead", () => this.chooseGuest());
    guest.dataset.action = "guest-instead";
    actions.appendChild(guest);
    this.footer.appendChild(actions);
    this.note("Your wallet stays in this browser. Other players only ever learn that you can receive ZEC privately — never your address, balance or history.");
    (actions.querySelector("button") as HTMLButtonElement | null)?.focus();
  }

  private renderCharacter(): void {
    const modal = this.modal?.kind === "character" ? this.modal : null;
    this.title(modal ? "Change character" : "Choose your character");
    const layout = el("div", "zw-onb-character");
    const preview = this.ensurePreview();
    preview.show(this.avatarValue);
    const controls = el("div", "zw-onb-character-controls");

    controls.appendChild(this.label("Character", "zw-onb-models-label"));
    const models = el("div", "zw-onb-models");
    models.setAttribute("role", "radiogroup");
    models.setAttribute("aria-labelledby", "zw-onb-models-label");
    const modelButtons = PLAYER_AVATAR_MODELS.map((model) => {
      const button = el("button", "zw-onb-model");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.model = model;
      button.textContent = AVATAR_MODEL_LABELS[model];
      button.addEventListener("click", () => this.setAvatar({ ...this.avatarValue, model }, models));
      return button;
    });
    models.append(...modelButtons);
    radioGroupKeys(models);
    controls.appendChild(models);

    controls.appendChild(this.label("Colour", "zw-onb-colors-label"));
    const swatches = el("div", "zw-onb-swatches");
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-labelledby", "zw-onb-colors-label");
    for (let color = 0; color < PLAYER_AVATAR_COLOR_COUNT; color++) {
      const swatch = el("button", "zw-onb-swatch");
      swatch.type = "button";
      swatch.setAttribute("role", "radio");
      swatch.dataset.color = String(color);
      swatch.style.background = avatarColorCss(color);
      swatch.title = AVATAR_COLOR_NAMES[color]!;
      swatch.setAttribute("aria-label", AVATAR_COLOR_NAMES[color]!);
      swatch.addEventListener("click", () => this.setAvatar({ ...this.avatarValue, color }, swatches));
      swatches.appendChild(swatch);
    }
    radioGroupKeys(swatches);
    controls.appendChild(swatches);
    const randomize = this.link("Randomize", () => {
      this.setAvatar(randomAvatar(), null);
    });
    controls.appendChild(randomize);
    const note = el("p", "zw-onb-note");
    note.textContent = "Your colour shows on your name tag and in the player menu. Players on low graphics see a simple figure in your colour.";
    controls.appendChild(note);

    layout.append(preview.element, controls);
    this.body.appendChild(layout);
    this.syncAvatarControls();

    const actions = el("div", "zw-onb-actions");
    if (modal) {
      const save = this.button("Save", true, () => {
        const avatar = { ...this.avatarValue };
        this.hide();
        modal.onDone(avatar);
      });
      save.dataset.action = "save-character";
      actions.append(save, this.button("Cancel", false, () => this.hide()));
    } else {
      const next = this.button("Continue", true, () => this.go(this.stepAfterCharacter()));
      next.dataset.action = "character-continue";
      actions.append(next, el("span", "zw-onb-spacer"), this.button("← Back", false, () => this.go(this.characterBack)));
    }
    this.footer.appendChild(actions);
    (models.querySelector('[aria-checked="true"]') as HTMLButtonElement | null)?.focus();
  }

  /** After the character: the nickname step for a holder; a returning player whose wallet is still locked goes back to "Welcome back". */
  private stepAfterCharacter(): OnboardingStep {
    return this.options.wallet.isHolder() ? "nickname" : "returning";
  }

  private renderNickname(): void {
    const modal = this.modal?.kind === "nickname" ? this.modal : null;
    this.title(modal ? modal.title : "Choose your name");
    if (!this.nicknameValue && this.rememberedName && !modal) this.nicknameValue = this.rememberedName;
    const field = el("label", "zw-onb-field");
    field.textContent = "Nickname";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "zw-input zw-onb-nickname";
    input.maxLength = MAX_NICKNAME_LENGTH;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = this.nicknameValue;
    input.setAttribute("aria-describedby", "zw-onb-nickname-status");
    field.appendChild(input);
    const status = el("div", "zw-onb-status");
    status.id = "zw-onb-nickname-status";
    status.setAttribute("aria-live", "polite");
    const privacy = el("p", "zw-onb-lead");
    privacy.textContent = "Your name is public. It is never linked to your wallet address.";
    const nc = this.options.nameConfirmation;
    this.nameModeKey = this.currentNameModeKey();
    // ADR-016: the fee box — the fee, why, and that it is not a purchase (no refunds). The address is never shown.
    const feeBox = el("div", "zw-onb-fee");
    feeBox.hidden = !nc.requiresFee;
    const feeLine = el("div", "zw-onb-fee-line");
    feeLine.textContent = nc.feeText;
    const explanation = el("p", "zw-onb-note");
    explanation.textContent = nc.explanation;
    explanation.hidden = nc.explanation === "";
    const testnet = el("p", "zw-onb-note");
    testnet.textContent =
      this.options.network === "main"
        ? "Real ZEC (mainnet beta), paid from your shielded balance — add funds and shield them in the Wallet panel first. Your wallet pays privately; the payment address is never shown."
        : "Test coins on this game's own test chain (from the in-game faucet) — they have no real value. Your wallet pays privately; the payment address is never shown.";
    feeBox.append(feeLine, explanation, testnet);
    // A registry that is down: holders keep a Guest-style name, and the step says why.
    const unavailable = el("p", "zw-onb-unavailable");
    unavailable.dataset.tone = "warn";
    unavailable.textContent = nc.unavailable ?? "";
    unavailable.hidden = nc.unavailable === null;
    // Live status of the confirmation (reserving → paying → pending → seen → confirmed), with its actions.
    const confirm = el("div", "zw-onb-confirm");
    confirm.hidden = true;
    confirm.setAttribute("aria-live", "polite");
    const confirmText = el("div", "zw-onb-confirm-text");
    const confirmBar = el("div", "zw-onb-confirm-bar");
    const confirmFill = el("div", "zw-onb-confirm-fill");
    confirmBar.appendChild(confirmFill);
    const confirmActions = el("div", "zw-onb-confirm-actions");
    confirm.append(confirmText, confirmBar, confirmActions);
    this.body.append(field, status, privacy, feeBox, unavailable, confirm);

    const actions = el("div", "zw-onb-actions");
    const next = this.button(nc.unavailable !== null ? (modal ? "OK" : nc.confirmLabel) : modal || nc.requiresFee ? nc.confirmLabel : "Continue", true, () => this.submitNickname());
    next.dataset.action = "nickname-continue";
    actions.appendChild(next);
    if (modal) actions.appendChild(this.button("Not now", false, () => this.hide()));
    else {
      const back = this.button("← Back", false, () => this.go("character"));
      back.dataset.action = "nickname-back";
      actions.append(el("span", "zw-onb-spacer"), back);
    }
    if (!modal && nc.requiresFee) {
      const skip = this.link("Skip — enter with a guest name for now", () => {
        if (this.confirmBusy) return;
        this.confirmedName = null;
        this.nicknameValue = "";
        this.go("enter");
      });
      skip.dataset.action = "skip-name";
      actions.appendChild(skip);
    }
    this.footer.appendChild(actions);

    input.addEventListener("input", () => {
      this.nicknameValue = input.value;
      if (this.confirmStatus?.phase !== "working") this.confirmStatus = null; // a new name: the last result no longer applies
      this.scheduleCheck();
      this.renderNicknameStatus();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !next.disabled) next.click();
    });
    this.renderNicknameStatus();
    if (this.lastCheckSent === null) this.scheduleCheck();
    input.focus();
    input.select();
  }

  /** The status line and the Continue button for the current input + the latest check that answers it. */
  private renderNicknameStatus(): void {
    const status = this.body.querySelector<HTMLDivElement>(".zw-onb-status");
    const next = this.card.querySelector<HTMLButtonElement>('[data-action="nickname-continue"]');
    const confirm = this.body.querySelector<HTMLDivElement>(".zw-onb-confirm");
    if (!status || !next) return;
    status.replaceChildren();
    const nc = this.options.nameConfirmation;
    const input = this.body.querySelector<HTMLInputElement>(".zw-onb-nickname");
    if (input) input.disabled = this.confirmBusy;
    // While the wallet pays and the server confirms, the onboarding stays on this step.
    for (const other of this.card.querySelectorAll<HTMLButtonElement>('[data-action="nickname-back"], [data-action="skip-name"]')) other.disabled = this.confirmBusy;
    const local = checkNicknameLocally(this.nicknameValue);
    if (nc.unavailable !== null) {
      status.dataset.tone = "";
      status.textContent = "";
      next.disabled = false;
    } else if (!local.ok) {
      status.dataset.tone = local.problem === "empty" ? "" : "error";
      status.textContent = local.problem === "empty" ? `Up to ${MAX_NICKNAME_LENGTH} characters.` : nicknameProblemText(local.problem);
      next.disabled = true;
    } else {
      const answer = this.check && this.check.nickname === local.nickname ? this.check : null;
      if (!answer) {
        status.dataset.tone = "";
        status.textContent = "Checking…";
        next.disabled = false; // the server decides anyway; a slow answer must not block
      } else if (answer.status === "available") {
        status.dataset.tone = "ok";
        status.textContent = `${local.nickname} is free.`;
        next.disabled = false;
      } else if (answer.status === "taken") {
        status.dataset.tone = "warn";
        // ADR-016: a registered name is "taken" for its owner too — confirming then restores it (a signed check, no fee).
        status.append(`${local.nickname} is taken${answer.suggestion ? ` — ${answer.suggestion} is free.` : "."} ${nc.requiresFee ? "If it's your name (this wallet), confirming restores it without a fee. " : ""}`);
        if (answer.suggestion) {
          const suggestion = answer.suggestion;
          const use = this.link(`Use ${suggestion}`, () => {
            this.nicknameValue = suggestion;
            const input = this.body.querySelector<HTMLInputElement>(".zw-onb-nickname");
            if (input) input.value = suggestion;
            this.scheduleCheck();
            this.renderNicknameStatus();
          });
          use.dataset.action = "use-suggestion";
          status.appendChild(use);
        }
        next.disabled = false; // continuing anyway gets the suggested suffix from the server
      } else {
        status.dataset.tone = "error";
        status.textContent = answer.status === "reserved" ? nicknameProblemText("reserved") : "That name isn't allowed.";
        next.disabled = true;
      }
    }
    status.dataset.check = this.check && local.ok && this.check.nickname === local.nickname ? this.check.status : "";
    // ADR-016: while a confirmation runs nothing can be pressed twice; once confirmed in onboarding, the button continues.
    const doneHere = nc.requiresFee && !this.modal && this.confirmedName !== null && local.ok && local.nickname === this.confirmedName;
    if (this.confirmBusy) {
      next.disabled = true;
      next.textContent = "Confirming…";
    } else if (doneHere) {
      next.disabled = false;
      next.textContent = "Continue";
    } else if (nc.unavailable === null && (this.modal || nc.requiresFee)) {
      next.textContent = this.confirmStatus?.phase === "failed" && this.confirmStatus.retry ? "Try again" : nc.confirmLabel;
    }
    next.dataset.state = this.confirmBusy ? "busy" : doneHere ? "confirmed" : "";
    if (confirm) this.renderConfirmStatus(confirm);
  }

  private renderConfirmStatus(slot: HTMLDivElement): void {
    const status = this.confirmStatus;
    slot.hidden = status === null;
    const actions = slot.querySelector(".zw-onb-confirm-actions") as HTMLDivElement | null;
    actions?.replaceChildren();
    if (!status) return;
    slot.dataset.phase = status.phase;
    slot.dataset.step = status.phase === "working" ? (status.step ?? "") : status.phase === "failed" ? (status.reason ?? "") : "confirmed";
    (slot.querySelector(".zw-onb-confirm-text") as HTMLDivElement).textContent = status.phase === "done" ? (status.text ?? "Done.") : status.text;
    const fill = slot.querySelector(".zw-onb-confirm-fill") as HTMLDivElement;
    const progress = status.phase === "working" ? status.progress : status.phase === "done" ? 1 : 0;
    fill.style.width = progress === undefined ? "35%" : `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    slot.classList.toggle("indeterminate", status.phase === "working" && status.progress === undefined);
    if (status.phase !== "failed" || !actions) return;
    // ADR-016: not enough coins → this server's faucet, inline; then "Try again" (the same reservation — never paid twice).
    if (status.faucet) {
      const coins = this.button("Get test coins", true, () => {
        coins.disabled = true;
        coins.textContent = "Asking the faucet…";
        void (this.options.nameConfirmation.getTestCoins?.() ?? Promise.resolve("No faucet here."))
          .catch(() => "The faucet couldn't be reached.")
          .then((message) => {
            this.confirmStatus = { phase: "failed", text: message, reason: "insufficient", retry: true };
            if (this.isOpen && this.stepValue === "nickname") this.renderNicknameStatus();
          });
      });
      coins.dataset.action = "get-test-coins";
      actions.appendChild(coins);
    }
    if (status.retry) {
      const again = this.button("Try again", !status.faucet, () => this.submitNickname());
      again.dataset.action = "retry-name";
      actions.appendChild(again);
    }
  }

  private scheduleCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    const local = checkNicknameLocally(this.nicknameValue);
    if (!local.ok) return;
    const send = (): void => {
      this.checkTimer = null;
      if (this.lastCheckSent === local.nickname && this.check?.nickname === local.nickname) return;
      this.lastCheckSent = local.nickname;
      this.options.checkNickname(local.nickname);
    };
    const delay = this.options.checkDebounceMs ?? 400;
    if (delay <= 0) send();
    else this.checkTimer = setTimeout(send, delay);
  }

  private submitNickname(): void {
    if (this.confirmBusy) return;
    const nc = this.options.nameConfirmation;
    const modal = this.modal?.kind === "nickname" ? this.modal : null;
    // ADR-016: no registration on this server right now — the holder continues with a Guest-style name.
    if (nc.unavailable !== null) {
      if (modal) return this.hide();
      this.confirmedName = null;
      this.nicknameValue = "";
      return this.go("enter");
    }
    const local = checkNicknameLocally(this.nicknameValue);
    if (!local.ok) return;
    // Already confirmed in this onboarding: on to Enter.
    if (!modal && nc.requiresFee && this.confirmedName !== null && local.nickname === this.confirmedName) return this.go("enter");
    if (!modal && !nc.requiresFee) {
      // Honour mode (ADR-015): the name is applied after the join.
      this.nicknameValue = local.nickname;
      this.go("enter");
      return;
    }
    // Mid-session (any mode), or onboarding with a fee (ADR-016, BEFORE the join): applied now through NameConfirmation.
    this.confirmBusy = true;
    this.confirmStatus = null;
    this.renderNicknameStatus();
    const onStatus = (status: NameConfirmationStatus): void => {
      this.confirmStatus = status;
      if (this.isOpen && this.stepValue === "nickname") this.renderNicknameStatus();
    };
    nc.confirm(local.nickname, onStatus)
      .then(() => {
        this.confirmBusy = false;
        if (modal) {
          this.confirmStatus = null;
          if (this.modal !== modal) return;
          this.hide();
          modal.onDone(local.nickname);
          return;
        }
        this.confirmedName = local.nickname;
        this.nicknameValue = local.nickname;
        if (this.confirmStatus?.phase !== "done") this.confirmStatus = { phase: "done", text: `Confirmed — ${local.nickname} is yours.` };
        if (this.isOpen && this.stepValue === "nickname") this.renderNicknameStatus();
      })
      .catch((reason: unknown) => {
        this.confirmBusy = false;
        onStatus(failedStatus(reason));
      });
  }

  private renderEnter(): void {
    const holder = this.path === "holder" || (this.path === null && this.options.wallet.isHolder());
    this.title(holder ? "Ready to enter" : "Enter as a guest");
    const summary = el("div", "zw-onb-summary");
    if (holder) {
      const preview = this.ensurePreview();
      preview.show(this.avatarValue);
      summary.appendChild(preview.element);
      preview.element.classList.add("zw-onb-preview-small");
    }
    const details = el("div", "zw-onb-summary-details");
    const name = el("div", "zw-onb-summary-name");
    const fee = this.options.nameConfirmation.requiresFee || this.options.nameConfirmation.unavailable !== null;
    const nickname = holder ? (fee ? (this.confirmedName ? checkNicknameLocally(this.confirmedName) : null) : checkNicknameLocally(this.nicknameValue || this.rememberedName || "")) : null;
    name.textContent = holder ? (nickname?.ok ? nickname.nickname : fee ? "Guest-#### for now" : "Your name") : "Guest-####";
    const sub = el("div", "zw-onb-note");
    sub.textContent = holder ? `${AVATAR_MODEL_LABELS[this.avatarValue.model]} · ${AVATAR_COLOR_NAMES[this.avatarValue.color]}` : "A new guest number each visit, and the default character.";
    if (holder && fee) {
      const confirmed = el("div", "zw-onb-status");
      confirmed.dataset.tone = nickname?.ok ? "ok" : "";
      confirmed.dataset.confirmed = String(Boolean(nickname?.ok));
      confirmed.textContent = nickname?.ok ? "Name confirmed — yours on any device with this wallet." : "Confirm a name any time: Profile → Change name.";
      details.append(name, sub, confirmed);
    }
    const can = el("ul", "zw-onb-can");
    // On a name-registry server the server grants a microphone and the stage only
    // to a confirmed name — a holder who skipped it listens until then.
    const nameFeeWords = this.options.network === "main" ? "a small fee in ZEC" : "a small test-coin fee";
    const voiceLine =
      this.options.nameConfirmation.requiresFee && !nickname?.ok
        ? `Listen to voices nearby and the Watch Hall stage — talking and presenting need a confirmed name (${nameFeeWords})`
        : "Talk in voice (Whisper, Talk, Shout) and present on the Watch Hall stage";
    const lines = holder
      ? [voiceLine, "Send and receive ZEC privately — others only see that you can receive", "Chat, whisper, watch and learn"]
      : ["Explore, chat, whisper, watch and learn", "Listen to voices nearby and the Watch Hall stage", "Connect a wallet any time to choose a name, talk and use ZEC"];
    for (const line of lines) {
      const item = el("li", "");
      item.textContent = line;
      can.appendChild(item);
    }
    if (!(holder && fee)) details.append(name, sub);
    details.append(can);
    summary.appendChild(details);
    this.body.appendChild(summary);

    const actions = el("div", "zw-onb-actions");
    const enter = this.button(this.worldIsReady ? "Enter world" : "Loading the world…", true, () => {
      if (!this.worldIsReady) return;
      if (holder) {
        // ADR-016: with fee-confirmed names only a confirmed (or claimed) name; the server applies it at the join.
        const chosen = checkNicknameLocally(fee ? (this.confirmedName ?? "") : this.nicknameValue || this.rememberedName || "");
        this.complete({ mode: "holder", avatar: { ...this.avatarValue }, nickname: chosen.ok ? chosen.nickname : null });
      } else {
        this.complete({ mode: "guest", avatar: null, nickname: null });
      }
    });
    enter.dataset.action = "enter-world";
    enter.disabled = !this.worldIsReady;
    actions.appendChild(enter);
    actions.append(el("span", "zw-onb-spacer"), this.button("← Back", false, () => (holder ? this.go(this.options.wallet.isHolder() ? "nickname" : "returning") : this.go(this.options.profile ? "returning" : "welcome"))));
    this.footer.appendChild(actions);
    enter.focus();
  }

  // ------------------------------------------------------------------ character helpers

  private setAvatar(avatar: PlayerAvatar, group: HTMLElement | null): void {
    this.avatarValue = { model: avatar.model, color: avatar.color };
    this.preview?.show(this.avatarValue);
    this.syncAvatarControls();
    (group?.querySelector('[aria-checked="true"]') as HTMLButtonElement | null)?.focus();
  }

  private syncAvatarControls(): void {
    for (const button of this.body.querySelectorAll<HTMLButtonElement>(".zw-onb-model")) {
      const checked = button.dataset.model === this.avatarValue.model;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    for (const button of this.body.querySelectorAll<HTMLButtonElement>(".zw-onb-swatch")) {
      const checked = button.dataset.color === String(this.avatarValue.color);
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
  }

  private ensurePreview(): CharacterPreviewHandle {
    if (!this.preview) this.preview = this.options.createPreview();
    this.preview.element.classList.remove("zw-onb-preview-small");
    return this.preview;
  }

  // ------------------------------------------------------------------ small DOM helpers

  private title(text: string): void {
    const h = el("h2", "zw-onb-title");
    h.id = "zw-onb-title";
    h.textContent = text;
    this.body.appendChild(h);
  }

  private lead(text: string): void {
    const p = el("p", "zw-onb-lead");
    p.textContent = text;
    this.body.appendChild(p);
  }

  private note(text: string): void {
    const p = el("p", "zw-onb-note");
    p.textContent = text;
    this.body.appendChild(p);
  }

  private label(text: string, id: string): HTMLDivElement {
    const label = el("div", "zw-onb-label");
    label.id = id;
    label.textContent = text;
    return label;
  }

  private button(text: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const button = el("button", `zw-button zw-onb-button${primary ? " zw-button-primary" : ""}`);
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  private link(text: string, onClick: () => void): HTMLButtonElement {
    const button = el("button", "zw-onb-link");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  private choice(heading: string, lines: string[], cta: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const button = el("button", `zw-onb-choice${primary ? " zw-onb-choice-primary" : ""}`);
    button.type = "button";
    const h = el("h3", "");
    h.textContent = heading;
    const list = el("ul", "");
    for (const line of lines) {
      const item = el("li", "");
      item.textContent = line;
      list.appendChild(item);
    }
    const action = el("span", "zw-onb-choice-cta");
    action.textContent = cta;
    button.append(h, list, action);
    button.addEventListener("click", onClick);
    return button;
  }

  /** Keys stay inside the overlay: a focus trap on Tab, Escape cancels a modal (never the start-of-game flow). */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.modal) this.hide();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...this.card.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0 && element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !this.card.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.card.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
}

/** Arrow keys move the selection inside a radio group (roving tabindex); Home/End jump to the ends. */
function radioGroupKeys(group: HTMLElement): void {
  group.addEventListener("keydown", (event) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const current = radios.findIndex((radio) => radio.getAttribute("aria-checked") === "true");
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % radios.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + radios.length) % radios.length;
    else if (event.key === "Home") next = 0;
    else next = radios.length - 1;
    event.preventDefault();
    radios[next]?.click();
  });
}

function randomAvatar(): PlayerAvatar {
  return {
    model: PLAYER_AVATAR_MODELS[Math.floor(Math.random() * PLAYER_AVATAR_MODELS.length)]!,
    color: Math.floor(Math.random() * PLAYER_AVATAR_COLOR_COUNT),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

let onboardingStylesInjected = false;
function injectOnboardingStyles(): void {
  if (onboardingStylesInjected) return;
  onboardingStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
/* Layout: the card never overflows the viewport. Its header (brand, TESTNET chip, steps) and its footer
   (the step's buttons) stay put; only the body between them scrolls. Each step sets a width its content fills
   (data-size: wide for the two choices and the character, medium for the name and the summary, narrow otherwise). */
.zw-onboarding { position: absolute; inset: 0; z-index: 40; display: none; align-items: center; justify-content: center; box-sizing: border-box; padding: 16px;
  background: radial-gradient(ellipse at 50% 45%, rgba(14,10,30,0.42), rgba(10,8,22,0.78)), #1a1430${brandBackground("backdrop.webp")}; }
.zw-onboarding.visible { display: flex; }
.zw-onboarding.zw-onb-modal { background: rgba(6,6,14,0.55); }
.zw-onb-card { box-sizing: border-box; width: 100%; max-width: 960px; max-height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
  border-radius: 18px; background: linear-gradient(180deg, rgba(32,27,44,0.97), rgba(17,15,24,0.97)); border: 1px solid rgba(242,180,64,0.45);
  box-shadow: 0 24px 70px rgba(0,0,0,0.6); color: #f1e9dd; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
.zw-onb-card[data-size="medium"] { max-width: 720px; }
.zw-onb-card[data-size="narrow"] { max-width: 660px; }
.zw-onb-head { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 16px 28px 14px; border-bottom: 1px solid rgba(242,180,64,0.16); }
.zw-onb-brand { font: 700 15px Georgia, "Times New Roman", serif; letter-spacing: 0.05em; color: #f4d58d; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 8px; }
.zw-onb-brand-icon { width: 22px; height: 22px; }
.zw-onb-logo { display: block; margin: 0 auto 4px; height: clamp(72px, 16vh, 150px); width: auto; filter: drop-shadow(0 8px 18px rgba(0,0,0,0.5)); }
.zw-onb-chip[data-network="main"] { background: #c2410c; }
.zw-onb-chip { padding: 2px 8px; border-radius: 999px; background: #3a7bd5; color: #fff; font: 800 10px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.08em; white-space: nowrap; }
.zw-onb-steps { margin: 0 0 0 auto; padding: 0; list-style: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.zw-onb-steps[hidden] { display: none; }
.zw-onb-steps li { padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); font-size: 11px; line-height: 1.4; color: #8f87a3; white-space: nowrap; }
.zw-onb-steps li.done { color: #f4d58d; border-color: rgba(242,180,64,0.35); }
.zw-onb-steps li.current { color: #1a1206; background: #f2b440; border-color: #f2b440; font-weight: 700; }
.zw-onb-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 14px; padding: 20px 28px 22px;
  scrollbar-width: thin; scrollbar-color: rgba(242,180,64,0.45) transparent; }
.zw-onb-body::-webkit-scrollbar { width: 8px; }
.zw-onb-body::-webkit-scrollbar-thumb { background: rgba(242,180,64,0.4); border-radius: 4px; }
.zw-onb-footer { flex: none; padding: 14px 28px 16px; border-top: 1px solid rgba(242,180,64,0.16); background: rgba(10,8,16,0.5); }
.zw-onb-footer:empty { display: none; }
.zw-onb-title { margin: 0; font: 700 clamp(22px, 1.4vw + 12px, 28px)/1.2 Georgia, "Times New Roman", serif; color: #fff3da; letter-spacing: 0.01em; overflow-wrap: anywhere; }
.zw-onb-lead { margin: 0; font-size: 14px; line-height: 1.55; color: #ddd3c2; }
.zw-onb-note { margin: 0; font-size: 12px; line-height: 1.5; color: #a99f8c; }
.zw-onb-note[hidden] { display: none; }
.zw-onb-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 14px; }
.zw-onb-choice { all: unset; box-sizing: border-box; cursor: pointer; display: flex; flex-direction: column; gap: 10px; padding: 18px 20px; border-radius: 14px; min-width: 0;
  background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.12); transition: border-color 0.12s, background 0.12s; }
.zw-onb-choice:hover, .zw-onb-choice:focus-visible { background: rgba(255,255,255,0.085); border-color: rgba(242,180,64,0.75); }
.zw-onb-choice-primary { background: linear-gradient(160deg, rgba(242,180,64,0.22), rgba(242,180,64,0.05)); border-color: rgba(242,180,64,0.55); }
.zw-onb-choice h3 { margin: 0; font: 700 19px Georgia, "Times New Roman", serif; color: #fff1d0; }
.zw-onb-choice ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.65; color: #e3d9c8; }
.zw-onb-choice-cta { margin-top: auto; font-size: 13px; font-weight: 700; color: #f2b440; }
.zw-onb-actions { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: center; }
.zw-onb-spacer { flex: 1 1 0; min-width: 0; }
.zw-onb-button { font-size: 13px; padding: 9px 16px; border-radius: 8px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.zw-onb-link { all: unset; cursor: pointer; font-size: 13px; line-height: 1.4; color: #d7c9ae; text-decoration: underline dotted; }
.zw-onb-link:hover, .zw-onb-link:focus-visible { color: #fff3da; }
.zw-onb-link:disabled { opacity: 0.5; cursor: default; }
.zw-onb-character { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 24px; align-items: start; }
.zw-onb-character-controls { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
/* The turntable renders at 4:5, so the box keeps that ratio and only its height follows the viewport. */
.zw-onb-preview { box-sizing: border-box; height: clamp(200px, calc(100vh - 300px), 380px); aspect-ratio: 4 / 5; width: auto; border-radius: 14px; position: relative; overflow: hidden;
  border: 1px solid rgba(255,255,255,0.08); background: radial-gradient(ellipse at 50% 88%, rgba(242,180,64,0.18), rgba(22,18,36,0.95) 62%); }
@supports (height: 100dvh) { .zw-onb-preview { height: clamp(200px, calc(100dvh - 300px), 380px); } }
.zw-onb-preview.zw-onb-preview-small { height: clamp(150px, calc(100vh - 420px), 250px); flex: none; }
.zw-onb-preview-canvas { width: 100%; height: 100%; display: block; cursor: grab; }
.zw-onb-preview-canvas[hidden], .zw-onb-preview [hidden] { display: none; }
.zw-onb-silhouette { display: grid; place-items: center; }
.zw-onb-silhouette svg { height: 72%; }
.zw-onb-label { margin-top: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #b9ad97; }
.zw-onb-models { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.zw-onb-model { all: unset; box-sizing: border-box; cursor: pointer; padding: 12px 3px; border-radius: 10px; text-align: center; font-size: 12px; letter-spacing: -0.01em; font-weight: 600; color: #e9e1d2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); }
.zw-onb-model:hover { background: rgba(255,255,255,0.09); }
.zw-onb-model:focus-visible { outline: 2px solid #f2b440; outline-offset: 2px; }
.zw-onb-model[aria-checked="true"] { border-color: #f2b440; background: rgba(242,180,64,0.18); color: #fff3da; }
.zw-onb-swatches { display: flex; flex-wrap: wrap; gap: 12px; padding: 4px 2px; }
.zw-onb-swatch { all: unset; cursor: pointer; width: 34px; height: 34px; border-radius: 50%; box-shadow: inset 0 0 0 2px rgba(255,255,255,0.28); }
.zw-onb-swatch:focus-visible { outline: 2px solid #fff3da; outline-offset: 3px; }
.zw-onb-swatch[aria-checked="true"] { box-shadow: 0 0 0 3px #1a1622, 0 0 0 5px #f2b440; }
.zw-onb-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #cdbf9e; }
.zw-onb-field input { box-sizing: border-box; width: 100%; font-size: 18px; padding: 10px 12px; margin: 0; }
.zw-onb-status { min-height: 20px; font-size: 13px; line-height: 1.45; color: #cfc6b5; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.zw-onb-status:empty { min-height: 0; }
.zw-onb-status[data-tone="ok"] { color: #8fe3b0; }
.zw-onb-status[data-tone="warn"] { color: #ffd36a; }
.zw-onb-status[data-tone="error"] { color: #ff9c94; }
.zw-onb-confirm { box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px; background: rgba(242,180,64,0.08); border: 1px solid rgba(242,180,64,0.3); }
.zw-onb-confirm[hidden] { display: none; }
.zw-onb-confirm-text { font-size: 13px; line-height: 1.45; color: #f4e3c1; }
.zw-onb-confirm[data-phase="failed"] { background: rgba(255,120,110,0.08); border-color: rgba(255,140,120,0.4); }
.zw-onb-confirm[data-phase="failed"] .zw-onb-confirm-text { color: #ffc2b8; }
.zw-onb-confirm[data-phase="done"] { background: rgba(120,220,160,0.08); border-color: rgba(143,227,176,0.45); }
.zw-onb-confirm[data-phase="done"] .zw-onb-confirm-text { color: #b6f0cb; }
.zw-onb-confirm[data-phase="failed"] .zw-onb-confirm-bar { display: none; }
.zw-onb-confirm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.zw-onb-confirm-actions:empty { display: none; }
.zw-onb-fee { box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 10px; background: rgba(58,123,213,0.1); border: 1px solid rgba(110,160,240,0.35); }
.zw-onb-fee[hidden] { display: none; }
.zw-onb-fee-line { font-size: 14px; font-weight: 700; color: #dce9ff; }
.zw-onb-unavailable { margin: 0; font-size: 13px; line-height: 1.5; color: #ffd36a; }
.zw-onb-unavailable[hidden] { display: none; }
.zw-onb-confirm-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden; }
.zw-onb-confirm-fill { height: 100%; width: 0; background: #f2b440; transition: width 0.3s; }
.zw-onb-confirm.indeterminate .zw-onb-confirm-fill { animation: zw-onb-slide 1.2s ease-in-out infinite; }
@keyframes zw-onb-slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
.zw-onb-summary { display: flex; gap: 24px; align-items: center; }
.zw-onb-summary-details { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.zw-onb-summary-name { font: 700 24px Georgia, "Times New Roman", serif; color: #fff3da; overflow-wrap: anywhere; }
.zw-onb-can { margin: 6px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.7; color: #e3d9c8; }
.zw-onb-returning-card { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.05); }
.zw-onb-returning-swatch { width: 40px; height: 40px; border-radius: 50%; flex: none; box-shadow: inset 0 0 0 2px rgba(255,255,255,0.3); }
.zw-onb-returning-name { font: 700 18px Georgia, "Times New Roman", serif; color: #fff3da; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .zw-onb-head, .zw-onb-body, .zw-onb-footer { padding-left: 18px; padding-right: 18px; }
  .zw-onb-steps { margin-left: 0; justify-content: flex-start; width: 100%; }
  .zw-onb-character { grid-template-columns: minmax(0, 1fr); }
  .zw-onb-models { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .zw-onb-preview { height: clamp(180px, 34vh, 300px); margin: 0 auto; }
  .zw-onb-summary { flex-direction: column; align-items: flex-start; }
}
@media (max-height: 640px) {
  .zw-onb-head { padding-top: 10px; padding-bottom: 10px; }
  .zw-onb-body { padding-top: 14px; padding-bottom: 14px; gap: 10px; }
  .zw-onb-footer { padding-top: 10px; padding-bottom: 12px; }
  .zw-onb-choice { padding: 14px 16px; }
}
`;
  document.head.appendChild(style);
}
