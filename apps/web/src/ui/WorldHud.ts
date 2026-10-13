import type { MinimapData } from "./minimapTypes.ts";
import { injectUiStyles } from "./styles.ts";
import { drawDial, drawFullMap, paintMapSheet, type MapSheet } from "./MinimapRenderer.ts";
import { ChatPanel } from "./ChatPanel.ts";

/**
 * World HUD shell — the screen's chrome:
 *
 *  - top-right: in-world clock + circular minimap (rotates with the camera),
 *  - under it: the current location/zone label,
 *  - bottom-center: action bar (Talk · Projects · Community · Watch · Wallet · Map · Inventory · Profile),
 *  - bottom-left: live text chat (ChatPanel: General / Nearby / Hall / Whispers),
 *  - overlays: full district map, inventory and profile shells.
 *
 * Chat is live (App wires `chat` to the network). The
 * profile shell shows only the public nickname — never wallet data
 * (docs/privacy/PRIVACY_MODEL.md: social and financial identity stay separate).
 */

export interface WorldHudCallbacks {
  readonly onOpenProjects: () => void;
  /** Opens one project's detail view (where the real support flow lives). */
  readonly onOpenProject: (projectId: string) => void;
  /** Opens the Community Hub (ZecHub bounties & wiki, forum, open source). */
  readonly onOpenCommunity: () => void;
  /** Opens the player's own wallet panel. */
  readonly onOpenWallet?: () => void;
  /** Opens the Watch panel: live, schedule and replays. */
  readonly onOpenWatch?: () => void;
  /** ADR-015: Profile → "Change character" (wallet holders only). */
  readonly onChangeCharacter?: () => void;
  /** ADR-015: Profile → "Change name" (wallet holders only). */
  readonly onChangeName?: () => void;
  /** ADR-015: Profile → "Connect a wallet" (guests). */
  readonly onConnectWallet?: () => void;
  /** ADR-019: Profile → "Moderator sign-in" (the same key field as the Watch Hall host key). */
  readonly onModeratorSignIn?: () => void;
  /** The action bar's Moderation button and Profile → "Open the Moderation panel" (moderators only). */
  readonly onOpenModeration?: () => void;
}

export interface FeaturedProjectCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly hue: number;
}

/** Player within this many meters of the featured board/booth row → the Featured Projects card stack slides in. */
const FEATURED_PANEL_RADIUS = 11;

type ShellId = "map" | "inventory" | "profile";

const ICONS: Record<string, string> = {
  talk: '<path d="M4 5h16v10H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  projects: '<path d="M6 3h9l4 4v14H6z M15 3v4h4 M9 11h7 M9 15h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  community: '<path d="M4 6h16v9H8l-4 4z M8 10h8 M8 13h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="18" cy="5" r="3" fill="currentColor"/>',
  watch: '<rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 8l5 2.5-5 2.5z" fill="currentColor"/><path d="M8 21h8 M12 17v4" fill="none" stroke="currentColor" stroke-width="2"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 12h5 M3 9h18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.5" cy="12" r="1.2" fill="currentColor"/>',
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z M9 4v14 M15 6v14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  inventory: '<path d="M5 8h14l-1 12H6z M9 8V6a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  profile: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c1-5 15-5 16 0" fill="none" stroke="currentColor" stroke-width="2"/>',
  moderation: '<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2"/>',
};

export class WorldHud {
  private readonly root: HTMLDivElement;
  private readonly minimapCanvas: HTMLCanvasElement;
  private readonly clockElement: HTMLDivElement;
  private readonly locationElement: HTMLDivElement;
  /** Live text chat — App wires it to the network. */
  readonly chat: ChatPanel;
  private readonly overlay: HTMLDivElement;
  private readonly overlayBody: HTMLDivElement;
  private readonly overlayTitle: HTMLHeadingElement;
  private mapData: MinimapData | null;
  private nickname = "";
  private activeShell: ShellId | null = null;
  private clockTimer = 0;
  private minimapTimer = 1;
  private readonly startedAt = performance.now();
  private lastLocation = "";
  private readonly featuredPanel: HTMLDivElement;
  private featuredAnchor: { x: number; z: number } | null = null;
  /** The action bar's Moderation button (moderators only) and its count of new reports. */
  private readonly moderationButton: HTMLButtonElement;
  private readonly moderationBadge: HTMLSpanElement;
  private moderator = false;

  constructor(container: HTMLElement, mapData: MinimapData | null, callbacks: WorldHudCallbacks) {
    injectUiStyles();
    injectWorldHudStyles();
    this.mapData = mapData;

    this.root = document.createElement("div");
    this.root.className = "zw-ui zw-world-hud";
    container.appendChild(this.root);

    // --- top-right: clock + minimap + location
    const mapCluster = el("div", "zw-map-cluster");
    this.clockElement = el("div", "zw-panel zw-clock");
    this.minimapCanvas = document.createElement("canvas");
    this.minimapCanvas.className = "zw-minimap";
    this.minimapCanvas.width = 400;
    this.minimapCanvas.height = 400;
    this.minimapCanvas.title = "Open map";
    this.minimapCanvas.addEventListener("click", () => this.toggleShell("map"));
    this.locationElement = el("div", "zw-panel zw-zone-label");
    mapCluster.append(this.clockElement, this.minimapCanvas, this.locationElement);
    this.root.appendChild(mapCluster);
    if (!mapData) this.minimapCanvas.style.display = "none";

    // --- bottom-left: chat
    this.chat = new ChatPanel();
    this.root.appendChild(this.chat.element);

    // --- bottom-center: action bar
    const bar = el("div", "zw-panel zw-action-bar");
    const actions: [string, string, () => void][] = [
      ["talk", "Talk", () => this.chat.focus()],
      ["projects", "Projects", () => callbacks.onOpenProjects()],
      ["community", "Community", () => callbacks.onOpenCommunity()],
      ["watch", "Watch", () => callbacks.onOpenWatch?.()],
      ["wallet", "Wallet", () => callbacks.onOpenWallet?.()],
      ["map", "Map", () => this.toggleShell("map")],
      ["inventory", "Inventory", () => this.toggleShell("inventory")],
      ["profile", "Profile", () => this.toggleShell("profile")],
    ];
    for (const [icon, label, handler] of actions) {
      const button = el("button", "zw-action");
      button.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24">${ICONS[icon]}</svg><span>${label}</span>`;
      button.addEventListener("click", () => {
        document.exitPointerLock();
        button.blur(); // don't leave keyboard focus on the bar (E/Esc belong to the world)
        handler();
      });
      bar.appendChild(button);
    }
    // Shown only while this session is a moderator; the badge counts reports not seen yet.
    this.moderationButton = el("button", "zw-action zw-action-moderation");
    this.moderationButton.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24">${ICONS.moderation}</svg><span>Moderation</span>`;
    this.moderationBadge = el("span", "zw-action-badge");
    this.moderationBadge.hidden = true;
    this.moderationButton.appendChild(this.moderationBadge);
    this.moderationButton.hidden = true;
    this.moderationButton.addEventListener("click", () => {
      document.exitPointerLock();
      this.moderationButton.blur();
      callbacks.onOpenModeration?.();
    });
    bar.appendChild(this.moderationButton);
    this.root.appendChild(bar);

    // --- shell overlay (map / inventory / profile)
    this.overlay = el("div", "zw-shell-backdrop");
    const panel = el("div", "zw-panel zw-shell");
    this.overlayTitle = document.createElement("h2");
    this.overlayBody = el("div", "zw-shell-body");
    const close = el("button", "zw-button zw-shell-close");
    close.textContent = "Close (Esc)";
    close.addEventListener("click", () => this.closeShell());
    panel.append(this.overlayTitle, this.overlayBody, close);
    this.overlay.appendChild(panel);
    this.overlay.addEventListener("click", (event) => {
      if (event.target === this.overlay) this.closeShell();
    });
    this.root.appendChild(this.overlay);

    // --- right: Featured Projects card stack, shown near the district's project row
    this.featuredPanel = el("div", "zw-panel zw-featured");
    this.root.appendChild(this.featuredPanel);
    this.callbacks = callbacks;

    this.updateClock();
  }

  private readonly callbacks: WorldHudCallbacks;

  /** Cards come from the project registry; `anchor` is where the panel becomes relevant (the project board). */
  setFeaturedProjects(cards: readonly FeaturedProjectCard[], anchor: { x: number; z: number }): void {
    this.featuredAnchor = anchor;
    this.featuredPanel.replaceChildren();
    const title = el("div", "zw-featured-title");
    title.textContent = "Featured Projects";
    this.featuredPanel.appendChild(title);
    for (const card of cards.slice(0, 3)) {
      const row = el("div", "zw-featured-card");
      const art = el("div", "zw-featured-art");
      art.style.background = `linear-gradient(135deg, hsl(${card.hue} 60% 55%), hsl(${(card.hue + 50) % 360} 55% 22%))`;
      const body = el("div", "zw-featured-body");
      const name = el("div", "zw-featured-name");
      name.textContent = card.name;
      const description = el("div", "zw-featured-desc");
      description.textContent = card.description;
      const actions = el("div", "zw-featured-actions");
      const view = el("button", "zw-button");
      view.textContent = "View Project";
      view.addEventListener("click", () => this.callbacks.onOpenProject(card.id));
      const support = el("button", "zw-button zw-button-primary");
      support.textContent = "Support with ZEC";
      support.title = "Opens the project page — support uses shielded ZEC and never shows your wallet to other players.";
      support.addEventListener("click", () => this.callbacks.onOpenProject(card.id));
      actions.append(view, support);
      body.append(name, description, actions);
      row.append(art, body);
      this.featuredPanel.appendChild(row);
    }
  }

  get isShellOpen(): boolean {
    return this.activeShell !== null;
  }

  setNickname(nickname: string): void {
    this.nickname = nickname;
    if (this.activeShell === "profile") this.renderShell("profile");
  }

  /** ADR-015: wallet holder or guest (server-confirmed) and the avatar colour, for the Profile panel. */
  setProfile(profile: { holder: boolean; accentColor: string }): void {
    this.profile = { ...profile };
    if (this.activeShell === "profile") this.renderShell("profile");
  }

  private profile: { holder: boolean; accentColor: string } = { holder: false, accentColor: "#6b4fa0" };

  /** This session is a moderator (the Moderation button and the Profile entries), with `unseen` new reports. */
  setModerator(moderator: boolean, unseen = 0): void {
    const changed = moderator !== this.moderator;
    this.moderator = moderator;
    this.moderationButton.hidden = !moderator;
    this.moderationBadge.hidden = !moderator || unseen === 0;
    this.moderationBadge.textContent = unseen > 99 ? "99+" : String(unseen);
    this.moderationButton.title = unseen > 0 ? `Moderation — ${unseen} new report${unseen === 1 ? "" : "s"}` : "Moderation";
    if (changed && this.activeShell === "profile") this.renderShell("profile");
  }

  closeShell(): void {
    this.activeShell = null;
    this.overlay.classList.remove("visible");
  }

  /** Per-frame: minimap (player at center, map rotated so camera-forward is up) + zone label + clock. */
  update(deltaSeconds: number, playerX: number, playerZ: number, playerYaw: number, cameraYaw: number): void {
    this.clockTimer += deltaSeconds;
    if (this.clockTimer > 10) {
      this.clockTimer = 0;
      this.updateClock();
    }
    if (this.featuredAnchor) {
      const near = Math.hypot(playerX - this.featuredAnchor.x, playerZ - this.featuredAnchor.z) < FEATURED_PANEL_RADIUS;
      this.featuredPanel.classList.toggle("visible", near);
    }
    if (!this.mapData) return;
    // 30 Hz is plenty for a minimap and halves its canvas cost.
    this.minimapTimer += deltaSeconds;
    if (this.minimapTimer >= 1 / 30) {
      this.minimapTimer = 0;
      this.drawMinimap(playerX, playerZ, playerYaw, cameraYaw);
    }
    const region = this.mapData.regions.find((candidate) => Math.hypot(candidate.x - playerX, candidate.z - playerZ) <= candidate.radius);
    const location = region ? region.name : this.mapData.title;
    if (location !== this.lastLocation) {
      this.lastLocation = location;
      this.locationElement.textContent = location;
    }
  }

  dispose(): void {
    this.chat.dispose();
    this.root.remove();
  }

  /** In-world dusk clock: starts at 19:24 and advances one world minute per real minute, staying within the evening. */
  private updateClock(): void {
    const minutes = 19 * 60 + 24 + Math.floor((performance.now() - this.startedAt) / 60000);
    const wrapped = 19 * 60 + ((minutes - 19 * 60) % 120);
    this.clockElement.textContent = `☾ ${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
    this.clockElement.title = "World time (the district is always at dusk)";
  }

  private toggleShell(id: ShellId): void {
    if (this.activeShell === id) {
      this.closeShell();
      return;
    }
    this.activeShell = id;
    this.renderShell(id);
    this.overlay.classList.add("visible");
  }

  private renderShell(id: ShellId): void {
    this.overlayBody.replaceChildren();
    if (id === "map") {
      this.overlayTitle.textContent = this.mapData?.title ?? "Map";
      const canvas = document.createElement("canvas");
      canvas.className = "zw-shell-map";
      canvas.width = 900;
      canvas.height = 680;
      this.overlayBody.appendChild(canvas);
      if (this.mapData) {
        this.mapSheet ??= paintMapSheet(this.mapData);
        drawFullMap(canvas, this.mapSheet, this.mapData, this.lastPlayer);
      }
    } else if (id === "inventory") {
      this.overlayTitle.textContent = "Inventory";
      const grid = el("div", "zw-inventory-grid");
      for (let i = 0; i < 24; i++) grid.appendChild(el("div", "zw-inventory-slot"));
      const note = el("p", "zw-modal-subtitle");
      note.textContent = "Cosmetics and collectibles arrive in a later update. Nothing here is linked to a wallet.";
      this.overlayBody.append(grid, note);
    } else {
      this.overlayTitle.textContent = "Profile";
      const card = el("div", "zw-profile-card");
      const avatar = el("div", "zw-profile-avatar");
      avatar.textContent = (this.nickname || "?").slice(0, 1).toUpperCase();
      avatar.style.background = this.profile.accentColor;
      const name = el("div", "zw-profile-name");
      name.textContent = this.nickname || "Guest";
      const kind = el("div", "zw-profile-kind");
      kind.textContent = this.profile.holder ? "Wallet holder · can receive ZEC privately" : "Guest · explore, chat, listen and learn";
      const names = el("div", "");
      names.append(name, kind);
      const note = el("p", "zw-modal-subtitle");
      note.textContent = this.profile.holder
        ? "Your public profile is your nickname and character. Other players only learn that you can receive ZEC privately — never your address, balance or history."
        : "Guests get a Guest-#### name and the default character. Connect a wallet to choose your own name and character, talk in voice, and send or receive ZEC privately.";
      card.append(avatar, names);
      // ADR-015: holders change character and name here; guests are offered a wallet.
      const actions = el("div", "zw-profile-actions");
      const action = (label: string, handler: (() => void) | undefined, primary = false): void => {
        const button = el("button", `zw-button${primary ? " zw-button-primary" : ""}`);
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          this.closeShell();
          handler?.();
        });
        actions.appendChild(button);
      };
      if (this.profile.holder) {
        action("Change character", this.callbacks.onChangeCharacter);
        action("Change name", this.callbacks.onChangeName);
      } else {
        action("Connect a wallet to choose a name and character", this.callbacks.onConnectWallet, true);
      }
      // ADR-019 § 1: moderators sign in with the operator's key — here (anywhere) or in the Watch Hall's
      // "Unlock host tools" (the same field takes both keys). The role lasts this session only.
      const moderation = el("div", "zw-profile-moderation");
      if (this.moderator) {
        const badge = el("span", "zw-moderator-tag");
        badge.textContent = "Moderator";
        const line = el("span", "zw-profile-kind");
        line.textContent = "Signed in as a moderator for this session — your nameplate shows the tag.";
        moderation.append(badge, line);
        const open = el("button", "zw-button");
        open.type = "button";
        open.textContent = "Open the Moderation panel";
        open.addEventListener("click", () => {
          this.closeShell();
          this.callbacks.onOpenModeration?.();
        });
        moderation.appendChild(open);
      } else if (this.callbacks.onModeratorSignIn) {
        const signIn = el("button", "zw-button zw-profile-moderator-signin");
        signIn.type = "button";
        signIn.textContent = "Moderator sign-in";
        signIn.title = "For moderators the operator gave a key to";
        signIn.addEventListener("click", () => {
          this.closeShell();
          this.callbacks.onModeratorSignIn?.();
        });
        moderation.appendChild(signIn);
      }
      this.overlayBody.append(card, actions, note, moderation);
    }
  }

  private lastPlayer = { x: 0, z: 0 };

  private drawMinimap(px: number, pz: number, playerYaw: number, cameraYaw: number): void {
    this.lastPlayer = { x: px, z: pz };
    if (!this.mapSheet) this.mapSheet = paintMapSheet(this.mapData!);
    drawDial(this.minimapCanvas, this.mapSheet, this.mapData!, { playerX: px, playerZ: pz, playerYaw, cameraYaw });
  }

  private mapSheet: MapSheet | null = null;

  /** Swaps the map (e.g. after travelling to another location); the painted sheet is rebuilt lazily. */
  setMapData(mapData: MinimapData | null): void {
    if (mapData === this.mapData) return;
    this.mapData = mapData;
    this.mapSheet = null;
    this.minimapCanvas.style.display = mapData ? "" : "none";
  }
}


function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

let stylesInjected = false;

function injectWorldHudStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-world-hud { position: absolute; inset: 0; pointer-events: none; }
.zw-world-hud > * { pointer-events: auto; }
.zw-map-cluster { position: absolute; top: 12px; right: 12px; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; }
.zw-map-cluster > * { pointer-events: auto; }
.zw-clock { align-self: flex-end; padding: 4px 10px; font-size: 13px; font-weight: 600; }
.zw-minimap { width: 200px; height: 200px; border-radius: 50%; cursor: pointer; filter: drop-shadow(0 6px 14px rgba(0,0,0,0.55)); }
.zw-zone-label { padding: 4px 12px; font-size: 12px; color: #f3d9a6; letter-spacing: 0.04em; text-transform: uppercase; }
.zw-chat { position: absolute; left: 12px; bottom: 62px; width: min(380px, 42vw); display: flex; flex-direction: column; background: rgba(12,12,20,0.72); }
.zw-chat-tabs { display: flex; gap: 2px; padding: 6px 6px 0; }
.zw-chat-tab { background: rgba(255,255,255,0.06); color: #cfc6b8; border: 0; border-radius: 6px 6px 0 0; padding: 5px 12px; font: 600 12px "Segoe UI", system-ui, sans-serif; cursor: pointer; }
.zw-chat-tab.active { background: rgba(201,138,60,0.28); color: #fff3dc; }
.zw-chat-line { overflow-wrap: anywhere; }
.zw-chat-time { color: #8c8399; font-size: 11px; margin-right: 6px; }
.zw-chat-name { all: unset; cursor: pointer; font-weight: 700; color: #f2c879; margin-right: 6px; }
.zw-chat-name:hover { text-decoration: underline; } .zw-chat-name:disabled { cursor: default; text-decoration: none; }
.zw-chat-own .zw-chat-name { color: #9fd4ff; }
.zw-chat-nearby .zw-chat-name { color: #9be8b4; }
.zw-chat-whisper .zw-chat-name, .zw-chat-whisper .zw-chat-text { color: #e6b3ff; }
.zw-chat-takeaway { margin: 2px 0; padding: 2px 6px; border-left: 3px solid #f0c35e; border-radius: 4px; background: rgba(255,200,90,0.14); }
.zw-chat-tab[hidden] { display: none; }
.zw-chat-text { color: #f1ece4; }
.zw-chat-target { all: unset; cursor: pointer; align-self: center; padding: 3px 8px; border-radius: 999px; background: rgba(200,140,255,0.22); color: #f0d9ff; font: 600 11px "Segoe UI", system-ui, sans-serif; white-space: nowrap; }
.zw-chat-log { height: 150px; overflow-y: auto; padding: 8px 10px; font-size: 13px; line-height: 1.45; border-top: 1px solid rgba(201,138,60,0.25); }
.zw-chat-system { color: #b9b0c9; font-style: italic; }
.zw-chat-form { display: flex; gap: 6px; padding: 6px; }
.zw-chat-input { flex: 1; }
.zw-chat-send { background: transparent; border: 0; color: #e8c58a; cursor: pointer; padding: 0 6px; }
.zw-action-bar { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); display: flex; gap: 4px; padding: 6px 8px; }
.zw-action { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 64px; padding: 6px 8px; background: transparent; border: 0; border-radius: 8px; color: #efe5d4; font: 600 12px "Segoe UI", system-ui, sans-serif; cursor: pointer; }
.zw-action:hover { background: rgba(201,138,60,0.22); color: #fff; }
.zw-shell-backdrop { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(6,6,12,0.55); }
.zw-shell-backdrop.visible { display: flex; }
.zw-shell { padding: 18px 22px; max-width: min(960px, 94vw); max-height: 90vh; overflow: auto; }
.zw-shell h2 { margin: 0 0 12px; font-size: 20px; }
.zw-shell-map { width: min(900px, 88vw); height: auto; border-radius: 10px; display: block; }
.zw-shell-close { margin-top: 14px; }
.zw-inventory-grid { display: grid; grid-template-columns: repeat(6, 64px); gap: 8px; }
.zw-inventory-slot { width: 64px; height: 64px; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid rgba(201,138,60,0.25); }
.zw-profile-card { display: flex; align-items: center; gap: 14px; }
.zw-profile-avatar { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: #6b4fa0; font-size: 26px; font-weight: 700; }
.zw-profile-name { font-size: 20px; font-weight: 700; }
.zw-profile-kind { font-size: 12px; color: #c9bfae; margin-top: 2px; }
.zw-profile-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.zw-profile-moderation { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(201,138,60,0.2); }
.zw-profile-moderator-signin { background: transparent; border-color: rgba(255,255,255,0.14); color: #c9bfae; font-size: 11px; }
.zw-moderator-tag { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #2f6fb0; color: #fff; font: 700 10px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; }
.zw-action-moderation { position: relative; color: #b9d6ff; }
.zw-action-moderation[hidden] { display: none; }
.zw-action-badge { position: absolute; top: 2px; right: 8px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #d9483b; color: #fff; font: 700 10px/16px "Segoe UI", system-ui, sans-serif; text-align: center; }
.zw-action-badge[hidden] { display: none; }
.zw-chat-muted .zw-chat-input { border-color: rgba(255,120,100,0.55); }
.zw-featured { position: absolute; right: 12px; top: 468px; max-height: calc(100% - 520px); overflow-y: auto; width: 330px; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: linear-gradient(180deg, rgba(58,38,22,0.92), rgba(36,24,14,0.92)); border: 2px solid rgba(140,92,48,0.9); opacity: 0; transform: translateX(24px); transition: opacity 0.25s ease, transform 0.25s ease; pointer-events: none; }
.zw-featured.visible { opacity: 1; transform: none; pointer-events: auto; }
.zw-featured-title { font: 700 20px Georgia, "Times New Roman", serif; color: #f4e3c1; }
.zw-featured-card { display: flex; gap: 10px; padding: 8px; border-radius: 10px; background: rgba(15,10,6,0.6); }
.zw-featured-art { width: 64px; height: 64px; flex: none; border-radius: 8px; }
.zw-featured-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.zw-featured-name { font-weight: 700; font-size: 15px; }
.zw-featured-desc { font-size: 12px; color: #d8c7a8; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.zw-featured-actions { display: flex; gap: 6px; margin-top: 2px; }
.zw-featured-actions .zw-button { padding: 4px 8px; font-size: 11px; }
/* Re-home existing widgets around the new HUD: voice bottom-left under chat, interaction prompt just above the action bar. */
.zw-interaction-prompt { bottom: 96px; }
/* Modals (project panel, player card) always sit above the HUD shell. */
.zw-modal-backdrop, .zw-player-card-backdrop { z-index: 20; }
.zw-shell-backdrop { z-index: 15; }
.zw-location-label { display: none; }
/* Short viewports: the dial is 400 px tall in practice ("#app canvas" sizes it to its
   400-px backing store), which on a laptop-height window leaves no room under it for the right column
   (the Watch Hall's stage panel). Shrink it there; "#app" outranks that rule. */
@media (max-height: 760px) {
  #app .zw-minimap { width: 240px; height: 240px; }
}
/* At 1280–1440 px the bar is narrower so the connected voice panel (bottom-left) never runs under it. */
@media (max-width: 1440px) {
  .zw-action { min-width: 56px; padding: 6px 5px; }
}
@media (max-width: 720px) {
  .zw-chat { display: none; }
  .zw-featured { display: none; }
  .zw-minimap { width: 120px; height: 120px; }
  .zw-action { min-width: 48px; font-size: 10px; }
}
`;
  document.head.appendChild(style);
}
