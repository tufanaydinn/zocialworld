import { injectUiStyles } from "../ui/styles.ts";
import { ZcashWalletAdapter, exportSeedPhraseForRecovery, subscribeToWalletState, transactionCapZat, type WalletMigration, type WalletState } from "./ZcashWalletAdapter.ts";
import { formatElapsed, migrationProgress } from "./migrationProgress.ts";
import { detectAddressKind } from "./core/wallet-types";
import { getNetworkConfig } from "./config.ts";
import { gameServerOrigin } from "../core/serverOrigin.ts";
import { claimTestCoins } from "./faucetClient.ts";
import { FAUCET_MISSING_COPY, addressChain, faucetPlan, walletChain, type WalletChain } from "./testChain.ts";
import { MAINNET_CONSENT_CHECKBOX, MAINNET_CONSENT_POINTS, MAINNET_CONSENT_TITLE, giveMainnetConsent, hasMainnetConsent } from "./mainnetConsent.ts";
import { buildBackupQuiz, checkBackupQuiz, type QuizQuestion } from "./backupQuiz.ts";
import { birthdayYears, estimateBirthday } from "./birthday.ts";
import { SENDING_PAUSED, isBroadcastPhaseError, isSendingPaused, walletErrorMessage } from "./engineErrors.ts";
import { isKnownPlayerAddress } from "./playerAddresses.ts";
import { isTexOfTransparent } from "./texAddress.ts";
import { SAPLING_CROSSING_WITHDRAW_NOTE, saplingOutputCrossesPools } from "./poolCrossing.ts";
import { formatZatBig, parseZecAmount } from "./txCap.ts";
import type { ReceiveAddresses, SendingStatus, ShieldResult } from "./core/wallet.ts";

/**
 * In-game wallet panel (on ZcashWalletAdapter): create, restore,
 * unlock/lock, sync, balance, receive and backup.
 *
 * ADR-018 on a VITE_ZCASH_NETWORK=main build, with the Stage 2 "Ironwood" engine (ADR-018 § 3 and the § 1 Stage 2
 * amendment):
 *  - a consent step before first use on this device (real money, experimental, unaudited);
 *  - create: the 24 words, then a backup check (pick the right word for 3 positions) before the wallet is usable;
 *  - restore: the seed plus "When did you create this wallet?" (month/year or "not sure") → a birthday height; every
 *    shielded pool of the seed is found;
 *  - a wallet saved by the Stage-1 engine is restored from its encrypted seed and birthday with a progress line (a
 *    one-time rescan; the seed is never asked for again, only a date when the old save does not tell the birthday);
 *  - "Add funds": the owner's own full unified address (Orchard-family + Sapling + transparent receivers — any wallet
 *    can pay it), the transparent exchange address and the Sapling-only form, each with Copy — displayed only here,
 *    only for the owner (sync asks lightwalletd about the transparent receivers through the server's bridge to find
 *    deposits; player payments get the shielded-only unified address, never the one with the exchange receiver);
 *  - balance: "Shielded" (Ironwood + Sapling + legacy Orchard, spendable) and "Waiting to be shielded" (transparent)
 *    with a Shield button into Ironwood (network fee shown; no cap, no project fee);
 *  - "Withdraw" to the player's own external wallet: any u1…, zs1…, t1… or TEX (tex1…) address, the public-amount
 *    warning for t1/TEX (the beta cap applies, no transfer fee);
 *  - no faucet; engine errors as plain sentences; sending paused (balance visible) when the upgrade guard says so.
 *
 * Privacy and safety rules this panel keeps:
 *  - the seed phrase is shown only on creation and on an explicit,
 *    passphrase-protected backup request; it is never logged or sent;
 *  - the receive address is shown only to the wallet owner, behind an
 *    explicit "show" click — no other player can ever open this panel or
 *    see an address (no "View Wallet" anywhere);
 *  - everything renders with textContent;
 *  - the wallet syncs through this game's own server bridge, so the
 *    lightwalletd operator never sees the player's IP.
 */

const AUTO_SYNC_MS = 120_000;
const MAINNET = (): boolean => getNetworkConfig().network === "main";
const UNIT = (): string => (MAINNET() ? "ZEC" : "TAZ");

type View = "auto" | "create" | "restore" | "backup" | "funds" | "withdraw" | "ready-funds";

export class WalletPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly statusChip: HTMLSpanElement;
  private state: WalletState = ZcashWalletAdapter.state;
  private view: View = "auto";
  private initialized = false;
  private autoSync: ReturnType<typeof setInterval> | null = null;
  private revealedAddress: string | null = null;
  private freshWords: string[] | null = null;
  /** The words list whose "I wrote them down" box is ticked, so a re-render (a sync finishing) keeps it ticked. */
  private wordsChecked: readonly string[] | null = null;
  private readonly openFaucetGuide: () => void;
  private readonly getCapability: () => string | null;
  private faucet: { available: boolean; amount: number } | null = null;
  private faucetMessage = "";
  private faucetOk = true;
  /** The backup check of a new mainnet wallet (3 questions), with the answers picked so far. */
  private quiz: { readonly words: readonly string[]; readonly questions: QuizQuestion[]; answers: (string | null)[]; failed: boolean } | null = null;
  /** The owner's addresses while the "Add funds" view shows them (dropped when it closes). */
  private funds: ReceiveAddresses | null = null;
  /** The engine's upgrade guard, asked when the panel opens. */
  private sending: SendingStatus | null = null;
  /** The shield confirmation (its preview) or progress. */
  private shieldState: { readonly preview: ShieldResult | null; readonly busy: boolean; readonly message: string; readonly ok: boolean } | null = null;
  /** Transparent funds seen at the last balance (the gentle "shield" prompt shows once they arrive). */
  private lastShieldable = 0;
  /** Shields in flight (kept when the panel closes, unlike `shieldState`). */
  private shielding = 0;
  private readonly unsubscribe: () => void;
  /** Refreshes the migration's estimated progress while it runs. */
  private migrationTicker: ReturnType<typeof setInterval> | null = null;
  /** The date picked on "Unlock and upgrade", kept across re-renders. */
  private migrationDate: BirthdayPick | null = null;
  /** Opened from onboarding — `onReady` fires once the wallet is unlocked and new seed words were acknowledged. */
  private onboarding: { onReady: () => void } | null = null;
  private readonly closeButton: HTMLButtonElement;

  /** Told when the panel closes (App then asks a newly connected guest for a name — never over a seed phrase). */
  private readonly onClosed: () => void;

  constructor(container: HTMLElement, options: { openFaucetGuide: () => void; getCapability: () => string | null; onClose?: () => void }) {
    injectUiStyles();
    injectWalletStyles();
    this.openFaucetGuide = options.openFaucetGuide;
    this.getCapability = options.getCapability;
    this.onClosed = options.onClose ?? (() => undefined);
    this.backdrop = el("div", "zw-ui zw-wallet-backdrop");
    const panel = el("div", "zw-panel zw-wallet");
    const header = el("div", "zw-wallet-header");
    const title = el("div", "zw-wallet-title");
    title.textContent = "Wallet";
    const net = el("span", "zw-wallet-net");
    if (MAINNET()) {
      // ADR-018: real money, beta.
      net.textContent = "MAINNET BETA";
      net.dataset.network = "main";
      net.title = "Real ZEC — experimental, unaudited beta. Use a fresh wallet with a small amount.";
    } else {
      net.textContent = "TESTNET";
      net.title = "Test coins only — no real value.";
    }
    this.statusChip = el("span", "zw-wallet-status");
    const close = el("button", "zw-button");
    close.textContent = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    this.closeButton = close;
    header.append(title, net, this.statusChip, close);
    this.body = el("div", "zw-wallet-body");
    panel.append(header, this.body);
    this.backdrop.appendChild(panel);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });
    container.appendChild(this.backdrop);

    this.unsubscribe = subscribeToWalletState((state) => {
      const wasOpen = this.state.status === "ready" || this.state.status === "syncing";
      this.state = state;
      const isOpen = state.status === "ready" || state.status === "syncing";
      if (isOpen && !wasOpen) this.startAutoSync();
      if (!isOpen && wasOpen) this.stopAutoSync();
      if (!isOpen) {
        this.revealedAddress = null;
        this.funds = null;
      }
      const shieldable = state.balance?.shieldableZec ?? 0;
      if (shieldable > this.lastShieldable && this.isOpen && this.view === "auto") this.shieldState = null;
      this.lastShieldable = shieldable;
      if (this.isOpen) this.render();
    });
  }

  /** Detects an existing (locked) wallet — cheap, no wallet engine download. Call once at startup. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      await ZcashWalletAdapter.initialize(getNetworkConfig().proxyUrl);
    } catch (error) {
      console.warn("[wallet] initialize failed:", error);
    }
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  open(): void {
    document.exitPointerLock();
    void this.initialize();
    this.backdrop.classList.add("visible");
    this.view = "auto";
    this.render();
    if (MAINNET()) void this.refreshSendingStatus();
    if (!this.faucet && !MAINNET()) {
      // Does this game server run a test-coin faucet for its own test chain?
      void fetch(`${gameServerOrigin()}/zcash/info`)
        .then((r) => (r.ok ? (r.json() as Promise<{ faucet: boolean; amount: number }>) : { faucet: false, amount: 0 }))
        .then((info) => {
          this.faucet = { available: info.faucet, amount: info.amount };
          if (this.isOpen) this.render();
        })
        .catch(() => {
          this.faucet = { available: false, amount: 0 };
          if (this.isOpen) this.render(); // "The faucet is not set up on this server", not a stuck "Checking…"
        });
    }
  }

  /**
   * ADR-015 § 7: the same create / restore / unlock / seed-word screens, opened ABOVE
   * the onboarding overlay. Once the wallet is unlocked (and a new seed phrase was acknowledged
   * with "Done"), `onReady` fires and the panel closes — onboarding continues with the character.
   */
  openForOnboarding(onReady: () => void): void {
    this.onboarding = { onReady };
    this.backdrop.classList.add("zw-wallet-onboarding");
    this.closeButton.textContent = "Back";
    this.open();
  }

  /**
   * The player is in the middle of something here — creating or restoring (the wallet reports
   * "ready" before the new seed phrase is on screen) or reading a seed phrase — so onboarding must
   * not close the panel under them; it waits for `onReady` instead.
   */
  get isBusy(): boolean {
    // A withdrawal or a shield started here keeps the app busy even after the panel closes.
    if (this.withdrawForm?.busy === true || this.shielding > 0) return true;
    return this.isOpen && (this.freshWords !== null || this.quiz !== null || this.view !== "auto" || this.shieldState?.busy === true);
  }

  close(): void {
    const wasOpen = this.isOpen;
    this.backdrop.classList.remove("visible", "zw-wallet-onboarding");
    // Nothing stays in the hidden DOM — no seed words (backup view, quiz buttons), addresses or stale
    // listeners holding them.
    this.body.replaceChildren();
    this.freshWords = null; // never keep the seed on screen
    this.wordsChecked = null;
    this.quiz = null;
    this.funds = null; // the addresses are shown only while "Add funds" is open
    this.shieldState = null;
    this.view = "auto";
    this.onboarding = null;
    this.closeButton.textContent = "Close (Esc)";
    this.syncMigrationTicker();
    if (wasOpen) this.onClosed();
  }

  dispose(): void {
    // A disposed panel must not restart its auto-sync on a later wallet state change.
    this.unsubscribe();
    this.stopAutoSync();
    if (this.migrationTicker) clearInterval(this.migrationTicker);
    this.migrationTicker = null;
    this.backdrop.remove();
  }

  // ------------------------------------------------------------------ rendering

  private render(): void {
    // A closed panel renders nothing (late async callbacks and stale listeners included).
    this.syncMigrationTicker();
    if (!this.isOpen) return;
    const { status } = this.state;
    // Onboarding: an unlocked wallet with no seed phrase left on screen hands control back.
    if (this.onboarding && (status === "ready" || status === "syncing") && !this.freshWords && !this.quiz && this.view === "auto" && !this.state.backupPending) {
      const { onReady } = this.onboarding;
      this.close();
      onReady();
      return;
    }
    this.statusChip.textContent = status === "ready" ? "Unlocked" : status === "syncing" ? "Syncing…" : status === "locked" ? "Locked" : status === "idle" ? "No wallet" : status === "initializing" ? "Opening…" : status;
    this.statusChip.dataset.status = status;
    this.body.replaceChildren();
    // ADR-018 § 4: the consent step comes before anything else on this device.
    if (MAINNET() && !hasMainnetConsent()) return this.renderConsent();
    if (this.quiz) return this.renderQuiz(this.quiz);
    if (this.freshWords) return this.renderWords(this.freshWords, true);
    if (this.view === "create") return this.renderCreate();
    if (this.view === "restore") return this.renderRestore();
    if (this.view === "backup") return this.renderBackup();
    if (this.view === "funds") return this.renderFunds();
    if (this.view === "ready-funds") return this.renderReadyFunds();
    if (this.view === "withdraw") return this.renderWithdraw();
    switch (status) {
      case "idle":
      case "disconnected":
        return this.renderWelcome();
      case "locked":
        return this.renderUnlock();
      case "initializing":
        return this.renderBusy("Opening the wallet… The first time, the browser downloads the wallet engine (about 60 MB).");
      case "ready":
      case "syncing":
        return MAINNET() ? this.renderReadyMain() : this.renderReady();
      default:
        return this.renderError();
    }
  }

  private renderWelcome(): void {
    this.para(
      MAINNET()
        ? "A Zcash wallet inside the game: choose your own name and character, talk in voice and send ZEC to other players privately. This is the mainnet beta — real ZEC, at most a small amount per transaction. Add funds from an exchange or another wallet, shield them, and pay players without leaving the game."
        : "A Zcash wallet inside the game: choose your own name and character, talk in voice, send ZEC to other players privately, and support projects. This build runs on the game's own Zcash test chain — test coins with no real value, from the in-game faucet.",
    );
    this.para("Your secret seed phrase is generated in your browser and stored only on this device, encrypted with your passphrase. The game server never sees it.", "zw-wallet-muted");
    const actions = el("div", "zw-wallet-actions");
    actions.append(
      this.button("Create a new wallet", () => this.go("create"), true),
      this.button("Restore from a seed phrase", () => this.go("restore")),
    );
    this.body.appendChild(actions);
    this.errorLine();
  }

  private renderCreate(): void {
    this.back();
    this.heading(MAINNET() ? "Create a mainnet wallet" : "Create a testnet wallet");
    this.para("Choose a passphrase (at least 10 characters). It encrypts your seed phrase on this device; you'll need it to unlock the wallet.");
    const pass = this.password("Passphrase");
    const confirm = this.password("Repeat passphrase");
    const message = el("div", "zw-wallet-error");
    const create = this.button("Create wallet", () => {
      if (pass.value.length < 10) return void (message.textContent = "The passphrase needs at least 10 characters.");
      if (pass.value !== confirm.value) return void (message.textContent = "The passphrases don't match.");
      create.disabled = true;
      message.textContent = "";
      ZcashWalletAdapter.createWallet(pass.value)
        .then((words) => {
          pass.value = confirm.value = "";
          this.freshWords = words;
          this.view = "auto";
          this.render();
        })
        .catch((error: unknown) => {
          create.disabled = false;
          message.textContent = friendly(error);
        });
    }, true);
    message.textContent = this.state.status === "error" ? friendly(this.state.error) : "";
    this.body.append(pass.parentElement!, confirm.parentElement!, create, message);
    pass.focus();
  }

  private renderWords(words: readonly string[], fresh: boolean): void {
    this.heading(fresh ? "Write down your seed phrase" : "Your seed phrase");
    this.para("These 24 words ARE your wallet. Anyone who has them can spend your coins; if you lose them and forget your passphrase, the coins are gone. Write them on paper. Never type them into a website, chat or message — the game will never ask for them.", "zw-wallet-warning");
    const grid = el("ol", "zw-wallet-words");
    for (const word of words) {
      const item = el("li", "");
      item.textContent = word; // textContent ONLY
      grid.appendChild(item);
    }
    const check = document.createElement("label");
    check.className = "zw-wallet-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    check.append(box, document.createTextNode(" I wrote the 24 words down and stored them safely."));
    const done = this.button(MAINNET() && (fresh || this.state.backupPending) ? "Next: check my backup" : "Done", () => {
      this.wordsChecked = null;
      // ADR-018 § 1: real money — prove the words were written down before the wallet is usable.
      if (MAINNET() && (fresh || this.state.backupPending)) {
        this.quiz = { words: [...words], questions: buildBackupQuiz(words), answers: [null, null, null], failed: false };
        this.freshWords = null;
        this.view = "auto";
        return this.render();
      }
      this.freshWords = null;
      this.view = "auto";
      this.render();
    }, true);
    done.dataset.action = "words-done";
    // A new wallet's first sync re-renders this view: the tick survives it (it used to come back unticked).
    box.checked = this.wordsChecked === words;
    done.disabled = !box.checked;
    box.addEventListener("change", () => {
      this.wordsChecked = box.checked ? words : null;
      done.disabled = !box.checked;
    });
    this.body.append(grid, check, done);
  }

  private renderRestore(): void {
    this.back();
    this.heading("Restore a wallet");
    const seedLabel = el("label", "zw-wallet-field");
    seedLabel.textContent = "Seed phrase (24 words)";
    const seed = document.createElement("textarea");
    seed.className = "zw-input zw-wallet-seed";
    seed.spellcheck = false;
    seed.autocomplete = "off";
    seed.rows = 3;
    seedLabel.appendChild(seed);
    const pass = this.password("New passphrase for this device");
    if (MAINNET()) return this.renderRestoreMain(seedLabel, seed, pass);
    const birthday = document.createElement("input");
    birthday.type = "number";
    birthday.min = "1";
    birthday.className = "zw-input";
    birthday.placeholder = "optional";
    const birthdayLabel = el("label", "zw-wallet-field");
    birthdayLabel.textContent = "Wallet birthday (block height you first used it — finds older coins)";
    birthdayLabel.appendChild(birthday);
    const message = el("div", "zw-wallet-error");
    const restore = this.button("Restore", () => {
      if (pass.value.length < 10) return void (message.textContent = "The passphrase needs at least 10 characters.");
      restore.disabled = true;
      message.textContent = "";
      const height = Number.parseInt(birthday.value, 10);
      ZcashWalletAdapter.importSeed(seed.value.trim().replace(/\s+/g, " ").toLowerCase(), pass.value, Number.isFinite(height) ? height : undefined)
        .then(() => {
          seed.value = pass.value = "";
          this.go("auto");
        })
        .catch((error: unknown) => {
          restore.disabled = false;
          message.textContent = friendly(error);
        });
    }, true);
    message.textContent = this.state.status === "error" ? friendly(this.state.error) : "";
    this.body.append(seedLabel, pass.parentElement!, birthdayLabel, restore, message);
    seed.focus();
  }

  private renderUnlock(): void {
    this.heading("Unlock your wallet");
    this.para("Your wallet is stored encrypted on this device.");
    // A Stage-1 save whose birthday could not be read — ask roughly when the wallet was created (never the
    // seed: the keystore has it), then unlock again with that birthday.
    // The date the player picked survives re-renders (a wrong passphrase re-renders this screen).
    const picker = this.state.migrationNeedsBirthday ? this.birthdayPicker((this.migrationDate ??= { month: null, year: null, notSure: false })) : null;
    if (picker) {
      const note = el("p", "zw-wallet-p zw-wallet-warning");
      note.dataset.role = "migration-date";
      note.textContent =
        "This wallet was saved by an older version of the game. The new wallet engine restores it from your seed phrase, which stays encrypted on this device — it only needs to know roughly when you created the wallet, to know where to start scanning. Your funds are safe.";
      this.body.append(note, picker.when, picker.estimateLine);
    }
    const pass = this.password("Passphrase");
    const message = el("div", "zw-wallet-error");
    message.dataset.role = "unlock-error";
    message.textContent = unlockErrorText(this.state.error, picker !== null);
    const unlock = this.button(picker ? "Unlock and upgrade" : "Unlock", () => {
      unlock.disabled = true;
      ZcashWalletAdapter.unlock(pass.value, picker ? { birthdayHeight: picker.estimate().height } : {})
        .catch(() => undefined)
        .finally(() => {
          pass.value = "";
          unlock.disabled = false;
        });
    }, true);
    unlock.dataset.action = "unlock";
    pass.addEventListener("keydown", (event) => {
      if (event.key === "Enter") unlock.click();
    });
    const forget = this.button("Forget this wallet on this device…", () => {
      if (!window.confirm("Remove the wallet from this browser? You can only get it back with your 24-word seed phrase.")) return;
      void ZcashWalletAdapter.clearAllData().then(() => this.go("auto"));
    });
    forget.classList.add("zw-wallet-danger");
    this.body.append(pass.parentElement!, unlock, message, forget);
    pass.focus();
  }
  private renderReady(): void {
    const balance = this.state.balance;
    const card = el("div", "zw-wallet-balance");
    const amount = el("div", "zw-wallet-amount");
    amount.textContent = balance ? `${formatZec(balance.totalZec)} TAZ` : "— TAZ";
    amount.title = "TAZ = testnet ZEC";
    const sub = el("div", "zw-wallet-muted");
    sub.textContent = balance
      ? `${balance.pendingZec > 0 ? `${formatZec(balance.pendingZec)} pending · ` : ""}${this.state.status === "syncing" ? "syncing…" : "up to date"}`
      : this.state.status === "syncing"
        ? "Syncing with the testnet…"
        : "Not synced yet";
    card.append(amount, sub);
    const actions = el("div", "zw-wallet-actions");
    const syncButton = this.button(this.state.status === "syncing" ? "Syncing…" : "Sync now", () => void ZcashWalletAdapter.sync().catch(() => undefined));
    syncButton.disabled = this.state.status === "syncing";
    actions.append(syncButton, this.button("Lock", () => void ZcashWalletAdapter.lock()), this.button("Back up seed…", () => this.go("backup")));
    this.body.append(card, actions);
    this.errorLine();

    // The coins section follows the wallet's chain (testChain.ts). This build's wallet is on the game's
    // own regtest chain (uregtest1…), which public testnet faucets reject — so only this server's faucet is offered.
    const chain = this.chain();
    const plan = faucetPlan(chain, this.faucet ? { available: this.faucet.available } : null);
    const section = el("div", "zw-wallet-coins");
    section.dataset.chain = chain;
    section.dataset.faucet = plan.show ? plan.server : "hidden";
    this.body.appendChild(section);
    const h = el("h3", "zw-wallet-h");
    h.textContent = plan.heading;
    const intro = el("p", "zw-wallet-p zw-wallet-muted");
    intro.textContent = `${plan.intro} Only you see your address; share it only with people you choose. Other players can still send you ZEC without ever seeing it (player menu → Send ZEC).`;
    section.append(h, intro);
    const addressBox = el("div", "zw-wallet-address");
    const addressLabel = el("div", "zw-wallet-address-label");
    addressLabel.textContent = plan.addressLabel;
    addressBox.appendChild(addressLabel);
    if (this.revealedAddress) {
      const code = el("code", "");
      code.textContent = this.revealedAddress;
      code.dataset.chain = addressChain(this.revealedAddress);
      const copy = this.button("Copy", () => void navigator.clipboard?.writeText(this.revealedAddress ?? ""));
      const hide = this.button("Hide", () => {
        this.revealedAddress = null;
        this.render();
      });
      addressBox.append(code, copy, hide);
    } else {
      addressBox.appendChild(
        this.button("Show my receive address", () => {
          void ZcashWalletAdapter.getReceiveAddress()
            .then((address) => {
              this.revealedAddress = address;
              this.render();
            })
            .catch((error: unknown) => window.alert(friendly(error)));
        }),
      );
    }
    section.appendChild(addressBox);
    if (!plan.show) return; // mainnet: no faucet of any kind
    const faucets = el("div", "zw-wallet-actions");
    if (plan.server === "ready" && this.faucet) {
      const claim = this.button(`Get ${this.faucet.amount} test coins`, () => void this.claimFaucet(claim), true);
      claim.dataset.action = "faucet-claim";
      faucets.appendChild(claim);
    } else {
      const note = el("p", "zw-wallet-p zw-wallet-faucet-note");
      note.textContent = plan.server === "checking" ? "Checking this server's faucet…" : chain === "regtest" ? `${FAUCET_MISSING_COPY} Ask the server operator for test coins.` : "This server has no faucet of its own.";
      section.appendChild(note);
    }
    // Public testnet faucets and their guide: only for a PUBLIC testnet wallet (utest… addresses), never for regtest.
    for (const faucet of plan.publicFaucets) faucets.appendChild(external(`Faucet: ${faucet.label} ↗`, faucet.url));
    if (plan.guide) {
      faucets.appendChild(this.button("Faucets guide (in-game wiki)", () => {
        this.close();
        this.openFaucetGuide();
      }));
    }
    if (faucets.childElementCount > 0) section.appendChild(faucets);
    if (this.faucetMessage) {
      const message = el("p", "zw-wallet-p zw-wallet-faucet-message");
      message.dataset.tone = this.faucetOk ? "ok" : "warn";
      message.setAttribute("role", "status");
      message.textContent = this.faucetMessage;
      section.appendChild(message);
    }
  }

  /** The wallet's chain: this build's network (testChain.ts), corrected by the revealed address's own prefix. */
  private chain(): WalletChain {
    const fromAddress = this.revealedAddress ? addressChain(this.revealedAddress) : "unknown";
    return fromAddress !== "unknown" ? fromAddress : walletChain(getNetworkConfig().network);
  }

  /** Asks this game server's faucet to send test coins to OUR address (the address goes only to our own server). */
  private async claimFaucet(button: HTMLButtonElement): Promise<void> {
    const capability = this.getCapability();
    if (!capability) {
      this.faucetMessage = "Not connected to the game server — try again in a moment.";
      return this.render();
    }
    button.disabled = true;
    this.faucetOk = true;
    this.faucetMessage = "Asking the faucet…";
    this.render();
    // Shared with the name-fee step's "Get test coins" (ADR-016): zcash/faucetClient.ts.
    const result = await claimTestCoins(capability);
    this.faucetOk = result.ok;
    this.faucetMessage = result.message;
    this.render();
  }

  private renderBackup(): void {
    this.back();
    this.heading("Back up your seed phrase");
    this.para("Enter your passphrase to show the 24 words. Make sure nobody can see your screen — and don't share your screen while they're visible.", "zw-wallet-warning");
    const pass = this.password("Passphrase");
    const message = el("div", "zw-wallet-error");
    const show = this.button("Show seed phrase", () => {
      void exportSeedPhraseForRecovery(pass.value)
        .then((seed) => {
          pass.value = "";
          if (!seed) return void (message.textContent = "Wrong passphrase.");
          if (!this.isOpen || this.view !== "backup") return; // Never into a closed panel
          this.body.replaceChildren();
          this.back();
          this.renderWords(seed.split(" "), false);
        })
        .catch(() => (message.textContent = "Wrong passphrase."));
    }, true);
    this.body.append(pass.parentElement!, show, message);
    pass.focus();
  }

  private renderBusy(text: string): void {
    const spinner = el("div", "zw-wallet-busy");
    spinner.textContent = text;
    this.body.appendChild(spinner);
  }

  private renderError(): void {
    this.para(`Something went wrong: ${this.state.error ?? "unknown error"}`, "zw-wallet-error");
    this.para(`The wallet syncs through the game server's ${MAINNET() ? "Zcash" : "testnet"} bridge. If the server is offline, try again later.`, "zw-wallet-muted");
    this.body.appendChild(this.button("Try again", () => void ZcashWalletAdapter.initialize(getNetworkConfig().proxyUrl), true));
  }

  // ------------------------------------------------------------------ mainnet beta (ADR-018)

  /** ADR-018 § 4: "experimental, unaudited software, real money; use a fresh wallet with a small amount" — once per device. */
  private renderConsent(): void {
    const box = el("div", "zw-wallet-consent");
    box.dataset.view = "consent";
    const h = el("h3", "zw-wallet-h");
    h.textContent = MAINNET_CONSENT_TITLE;
    const list = el("ul", "");
    for (const point of MAINNET_CONSENT_POINTS) {
      const item = el("li", "");
      item.textContent = point;
      list.appendChild(item);
    }
    box.append(h, list);
    const check = document.createElement("label");
    check.className = "zw-wallet-check";
    const agree = document.createElement("input");
    agree.type = "checkbox";
    agree.dataset.action = "consent-check";
    check.append(agree, document.createTextNode(` ${MAINNET_CONSENT_CHECKBOX}`));
    const go = this.button("Continue", () => {
      giveMainnetConsent();
      this.render();
    }, true);
    go.dataset.action = "consent-continue";
    go.disabled = true;
    agree.addEventListener("change", () => (go.disabled = !agree.checked));
    this.body.append(box, check, go);
  }

  /** ADR-018 § 1: the backup check of a new mainnet wallet — the right word for three positions. */
  private renderQuiz(quiz: NonNullable<WalletPanel["quiz"]>): void {
    this.heading("Check your backup");
    this.para("Pick the right word for each position, from the paper you just wrote. Until this check passes, the wallet sends nothing and shows no address.", "zw-wallet-muted");
    const wrap = el("div", "zw-wallet-quiz");
    wrap.dataset.view = "quiz";
    quiz.questions.forEach((question, i) => {
      const row = el("div", "zw-wallet-quiz-q");
      const label = el("div", "zw-wallet-address-label");
      label.textContent = `Word #${question.index + 1}`;
      const options = el("div", "zw-wallet-actions");
      for (const option of question.options) {
        const choice = this.button(option, () => {
          if (!this.isOpen || this.quiz !== quiz) return; // A stale button does nothing
          quiz.answers[i] = option;
          quiz.failed = false;
          this.render();
        });
        choice.setAttribute("aria-pressed", String(quiz.answers[i] === option));
        choice.dataset.quizPosition = String(question.index + 1);
        options.appendChild(choice);
      }
      row.append(label, options);
      wrap.appendChild(row);
    });
    this.body.appendChild(wrap);
    if (quiz.failed) this.para("Not quite — check the words on your paper. If they don't match, show the words again and write them down once more.", "zw-wallet-error");
    const actions = el("div", "zw-wallet-actions");
    const confirm = this.button("Confirm backup", () => {
      if (!this.isOpen || this.quiz !== quiz) return; // A stale button does nothing
      if (!checkBackupQuiz(quiz.words, quiz.questions, quiz.answers)) {
        quiz.failed = true;
        return this.render();
      }
      ZcashWalletAdapter.confirmBackup();
      this.quiz = null;
      // A new mainnet wallet made during onboarding shows its deposit addresses before the player moves on.
      this.view = this.onboarding && MAINNET() ? "ready-funds" : "auto";
      this.render();
    }, true);
    confirm.dataset.action = "quiz-confirm";
    confirm.disabled = quiz.answers.some((answer) => answer === null);
    const again = this.button("Show the words again", () => {
      if (!this.isOpen || this.quiz !== quiz) return; // A stale (hidden) button never re-renders the words
      this.freshWords = [...quiz.words];
      this.quiz = null;
      this.render();
    });
    actions.append(confirm, again);
    this.body.appendChild(actions);
  }

  /** ADR-018 § 1: restore with "When did you create this wallet?" instead of a block height. */
  private renderRestoreMain(seedLabel: HTMLLabelElement, seed: HTMLTextAreaElement, pass: HTMLInputElement): void {
    const picker = this.birthdayPicker();
    // ADR-018 § 1 Stage 2 amendment: every shielded pool is found now. Transparent funds: the engine
    // (upstream zcash_client_sqlite) watches the seed's standard transparent addresses with a gap limit of 10 unused
    // receiving addresses and 5 change addresses — read from its code, not yet tried with a real Zashi/Zodl seed.
    this.para(
      "A seed from Zashi, Zodl, Zingo or another Zcash wallet shows its funds in every shielded pool here (Ironwood, Orchard and Sapling). Transparent funds show when they sit on the seed's standard transparent addresses (the first unused ones in a row, as most wallets use them). The first scan takes a while — a fresh game wallet, topped up from your other wallet, is still the safest way to try the beta.",
      "zw-wallet-muted",
    );
    const message = el("div", "zw-wallet-error");
    const restore = this.button("Restore", () => {
      if (pass.value.length < 10) return void (message.textContent = "The passphrase needs at least 10 characters.");
      restore.disabled = true;
      message.textContent = "";
      const { height } = picker.estimate();
      ZcashWalletAdapter.importSeed(seed.value.trim().replace(/\s+/g, " ").toLowerCase(), pass.value, height)
        .then(() => {
          seed.value = pass.value = "";
          this.go("auto");
        })
        .catch((error: unknown) => {
          restore.disabled = false;
          message.textContent = friendly(error);
        });
    }, true);
    restore.dataset.action = "restore";
    message.textContent = this.state.status === "error" ? friendly(this.state.error) : "";
    this.body.append(seedLabel, pass.parentElement!, picker.when, picker.estimateLine, restore, message);
    seed.focus();
  }

  /**
   * "When did you create this wallet?" (month/year or "Not sure") with the estimated birthday height under it — the
   * restore form's date step, and the question asked when a Stage-1 save does not tell its birthday.
   */
  private birthdayPicker(remember?: BirthdayPick): { readonly when: HTMLElement; readonly estimateLine: HTMLElement; readonly estimate: () => { readonly height: number } } {
    const now = Date.now();
    const when = el("div", "zw-wallet-field");
    when.dataset.view = "restore-date";
    const question = el("span", "");
    question.textContent = "When did you create this wallet?";
    const row = el("div", "zw-wallet-select");
    const month = document.createElement("select");
    month.setAttribute("aria-label", "Month");
    MONTHS.forEach((name, i) => {
      const option = document.createElement("option");
      option.value = String(i + 1);
      option.textContent = name;
      month.appendChild(option);
    });
    const year = document.createElement("select");
    year.setAttribute("aria-label", "Year");
    for (const value of birthdayYears(now)) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      year.appendChild(option);
    }
    const today = new Date(now);
    month.value = remember?.month ?? String(today.getUTCMonth() + 1);
    year.value = remember?.year ?? String(today.getUTCFullYear());
    const notSureLabel = document.createElement("label");
    notSureLabel.className = "zw-wallet-check";
    const notSure = document.createElement("input");
    notSure.type = "checkbox";
    notSure.dataset.action = "birthday-not-sure";
    notSure.checked = remember?.notSure ?? false;
    notSureLabel.append(notSure, document.createTextNode(" Not sure"));
    row.append(month, year, notSureLabel);
    when.append(question, row);
    const estimateLine = el("p", "zw-wallet-p zw-wallet-muted");
    estimateLine.dataset.role = "birthday-estimate";
    const estimate = () => {
      month.disabled = year.disabled = notSure.checked;
      if (remember) {
        remember.month = month.value;
        remember.year = year.value;
        remember.notSure = notSure.checked;
      }
      const result = estimateBirthday(notSure.checked ? { year: null, month: 1 } : { year: Number(year.value), month: Number(month.value) }, Date.now());
      estimateLine.textContent = notSure.checked
        ? `The wallet scans from May 2022 (block ${result.height.toLocaleString("en-US")}). That can take a long time the first time — an hour or more — but it finds every coin since.`
        : `The wallet scans from about a week before that month (block ${result.height.toLocaleString("en-US")})${result.slow ? " — older wallets take longer to scan the first time" : ""}.`;
      return result;
    };
    for (const control of [month, year, notSure]) control.addEventListener("change", () => void estimate());
    estimate();
    return { when, estimateLine, estimate };
  }
  /** ADR-018 § 1: shielded balance, "waiting to be shielded", Shield, Add funds, Withdraw. */
  private renderReadyMain(): void {
    const balance = this.state.balance;
    const unit = UNIT();
    if (this.state.backupPending) {
      this.para("Back up this wallet before using it: confirm your 24 words (real money — if this browser's data is lost, the words are the only way back).", "zw-wallet-warning");
      const backup = this.button("Back up and check my seed phrase…", () => this.go("backup"), true);
      backup.dataset.action = "backup-now";
      const actions = el("div", "zw-wallet-actions");
      actions.append(backup, this.button("Lock", () => void ZcashWalletAdapter.lock()));
      this.body.appendChild(actions);
      return;
    }
    const pools = el("div", "zw-wallet-pools");
    const shielded = el("div", "zw-wallet-pool");
    shielded.dataset.pool = "shielded";
    const transparent = el("div", "zw-wallet-pool");
    transparent.dataset.pool = "transparent";
    const fill = (card: HTMLElement, label: string, amount: string, note: string): void => {
      const l = el("div", "zw-wallet-pool-label");
      l.textContent = label;
      const a = el("div", "zw-wallet-pool-amount");
      a.textContent = amount;
      const n = el("div", "zw-wallet-muted");
      n.style.fontSize = "12px";
      n.textContent = note;
      card.append(l, a, n);
    };
    // "Shielded" is every shielded pool the wallet can spend from — Ironwood (where change and shielded
    // funds go), Sapling and legacy Orchard.
    fill(shielded, "Shielded", balance ? `${formatZec(balance.totalZec)} ${unit}` : `— ${unit}`, balance && balance.pendingZec > 0 ? `spendable for payments · ${formatZec(balance.pendingZec)} confirming` : "spendable for payments");
    shielded.title = "Ironwood, Sapling and Orchard funds together — all spendable for payments.";
    fill(transparent, "Waiting to be shielded", balance ? `${formatZec(balance.transparentZec)} ${unit}` : `— ${unit}`, "transparent — shield it to use it in the game");
    pools.append(shielded, transparent);
    const migration = this.state.migration;
    const sub = el("div", "zw-wallet-muted");
    sub.style.fontSize = "12px";
    sub.textContent = migration ? "Rescanning…" : this.state.status === "syncing" ? "Syncing with the Zcash network…" : balance ? "Up to date" : "Not synced yet";
    this.body.append(pools, sub);
    if (migration) this.renderMigration(migration);

    const paused = this.sending && !this.sending.allowed;
    if (paused) {
      const banner = el("p", "zw-wallet-paused");
      banner.dataset.role = "sending-paused";
      banner.textContent = this.sending?.code === "consensus_branch_unknown" ? walletErrorMessage({ code: "consensus_branch_unknown" }) : SENDING_PAUSED;
      this.body.appendChild(banner);
    }

    const shieldable = balance?.shieldableZec ?? 0;
    if (shieldable > 0 || this.shieldState) this.renderShield(shieldable, Boolean(paused));

    const actions = el("div", "zw-wallet-actions");
    const funds = this.button("Add funds", () => this.go("funds"), !balance || balance.totalZec === 0);
    funds.dataset.action = "add-funds";
    const withdraw = this.button("Withdraw…", () => this.go("withdraw"));
    withdraw.dataset.action = "withdraw";
    withdraw.disabled = Boolean(paused) || !balance || balance.totalZec <= 0;
    const syncButton = this.button(this.state.status === "syncing" ? "Syncing…" : "Sync now", () => void ZcashWalletAdapter.sync().catch(() => undefined));
    syncButton.disabled = this.state.status === "syncing";
    actions.append(funds, withdraw, syncButton, this.button("Lock", () => void ZcashWalletAdapter.lock()), this.button("Back up seed…", () => this.go("backup")));
    this.body.appendChild(actions);
    this.errorLine();
    const cap = transactionCapZat();
    this.para(`Mainnet beta: ${cap === null ? "no per-transaction limit" : `at most ${formatZatBig(cap)} ZEC per payment, withdrawal or name fee`}. Payments to players are shielded; every send shows its network fee.`, "zw-wallet-muted");
  }

  /**
   * ADR-018 § 3: the one-time rescan of a wallet saved by the Stage-1 engine, restored from the encrypted
   * seed and its birthday. The engine reports no progress while it scans (it holds its database for the whole scan), so
   * the bar is an ESTIMATE from the number of blocks and the measured Stage-2 mainnet speed (`migrationProgress`).
   */
  private renderMigration(migration: WalletMigration): void {
    const progress = migrationProgress(migration, Date.now());
    const box = el("div", "zw-wallet-prompt");
    box.dataset.role = "migration";
    const title = el("p", "zw-wallet-p");
    title.style.fontWeight = "700";
    title.textContent = "Upgrading your wallet to the new wallet engine";
    const text = el("p", "zw-wallet-p");
    text.textContent =
      `A one-time rescan restores this wallet from your seed phrase, which stays encrypted on this device: it starts at the wallet's birthday (block ${migration.fromHeight.toLocaleString("en-US")})` +
      (progress.blocks !== null ? ` and checks about ${progress.blocks.toLocaleString("en-US")} blocks — roughly ${progress.etaMinutes} minute${progress.etaMinutes === 1 ? "" : "s"}.` : ".") +
      " Your funds are safe. Sending works again when it finishes; keep this tab open (closing it starts the rescan again next time).";
    const bar = el("div", "zw-wallet-progress");
    const fill = el("div", "zw-wallet-progress-fill");
    fill.style.width = `${Math.round(progress.fraction * 100)}%`;
    bar.appendChild(fill);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(Math.round(progress.fraction * 100)));
    const status = el("p", "zw-wallet-p zw-wallet-muted");
    status.style.fontSize = "12px";
    status.dataset.role = "migration-status";
    status.textContent = `${progress.blocks !== null ? `About ${Math.round(progress.fraction * 100)}% (estimated) · ` : ""}${formatElapsed(progress.elapsedSeconds)} elapsed`;
    box.append(title, text, bar, status);
    this.body.appendChild(box);
  }

  /** Re-renders the migration's progress line every few seconds while it runs and the panel is open. */
  private syncMigrationTicker(): void {
    const wanted = this.isOpen && this.state.migration !== null;
    if (wanted && !this.migrationTicker) {
      this.migrationTicker = setInterval(() => {
        if (this.isOpen && this.state.migration && this.view === "auto") this.render();
        else this.syncMigrationTicker();
      }, 5_000);
    } else if (!wanted && this.migrationTicker) {
      clearInterval(this.migrationTicker);
      this.migrationTicker = null;
    }
  }

  /** The "waiting to be shielded" prompt and its confirmation (network fee only: no cap, no project fee — ADR-018 § 1). */
  private renderShield(shieldableZec: number, paused: boolean): void {
    const state = this.shieldState;
    const box = el("div", state?.preview ? "zw-wallet-confirm" : "zw-wallet-prompt");
    box.dataset.role = "shield";
    if (!state) {
      const text = el("p", "zw-wallet-p");
      text.textContent = `${formatZec(shieldableZec)} ZEC arrived on your exchange (transparent) address. Shield it to use it in the game — you pay only the network fee.`;
      const shield = this.button("Shield…", () => void this.previewShield(), true);
      shield.dataset.action = "shield";
      shield.disabled = paused;
      box.append(text, shield);
      this.body.appendChild(box);
      return;
    }
    if (state.preview) {
      const preview = state.preview;
      box.append(
        line("Moves into your shielded balance (Ironwood)", `${zat(preview.transparentInZat)} ZEC`),
        line("Network fee", `${zat(preview.feeZat)} ZEC`),
        line("Arrives shielded", `${zat(preview.shieldedZat)} ZEC`),
      );
      // The engine shields one source at a time (a TEX withdrawal's one-time address never together
      // with the other addresses — that would link them on chain); what remains needs another Shield.
      const restZat = Math.round(shieldableZec * 1e8) - preview.transparentInZat;
      if (restZat > 0) {
        const rest = el("p", "zw-wallet-p zw-wallet-muted");
        rest.dataset.role = "shield-rest";
        rest.textContent = `The other ${zat(restZat)} ZEC waiting is shielded separately — use Shield again afterwards (the wallet never shields a TEX withdrawal's one-time address together with your other addresses: that would link them on the chain).`;
        box.appendChild(rest);
      }
      const row = el("div", "zw-wallet-actions");
      const go = this.button(state.busy ? "Shielding…" : "Shield now", () => void this.runShield(), true);
      go.dataset.action = "shield-confirm";
      go.disabled = state.busy || paused;
      const cancel = this.button("Cancel", () => {
        this.shieldState = null;
        this.render();
      });
      cancel.disabled = state.busy;
      row.append(go, cancel);
      box.appendChild(row);
    }
    if (state.message) {
      const message = el("p", state.ok ? "zw-wallet-p zw-wallet-faucet-message" : "zw-wallet-p zw-wallet-error");
      message.setAttribute("role", "status");
      message.textContent = state.message;
      box.appendChild(message);
    }
    this.body.appendChild(box);
  }

  private async previewShield(): Promise<void> {
    this.shieldState = { preview: null, busy: true, message: "Working out the network fee…", ok: true };
    this.render();
    await this.refreshSendingStatus();
    if (this.sending && !this.sending.allowed) {
      this.shieldState = { preview: null, busy: false, message: SENDING_PAUSED, ok: false };
      return this.render();
    }
    try {
      const preview = await ZcashWalletAdapter.previewShield();
      this.shieldState = { preview, busy: false, message: "", ok: true };
    } catch (error) {
      this.shieldState = { preview: null, busy: false, message: walletErrorMessage(error, { context: "shield" }), ok: false };
    }
    this.render();
  }

  private async runShield(): Promise<void> {
    const preview = this.shieldState?.preview ?? null;
    this.shieldState = { preview, busy: true, message: "Shielding — building the proof takes up to a minute…", ok: true };
    this.render();
    this.shielding++;
    try {
      const result = await ZcashWalletAdapter.shieldTransparent();
      this.shieldState = { preview: null, busy: false, message: `Shielded: ${zat(result.shieldedZat)} ZEC arrives in your shielded balance after the next block (about 75 seconds).`, ok: true };
      setTimeout(() => void ZcashWalletAdapter.sync().catch(() => undefined), 80_000);
    } catch (error) {
      if (isSendingPaused(error)) void this.refreshSendingStatus();
      // After a lost answer the shield may have gone through — no "Shield now" again until the next sync.
      this.shieldState = { preview: isBroadcastPhaseError(error) ? null : preview, busy: false, message: walletErrorMessage(error, { context: "shield" }), ok: false };
    } finally {
      this.shielding--;
    }
    this.render();
  }

  /**
   * ADR-018 § 1 "Adding funds": the owner's own addresses, displayed in the owner's own panel only. Not "never over the
   * wire": every sync asks lightwalletd, through the game server's bridge, for the transparent
   * receiver's UTXOs (GetAddressUtxos), so the bridge and lightwalletd see that t-address (docs/privacy/
   * ZCASH_WALLET_THREAT_MODEL.md § Mainnet).
   */
  private renderFunds(): void {
    this.back();
    this.heading("Add funds");
    const intro = el("p", "zw-wallet-p");
    intro.dataset.view = "funds";
    intro.textContent =
      "Every wallet and exchange can send here. Send a small amount: the beta limits what each payment from the game can be. Only you see these addresses in the game — other players never do. To find deposits, your wallet asks the Zcash network about your transparent (exchange) addresses through the game server, which does not log them.";
    this.body.appendChild(intro);
    if (this.state.backupPending) return this.para("Confirm your seed-phrase backup first (Back up seed…).", "zw-wallet-warning");
    this.renderDepositAddresses();
  }

  /** The deposit addresses (fetched once per opening): unified, exchange (transparent) and Sapling-only. */
  private renderDepositAddresses(): void {
    if (!this.funds) {
      this.renderBusy("Getting your addresses…");
      void ZcashWalletAdapter.getAddresses()
        .then((addresses) => {
          this.funds = addresses;
          if (this.isOpen && (this.view === "funds" || this.view === "ready-funds")) this.render();
        })
        .catch((error: unknown) => {
          if (this.isOpen && (this.view === "funds" || this.view === "ready-funds")) {
            this.body.replaceChildren();
            if (this.view === "funds") this.back();
            this.para(walletErrorMessage(error, { fallback: "Your addresses couldn't be read. Try again in a moment." }), "zw-wallet-error");
          }
        });
      return;
    }
    // ADR-018 § 1 Stage 2 amendment: the full unified address — Orchard-family (Ironwood), Sapling and
    // transparent receivers — so any Zcash wallet can pay it shielded; the exchange t1… and the Sapling-only form below.
    this.addressBlock("Your main address — unified (shielded Ironwood + Sapling receivers, and a transparent one)", this.funds.unified, "unified");
    this.para("Any Zcash wallet can pay it — Zashi/Zodl, Zingo, YWallet, Edge and others pay its shielded part, and the funds arrive shielded.", "zw-wallet-muted");
    this.addressBlock("Exchange address (transparent)", this.funds.transparent, "transparent");
    this.para("Transparent deposits are public on the chain: anyone can see that this address received the amount. Most exchanges (Coinbase, Kraken, Binance…) can only withdraw to an address like this one. When it arrives (one confirmation), press Shield.", "zw-wallet-warning");
    this.addressBlock("Sapling-only address — for wallets that can't pay a unified address", this.funds.sapling, "sapling");
  }

  /** Onboarding, after a new mainnet wallet's backup check: where to send ZEC, then on into the world. */
  private renderReadyFunds(): void {
    this.heading("Your wallet is ready");
    const intro = el("p", "zw-wallet-p");
    intro.dataset.view = "ready-funds";
    intro.textContent =
      "To pay other players — or to confirm a name of your own, which costs a small one-time fee — add some ZEC first. Send a small amount from any Zcash wallet or exchange to an address below. You can also do this later: open Wallet → Add funds in the game.";
    this.body.appendChild(intro);
    const actions = el("div", "zw-wallet-actions");
    const next = this.button("Continue", () => {
      if (!this.isOpen || this.view !== "ready-funds") return;
      this.view = "auto";
      this.render();
    }, true);
    next.dataset.action = "ready-funds-continue";
    actions.appendChild(next);
    this.renderDepositAddresses();
    this.body.appendChild(actions);
  }

  private addressBlock(label: string, address: string, kind: string): void {
    const box = el("div", "zw-wallet-address");
    box.dataset.address = kind;
    const title = el("div", "zw-wallet-address-label");
    title.textContent = label;
    const code = el("code", "");
    code.textContent = address; // textContent ONLY
    const copy = this.button("Copy", () => {
      void navigator.clipboard?.writeText(address).then(
        () => {
          copy.textContent = "Copied";
          setTimeout(() => (copy.textContent = "Copy"), 1500);
        },
        () => undefined,
      );
    });
    copy.dataset.action = `copy-${kind}`;
    box.append(title, code, copy);
    this.body.appendChild(box);
  }

  /** ADR-018 § 1 "Withdrawing": to the player's own external wallet; the cap applies, the transfer fee does not. */
  private renderWithdraw(): void {
    this.back();
    this.heading("Withdraw to your own wallet");
    const cap = transactionCapZat();
    const intro = el("p", "zw-wallet-p zw-wallet-muted");
    intro.dataset.view = "withdraw";
    // ADR-018 § 3: any u1…, zs1…, t1… or TEX (tex1…) address; t1/TEX make the amount public.
    intro.textContent = `To a wallet of yours: any unified address (u1…), a Sapling address (zs1…), a transparent address (t1…) or an exchange's TEX address (tex1…). ${cap === null ? "" : `Beta limit: ${formatZatBig(cap)} ZEC per transaction. `}No transfer fee — only the network fee.`;
    this.body.appendChild(intro);
    if (this.state.backupPending) return this.para("Confirm your seed-phrase backup first (Back up seed…).", "zw-wallet-warning");
    if (this.sending && !this.sending.allowed) return this.para(SENDING_PAUSED, "zw-wallet-paused");
    const form = (this.withdrawForm ??= { to: "", amount: "", memo: "", preview: null, busy: false, message: "", ok: false, txid: null });
    // Any edit after Review drops the reviewed preview AND its confirmation on screen at once (Send turns
    // back into Review), so what is sent is always exactly what was reviewed.
    let confirmBox: HTMLElement | null = null;
    const actions = el("div", "zw-wallet-actions");
    const showActions = (): void => {
      actions.replaceChildren();
      if (!form.preview) {
        const review = this.button("Review", () => void this.reviewWithdraw(), true);
        review.dataset.action = "withdraw-review";
        review.disabled = form.busy;
        actions.appendChild(review);
      } else {
        const send = this.button(form.busy ? "Sending…" : "Send", () => void this.runWithdraw(), true);
        send.dataset.action = "withdraw-send";
        send.disabled = form.busy;
        actions.appendChild(send);
      }
    };
    const edited = (): void => {
      if (form.busy || !form.preview) return;
      form.preview = null;
      confirmBox?.remove();
      confirmBox = null;
      showActions();
    };
    const to = this.textField("Your wallet's address", form.to, (value) => {
      form.to = value;
      edited();
    });
    const amount = this.textField(`Amount (${UNIT()})`, form.amount, (value) => {
      form.amount = value;
      edited();
    });
    amount.inputMode = "decimal";
    const memo = this.textField("Memo (optional, shielded addresses only)", form.memo, (value) => {
      form.memo = value;
      edited();
    });
    for (const field of [to, amount, memo]) field.disabled = form.busy;
    const warning = el("p", "zw-wallet-p zw-wallet-warning");
    warning.dataset.role = "withdraw-public-hint";
    const showTransparent = (): void => {
      const kind = publicAddressInput(to.value);
      memo.disabled = kind !== null || form.busy;
      warning.hidden = kind === null;
      warning.textContent =
        kind === "tex"
          ? "This is a TEX (exchange) address: the amount and the address become public on the chain. It is paid in two transactions — first to a one-time transparent address of your wallet, then to the exchange — and the network fee covers both."
          : "This is a transparent address: the amount and the address become public on the chain.";
    };
    to.addEventListener("input", showTransparent);
    showTransparent();
    this.body.appendChild(warning);
    const balance = this.state.balance;
    if (balance) this.para(`Shielded balance: ${formatZec(balance.totalZec)} ZEC`, "zw-wallet-muted");
    if (form.preview) {
      const preview = form.preview;
      const box = el("div", "zw-wallet-confirm");
      box.dataset.role = "withdraw-confirm";
      box.append(
        line("To", shortAddress(preview.request.to)),
        line("You send", `${formatZatBig(preview.request.amountZat)} ZEC`),
        line(preview.recipientTex ? "Network fee (both transactions)" : "Network fee", `${zat(preview.networkFeeZat)} ZEC`),
        line("Transfer fee", "none (your own wallet)"),
      );
      if (preview.recipientTex) box.appendChild(line("Transactions", "2 (TEX: the exchange needs a transparent source)"));
      // Whatever was typed, the engine's resolved pool decides whether the amount becomes public.
      if (preview.recipientPool === "transparent") {
        const publicNote = el("p", "zw-wallet-p zw-wallet-warning");
        publicNote.dataset.role = "withdraw-public";
        publicNote.textContent = preview.recipientTex
          ? "This goes to a TEX (exchange) address: the amount and the address become public on the chain."
          : "This goes to a transparent address: the amount and the address become public on the chain.";
        box.appendChild(publicNote);
      }
      // A Sapling destination paid from Ironwood funds crosses pools — the amount becomes public too.
      if (saplingOutputCrossesPools(preview.recipientPool, preview.request.amountZat + BigInt(preview.networkFeeZat), this.state.balance?.shieldedPools)) {
        const crossing = el("p", "zw-wallet-p zw-wallet-warning");
        crossing.dataset.role = "withdraw-pool-crossing";
        crossing.textContent = SAPLING_CROSSING_WITHDRAW_NOTE;
        box.appendChild(crossing);
      }
      this.body.appendChild(box);
      confirmBox = box;
    }
    showActions();
    this.body.appendChild(actions);
    if (form.message) {
      const message = el("p", form.ok ? "zw-wallet-p zw-wallet-faucet-message" : "zw-wallet-p zw-wallet-error");
      message.setAttribute("role", "status");
      message.textContent = form.message;
      this.body.appendChild(message);
    }
  }

  /** `preview.request` is exactly what was reviewed — and exactly what Send sends. */
  private withdrawForm: {
    to: string;
    amount: string;
    memo: string;
    preview: { request: WithdrawRequest; networkFeeZat: number; recipientPool: "ironwood" | "sapling" | "transparent" | null; recipientTex: boolean } | null;
    busy: boolean;
    message: string;
    ok: boolean;
    txid: string | null;
  } | null = null;

  private withdrawRequest(): WithdrawRequest | string {
    const form = this.withdrawForm!;
    const amountZat = parseZecAmount(form.amount);
    if (amountZat === null) return "Enter an amount like 0.005 (up to 8 decimals).";
    const cap = transactionCapZat();
    if (cap !== null && amountZat > cap) return `The beta limit is ${formatZatBig(cap)} ZEC per transaction.`;
    if (!form.to.trim()) return "Enter your wallet's address.";
    // A mistyped TEX address is caught here (bech32m checksum), before the engine is asked.
    if (/^tex/i.test(form.to.trim()) && detectAddressKind(form.to) !== "tex") return "That TEX address isn't valid — check it against your exchange's deposit page.";
    const publicKind = publicAddressInput(form.to);
    return { purpose: "withdrawal", to: form.to.trim(), amountZat, ...(form.memo && publicKind === null ? { memo: form.memo } : {}) };
  }

  private async reviewWithdraw(): Promise<void> {
    const form = this.withdrawForm!;
    const request = this.withdrawRequest();
    if (typeof request === "string") {
      form.message = request;
      form.ok = false;
      return this.render();
    }
    form.busy = true;
    form.message = "Working out the network fee…";
    form.ok = true;
    this.render();
    await this.refreshSendingStatus();
    try {
      if (this.sending && !this.sending.allowed) throw Object.assign(new Error(SENDING_PAUSED), { code: this.sending.code ?? "consensus_branch_mismatch" });
      const preview = await ZcashWalletAdapter.previewSend(request);
      const refusal = await this.withdrawRefusal(request, preview.recipientAddress);
      if (refusal) throw Object.assign(new Error(refusal), { code: "withdraw_refused" });
      // The fields are locked while busy; the preview is kept only for exactly the request that was reviewed.
      const now = this.withdrawRequest();
      if (typeof now === "string" || !sameWithdrawRequest(now, request)) {
        form.preview = null;
        form.message = "The form changed while the fee was worked out — review again.";
        form.ok = false;
      } else {
        form.preview = { request, networkFeeZat: preview.networkFeeZat, recipientPool: preview.recipientPool, recipientTex: preview.recipientTex };
        form.message = "";
      }
    } catch (error) {
      const own = (error as { code?: unknown }).code === "withdraw_refused" ? (error as Error).message : null;
      form.message = own ?? walletErrorMessage(error, { context: "withdrawal", transparentWaiting: (this.state.balance?.shieldableZec ?? 0) > 0 });
      form.ok = false;
    }
    form.busy = false;
    this.render();
  }

  /**
   * A deterrent, not enforcement: Withdraw is for the player's OWN external wallet. It refuses an address
   * another player's wallet sealed to this one during this session (that payment should go through Send ZEC, with the
   * project fee) and this wallet's own addresses. The client cannot know who owns any other address.
   */
  private async withdrawRefusal(request: WithdrawRequest, resolved: string | null): Promise<string | null> {
    if (isKnownPlayerAddress(request.to, resolved)) {
      return "That is another player's address from a payment this session. Pay players with Send ZEC (player menu) — Withdraw is only for your own wallet.";
    }
    try {
      const own = this.funds ?? (await ZcashWalletAdapter.getAddresses());
      if (isOwnWithdrawAddress(own, [request.to, resolved])) return "That is this wallet's own address — nothing to withdraw to.";
    } catch {
      // the own-address check is best effort
    }
    return null;
  }

  private async runWithdraw(): Promise<void> {
    const form = this.withdrawForm!;
    // Only a reviewed request is ever sent, and exactly as reviewed.
    const reviewed = form.preview?.request ?? null;
    const current = this.withdrawRequest();
    if (form.busy || !reviewed || typeof current === "string" || !sameWithdrawRequest(current, reviewed)) {
      form.preview = null;
      form.message = typeof current === "string" ? current : "Review the withdrawal first.";
      form.ok = false;
      return this.render();
    }
    const request = reviewed;
    form.busy = true;
    form.message = "Sending — building the proof takes up to a minute…";
    form.ok = true;
    this.render();
    try {
      // A TEX withdrawal is two transactions (broadcast order).
      const txids = await ZcashWalletAdapter.sendRequestTxids(request);
      const sent =
        txids.length > 1
          ? `Sent in ${txids.length} transactions (TEX): ${txids.map((t) => `${t.slice(0, 10)}…`).join(" then ")} — on their way to your wallet.`
          : `Sent. Transaction ${txids[0]!.slice(0, 10)}… is on its way to your wallet.`;
      this.withdrawForm = { to: "", amount: "", memo: "", preview: null, busy: false, message: sent, ok: true, txid: null };
    } catch (error) {
      if (isSendingPaused(error)) void this.refreshSendingStatus();
      form.busy = false;
      form.preview = null;
      form.message = walletErrorMessage(error, { context: "withdrawal", transparentWaiting: (this.state.balance?.shieldableZec ?? 0) > 0 });
      form.ok = false;
      // After a lost answer the withdrawal may have gone out — the form is cleared so it is not simply sent again.
      if (isBroadcastPhaseError(error)) this.withdrawForm = { to: "", amount: "", memo: "", preview: null, busy: false, message: form.message, ok: false, txid: null };
    }
    this.render();
  }

  /** ADR-018 § 2: the engine's branch guard. Never throws; a failure leaves the last answer. */
  private async refreshSendingStatus(): Promise<void> {
    if (this.state.status !== "ready" && this.state.status !== "syncing") return;
    try {
      this.sending = await ZcashWalletAdapter.sendingStatus();
    } catch {
      // keep the last answer
    }
    if (this.isOpen) this.render();
  }

  private textField(label: string, value: string, onInput: (value: string) => void): HTMLInputElement {
    const wrap = el("label", "zw-wallet-field");
    wrap.textContent = label;
    const input = document.createElement("input");
    input.className = "zw-input";
    input.value = value;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.addEventListener("keydown", (event) => event.stopPropagation());
    input.addEventListener("input", () => onInput(input.value));
    wrap.appendChild(input);
    this.body.appendChild(wrap);
    return input;
  }

  // ------------------------------------------------------------------ helpers

  private go(view: View): void {
    this.view = view;
    this.render();
  }

  private back(): void {
    this.body.appendChild(this.button("← Back", () => this.go("auto")));
  }

  private heading(text: string): void {
    const h = el("h3", "zw-wallet-h");
    h.textContent = text;
    this.body.appendChild(h);
  }

  private para(text: string, className = ""): void {
    const p = el("p", `zw-wallet-p ${className}`);
    p.textContent = text;
    this.body.appendChild(p);
  }

  private errorLine(): void {
    if (!this.state.error) return;
    this.para(this.state.error, "zw-wallet-error");
  }

  private button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = el("button", `zw-button${primary ? " zw-button-primary" : ""}`);
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  private password(label: string): HTMLInputElement {
    const wrap = el("label", "zw-wallet-field");
    wrap.textContent = label;
    const input = document.createElement("input");
    input.type = "password";
    input.className = "zw-input";
    input.autocomplete = "off";
    input.addEventListener("keydown", (event) => event.stopPropagation());
    wrap.appendChild(input);
    return input;
  }

  private startAutoSync(): void {
    this.stopAutoSync();
    void ZcashWalletAdapter.sync().catch(() => undefined);
    this.autoSync = setInterval(() => {
      if (this.state.status === "ready") void ZcashWalletAdapter.sync().catch(() => undefined);
    }, AUTO_SYNC_MS);
  }

  private stopAutoSync(): void {
    if (this.autoSync) clearInterval(this.autoSync);
    this.autoSync = null;
  }
}

function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/SharedArrayBuffer|crossOriginIsolated|Atomics/i.test(message)) return "This page isn't cross-origin isolated, so the wallet engine can't start (server configuration).";
  if (/fetch|network|unavailable|14/i.test(message)) return `Couldn't reach the ${MAINNET() ? "Zcash network" : "testnet"} through the game server (${message}).`;
  return message;
}

/** A zatoshi number as ZEC text ("0.00015"). */
function zat(value: number): string {
  return formatZatBig(BigInt(Math.round(value)));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A withdrawal as the form builds it (ADR-018 § 1). */
type WithdrawRequest = { purpose: "withdrawal"; to: string; amountZat: bigint; memo?: string };

/**
 * What the typed withdrawal address makes public — "transparent" for t1…/t3…, "tex" for tex1… (as typed,
 * so the warning shows while typing; the engine's resolved pool decides at Review) — or null for a shielded address.
 */
export function publicAddressInput(text: string): "transparent" | "tex" | null {
  const a = text.trim().toLowerCase();
  if (/^tex(test|regtest)?1/.test(a)) return "tex";
  if (/^(t[13]|tm)/.test(a)) return "transparent";
  return null;
}

/** A month/year (or "not sure") picked in the birthday picker; null = not picked yet (the picker shows today). */
type BirthdayPick = { month: string | null; year: string | null; notSure: boolean };

/**
 * The line under Unlock. On "Unlock and upgrade" (`datePicker`) the date question is the screen's
 * own note, so only that message is hidden — any other error (a wrong passphrase) still shows.
 */
export function unlockErrorText(error: string | null, datePicker: boolean): string {
  if (!error) return "";
  if (datePicker && error === walletErrorMessage({ code: "migration_birthday_unknown" })) return "";
  return error;
}

/**
 * Whether a withdrawal destination (as typed, or as the engine resolved it) is one of this
 * wallet's own addresses — including the TEX form of its own t-address (the same P2PKH hash under `tex`), which would
 * go out in two transactions and come straight back, public, to "Waiting to be shielded".
 */
export function isOwnWithdrawAddress(own: ReceiveAddresses, candidates: readonly (string | null | undefined)[]): boolean {
  const mine = new Set([own.unified, own.unifiedShielded, own.unifiedSaplingTransparent, own.sapling, own.transparent].map((a) => a.toLowerCase()));
  return candidates.some((a) => typeof a === "string" && (mine.has(a.trim().toLowerCase()) || isTexOfTransparent(a, own.transparent)));
}

/** The same destination, amount and memo. */
export function sameWithdrawRequest(a: WithdrawRequest, b: WithdrawRequest): boolean {
  return a.to === b.to && a.amountZat === b.amountZat && (a.memo ?? "") === (b.memo ?? "");
}

/** The confirmation's "To" line: the start and the end of the address the player typed (the full one stays in the field). */
export function shortAddress(address: string): string {
  const a = address.trim();
  return a.length <= 26 ? a : `${a.slice(0, 14)}…${a.slice(-10)}`;
}

/** One "label … value" row of a confirmation box. */
function line(label: string, value: string): HTMLDivElement {
  const row = el("div", "zw-wallet-line");
  const name = el("span", "");
  name.textContent = label;
  const amount = el("b", "");
  amount.textContent = value;
  row.append(name, amount);
  return row;
}

function formatZec(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, "") || "0";
}

function external(label: string, url: string): HTMLAnchorElement {
  const a = el("a", "zw-button");
  a.textContent = label;
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

let walletStylesInjected = false;
function injectWalletStyles(): void {
  if (walletStylesInjected) return;
  walletStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-wallet-backdrop { position: absolute; inset: 0; z-index: 21; display: none; align-items: center; justify-content: center; background: rgba(6,6,14,0.6); }
.zw-wallet-backdrop.visible { display: flex; }
/* Above the onboarding overlay (z-index 40). */
.zw-wallet-backdrop.zw-wallet-onboarding { z-index: 45; }
.zw-wallet { width: min(560px, 94vw); max-height: 90vh; display: flex; flex-direction: column; padding: 0; overflow: hidden;
  background: linear-gradient(180deg, rgba(30,26,18,0.97), rgba(16,14,12,0.97)); border: 2px solid rgba(244,183,40,0.6); }
.zw-wallet-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid rgba(244,183,40,0.3); }
.zw-wallet-title { font: 700 20px Georgia, serif; color: #f9e2a8; flex: none; }
.zw-wallet-net { padding: 2px 8px; border-radius: 999px; background: #3a7bd5; color: #fff; font: 800 10px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.08em; }
.zw-wallet-status { flex: 1; font-size: 12px; color: #cdbf9e; }
.zw-wallet-status[data-status="ready"] { color: #8fe3b0; }
.zw-wallet-body { padding: 14px 18px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.zw-wallet-h { margin: 6px 0 0; font: 700 16px Georgia, serif; color: #f4e3c1; }
.zw-wallet-p { margin: 0; font-size: 13px; line-height: 1.5; color: #e9dfcc; }
.zw-wallet-muted { color: #b8ac93; }
.zw-wallet-warning { padding: 8px 10px; border-radius: 8px; background: rgba(224,68,62,0.15); border: 1px solid rgba(224,68,62,0.5); color: #ffd9d6; }
.zw-wallet-error { color: #ff9c94; font-size: 13px; min-height: 0; }
.zw-wallet-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.zw-wallet-actions a { text-decoration: none; }
.zw-wallet-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #cdbf9e; }
.zw-wallet-seed { resize: vertical; font-family: ui-monospace, monospace; }
.zw-wallet-words { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 12px; margin: 0; padding: 10px 10px 10px 34px; border-radius: 8px; background: rgba(0,0,0,0.35);
  font: 600 13px ui-monospace, monospace; color: #fff6dc; }
.zw-wallet-check { font-size: 13px; color: #e9dfcc; }
.zw-wallet-balance { padding: 14px; border-radius: 12px; background: rgba(244,183,40,0.12); border: 1px solid rgba(244,183,40,0.35); }
.zw-wallet-amount { font: 800 26px "Segoe UI", system-ui, sans-serif; color: #ffd36a; }
.zw-wallet-coins { display: flex; flex-direction: column; gap: 10px; }
.zw-wallet-address { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.zw-wallet-address-label { flex: 1 1 100%; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: #cdbf9e; }
.zw-wallet-faucet-note { color: #ffd36a; }
.zw-wallet-faucet-message { padding: 8px 10px; border-radius: 8px; background: rgba(120,220,160,0.08); border: 1px solid rgba(143,227,176,0.4); color: #cfeedd; }
.zw-wallet-faucet-message[data-tone="warn"] { background: rgba(255,200,90,0.08); border-color: rgba(255,200,90,0.45); color: #ffe2a0; }
.zw-wallet-address code { flex: 1 1 100%; overflow-wrap: anywhere; padding: 8px; border-radius: 8px; background: rgba(0,0,0,0.35); font-size: 12px; color: #fff6dc; }
.zw-wallet-busy { padding: 18px; text-align: center; color: #e9dfcc; }
/* ADR-018: the mainnet beta's views. */
.zw-wallet-net[data-network="main"] { background: #c2410c; }
.zw-wallet-consent { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px; background: rgba(194,65,12,0.14); border: 1px solid rgba(251,146,60,0.55); }
.zw-wallet-consent ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 1.45; color: #ffe8d6; }
.zw-wallet-pools { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.zw-wallet-pool { padding: 12px; border-radius: 12px; background: rgba(244,183,40,0.10); border: 1px solid rgba(244,183,40,0.35); display: flex; flex-direction: column; gap: 4px; }
.zw-wallet-pool[data-pool="transparent"] { background: rgba(120,160,220,0.08); border-color: rgba(140,180,240,0.4); }
.zw-wallet-pool-label { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #cdbf9e; }
.zw-wallet-pool-amount { font: 800 22px "Segoe UI", system-ui, sans-serif; color: #ffd36a; }
.zw-wallet-pool[data-pool="transparent"] .zw-wallet-pool-amount { color: #b9d4ff; }
.zw-wallet-prompt { padding: 8px 10px; border-radius: 8px; background: rgba(120,220,160,0.08); border: 1px solid rgba(143,227,176,0.45); color: #cfeedd; font-size: 13px; line-height: 1.45; }
.zw-wallet-paused { padding: 8px 10px; border-radius: 8px; background: rgba(255,200,90,0.1); border: 1px solid rgba(255,200,90,0.5); color: #ffe2a0; font-size: 13px; }
.zw-wallet-confirm { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(244,183,40,0.35); }
.zw-wallet-line { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: #efe6d2; }
.zw-wallet-line b { color: #fff6dc; }
.zw-wallet-quiz { display: flex; flex-direction: column; gap: 10px; }
.zw-wallet-quiz-q { display: flex; flex-direction: column; gap: 6px; }
.zw-wallet-quiz-q .zw-wallet-actions button[aria-pressed="true"] { background: #f4b728; color: #241a05; border-color: #f4b728; }
.zw-wallet-select { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.zw-wallet-select select { padding: 6px 8px; border-radius: 8px; background: rgba(0,0,0,0.35); color: #fff6dc; border: 1px solid rgba(244,183,40,0.4); }
.zw-wallet-danger { color: #ff9c94 !important; }
/* The Stage-1 wallet's one-time rescan (estimated progress). */
.zw-wallet-progress { height: 8px; border-radius: 999px; background: rgba(0,0,0,0.35); overflow: hidden; margin: 6px 0 2px; }
.zw-wallet-progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #8fe3b0, #f4b728); transition: width 0.6s ease; }
`;
  document.head.appendChild(style);
}
