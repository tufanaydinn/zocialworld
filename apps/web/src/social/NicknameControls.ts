import { injectUiStyles } from "../ui/styles.ts";
import { MAX_NICKNAME_LENGTH } from "@project/shared";

/**
 * Always-on (not dev-gated), minimal nickname entry/edit control
 * Deliberately not a blocking pre-join modal: it never
 * steals keyboard focus on its own (no auto-focus) and never shares a
 * CSS class with `ProjectDiscoveryPanel`'s backdrop, so it cannot
 * interfere with movement/interaction or with the e2e suite.
 *
 * The user's nickname choice always reaches the server as a
 * `set_nickname` request (never a change to the initial `join`) — see
 * `App.ts`. This keeps exactly one code path for "the nickname changed",
 * rather than duplicating validation/conflict-handling for a pre-join
 * case. The server is authoritative either way: whatever actually lands
 * comes back via `nickname_updated` and is reflected here through
 * `setCurrentNickname()`.
 *
 * Choosing a name (ADR-015) is a wallet-holder feature. For a
 * guest (`setGuest(true)`) the input and button are disabled and the button
 * reads "Connect a wallet to choose a name"; clicking it opens the wallet
 * (`onConnectWallet`). The server drops a guest's `set_nickname` anyway.
 */
export class NicknameControls {
  private readonly element: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly button: HTMLButtonElement;
  private readonly connectButton: HTMLButtonElement;
  private onSubmitCallback: (nickname: string) => void = () => {};
  private onConnectWalletCallback: () => void = () => {};
  private guest = true;

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.element = document.createElement("div");
    this.element.className = "zw-ui zw-panel zw-nickname-controls";

    const label = document.createElement("span");
    label.className = "zw-nickname-label";
    label.textContent = "Nickname:";
    this.element.appendChild(label);

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "zw-input";
    this.input.setAttribute("aria-label", "Nickname");
    this.input.maxLength = MAX_NICKNAME_LENGTH;
    this.input.placeholder = "Guest";
    this.element.appendChild(this.input);

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "zw-button";
    this.button.textContent = "Set";
    this.button.addEventListener("click", () => this.submit());
    this.element.appendChild(this.button);

    // ADR-015: guests see why they cannot rename, and the way there.
    this.connectButton = document.createElement("button");
    this.connectButton.type = "button";
    this.connectButton.className = "zw-button zw-nickname-connect";
    this.connectButton.textContent = "Connect a wallet to choose a name";
    this.connectButton.title = "Guests get a Guest-#### name. Wallet holders choose their own.";
    this.connectButton.addEventListener("click", () => {
      this.connectButton.blur();
      this.onConnectWalletCallback();
    });
    this.element.appendChild(this.connectButton);

    this.input.addEventListener("keydown", (event) => {
      // Stop propagation so a held key here (e.g. typing "West") never
      // reaches the global InputManager listener on `window` — see
      // InputManager's own input-focus guard for the belt-and-suspenders
      // half of this fix.
      event.stopPropagation();
      if (event.key === "Enter") this.submit();
    });

    container.appendChild(this.element);
    this.setGuest(true);
  }

  onNicknameSubmit(callback: (nickname: string) => void): void {
    this.onSubmitCallback = callback;
  }

  /** ADR-015: the guest's "Connect a wallet to choose a name" button was clicked. */
  onConnectWallet(callback: () => void): void {
    this.onConnectWalletCallback = callback;
  }

  /**
   * ADR-015: guests cannot choose a name — the control is disabled and says why (from the
   * server-confirmed canReceive). The input is read-only rather than `disabled`, so it still takes
   * focus (keyboard isolation from the game keeps working the same way for everyone); the
   * "Connect a wallet to choose a name" button replaces "Set".
   */
  setGuest(guest: boolean): void {
    this.guest = guest;
    this.input.readOnly = guest;
    this.input.title = guest ? "Guests get a Guest-#### name — connect a wallet to choose your own." : "";
    this.button.disabled = guest;
    this.button.hidden = guest;
    this.connectButton.hidden = !guest;
    this.element.dataset.guest = String(guest);
  }

  get isGuest(): boolean {
    return this.guest;
  }

  /** Reflects the server-confirmed nickname (e.g. after conflict-suffixing) — called from `welcome`/`nickname_updated`. Setting `.value` is a safe property assignment, never markup. */
  setCurrentNickname(nickname: string): void {
    this.input.value = nickname;
  }

  private submit(): void {
    if (this.guest) return;
    const value = this.input.value.trim();
    if (value.length === 0) return;
    this.onSubmitCallback(value);
  }

  dispose(): void {
    this.element.remove();
  }
}
