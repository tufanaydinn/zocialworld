import * as THREE from "three";
import { drawEmblem } from "../world/district/textures.ts";
import type { Lesson, Tier } from "./types.ts";

/**
 * Canvas faces for lesson stations and learning-track boards: a station's tier band, title, summary, steps and live
 * status, and a track board's pictogram, title and module list. Locations with lesson stations draw them onto meshes.
 */

export const TIER_COLOR: Record<Tier, string> = {
  beginner: "#7fd36a",
  intermediate: "#5fb4ff",
  advanced: "#b48cff",
  expert: "#f6c560",
  quiz: "#ff8fc8",
};

export type StationState = "locked" | "open" | "done";

/** The face of one lesson station: tier band, title, summary, the four steps and its live status. */
export class StationBoard {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas = document.createElement("canvas");
  private readonly lesson: Lesson;
  private readonly label: string;

  constructor(lesson: Lesson, label = lesson.title) {
    this.lesson = lesson;
    this.label = label;
    this.canvas.width = 768;
    this.canvas.height = 560;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.draw("open");
  }

  draw(state: StationState): void {
    const context = this.canvas.getContext("2d")!;
    const { width, height } = this.canvas;
    const accent = TIER_COLOR[this.lesson.tier];
    const wood = context.createLinearGradient(0, 0, 0, height);
    wood.addColorStop(0, "#3e2a1a");
    wood.addColorStop(1, "#24170d");
    context.fillStyle = wood;
    context.fillRect(0, 0, width, height);
    context.fillStyle = accent;
    context.fillRect(0, 0, width, 14);
    context.strokeStyle = "#140c06";
    context.lineWidth = 12;
    context.strokeRect(6, 6, width - 12, height - 12);
    context.fillStyle = accent;
    context.font = "800 26px 'Segoe UI', system-ui, sans-serif";
    context.fillText(this.lesson.tier === "quiz" ? "GATE QUIZ" : this.lesson.tier.toUpperCase(), 36, 62);
    context.fillStyle = "#f6e9cf";
    context.font = "700 46px Georgia, 'Times New Roman', serif";
    wrap(context, this.label, 36, 116, width - 72, 50, 2);
    context.fillStyle = "#d8c8a8";
    context.font = "500 26px 'Segoe UI', system-ui, sans-serif";
    wrap(context, this.lesson.summary, 36, 228, width - 72, 34, 3);

    const steps = ["LEARN", ...(this.lesson.see ? ["SEE"] : []), ...(this.lesson.try ? ["TRY"] : []), "PROVE"];
    let x = 36;
    context.font = "800 22px 'Segoe UI', system-ui, sans-serif";
    for (const step of steps) {
      const w = context.measureText(step).width + 26;
      context.fillStyle = state === "done" ? "rgba(110,220,140,0.85)" : "rgba(255,255,255,0.12)";
      context.beginPath();
      context.roundRect(x, 360, w, 40, 10);
      context.fill();
      context.fillStyle = state === "done" ? "#0e2614" : "#efe2c8";
      context.fillText(step, x + 13, 388);
      x += w + 12;
    }

    const status = state === "done" ? "✓ Completed" : state === "locked" ? "🔒 Locked — finish the previous modules" : "Press E to start";
    context.fillStyle = state === "done" ? "#9fe8b2" : state === "locked" ? "#e6a0a0" : "#ffd27a";
    context.font = "700 30px 'Segoe UI', system-ui, sans-serif";
    context.fillText(status, 36, height - 56);
    drawEmblem(context, width - 70, height - 70, 64, accent);
    this.texture.needsUpdate = true;
  }
}

export type TierIcon = "leaf" | "book" | "cube" | "star" | "trophy";

/** Tier pictograms (leaf, open book, cube, star, trophy), drawn in code. */
export function drawTierIcon(context: CanvasRenderingContext2D, icon: TierIcon, cx: number, cy: number, size: number, color: string): void {
  const s = size / 2;
  context.save();
  context.translate(cx, cy);
  context.fillStyle = color;
  context.strokeStyle = color;
  context.lineJoin = "round";
  context.lineCap = "round";
  if (icon === "leaf") {
    for (const side of [-1, 1]) {
      context.beginPath();
      context.moveTo(0, s * 0.85);
      context.quadraticCurveTo(side * s * 1.05, s * 0.2, side * s * 0.75, -s * 0.85);
      context.quadraticCurveTo(side * s * 0.05, -s * 0.45, 0, s * 0.85);
      context.fill();
    }
    context.strokeStyle = "rgba(0,0,0,0.35)";
    context.lineWidth = size * 0.05;
    context.beginPath();
    context.moveTo(0, s * 0.95);
    context.lineTo(0, s * 0.1);
    context.stroke();
  } else if (icon === "book") {
    for (const side of [-1, 1]) {
      context.beginPath();
      context.moveTo(0, -s * 0.55);
      context.quadraticCurveTo(side * s * 0.5, -s * 0.85, side * s, -s * 0.6);
      context.lineTo(side * s, s * 0.7);
      context.quadraticCurveTo(side * s * 0.5, s * 0.45, 0, s * 0.75);
      context.closePath();
      context.fill();
    }
    context.strokeStyle = "rgba(0,0,0,0.35)";
    context.lineWidth = size * 0.035;
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const y = -s * 0.3 + k * s * 0.3;
        context.beginPath();
        context.moveTo(side * s * 0.18, y);
        context.lineTo(side * s * 0.8, y - s * 0.06);
        context.stroke();
      }
    }
  } else if (icon === "cube") {
    const shade = (k: number): string => `rgba(0,0,0,${k})`;
    const faces: [number, number][][] = [
      [[0, -s], [s * 0.88, -s * 0.5], [0, 0], [-s * 0.88, -s * 0.5]],
      [[-s * 0.88, -s * 0.5], [0, 0], [0, s], [-s * 0.88, s * 0.5]],
      [[s * 0.88, -s * 0.5], [0, 0], [0, s], [s * 0.88, s * 0.5]],
    ];
    faces.forEach((face, i) => {
      context.beginPath();
      face.forEach(([x, y], k) => (k ? context.lineTo(x, y) : context.moveTo(x, y)));
      context.closePath();
      context.fillStyle = color;
      context.fill();
      if (i) {
        context.fillStyle = shade(i === 1 ? 0.18 : 0.35);
        context.fill();
      }
    });
  } else if (icon === "star") {
    context.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? s * 0.45 : s;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i) context.lineTo(x, y);
      else context.moveTo(x, y);
    }
    context.closePath();
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(-s * 0.62, -s * 0.85);
    context.lineTo(s * 0.62, -s * 0.85);
    context.quadraticCurveTo(s * 0.6, s * 0.1, 0, s * 0.25);
    context.quadraticCurveTo(-s * 0.6, s * 0.1, -s * 0.62, -s * 0.85);
    context.fill();
    context.lineWidth = size * 0.08;
    for (const side of [-1, 1]) {
      context.beginPath();
      context.arc(side * s * 0.62, -s * 0.45, s * 0.26, -Math.PI / 2, Math.PI / 2, side < 0);
      context.stroke();
    }
    context.fillRect(-s * 0.1, s * 0.2, s * 0.2, s * 0.4);
    context.fillRect(-s * 0.45, s * 0.6, s * 0.9, s * 0.25);
  }
  context.restore();
}

export interface TrackRow {
  readonly tag: "DONE" | "OPEN" | "LOCKED" | "SOON";
  readonly text: string;
}

/**
 * A learning-track board: tier pictogram, title, a short subtitle and up to five module rows with coloured icon
 * tiles and their live status.
 */
export class TrackBoard {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas = document.createElement("canvas");
  private readonly title: string;
  private readonly subtitle: string;
  private readonly accent: string;
  private readonly icon: TierIcon;

  constructor(title: string, subtitle: string, accent: string, icon: TierIcon) {
    this.title = title;
    this.subtitle = subtitle;
    this.accent = accent;
    this.icon = icon;
    this.canvas.width = 1024;
    this.canvas.height = 720;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.setRows([], "");
  }

  setRows(rows: readonly TrackRow[], footer: string): void {
    const context = this.canvas.getContext("2d")!;
    const { width, height } = this.canvas;
    const wood = context.createLinearGradient(0, 0, 0, height);
    wood.addColorStop(0, "#3a2516");
    wood.addColorStop(1, "#22150c");
    context.fillStyle = wood;
    context.fillRect(0, 0, width, height);
    // Plank seams.
    context.fillStyle = "rgba(0,0,0,0.18)";
    for (let y = 120; y < height; y += 120) context.fillRect(0, y, width, 3);
    // Gold double frame.
    context.strokeStyle = "#d9a441";
    context.lineWidth = 10;
    context.strokeRect(14, 14, width - 28, height - 28);
    context.lineWidth = 3;
    context.strokeRect(32, 32, width - 64, height - 64);

    drawTierIcon(context, this.icon, 110, 108, 104, this.accent);
    context.fillStyle = "#fbecd2";
    context.font = "700 84px Georgia, 'Times New Roman', serif";
    context.textBaseline = "alphabetic";
    context.fillText(this.title, 184, 128);
    context.fillStyle = "#e8c98a";
    context.font = "600 38px 'Segoe UI', system-ui, sans-serif";
    context.fillText(this.subtitle, 64, 206);

    const rowHeight = 82;
    rows.slice(0, 5).forEach((row, i) => {
      const y = 236 + i * rowHeight;
      context.fillStyle = "rgba(255,236,200,0.07)";
      context.beginPath();
      context.roundRect(56, y, width - 112, rowHeight - 14, 14);
      context.fill();
      const tile = row.tag === "DONE" ? "#59c27a" : row.tag === "LOCKED" ? "#6e6058" : row.tag === "SOON" ? "#4a5a8a" : this.accent;
      context.fillStyle = tile;
      context.beginPath();
      context.roundRect(68, y + 8, 52, 52, 10);
      context.fill();
      context.fillStyle = "#ffffff";
      context.font = "800 34px 'Segoe UI', system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText(row.tag === "DONE" ? "✓" : row.tag === "LOCKED" ? "🔒" : row.tag === "SOON" ? "…" : "▶", 94, y + 46);
      context.textAlign = "left";
      context.fillStyle = row.tag === "LOCKED" || row.tag === "SOON" ? "#c9b9a2" : "#fbecd2";
      context.font = "600 40px 'Segoe UI', system-ui, sans-serif";
      let text = row.text;
      while (context.measureText(text).width > width - 360 && text.length > 4) text = `${text.slice(0, -2)}…`;
      context.fillText(text, 140, y + 48);
      context.textAlign = "right";
      context.font = "800 28px 'Segoe UI', system-ui, sans-serif";
      context.fillStyle = row.tag === "DONE" ? "#8fe6a8" : row.tag === "OPEN" ? "#ffd27a" : "#a89a8a";
      context.fillText(row.tag, width - 76, y + 46);
      context.textAlign = "left";
    });
    if (footer) {
      context.fillStyle = "#e8c98a";
      context.font = "600 30px 'Segoe UI', system-ui, sans-serif";
      context.fillText(footer, 64, height - 52);
    }
    this.texture.needsUpdate = true;
  }
}

function wrap(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): void {
  const words = text.split(" ");
  let line = "";
  let lines = 0;
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i]!;
    if (context.measureText(candidate).width > maxWidth && line) {
      if (lines === maxLines - 1) {
        context.fillText(`${line}…`, x, y + lines * lineHeight);
        return;
      }
      context.fillText(line, x, y + lines * lineHeight);
      lines++;
      line = words[i]!;
    } else {
      line = candidate;
    }
  }
  context.fillText(line, x, y + lines * lineHeight);
}
