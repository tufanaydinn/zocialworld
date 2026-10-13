import { injectUiStyles } from "./styles.ts";
import type { PortalDestination } from "../world/destinations.ts";

/**
 * Portal destination menu: opened from the portal gate (E). Available
 * destinations teleport the player; announced future locations are shown
 * as "coming soon" so players see where the world is heading.
 */
export class PortalPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly veil: HTMLDivElement;

  constructor(container: HTMLElement, destinations: readonly PortalDestination[], onTravel: (destination: PortalDestination) => void) {
    injectUiStyles();
    injectPortalStyles();
    this.backdrop = el("div", "zw-ui zw-portal-backdrop");
    const panel = el("div", "zw-panel zw-portal");
    const header = el("div", "zw-portal-header");
    const titles = el("div");
    const title = el("div", "zw-portal-title");
    title.textContent = "Portal";
    const subtitle = el("div", "zw-portal-subtitle");
    subtitle.textContent = "Step through the gate to travel.";
    titles.append(title, subtitle);
    const close = el("button", "zw-button");
    close.textContent = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    header.append(titles, close);

    const list = el("div", "zw-portal-list");
    // Door-only destinations (e.g. the Watch Hall's exit) are not offered here.
    const listed = destinations.filter((destination) => destination.listed !== false);
    const available = listed.filter((destination) => destination.available);
    const upcoming = listed.filter((destination) => !destination.available);
    for (const destination of available) {
      const card = el("button", "zw-portal-card");
      card.dataset.destination = destination.id;
      card.append(icon(destination.icon), text(destination.name, destination.description), badge("Travel", "zw-portal-go"));
      card.addEventListener("click", () => {
        this.close();
        onTravel(destination);
      });
      list.appendChild(card);
    }
    const soon = el("div", "zw-portal-section");
    soon.textContent = "Coming soon";
    list.appendChild(soon);
    for (const destination of upcoming) {
      const card = el("div", "zw-portal-card zw-portal-locked");
      card.dataset.destination = destination.id;
      card.append(icon(destination.icon), text(destination.name, destination.description), badge("Soon", "zw-portal-soon"));
      list.appendChild(card);
    }

    panel.append(header, list);
    this.backdrop.appendChild(panel);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });
    this.veil = el("div", "zw-portal-veil");
    container.append(this.backdrop, this.veil);
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  open(): void {
    document.exitPointerLock();
    this.backdrop.classList.add("visible");
  }

  close(): void {
    this.backdrop.classList.remove("visible");
  }

  /** Flash of portal light: fades in, runs `atPeak` (the actual move) hidden behind it, then fades out. */
  playTravelVeil(atPeak: () => void): void {
    this.veil.classList.add("active");
    window.setTimeout(() => {
      atPeak();
      window.setTimeout(() => this.veil.classList.remove("active"), 120);
    }, 260);
  }

  dispose(): void {
    this.backdrop.remove();
    this.veil.remove();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function icon(glyph: string): HTMLElement {
  const element = el("div", "zw-portal-icon");
  element.textContent = glyph;
  return element;
}

function text(name: string, description: string): HTMLElement {
  const wrapper = el("div", "zw-portal-text");
  const title = el("div", "zw-portal-name");
  title.textContent = name;
  const meta = el("div", "zw-portal-desc");
  meta.textContent = description;
  wrapper.append(title, meta);
  return wrapper;
}

function badge(label: string, className: string): HTMLElement {
  const element = el("span", `zw-portal-badge ${className}`);
  element.textContent = label;
  return element;
}

let stylesInjected = false;
function injectPortalStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-portal-backdrop { position: absolute; inset: 0; z-index: 20; display: none; align-items: center; justify-content: center; background: radial-gradient(circle at 50% 45%, rgba(255,190,110,0.18), rgba(8,6,16,0.7) 60%); }
.zw-portal-backdrop.visible { display: flex; }
.zw-portal { width: min(620px, 94vw); max-height: 88vh; display: flex; flex-direction: column; padding: 0; overflow: hidden;
  background: linear-gradient(180deg, rgba(34,30,66,0.97), rgba(20,16,38,0.97)); border: 2px solid rgba(231,183,90,0.85); box-shadow: 0 0 60px rgba(255,190,110,0.25); }
.zw-portal-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid rgba(231,183,90,0.35); }
.zw-portal-title { font: 700 24px Georgia, "Times New Roman", serif; color: #f6e3b4; }
.zw-portal-subtitle { font-size: 13px; color: #c9bce0; margin-top: 2px; }
.zw-portal-list { overflow-y: auto; padding: 14px 18px 18px; display: flex; flex-direction: column; gap: 8px; }
.zw-portal-section { margin: 10px 2px 2px; font: 700 12px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: #e7b75a; }
.zw-portal-card { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 12px; text-align: left; font: inherit; color: #f1e9dd;
  background: rgba(10,8,22,0.5); border: 1px solid rgba(231,183,90,0.22); cursor: pointer; }
button.zw-portal-card:hover { border-color: rgba(255,200,110,0.85); background: rgba(60,44,30,0.65); box-shadow: 0 0 18px rgba(255,190,110,0.2); }
.zw-portal-locked { opacity: 0.62; cursor: default; }
.zw-portal-icon { flex: none; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 22px;
  background: radial-gradient(circle, rgba(255,214,140,0.35), rgba(60,44,110,0.6)); border: 1px solid rgba(231,183,90,0.6); color: #ffe2a8; }
.zw-portal-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.zw-portal-name { font-weight: 700; font-size: 15px; }
.zw-portal-desc { font-size: 12px; color: #c4b8d8; line-height: 1.4; }
.zw-portal-badge { flex: none; padding: 5px 12px; border-radius: 999px; font: 700 12px "Segoe UI", system-ui, sans-serif; }
.zw-portal-go { background: #e7b75a; color: #24170b; }
.zw-portal-soon { background: rgba(255,255,255,0.08); color: #d9cdee; border: 1px solid rgba(255,255,255,0.18); }
.zw-portal-veil { position: absolute; inset: 0; z-index: 30; pointer-events: none; opacity: 0; transition: opacity 0.7s ease-out;
  background: radial-gradient(circle at 50% 50%, rgba(255,246,220,1), rgba(255,200,120,0.95) 45%, rgba(150,110,220,0.9)); }
.zw-portal-veil.active { opacity: 1; transition: opacity 0.26s ease-in; }
`;
  document.head.appendChild(style);
}
