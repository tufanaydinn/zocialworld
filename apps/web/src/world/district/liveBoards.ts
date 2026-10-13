import * as THREE from "three";
import { drawEmblem } from "./textures.ts";

/**
 * In-world notice boards whose face is a canvas redrawn from live
 * community data (ZecHub bounties, wiki, forum threads, GitHub repos).
 * The board starts with a "loading" face and is redrawn once the data
 * arrives; pressing E opens the full in-game Community Hub panel.
 */

export interface BoardRow {
  /** Short highlighted tag on the left (e.g. "0.25 ZEC", "12 posts"). */
  readonly tag?: string;
  readonly text: string;
}

export class LiveBoard {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly title: string;
  private readonly subtitle: string;
  private readonly accent: string;

  constructor(title: string, subtitle: string, accent = "#e39a2d") {
    this.title = title;
    this.subtitle = subtitle;
    this.accent = accent;
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1024;
    this.canvas.height = 680;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.draw([], "Loading live data…");
  }

  setRows(rows: readonly BoardRow[], footer = "Press E to browse"): void {
    this.draw(rows, footer);
  }

  setOffline(): void {
    this.draw([], "Live data unavailable — press E to retry");
  }

  private draw(rows: readonly BoardRow[], footer: string): void {
    const context = this.canvas.getContext("2d")!;
    const { width, height } = this.canvas;
    const wood = context.createLinearGradient(0, 0, 0, height);
    wood.addColorStop(0, "#4a2f1b");
    wood.addColorStop(1, "#2e1d11");
    context.fillStyle = wood;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#1c1108";
    context.lineWidth = 16;
    context.strokeRect(8, 8, width - 16, height - 16);

    context.fillStyle = "#f4e3c1";
    context.font = "700 62px Georgia, 'Times New Roman', serif";
    context.textBaseline = "alphabetic";
    context.fillText(this.title, 44, 92);
    context.fillStyle = "#cdb894";
    context.font = "600 26px 'Segoe UI', system-ui, sans-serif";
    context.fillText(this.subtitle, 46, 132);
    drawEmblem(context, width - 76, 74, 70, this.accent);

    const top = 166;
    const rowHeight = 86;
    rows.slice(0, 5).forEach((row, index) => {
      const y = top + index * rowHeight;
      context.fillStyle = "rgba(14,9,5,0.6)";
      context.beginPath();
      context.roundRect(36, y, width - 72, rowHeight - 12, 12);
      context.fill();
      let x = 56;
      if (row.tag) {
        context.font = "800 26px 'Segoe UI', system-ui, sans-serif";
        const tagWidth = Math.max(130, context.measureText(row.tag).width + 28);
        context.fillStyle = this.accent;
        context.beginPath();
        context.roundRect(x, y + 16, tagWidth, 42, 10);
        context.fill();
        context.fillStyle = "#24170b";
        context.textAlign = "center";
        context.fillText(row.tag, x + tagWidth / 2, y + 46);
        context.textAlign = "left";
        x += tagWidth + 18;
      }
      context.fillStyle = "#f3e7d3";
      context.font = "600 30px 'Segoe UI', system-ui, sans-serif";
      context.fillText(fitText(context, row.text, width - x - 56), x, y + 47);
    });

    context.fillStyle = "#e8c58a";
    context.font = "700 28px 'Segoe UI', system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText(footer, width / 2, height - 34);
    context.textAlign = "left";
    this.texture.needsUpdate = true;
  }
}

function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && context.measureText(`${trimmed}…`).width > maxWidth) trimmed = trimmed.slice(0, -1);
  return `${trimmed.trimEnd()}…`;
}

export interface CommunityBoards {
  readonly bounties: LiveBoard;
  readonly wiki: LiveBoard;
  readonly github: LiveBoard;
  readonly forum: LiveBoard;
}
