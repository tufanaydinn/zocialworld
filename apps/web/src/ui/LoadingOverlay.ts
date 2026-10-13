import type { AssetManager } from "../assets/AssetManager.ts";
import { HAS_BRAND_ART, brandBackground } from "./brand.ts";

/**
 * Full-screen "entering the district" veil shown while GLB dressing
 * streams in and shaders compile, so the first seconds don't look like a
 * half-built, stuttering world. Purely visual: it never captures input
 * (pointer-events: none) and fades out when `finish()` is called.
 */
export class LoadingOverlay {
  private readonly element: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private readonly unsubscribe: () => void;
  private readonly seen = new Set<string>();
  private readonly done = new Set<string>();

  constructor(container: HTMLElement, assets: AssetManager) {
    this.element = document.createElement("div");
    this.element.className = "zw-loading";
    this.element.innerHTML = `<div class="zw-loading-card">${HAS_BRAND_ART ? `<img class="zw-loading-logo" src="/brand/logo.webp" alt="Zocial World">` : ""}<div class="zw-loading-ring"></div><div class="zw-loading-title">Entering Zocial World…</div><div class="zw-loading-detail"></div></div>`;
    this.detail = this.element.querySelector(".zw-loading-detail") as HTMLDivElement;
    container.appendChild(this.element);
    injectStyles();
    this.unsubscribe = assets.onProgress((progress) => {
      this.seen.add(progress.url);
      if (progress.totalBytes > 0 && progress.loadedBytes >= progress.totalBytes) this.done.add(progress.url);
      this.detail.textContent = `${this.done.size} / ${this.seen.size} assets`;
    });
  }

  finish(): void {
    this.unsubscribe();
    this.detail.textContent = "Ready";
    this.element.classList.add("done");
    window.setTimeout(() => this.element.remove(), 700);
  }
}

let injected = false;
function injectStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-loading { position: absolute; inset: 0; z-index: 30; display: grid; place-items: center; pointer-events: none;
  background: radial-gradient(ellipse at 50% 50%, rgba(14,10,30,0.35), rgba(10,8,22,0.8)), #1a1430${brandBackground("backdrop.webp")};
  transition: opacity 0.6s ease; }
.zw-loading-logo { height: clamp(110px, 26vh, 240px); width: auto; filter: drop-shadow(0 10px 24px rgba(0,0,0,0.55)); }
.zw-loading.done { opacity: 0; }
.zw-loading-card { display: flex; flex-direction: column; align-items: center; gap: 12px; color: #f4e3c1; font-family: Georgia, "Times New Roman", serif; }
.zw-loading-ring { width: 46px; height: 46px; border-radius: 50%; border: 4px solid rgba(242,180,64,0.25); border-top-color: #f2b440; animation: zw-spin 0.9s linear infinite; }
.zw-loading-title { font-size: 22px; letter-spacing: 0.02em; }
.zw-loading-detail { font: 600 12px "Segoe UI", system-ui, sans-serif; color: #c9b8d8; }
@keyframes zw-spin { to { transform: rotate(360deg); } }
`;
  document.head.appendChild(style);
}
