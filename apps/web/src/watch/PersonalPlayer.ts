import { injectUiStyles } from "../ui/styles.ts";
import { embedUrl, supportsCredentialless, watchUrl, YOUTUBE_ID_PATTERN } from "./youtube.ts";

/**
 * The opt-in personal YouTube player (ADR-014 § 7, docs/architecture/WATCH_HALL.md).
 *
 * Nothing else in the game contacts YouTube. "Watch here" first asks for consent (remembered per
 * device), then:
 *  - Chromium (`<iframe credentialless>` support): a DOM overlay with a cookieless, credentialless
 *    youtube-nocookie.com embed. `referrerpolicy="strict-origin"` is required — the production
 *    `Referrer-Policy: no-referrer` makes the embed fail with YouTube Error 153 — so YouTube learns
 *    the game's origin (said in the consent text and docs/privacy/WATCH_HALL_THREAT_MODEL.md);
 *  - other browsers: the watch page in a new tab (noopener, noreferrer).
 * YouTube's iframe_api script is never loaded, and safeHtml's iframe ban is untouched: this is
 * the one iframe the client ever creates, built here with fixed attributes from a validated id.
 */

/** Per-device consent flag. */
export const YOUTUBE_CONSENT_KEY = "zocial-world.watch.youtube-consent";

export const YOUTUBE_CONSENT_TEXT = "Watching here connects your browser to YouTube (Google): it sees your IP address and that you are watching from Zocial World.";

export interface PlayableVideo {
  readonly id: string;
  readonly title: string;
}

export interface PersonalPlayerOptions {
  /** Gives keyboard focus back to the game after Close (a cross-origin iframe keeps it otherwise). */
  readonly focusGame?: () => void;
  /** Called when the overlay opens or closes (the stage audio ducks while it is open). */
  readonly onOpenChange?: (open: boolean) => void;
}

function readConsent(): boolean {
  try {
    return window.localStorage.getItem(YOUTUBE_CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

function writeConsent(granted: boolean): void {
  try {
    if (granted) window.localStorage.setItem(YOUTUBE_CONSENT_KEY, "granted");
    else window.localStorage.removeItem(YOUTUBE_CONSENT_KEY);
  } catch {
    // Storage blocked (private mode, policy): consent then lasts for this page only.
  }
}

export class PersonalPlayer {
  private readonly consentBackdrop: HTMLDivElement;
  private readonly consentTitle: HTMLDivElement;
  private readonly rememberBox: HTMLInputElement;
  private readonly consentYouTubeLink: HTMLAnchorElement;
  private readonly overlay: HTMLDivElement;
  private readonly overlayTitle: HTMLDivElement;
  private readonly overlayYouTubeLink: HTMLAnchorElement;
  private readonly frameHost: HTMLDivElement;
  private readonly listeners = new Set<(open: boolean) => void>();
  private readonly options: PersonalPlayerOptions;
  private iframe: HTMLIFrameElement | null = null;
  private pending: PlayableVideo | null = null;
  /** Consent given this page session (when "remember" was unticked or storage is blocked). */
  private sessionConsent = false;

  constructor(container: HTMLElement, options: PersonalPlayerOptions = {}) {
    this.options = options;
    if (options.onOpenChange) this.listeners.add(options.onOpenChange);
    injectUiStyles();
    injectPlayerStyles();

    // ---- consent dialog
    this.consentBackdrop = el("div", "zw-ui zw-watch-consent-backdrop");
    this.consentBackdrop.setAttribute("role", "dialog");
    this.consentBackdrop.setAttribute("aria-modal", "true");
    this.consentBackdrop.setAttribute("aria-label", "Watch on YouTube here?");
    const dialog = el("div", "zw-panel zw-watch-consent");
    const heading = el("div", "zw-watch-consent-heading");
    heading.textContent = "Watch here with YouTube?";
    this.consentTitle = el("div", "zw-watch-consent-video");
    const text = el("p", "zw-watch-consent-text");
    text.textContent = YOUTUBE_CONSENT_TEXT;
    const detail = el("p", "zw-watch-consent-detail");
    detail.textContent = "Nothing else in Zocial World contacts YouTube. The player is cookieless and closes with Esc or the Close button. You can also open the video on YouTube in a new tab instead.";
    const remember = el("label", "zw-watch-consent-remember");
    this.rememberBox = document.createElement("input");
    this.rememberBox.type = "checkbox";
    this.rememberBox.checked = true;
    remember.append(this.rememberBox, document.createTextNode(" Remember my choice on this device"));
    const actions = el("div", "zw-watch-consent-actions");
    const accept = el("button", "zw-button zw-button-primary zw-watch-consent-accept");
    accept.textContent = "Watch here";
    accept.addEventListener("click", () => this.accept());
    this.consentYouTubeLink = el("a", "zw-button zw-watch-consent-tab");
    this.consentYouTubeLink.textContent = "Open on YouTube ↗";
    this.consentYouTubeLink.target = "_blank";
    this.consentYouTubeLink.rel = "noopener noreferrer";
    this.consentYouTubeLink.addEventListener("click", () => this.hideConsent());
    const cancel = el("button", "zw-button zw-watch-consent-cancel");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    actions.append(accept, this.consentYouTubeLink, cancel);
    dialog.append(heading, this.consentTitle, text, detail, remember, actions);
    this.consentBackdrop.appendChild(dialog);
    this.consentBackdrop.addEventListener("click", (event) => {
      if (event.target === this.consentBackdrop) this.close();
    });
    container.appendChild(this.consentBackdrop);

    // ---- player overlay (a floating window: the world stays visible and playable around it)
    this.overlay = el("div", "zw-ui zw-watch-player");
    this.overlay.setAttribute("role", "dialog");
    this.overlay.setAttribute("aria-label", "YouTube player");
    const bar = el("div", "zw-watch-player-bar");
    this.overlayTitle = el("div", "zw-watch-player-title");
    this.overlayYouTubeLink = el("a", "zw-button zw-watch-player-tab");
    this.overlayYouTubeLink.textContent = "Open on YouTube ↗";
    this.overlayYouTubeLink.target = "_blank";
    this.overlayYouTubeLink.rel = "noopener noreferrer";
    const forget = el("button", "zw-button zw-watch-player-forget");
    forget.textContent = "Forget consent";
    forget.title = "Ask again before the next YouTube video";
    forget.addEventListener("click", () => {
      this.forgetConsent();
      this.close();
    });
    const close = el("button", "zw-button zw-button-primary zw-watch-player-close");
    close.textContent = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    bar.append(this.overlayTitle, this.overlayYouTubeLink, forget, close);
    this.frameHost = el("div", "zw-watch-player-frame");
    this.overlay.append(bar, this.frameHost);
    container.appendChild(this.overlay);
  }

  /** Whether the player overlay is showing. */
  get isOpen(): boolean {
    return this.overlay.classList.contains("visible");
  }

  get isConsentOpen(): boolean {
    return this.consentBackdrop.classList.contains("visible");
  }

  /** Whether "Watch here" will play without asking (remembered on this device or given this session). */
  get hasConsent(): boolean {
    return this.sessionConsent || readConsent();
  }

  /** Subscribe to the overlay opening/closing; returns the unsubscribe function. */
  onOpenChange(listener: (open: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** "Watch here": a new tab where credentialless iframes are unsupported; otherwise consent (once) then the overlay. */
  play(video: PlayableVideo): void {
    if (!YOUTUBE_ID_PATTERN.test(video.id)) return;
    const title = video.title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!supportsCredentialless()) {
      // An explicit new-tab navigation, like "Open on YouTube ↗": nothing is embedded in our page.
      window.open(watchUrl(video.id), "_blank", "noopener,noreferrer");
      return;
    }
    document.exitPointerLock?.();
    if (this.hasConsent) {
      this.openOverlay({ id: video.id, title });
      return;
    }
    this.pending = { id: video.id, title };
    this.consentTitle.textContent = title;
    this.consentYouTubeLink.href = watchUrl(video.id);
    this.rememberBox.checked = true;
    this.consentBackdrop.classList.add("visible");
    this.consentBackdrop.querySelector<HTMLButtonElement>(".zw-watch-consent-accept")?.focus();
  }

  /** Closes the consent dialog and/or the player (stops playback by removing the iframe). */
  close(): void {
    this.hideConsent();
    if (!this.isOpen) return;
    this.iframe?.remove();
    this.iframe = null;
    this.frameHost.replaceChildren();
    this.overlay.classList.remove("visible");
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.overlay.contains(active)) active.blur();
    this.options.focusGame?.();
    this.emit(false);
  }

  /** Forgets the remembered consent on this device; the next "Watch here" asks again. */
  forgetConsent(): void {
    this.sessionConsent = false;
    writeConsent(false);
  }

  dispose(): void {
    this.close();
    this.consentBackdrop.remove();
    this.overlay.remove();
    this.listeners.clear();
  }

  private accept(): void {
    const video = this.pending;
    if (!video) return this.hideConsent();
    this.sessionConsent = true;
    if (this.rememberBox.checked) writeConsent(true);
    this.hideConsent();
    this.openOverlay(video);
  }

  private hideConsent(): void {
    this.pending = null;
    this.consentBackdrop.classList.remove("visible");
  }

  private openOverlay(video: PlayableVideo): void {
    this.iframe?.remove();
    const frame = document.createElement("iframe");
    // credentialless must be set before the first navigation (src).
    frame.setAttribute("credentialless", "");
    (frame as HTMLIFrameElement & { credentialless?: boolean }).credentialless = true;
    frame.setAttribute("referrerpolicy", "strict-origin");
    frame.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
    frame.setAttribute("allowfullscreen", "");
    frame.title = `YouTube video: ${video.title}`;
    frame.className = "zw-watch-player-iframe";
    frame.src = embedUrl(video.id);
    this.iframe = frame;
    this.frameHost.replaceChildren(frame);
    this.overlayTitle.textContent = video.title;
    this.overlayYouTubeLink.href = watchUrl(video.id);
    const wasOpen = this.isOpen;
    this.overlay.classList.add("visible");
    if (!wasOpen) this.emit(true);
  }

  private emit(open: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(open);
      } catch (error) {
        console.warn("[watch] player listener failed:", error);
      }
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

let stylesInjected = false;
function injectPlayerStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-watch-consent-backdrop { position: absolute; inset: 0; z-index: 22; display: none; align-items: center; justify-content: center; background: rgba(8,6,16,0.6); }
.zw-watch-consent-backdrop.visible { display: flex; }
.zw-watch-consent { width: min(480px, 92vw); padding: 18px 20px; background: linear-gradient(180deg, rgba(40,28,20,0.98), rgba(22,16,14,0.98)); border: 2px solid rgba(160,108,56,0.85); color: #f1e9dd; }
.zw-watch-consent-heading { font: 700 19px Georgia, "Times New Roman", serif; color: #f4e3c1; margin-bottom: 6px; }
.zw-watch-consent-video { font: 600 13px "Segoe UI", system-ui, sans-serif; color: #e8c58a; margin-bottom: 10px; overflow-wrap: anywhere; }
.zw-watch-consent-text { font-size: 14px; line-height: 1.5; margin: 0 0 8px; }
.zw-watch-consent-detail { font-size: 12px; line-height: 1.5; color: #cdbda5; margin: 0 0 12px; }
.zw-watch-consent-remember { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #d9cdb8; margin-bottom: 14px; cursor: pointer; }
.zw-watch-consent-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.zw-watch-consent-actions a.zw-button { text-decoration: none; display: inline-block; }
/* Top-centre, between the title card and the minimap, sized so it never covers the chat (bottom left) or the
   stage panel (right column): a viewer watching "together" keeps reading the Hall chat and reaching the stage controls. */
.zw-watch-player { position: absolute; left: 50%; top: 56px; transform: translateX(-50%); z-index: 21; display: none; flex-direction: column;
  width: max(min(480px, 92vw), min(960px, calc(100vw - 840px), calc((100vh - 400px) * 16 / 9))); border-radius: 12px; overflow: hidden; border: 2px solid rgba(160,108,56,0.85);
  background: #0b0908; box-shadow: 0 18px 60px rgba(0,0,0,0.6); pointer-events: auto; }
.zw-watch-player.visible { display: flex; }
.zw-watch-player-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; background: linear-gradient(180deg, rgba(40,28,20,0.98), rgba(26,18,14,0.98)); }
.zw-watch-player-title { flex: 1; min-width: 0; font: 600 13px "Segoe UI", system-ui, sans-serif; color: #f4e3c1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zw-watch-player-bar a.zw-button { text-decoration: none; }
.zw-watch-player-bar .zw-button { padding: 4px 10px; font-size: 12px; }
.zw-watch-player-frame { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; }
.zw-watch-player-iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
@media (max-width: 720px) { .zw-watch-player-forget { display: none; } }
`;
  document.head.appendChild(style);
}
