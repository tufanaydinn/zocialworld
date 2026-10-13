import { injectUiStyles } from "../ui/styles.ts";

/**
 * "Update ready — reload" (ADR-018): a new engine or client build reaches players without a manual step.
 *
 * The game is a web page: a rebuilt wallet engine reaches players on their next page load, and the encrypted wallet
 * stays on the device. The game server announces the id of the client build it serves (`welcome.build`, `GET
 * /version`); a page running another build shows a small banner and reloads ONLY between actions — never while a
 * payment, a withdrawal, shielding or the name fee is being sent, never during onboarding or a wallet step
 * (creating, restoring, reading or checking a seed phrase), and never while the player presents on the Watch Hall stage
 * (a reload would end the share for everyone). "Reload" while busy waits until the action is over.
 *
 * The decision logic is pure (`shouldOfferUpdate`, `UpdateGate`); the banner is a thin DOM layer.
 */

/** Whether `serverBuild` means a newer client exists: both known and different. Development (no ids) never prompts. */
export function shouldOfferUpdate(clientBuild: string | null | undefined, serverBuild: string | null | undefined): boolean {
  return Boolean(clientBuild) && Boolean(serverBuild) && clientBuild !== serverBuild && clientBuild !== "dev";
}

/** Reload when idle: asks `isBusy` now and then, and reloads at the first idle moment after `request()`. */
export class UpdateGate {
  private readonly isBusy: () => boolean;
  private readonly reload: () => void;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private pending = false;

  constructor(options: { readonly isBusy: () => boolean; readonly reload: () => void; readonly schedule?: (fn: () => void, ms: number) => unknown }) {
    this.isBusy = options.isBusy;
    this.reload = options.reload;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  get waiting(): boolean {
    return this.pending;
  }

  /** Reloads now if idle; otherwise once idle (checked every second). Returns true if it reloaded at once. */
  request(): boolean {
    if (!this.isBusy()) {
      this.pending = false;
      this.reload();
      return true;
    }
    if (this.pending) return false;
    this.pending = true;
    const poll = (): void => {
      if (!this.pending) return;
      if (this.isBusy()) {
        this.schedule(poll, 1000);
        return;
      }
      this.pending = false;
      this.reload();
    };
    this.schedule(poll, 1000);
    return false;
  }

  cancel(): void {
    this.pending = false;
  }
}

/** The banner: "Update ready — reload". Shown once a newer build is announced; a reload waits for an idle moment. */
export class UpdatePrompt {
  private readonly root: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private readonly gate: UpdateGate;
  private readonly clientBuild: string | null;
  private shown = false;

  constructor(container: HTMLElement, options: { readonly clientBuild: string | null; readonly isBusy: () => boolean; readonly reload?: () => void }) {
    injectUiStyles();
    injectUpdateStyles();
    this.clientBuild = options.clientBuild;
    this.gate = new UpdateGate({ isBusy: options.isBusy, reload: options.reload ?? (() => window.location.reload()) });
    this.root = document.createElement("div");
    this.root.className = "zw-ui zw-update";
    this.root.setAttribute("role", "status");
    this.root.dataset.role = "update-prompt";
    this.text = document.createElement("span");
    this.text.textContent = "Update ready — reload to get the new version. Your wallet stays on this device.";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "zw-button zw-button-primary";
    this.button.textContent = "Reload";
    this.button.addEventListener("click", () => {
      if (!this.gate.request()) {
        this.text.textContent = "Reloading as soon as the current action is finished…";
        this.button.disabled = true;
      }
    });
    this.root.append(this.text, this.button);
    container.appendChild(this.root);
  }

  /** The server announced its build (welcome or /version). */
  announce(serverBuild: string | null | undefined): void {
    if (this.shown || !shouldOfferUpdate(this.clientBuild, serverBuild)) return;
    this.shown = true;
    this.root.classList.add("visible");
  }

  get visible(): boolean {
    return this.shown;
  }
}

let updateStylesInjected = false;
function injectUpdateStyles(): void {
  if (updateStylesInjected) return;
  updateStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-update { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 50; display: none; align-items: center; gap: 12px;
  padding: 8px 12px 8px 16px; border-radius: 12px; background: rgba(24,20,12,0.96); border: 1px solid rgba(244,183,40,0.6); box-shadow: 0 8px 24px rgba(0,0,0,0.45);
  font-size: 13px; color: #f4e3c1; pointer-events: auto; }
.zw-update.visible { display: flex; }
`;
  document.head.appendChild(style);
}
