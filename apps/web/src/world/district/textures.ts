import * as THREE from "three";

/**
 * Procedural canvas textures for props, boards and nameplates: dressed stone, glow and flame sprites, carved signs,
 * name tags and the emblem glyph. Everything is drawn with Canvas2D at runtime (no image files) and cached by key,
 * so each texture is created once per session. The canvas, caching and stone helpers are exported for content that
 * draws textures of its own.
 */

const cache = new Map<string, THREE.Texture>();

/** Returns the texture stored under `key`, creating it with `create` on first use. */
export function cached(key: string, create: () => THREE.Texture): THREE.Texture {
  let texture = cache.get(key);
  if (!texture) {
    texture = create();
    cache.set(key, texture);
  }
  return texture;
}

/** Small deterministic PRNG so textures look identical across reloads (stable screenshots). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

export function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D unavailable");
  return [canvas, context];
}

export function toTexture(canvas: HTMLCanvasElement, repeat = false, srgb = true): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  texture.anisotropy = 4;
  return texture;
}

/** A stone fill colour: `base` RGB shifted by a random amount up to `spread`. */
export function stoneColor(random: () => number, base: [number, number, number], spread: number): string {
  const jitter = (random() - 0.5) * spread;
  const [r, g, b] = base;
  return `rgb(${Math.round(r + jitter)}, ${Math.round(g + jitter * 0.9)}, ${Math.round(b + jitter * 1.1)})`;
}

/** One rounded stone with a soft highlight and shade. */
export function drawStone(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  radius: number,
): void {
  context.fillStyle = fill;
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
  // Soft top-left highlight / bottom-right shade to read as rounded cobbles.
  const gradient = context.createLinearGradient(x, y, x + width, y + height);
  gradient.addColorStop(0, "rgba(255,255,255,0.16)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.22)");
  context.fillStyle = gradient;
  context.fill();
}

/** Large staggered dressed-stone blocks — walls, pillars and planters. */
export function stoneBlockTexture(): THREE.Texture {
  return cached("stone-block", () => {
    const size = 512;
    const [canvas, context] = makeCanvas(size, size);
    const random = seededRandom(23);
    context.fillStyle = "#3e3644";
    context.fillRect(0, 0, size, size);
    const rows = 4;
    const rowHeight = size / rows;
    for (let row = 0; row < rows; row++) {
      let x = row % 2 === 0 ? 0 : -rowHeight * 0.7;
      while (x < size) {
        const width = rowHeight * (1.1 + random() * 0.8);
        const fill = stoneColor(random, [146, 136, 132], 28);
        drawStone(context, x + 4, row * rowHeight + 4, width - 8, rowHeight - 8, fill, 6);
        if (x + width > size) drawStone(context, x - size + 4, row * rowHeight + 4, width - 8, rowHeight - 8, fill, 6);
        x += width;
      }
    }
    return toTexture(canvas, true);
  });
}

/** Soft radial glow for lantern halos and window bloom sprites (additive). */
export function glowTexture(): THREE.Texture {
  return cached("glow", () => {
    const size = 128;
    const [canvas, context] = makeCanvas(size, size);
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,236,190,1)");
    gradient.addColorStop(0.2, "rgba(255,196,110,0.75)");
    gradient.addColorStop(0.5, "rgba(255,150,60,0.22)");
    gradient.addColorStop(1, "rgba(255,120,40,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    return toTexture(canvas);
  });
}

/** Teardrop flame for animated fire billboards. */
export function flameTexture(): THREE.Texture {
  return cached("flame", () => {
    const width = 64;
    const height = 128;
    const [canvas, context] = makeCanvas(width, height);
    const gradient = context.createRadialGradient(width / 2, height * 0.72, 2, width / 2, height * 0.6, height * 0.55);
    gradient.addColorStop(0, "rgba(255,250,210,1)");
    gradient.addColorStop(0.25, "rgba(255,200,90,0.95)");
    gradient.addColorStop(0.6, "rgba(255,110,30,0.6)");
    gradient.addColorStop(1, "rgba(200,40,10,0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.moveTo(width / 2, 4);
    context.bezierCurveTo(width * 0.95, height * 0.45, width * 0.95, height * 0.95, width / 2, height - 4);
    context.bezierCurveTo(width * 0.05, height * 0.95, width * 0.05, height * 0.45, width / 2, 4);
    context.fill();
    return toTexture(canvas);
  });
}

/**
 * Draws the emblem: a stylized "Z" with short vertical strokes through its top and bottom bars. A glyph drawn in
 * code, the world's Zcash-ecosystem identity marker without a logo file.
 */
export function drawEmblem(context: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  const half = size / 2;
  const bar = size * 0.17;
  context.save();
  context.translate(cx, cy);
  context.fillStyle = color;
  context.beginPath();
  // Top bar.
  context.rect(-half * 0.72, -half * 0.62, half * 1.44, bar);
  // Bottom bar.
  context.rect(-half * 0.72, half * 0.62 - bar, half * 1.44, bar);
  context.fill();
  // Diagonal.
  context.beginPath();
  context.moveTo(half * 0.72, -half * 0.62 + bar);
  context.lineTo(half * 0.72 - bar * 1.25, -half * 0.62 + bar);
  context.lineTo(-half * 0.72, half * 0.62 - bar);
  context.lineTo(-half * 0.72 + bar * 1.25, half * 0.62 - bar);
  context.closePath();
  context.fill();
  // Vertical ticks through the bars.
  context.fillRect(-bar * 0.32, -half * 0.92, bar * 0.64, half * 0.36);
  context.fillRect(-bar * 0.32, half * 0.56, bar * 0.64, half * 0.36);
  context.restore();
}

export interface SignTextOptions {
  readonly title: string;
  readonly subtitle?: string;
  readonly width?: number;
  readonly height?: number;
}

/** Carved wooden sign board with a cream title and an optional subtitle. */
export function signTexture(options: SignTextOptions): THREE.Texture {
  const key = `sign:${options.title}:${options.subtitle ?? ""}`;
  return cached(key, () => {
    const width = options.width ?? 1024;
    const height = options.height ?? 300;
    const [canvas, context] = makeCanvas(width, height);
    const random = seededRandom(options.title.length * 97 + 3);

    const wood = context.createLinearGradient(0, 0, 0, height);
    wood.addColorStop(0, "#6b4529");
    wood.addColorStop(0.5, "#5a3920");
    wood.addColorStop(1, "#4a2e19");
    context.fillStyle = wood;
    context.fillRect(0, 0, width, height);
    // Plank seams and grain.
    for (let i = 1; i < 3; i++) {
      context.fillStyle = "rgba(20,10,4,0.45)";
      context.fillRect(0, (height / 3) * i - 2, width, 4);
    }
    for (let i = 0; i < 90; i++) {
      context.strokeStyle = `rgba(30,16,6,${0.08 + random() * 0.12})`;
      context.lineWidth = 1 + random() * 2;
      const y = random() * height;
      context.beginPath();
      context.moveTo(0, y);
      context.bezierCurveTo(width * 0.3, y + (random() - 0.5) * 12, width * 0.7, y + (random() - 0.5) * 12, width, y);
      context.stroke();
    }
    context.strokeStyle = "#2c1a0c";
    context.lineWidth = 14;
    context.strokeRect(7, 7, width - 14, height - 14);

    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#f4e3c1";
    context.shadowColor = "rgba(0,0,0,0.6)";
    context.shadowOffsetY = 4;
    context.shadowBlur = 6;
    const titleSize = Math.round(height * (options.subtitle ? 0.36 : 0.5));
    context.font = `700 ${titleSize}px Georgia, "Times New Roman", serif`;
    context.fillText(options.title, width / 2, options.subtitle ? height * 0.4 : height / 2, width * 0.9);
    if (options.subtitle) {
      context.font = `600 ${Math.round(height * 0.17)}px Georgia, "Times New Roman", serif`;
      context.fillStyle = "#e5cfa3";
      context.fillText(options.subtitle, width / 2, height * 0.75, width * 0.9);
    }
    return toTexture(canvas);
  });
}

/** Colored nameplate text for ambient NPCs (in-world sprite, depth-tested). */
export function nameTexture(name: string, color: string): THREE.Texture {
  return cached(`name:${name}:${color}`, () => {
    const width = 256;
    const height = 64;
    const [canvas, context] = makeCanvas(width, height);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `700 34px "Segoe UI", system-ui, sans-serif`;
    context.lineWidth = 6;
    context.strokeStyle = "rgba(10,8,20,0.85)";
    context.strokeText(name, width / 2, height / 2);
    context.fillStyle = color;
    context.fillText(name, width / 2, height / 2);
    return toTexture(canvas);
  });
}
