import * as THREE from "three";
import type { HallReaction } from "@project/shared";
import { drawEmblem, seededRandom } from "../district/textures.ts";
import { getContentBaseUrl } from "../../community/config.ts";
import type { DiscussionBoardApi, DiscussionLine, LiveNowBoardApi, LiveNowEntry, SpeakerCardBoardApi, SpeakerCardState } from "./contract.ts";

/**
 * The Watch Hall's functional canvas faces: the Live Now and Discussion
 * Corner boards, the speaker-card strip, the screen's idle face and its LIVE
 * pill. Any hall builder mounts them; the board systems feed them through the
 * `contract.ts` interfaces.
 *
 * Everything is drawn with Canvas2D in code (no image files, no web fonts).
 * Live faces follow the LiveBoard conventions: Georgia titles, a wood
 * gradient, cream text and gold accents, shown on an unlit material at
 * brightness 0.8 (see `hallTextMaterial`). They redraw only when their data
 * changes, at most once a second.
 */

/** Font stacks of the hall faces (system fonts only). */
export const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Segoe UI', system-ui, sans-serif";
const CREAM = "#fbecd2";
const GOLD = "#e3ad4c";
const TAN = "#e8c98a";

/** An sRGB canvas texture, optionally tiling. */
export function canvasTexture(canvas: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** A canvas of the given size and its 2D context. */
export function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return [canvas, canvas.getContext("2d")!];
}

/**
 * Unlit face for text and pictures (boards, signs, the screen): brightness ≤ 0.8 keeps glyphs under the bloom
 * threshold (0.82) so they stay crisp, fog off so the far boards don't wash out, max anisotropy for angled views.
 */
export function hallTextMaterial(texture: THREE.Texture, brightness = 0.8): THREE.MeshBasicMaterial {
  texture.anisotropy = 16;
  return new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(brightness, brightness, brightness), fog: false });
}

/** Coalesces redraw requests: at most one draw per `intervalMs` (boards change at most about once a second). */
function throttled(draw: () => void, intervalMs = 1000): () => void {
  let pending = false;
  let last = -Infinity;
  return () => {
    if (pending) return;
    pending = true;
    window.setTimeout(() => {
      pending = false;
      last = performance.now();
      draw();
    }, Math.max(0, last + intervalMs - performance.now()));
  };
}

function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && context.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

/** Dark wood board background with plank seams and a gold double frame. */
function woodPanel(context: CanvasRenderingContext2D, width: number, height: number, seam = 124): void {
  const wood = context.createLinearGradient(0, 0, 0, height);
  wood.addColorStop(0, "#4a2f1b");
  wood.addColorStop(1, "#2a1a0f");
  context.fillStyle = wood;
  context.fillRect(0, 0, width, height);
  const random = seededRandom(width + height);
  for (let i = 0; i < 70; i++) {
    context.strokeStyle = `rgba(20,10,4,${0.06 + random() * 0.08})`;
    context.lineWidth = 1 + random() * 2;
    const y = random() * height;
    context.beginPath();
    context.moveTo(0, y);
    context.bezierCurveTo(width * 0.3, y + (random() - 0.5) * 14, width * 0.7, y + (random() - 0.5) * 14, width, y);
    context.stroke();
  }
  context.fillStyle = "rgba(0,0,0,0.2)";
  for (let y = seam; y < height; y += seam) context.fillRect(0, y, width, 3);
  context.strokeStyle = "#d9a441";
  context.lineWidth = 10;
  context.strokeRect(12, 12, width - 24, height - 24);
  context.lineWidth = 3;
  context.strokeRect(30, 30, width - 60, height - 60);
}

// ---------------------------------------------------------------- pictograms

/** Film camera pictogram (the Live Now header; signs reuse it). */
export function drawCameraIcon(context: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  const s = size / 2;
  context.save();
  context.translate(cx, cy);
  context.fillStyle = color;
  context.beginPath();
  context.arc(-s * 0.42, -s * 0.5, s * 0.34, 0, Math.PI * 2);
  context.arc(s * 0.2, -s * 0.56, s * 0.4, 0, Math.PI * 2);
  context.fill();
  roundRect(context, -s * 0.85, -s * 0.18, s * 1.3, s * 0.82, s * 0.12);
  context.fill();
  context.beginPath();
  context.moveTo(s * 0.45, s * 0.05);
  context.lineTo(s * 0.95, -s * 0.2);
  context.lineTo(s * 0.95, s * 0.68);
  context.lineTo(s * 0.45, s * 0.42);
  context.closePath();
  context.fill();
  context.restore();
}

function drawBubbleIcon(context: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  const s = size / 2;
  context.save();
  context.translate(cx, cy);
  context.fillStyle = color;
  roundRect(context, -s * 0.9, -s * 0.7, s * 1.8, s * 1.15, s * 0.35);
  context.fill();
  context.beginPath();
  context.moveTo(-s * 0.45, s * 0.35);
  context.lineTo(-s * 0.7, s * 0.85);
  context.lineTo(-s * 0.05, s * 0.4);
  context.fill();
  context.fillStyle = "rgba(0,0,0,0.35)";
  for (const x of [-0.45, 0, 0.45]) {
    context.beginPath();
    context.arc(x * s, -s * 0.12, s * 0.12, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawPeopleIcon(context: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string, count = 2): void {
  const s = size / 2;
  context.save();
  context.translate(cx, cy);
  context.fillStyle = color;
  const people = count === 3 ? [-0.55, 0.55, 0] : count === 2 ? [-0.32, 0.32] : [0];
  people.forEach((x, i) => {
    const scale = count === 3 && i === 2 ? 1.1 : 0.9;
    context.beginPath();
    context.arc(x * s, -s * 0.35 * scale, s * 0.28 * scale, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.ellipse(x * s, s * 0.45, s * 0.42 * scale, s * 0.42 * scale, 0, Math.PI, 0);
    context.fill();
  });
  context.restore();
}

function drawBulbIcon(context: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  const s = size / 2;
  context.save();
  context.translate(cx, cy);
  context.fillStyle = color;
  context.beginPath();
  context.arc(0, -s * 0.2, s * 0.58, Math.PI * 0.8, Math.PI * 0.2);
  context.lineTo(s * 0.26, s * 0.5);
  context.lineTo(-s * 0.26, s * 0.5);
  context.closePath();
  context.fill();
  context.fillRect(-s * 0.24, s * 0.58, s * 0.48, s * 0.14);
  context.fillRect(-s * 0.18, s * 0.78, s * 0.36, s * 0.12);
  context.restore();
}

function drawEyeIcon(context: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  const s = size / 2;
  context.save();
  context.translate(cx, cy);
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(-s, 0);
  context.quadraticCurveTo(0, -s * 0.95, s, 0);
  context.quadraticCurveTo(0, s * 0.95, -s, 0);
  context.fill();
  context.fillStyle = "#2a1a0f";
  context.beginPath();
  context.arc(0, 0, s * 0.32, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/** The eight hall reactions as small vector pictograms (canvas fonts may lack colour emoji). */
export function drawReactionIcon(context: CanvasRenderingContext2D, reaction: HallReaction, cx: number, cy: number, size: number): void {
  const s = size / 2;
  context.save();
  context.translate(cx, cy);
  const face = (mouth: "laugh" | "wow"): void => {
    context.fillStyle = "#f6c142";
    context.beginPath();
    context.arc(0, 0, s * 0.9, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#4a2a0a";
    for (const x of [-0.32, 0.32]) {
      context.beginPath();
      if (mouth === "laugh") context.ellipse(x * s, -s * 0.22, s * 0.16, s * 0.08, 0, Math.PI, 0);
      else context.arc(x * s, -s * 0.22, s * 0.11, 0, Math.PI * 2);
      context.fill();
    }
    context.beginPath();
    if (mouth === "laugh") context.ellipse(0, s * 0.18, s * 0.46, s * 0.36, 0, 0, Math.PI);
    else context.ellipse(0, s * 0.32, s * 0.2, s * 0.26, 0, 0, Math.PI * 2);
    context.fill();
  };
  switch (reaction) {
    case "clap":
      context.fillStyle = "#f2c38a";
      for (const [x, angle] of [[-0.2, -0.35], [0.2, 0.35]] as const) {
        context.save();
        context.rotate(angle);
        roundRect(context, x * s - s * 0.28, -s * 0.75, s * 0.56, s * 1.35, s * 0.26);
        context.fill();
        context.restore();
      }
      context.strokeStyle = "#ffd76a";
      context.lineWidth = s * 0.12;
      for (const a of [-2.3, -1.57, -0.84]) {
        context.beginPath();
        context.moveTo(Math.cos(a) * s * 0.95, Math.sin(a) * s * 0.95);
        context.lineTo(Math.cos(a) * s * 1.2, Math.sin(a) * s * 1.2);
        context.stroke();
      }
      break;
    case "heart":
      context.fillStyle = "#e8434c";
      context.beginPath();
      context.moveTo(0, s * 0.85);
      context.bezierCurveTo(-s * 1.2, 0, -s * 0.7, -s * 1.0, 0, -s * 0.38);
      context.bezierCurveTo(s * 0.7, -s * 1.0, s * 1.2, 0, 0, s * 0.85);
      context.fill();
      break;
    case "fire":
      context.fillStyle = "#f2742a";
      context.beginPath();
      context.moveTo(0, -s);
      context.bezierCurveTo(s * 0.9, -s * 0.2, s * 0.85, s * 0.9, 0, s * 0.9);
      context.bezierCurveTo(-s * 0.85, s * 0.9, -s * 0.9, -s * 0.1, -s * 0.2, -s * 0.45);
      context.quadraticCurveTo(-s * 0.1, -s * 0.1, 0, -s);
      context.fill();
      context.fillStyle = "#ffd25a";
      context.beginPath();
      context.ellipse(0, s * 0.45, s * 0.32, s * 0.42, 0, 0, Math.PI * 2);
      context.fill();
      break;
    case "laugh":
      face("laugh");
      break;
    case "wow":
      face("wow");
      break;
    case "party":
      context.fillStyle = "#c86ee8";
      context.beginPath();
      context.moveTo(-s * 0.8, s * 0.85);
      context.lineTo(-s * 0.15, -s * 0.55);
      context.lineTo(s * 0.55, s * 0.15);
      context.closePath();
      context.fill();
      for (const [x, y, color] of [[0.35, -0.75, "#ffd25a"], [0.8, -0.3, "#5ad1ff"], [0.65, -0.85, "#ff6a8a"], [0.95, 0.2, "#7ae07a"]] as const) {
        context.fillStyle = color;
        context.fillRect(x * s - s * 0.1, y * s - s * 0.1, s * 0.2, s * 0.2);
      }
      break;
    case "zec":
      context.fillStyle = "#f3b73a";
      context.beginPath();
      context.arc(0, 0, s * 0.95, 0, Math.PI * 2);
      context.fill();
      drawEmblem(context, 0, 0, s * 1.3, "#3a250c");
      break;
    case "idea":
      drawBulbIcon(context, 0, 0, size, "#ffd25a");
      break;
  }
  context.restore();
}

/** Draws a leading pictogram for meta chips ("👥 23" → people icon + "23"), returns the remaining text. */
function metaIcon(context: CanvasRenderingContext2D, meta: string, x: number, cy: number, size: number, color: string): { text: string; width: number } {
  const match = /^(\p{Extended_Pictographic}️?)\s*/u.exec(meta);
  if (!match) return { text: meta, width: 0 };
  const glyph = match[1]!;
  if (glyph.startsWith("👁")) drawEyeIcon(context, x + size / 2, cy, size, color);
  else drawPeopleIcon(context, x + size / 2, cy, size, color, 2);
  return { text: meta.slice(match[0].length), width: size + 10 };
}

// ---------------------------------------------------------------- Live Now board

const KIND_STYLE: Record<LiveNowEntry["kind"], { pill: string; text: string; tint: [string, string] }> = {
  stage: { pill: "#d8323a", text: "#ffffff", tint: ["#4a2c7a", "#d06a4a"] },
  live: { pill: "#d8323a", text: "#ffffff", tint: ["#2a3a8a", "#c0506a"] },
  today: { pill: "#e39a2d", text: "#24170b", tint: ["#3a2a6a", "#e0904a"] },
  upcoming: { pill: "#5b63c8", text: "#ffffff", tint: ["#23305e", "#6a62c0"] },
  replay: { pill: "#5d6b8a", text: "#ffffff", tint: ["#2a2f4a", "#5a6a8a"] },
};

/** Only our own origins may feed an in-world image: the page and the content gateway (its media proxy). */
function isOwnImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    const own = new Set([window.location.origin, new URL(getContentBaseUrl(), window.location.href).origin]);
    return own.has(parsed.origin) && (parsed.protocol === "https:" || parsed.protocol === "http:");
  } catch {
    return false;
  }
}

/** Placeholder thumbnail: a dusk landscape tinted per kind with the emblem. */
function drawThumbPlaceholder(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, kind: LiveNowEntry["kind"]): void {
  const [top, bottom] = KIND_STYLE[kind].tint;
  const sky = context.createLinearGradient(0, y, 0, y + height);
  sky.addColorStop(0, top);
  sky.addColorStop(1, bottom);
  context.fillStyle = sky;
  context.fillRect(x, y, width, height);
  context.fillStyle = "rgba(20,14,40,0.75)";
  context.beginPath();
  context.moveTo(x, y + height);
  context.lineTo(x + width * 0.22, y + height * 0.58);
  context.lineTo(x + width * 0.4, y + height * 0.8);
  context.lineTo(x + width * 0.62, y + height * 0.48);
  context.lineTo(x + width, y + height * 0.85);
  context.lineTo(x + width, y + height);
  context.fill();
  drawEmblem(context, x + width * 0.5, y + height * 0.42, height * 0.5, "#f3c25a");
}

/** The "Live Now" board (left front corner): what is on stage, live streams and the next events, with thumbnails. */
export class LiveNowBoard implements LiveNowBoardApi {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private entries: LiveNowEntry[] = [];
  private offline: string | null = null;
  private signature = "";
  private readonly images = new Map<string, HTMLImageElement | "failed">();
  private readonly redraw = throttled(() => this.draw());

  constructor() {
    [this.canvas, this.context] = makeCanvas(1536, 996);
    this.texture = canvasTexture(this.canvas);
    this.draw();
  }

  setEntries(entries: LiveNowEntry[]): void {
    const signature = JSON.stringify(entries.slice(0, 4));
    if (signature === this.signature && this.offline === null) return;
    this.signature = signature;
    this.entries = entries.slice(0, 4);
    this.offline = null;
    for (const entry of this.entries) if (entry.thumbUrl) this.load(entry.thumbUrl);
    this.redraw();
  }

  setOffline(message = "Schedule unavailable right now — the Watch panel has replays."): void {
    if (this.offline === message) return;
    this.offline = message;
    this.signature = "";
    this.redraw();
  }

  private load(url: string): void {
    if (this.images.has(url) || !isOwnImageUrl(url)) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => this.redraw();
    image.onerror = () => {
      this.images.set(url, "failed");
    };
    this.images.set(url, image);
    image.src = url;
  }

  private draw(): void {
    const context = this.context;
    const { width, height } = this.canvas;
    woodPanel(context, width, height, 196);
    drawCameraIcon(context, 104, 96, 92, GOLD);
    context.fillStyle = CREAM;
    context.font = `700 96px ${SERIF}`;
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillText("Live Now", 178, 128);
    context.font = `600 30px ${SANS}`;
    context.fillStyle = TAN;
    context.textAlign = "right";
    context.fillText("Press E · Watch panel", width - 64, 120);
    context.textAlign = "left";

    if (this.offline !== null || this.entries.length === 0) {
      context.fillStyle = CREAM;
      context.font = `700 54px ${SANS}`;
      context.textAlign = "center";
      context.fillText(this.offline === null ? "Nothing live right now" : "Watch catalogue offline", width / 2, height / 2 - 10);
      context.font = `500 36px ${SANS}`;
      context.fillStyle = TAN;
      context.fillText(fitText(context, this.offline ?? "Replays, Zcon talks and community calls — open the Watch panel.", width - 200), width / 2, height / 2 + 52);
      context.textAlign = "left";
      this.texture.needsUpdate = true;
      return;
    }

    const rowHeight = 196;
    this.entries.forEach((entry, i) => {
      const y = 176 + i * rowHeight;
      const featured = i === 0 && (entry.kind === "stage" || entry.kind === "live");
      context.fillStyle = featured ? "rgba(255,214,140,0.16)" : "rgba(255,236,200,0.07)";
      roundRect(context, 50, y, width - 100, rowHeight - 18, 18);
      context.fill();
      if (featured) {
        context.strokeStyle = "#f0c35e";
        context.lineWidth = 5;
        context.stroke();
      }
      // Thumbnail (16:9), rounded.
      const tx = 70;
      const ty = y + 12;
      const tw = 272;
      const th = 153;
      context.save();
      roundRect(context, tx, ty, tw, th, 14);
      context.clip();
      const image = entry.thumbUrl ? this.images.get(entry.thumbUrl) : undefined;
      if (image && image !== "failed" && image.complete && image.naturalWidth > 0) {
        const scale = Math.max(tw / image.naturalWidth, th / image.naturalHeight);
        const dw = image.naturalWidth * scale;
        const dh = image.naturalHeight * scale;
        context.drawImage(image, tx + (tw - dw) / 2, ty + (th - dh) / 2, dw, dh);
      } else {
        drawThumbPlaceholder(context, tx, ty, tw, th, entry.kind);
      }
      context.restore();

      // Badge pill (top right).
      const style = KIND_STYLE[entry.kind];
      context.font = `800 30px ${SANS}`;
      const live = entry.kind === "stage" || entry.kind === "live";
      const label = entry.badge.toUpperCase();
      const pillWidth = context.measureText(label).width + (live ? 66 : 40);
      const px = width - 76 - pillWidth;
      context.fillStyle = style.pill;
      roundRect(context, px, y + 22, pillWidth, 50, 12);
      context.fill();
      context.fillStyle = style.text;
      if (live) {
        context.beginPath();
        context.moveTo(px + 20, y + 34);
        context.lineTo(px + 40, y + 47);
        context.lineTo(px + 20, y + 60);
        context.closePath();
        context.fill();
      }
      context.fillText(label, px + (live ? 48 : 20), y + 58);

      // Title and subtitle.
      const textX = tx + tw + 30;
      context.fillStyle = CREAM;
      context.font = `700 48px ${SANS}`;
      context.fillText(fitText(context, entry.title, px - textX - 24), textX, y + 66);
      context.fillStyle = "#d8c8a8";
      context.font = `500 36px ${SANS}`;
      context.fillText(fitText(context, entry.subtitle, width - 360 - textX), textX, y + 120);

      // Meta chip (bottom right).
      if (entry.meta) {
        context.font = `700 34px ${SANS}`;
        const right = width - 80;
        const probe = /^(\p{Extended_Pictographic}️?)\s*/u.exec(entry.meta);
        const bare = probe ? entry.meta.slice(probe[0].length) : entry.meta;
        const textWidth = context.measureText(bare).width;
        const iconWidth = probe ? 44 : 0;
        const start = right - textWidth - iconWidth;
        const { text } = metaIcon(context, entry.meta, start, y + 132, 34, "#f4e3c1");
        context.fillStyle = "#f4e3c1";
        context.fillText(text, start + iconWidth, y + 144);
      }
    });
    this.texture.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- Discussion Corner board

const ACTION_TILES: readonly { label: string; color: string; icon: "bubble" | "bulb" | "people" | "group" }[] = [
  { label: "Live Chat & Reactions", color: "#7c4dd8", icon: "bubble" },
  { label: "Share Takeaways", color: "#e08a2a", icon: "bulb" },
  { label: "Start a Discussion", color: "#2a9e92", icon: "people" },
  { label: "Find Your People", color: "#3d6fd8", icon: "group" },
];
const REACTION_ORDER: readonly HallReaction[] = ["clap", "heart", "fire", "laugh", "wow", "party", "zec", "idea"];

/** The "Discussion Corner" board (right front corner): the four actions, the latest hall lines, reaction tallies, members. */
export class DiscussionBoard implements DiscussionBoardApi {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private lines: DiscussionLine[] = [];
  private reactions: Partial<Record<HallReaction, number>> = {};
  /** Whose counts the strip shows ("This session", "Last session" or "Last minute"). */
  private reactionLabel = "Reactions";
  private members = 0;
  private signature = "";
  private readonly redraw = throttled(() => this.draw());

  constructor() {
    [this.canvas, this.context] = makeCanvas(1536, 996);
    this.texture = canvasTexture(this.canvas);
    this.draw();
  }

  setLines(lines: DiscussionLine[], reactions: Partial<Record<HallReaction, number>>, members: number, reactionLabel = "Reactions"): void {
    const latest = lines.slice(-5);
    const signature = JSON.stringify([latest, reactions, members, reactionLabel]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.lines = latest;
    this.reactions = { ...reactions };
    this.reactionLabel = reactionLabel;
    this.members = members;
    this.redraw();
  }

  private draw(): void {
    const context = this.context;
    const { width, height } = this.canvas;
    woodPanel(context, width, height, 166);
    drawBubbleIcon(context, 104, 92, 86, GOLD);
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    context.fillStyle = CREAM;
    context.font = `700 88px ${SERIF}`;
    context.fillText("Discussion Corner", 172, 124);
    context.font = `600 30px ${SANS}`;
    context.fillStyle = TAN;
    context.textAlign = "right";
    context.fillText("Press E", width - 64, 118);
    context.textAlign = "left";

    // Action tiles (left column).
    ACTION_TILES.forEach((tile, i) => {
      const y = 170 + i * 150;
      context.fillStyle = "rgba(255,236,200,0.08)";
      roundRect(context, 50, y, 690, 132, 18);
      context.fill();
      context.fillStyle = tile.color;
      roundRect(context, 70, y + 18, 96, 96, 18);
      context.fill();
      const cx = 118;
      const cy = y + 66;
      if (tile.icon === "bubble") drawBubbleIcon(context, cx, cy, 58, "#ffffff");
      else if (tile.icon === "bulb") drawBulbIcon(context, cx, cy, 62, "#ffffff");
      else drawPeopleIcon(context, cx, cy + 4, 58, "#ffffff", tile.icon === "people" ? 2 : 3);
      context.fillStyle = CREAM;
      context.font = `700 44px ${SANS}`;
      context.fillText(tile.label, 192, y + 82);
    });

    // Latest hall lines (right column).
    const x0 = 776;
    context.fillStyle = "rgba(10,6,2,0.32)";
    roundRect(context, x0, 170, width - 50 - x0, 582, 18);
    context.fill();
    context.fillStyle = TAN;
    context.font = `700 32px ${SANS}`;
    context.fillText("HALL CHAT", x0 + 26, 216);
    if (this.lines.length === 0) {
      context.fillStyle = "#c9b9a2";
      context.font = `500 34px ${SANS}`;
      context.fillText("Say hi in the Hall tab —", x0 + 26, 290);
      context.fillText("takeaways start with 💡", x0 + 26, 336);
    }
    this.lines.forEach((line, i) => {
      const y = 280 + i * 94;
      if (line.takeaway) {
        context.fillStyle = "rgba(255,200,90,0.16)";
        roundRect(context, x0 + 14, y - 46, width - 50 - x0 - 28, 80, 12);
        context.fill();
        context.fillStyle = "#f0c35e";
        context.fillRect(x0 + 14, y - 46, 8, 80);
      }
      context.font = `700 34px ${SANS}`;
      context.fillStyle = line.color;
      const name = fitText(context, `${line.nickname}:`, 260);
      context.fillText(name, x0 + 36, y);
      const nameWidth = context.measureText(name).width + 14;
      context.fillStyle = CREAM;
      context.font = `500 34px ${SANS}`;
      context.fillText(fitText(context, line.text, width - 90 - x0 - 36 - nameWidth), x0 + 36 + nameWidth, y);
    });

    // Reaction tallies and members (bottom strip). A label says whose counts they are — this stage
    // session's, the last one's (the stage is idle), or the last minute's (no turn yet).
    const y = 778;
    context.fillStyle = "rgba(10,6,2,0.32)";
    roundRect(context, 50, y, width - 100, 180, 18);
    context.fill();
    context.fillStyle = TAN;
    context.font = `700 28px ${SANS}`;
    context.fillText(this.reactionLabel.toUpperCase(), 76, y + 38);
    REACTION_ORDER.forEach((reaction, i) => {
      const cx = 108 + i * 132;
      drawReactionIcon(context, reaction, cx, y + 88, 54);
      context.fillStyle = CREAM;
      context.font = `700 32px ${SANS}`;
      context.textAlign = "center";
      context.fillText(compactCount(this.reactions[reaction] ?? 0), cx, y + 158);
      context.textAlign = "left";
    });
    drawPeopleIcon(context, width - 300, y + 90, 56, TAN, 3);
    context.fillStyle = CREAM;
    context.font = `700 44px ${SANS}`;
    context.fillText(String(this.members), width - 256, y + 106);
    context.font = `500 28px ${SANS}`;
    context.fillStyle = TAN;
    context.fillText("in the hall", width - 256, y + 144);
    this.texture.needsUpdate = true;
  }
}

/** A tally that fits under its icon: 999, 1.2k, 12k, 999k. */
function compactCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(Math.floor(count / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.floor(count / 1000)}k`;
}

// ---------------------------------------------------------------- speaker card strip

const MODE_STYLE: Record<SpeakerCardState["mode"], { label: string; pill: string; text: string }> = {
  live: { label: "LIVE", pill: "#d8323a", text: "#ffffff" },
  preparing: { label: "STARTING", pill: "#e39a2d", text: "#24170b" },
  next: { label: "UP NEXT", pill: "#5b63c8", text: "#ffffff" },
  idle: { label: "OPEN STAGE", pill: "#5d6b8a", text: "#ffffff" },
};

/** The strip under the screen: who is on stage, the title, speaker, project and link kinds (the DOM card has the real links). */
export class SpeakerCardBoard implements SpeakerCardBoardApi {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private state: SpeakerCardState = {
    mode: "idle",
    title: "The stage is open",
    note: "Request it at the podium · share a tab with sound · everyone in the hall watches together",
  };
  private signature = "";
  private readonly redraw = throttled(() => this.draw());

  constructor() {
    [this.canvas, this.context] = makeCanvas(2048, 320);
    this.texture = canvasTexture(this.canvas);
    this.draw();
  }

  set(state: SpeakerCardState): void {
    const signature = JSON.stringify(state);
    if (signature === this.signature) return;
    this.signature = signature;
    this.state = { ...state };
    this.redraw();
  }

  private draw(): void {
    const context = this.context;
    const { width, height } = this.canvas;
    const wood = context.createLinearGradient(0, 0, 0, height);
    wood.addColorStop(0, "#3a2414");
    wood.addColorStop(1, "#1f130a");
    context.fillStyle = wood;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#d9a441";
    context.lineWidth = 8;
    context.strokeRect(8, 8, width - 16, height - 16);
    context.lineWidth = 2;
    context.strokeRect(24, 24, width - 48, height - 48);
    const state = this.state;
    const style = MODE_STYLE[state.mode];
    context.textBaseline = "alphabetic";
    context.textAlign = "left";
    context.font = `800 40px ${SANS}`;
    const pillWidth = context.measureText(style.label).width + 56;
    context.fillStyle = style.pill;
    roundRect(context, 56, 58, pillWidth, 64, 14);
    context.fill();
    context.fillStyle = style.text;
    context.fillText(style.label, 84, 104);
    drawEmblem(context, 56 + pillWidth / 2, 214, 96, "#e3ad4c");

    const x = 96 + Math.max(pillWidth, 120);
    // Link chips take only the width they need (at most 520 px, two rows), so the title keeps its room.
    context.font = `700 36px ${SANS}`;
    const chips = (state.links ?? []).slice(0, 4).map((link) => {
      const label = { github: "GitHub", docs: "Docs", zechub: "ZecHub", forum: "Forum", web: "Website" }[link] ?? link;
      return { label, w: context.measureText(label).width + 44 };
    });
    let linksWidth = 0;
    for (let row = 0, i = 0; i < chips.length; row++) {
      let rowWidth = 0;
      while (i < chips.length && (rowWidth === 0 || rowWidth + 18 + chips[i]!.w <= 520)) rowWidth += (rowWidth === 0 ? 0 : 18) + chips[i++]!.w;
      linksWidth = Math.max(linksWidth, rowWidth);
    }
    if (linksWidth > 0) linksWidth += 30;
    context.fillStyle = CREAM;
    // The talk title steps down (84 → 64 px) before it gets an ellipsis.
    const titleRoom = width - x - linksWidth - 70;
    let titleSize = 84;
    context.font = `700 ${titleSize}px ${SERIF}`;
    while (titleSize > 64 && context.measureText(state.title).width > titleRoom) {
      titleSize -= 4;
      context.font = `700 ${titleSize}px ${SERIF}`;
    }
    context.fillText(fitText(context, state.title, titleRoom), x, 124);
    // "Presented by Luna · Speaker: Luna" says the same name twice: the speaker line only when it adds someone.
    const speakerLine = state.speaker && state.speaker !== state.presenter ? `Speaker: ${state.speaker}` : null;
    const people = [state.presenter && `Presented by ${state.presenter}`, speakerLine, state.project && `Project: ${state.project}`].filter(Boolean).join("  ·  ");
    context.font = `600 46px ${SANS}`;
    context.fillStyle = TAN;
    if (people) context.fillText(fitText(context, people, width - x - linksWidth - 70), x, 196);
    if (state.note) {
      context.font = `500 38px ${SANS}`;
      context.fillStyle = "#d8c8a8";
      context.fillText(fitText(context, state.note, width - x - linksWidth - 70), x, people ? 262 : 200);
    }
    if (chips.length > 0) {
      context.font = `700 36px ${SANS}`;
      let ly = 70;
      const left = width - 70 - (linksWidth - 30);
      let lx = left;
      for (const { label, w } of chips) {
        if (lx > left && lx + w > width - 60) {
          lx = left;
          ly += 84;
        }
        context.fillStyle = "rgba(255,214,140,0.16)";
        roundRect(context, lx, ly, w, 64, 14);
        context.fill();
        context.strokeStyle = "#d9a441";
        context.lineWidth = 2;
        context.stroke();
        context.fillStyle = CREAM;
        context.fillText(label, lx + 22, ly + 45);
        lx += w + 18;
      }
    }
    this.texture.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- the screen's idle face

/**
 * The idle face's static layer (16:9, any size): a deep navy-to-purple field with a soft vignette, a faint warm glow
 * and a large gold ZEC emblem in a gold ring. Drawn once per canvas size and reused by every `drawScreenIdle`.
 */
const idleBackdrops = new Map<string, HTMLCanvasElement>();
function idleBackdrop(width: number, height: number): HTMLCanvasElement {
  const key = `${width}x${height}`;
  const cached = idleBackdrops.get(key);
  if (cached) return cached;
  const [canvas, context] = makeCanvas(width, height);
  const unit = height / 1152;
  const cx = width / 2;
  const cy = height * 0.4;
  // Deep navy at the top to a royal purple at the bottom, a little lighter behind the emblem.
  const field = context.createLinearGradient(0, 0, width * 0.25, height);
  field.addColorStop(0, "#070b26");
  field.addColorStop(0.45, "#141640");
  field.addColorStop(1, "#331a5a");
  context.fillStyle = field;
  context.fillRect(0, 0, width, height);
  const glow = context.createRadialGradient(cx, cy, 0, cx, cy, height * 0.62);
  glow.addColorStop(0, "rgba(255,196,96,0.26)");
  glow.addColorStop(0.35, "rgba(190,120,200,0.12)");
  glow.addColorStop(1, "rgba(60,40,120,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  // Faint concentric "broadcast" rings around the emblem and a fine dust of stars.
  context.strokeStyle = "rgba(240,195,94,0.07)";
  context.lineWidth = 3 * unit;
  for (let i = 1; i <= 5; i++) {
    context.beginPath();
    context.arc(cx, cy, (330 + i * 92) * unit, 0, Math.PI * 2);
    context.stroke();
  }
  const random = seededRandom(77);
  for (let i = 0; i < 160; i++) {
    context.fillStyle = `rgba(255,236,200,${0.08 + random() * 0.22})`;
    const r = (0.8 + random() * 1.6) * unit;
    context.beginPath();
    context.arc(random() * width, random() * height, r, 0, Math.PI * 2);
    context.fill();
  }
  // Soft vignette.
  const vignette = context.createRadialGradient(cx, height * 0.48, height * 0.35, cx, height * 0.48, width * 0.62);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(2,2,12,0.62)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);

  // The emblem: drawn flat on its own layer, given a metallic gold gradient, then laid on with a warm glow.
  const radius = 330 * unit;
  const [layer, ink] = makeCanvas(width, height);
  ink.strokeStyle = "#000";
  ink.lineWidth = 26 * unit;
  ink.beginPath();
  ink.arc(cx, cy, radius, 0, Math.PI * 2);
  ink.stroke();
  ink.lineWidth = 6 * unit;
  ink.beginPath();
  ink.arc(cx, cy, radius - 34 * unit, 0, Math.PI * 2);
  ink.stroke();
  drawEmblem(ink, cx, cy, radius * 1.42, "#000");
  ink.globalCompositeOperation = "source-in";
  const metal = ink.createLinearGradient(cx - radius, cy - radius, cx + radius * 0.6, cy + radius);
  metal.addColorStop(0, "#ffe7a3");
  metal.addColorStop(0.42, "#f2c14e");
  metal.addColorStop(0.7, "#d99a2b");
  metal.addColorStop(1, "#b9781c");
  ink.fillStyle = metal;
  ink.fillRect(0, 0, width, height);
  context.save();
  context.shadowColor = "rgba(255,186,72,0.55)";
  context.shadowBlur = 70 * unit;
  context.drawImage(layer, 0, 0);
  context.restore();
  context.drawImage(layer, 0, 0);
  // A gold rule between the emblem and the text.
  const rule = context.createLinearGradient(cx - 360 * unit, 0, cx + 360 * unit, 0);
  rule.addColorStop(0, "rgba(240,195,94,0)");
  rule.addColorStop(0.5, "rgba(240,195,94,0.85)");
  rule.addColorStop(1, "rgba(240,195,94,0)");
  context.fillStyle = rule;
  context.fillRect(cx - 360 * unit, height * 0.735, 720 * unit, 3 * unit);
  idleBackdrops.set(key, canvas);
  return canvas;
}

/**
 * Idle face of the big screen (16:9; `HallScreen` draws it at 2048 x 1152): a large gold ZEC emblem on a deep
 * navy-to-purple field with a soft glow and vignette, and a short title and subtitle under it.
 */
export function drawScreenIdle(canvas: HTMLCanvasElement, title: string, subtitle: string): void {
  const context = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const unit = height / 1152;
  context.drawImage(idleBackdrop(width, height), 0, 0);
  context.save();
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.shadowColor = "rgba(0,0,0,0.55)";
  context.shadowBlur = 12 * unit;
  context.shadowOffsetY = 3 * unit;
  context.fillStyle = "#f4d58a";
  context.font = `700 ${Math.round(92 * unit)}px ${SERIF}`;
  context.fillText(fitText(context, title, width * 0.7), width / 2, height * 0.835);
  context.fillStyle = "#e9dcc6";
  context.font = `500 ${Math.round(46 * unit)}px ${SANS}`;
  context.fillText(fitText(context, subtitle, width * 0.76), width / 2, height * 0.91);
  context.restore();
}

/** Small red "LIVE" pill for the screen's top-right corner. */
export function livePillTexture(): THREE.CanvasTexture {
  const [canvas, context] = makeCanvas(256, 96);
  context.fillStyle = "#d8323a";
  roundRect(context, 4, 4, 248, 88, 22);
  context.fill();
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.moveTo(40, 26);
  context.lineTo(72, 48);
  context.lineTo(40, 70);
  context.closePath();
  context.fill();
  context.font = `800 54px ${SANS}`;
  context.textBaseline = "middle";
  context.fillText("LIVE", 88, 50);
  return canvasTexture(canvas);
}
