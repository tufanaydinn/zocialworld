import type { MinimapData } from "./minimapTypes.ts";

/**
 * Painted minimap. The whole location is rendered ONCE into a large
 * offscreen canvas ("the map sheet": textured grass, paving, walkways,
 * stairs, roofs seen from above, tree canopies, monument); each frame the
 * HUD only blits a rotated window of that sheet into the round dial and
 * draws the live overlays (zone badges, player arrow + view cone,
 * rotating compass). That keeps the per-frame cost to a single
 * drawImage plus a handful of shapes.
 */

const SHEET_PIXELS_PER_METER = 8;

export interface MapSheet {
  readonly canvas: HTMLCanvasElement;
  readonly toSheet: (x: number, z: number) => [number, number];
  readonly pixelsPerMeter: number;
}

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function paintMapSheet(data: MinimapData): MapSheet {
  const { minX, maxX, minZ, maxZ } = data.bounds;
  const ppm = SHEET_PIXELS_PER_METER;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((maxX - minX) * ppm);
  canvas.height = Math.ceil((maxZ - minZ) * ppm);
  const context = canvas.getContext("2d")!;
  const toSheet = (x: number, z: number): [number, number] => [(x - minX) * ppm, (z - minZ) * ppm];

  if (data.background) {
    // Indoor locations (the Watch Hall): a plain dark floor instead of grass.
    context.fillStyle = data.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    // Grass with soft mottling.
    const grass = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    grass.addColorStop(0, "#33452f");
    grass.addColorStop(1, "#28382a");
    context.fillStyle = grass;
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < 2600; i++) {
      const x = hash(i, 1) * canvas.width;
      const y = hash(i, 2) * canvas.height;
      context.fillStyle = `rgba(${90 + hash(i, 3) * 40}, ${120 + hash(i, 4) * 50}, 80, 0.10)`;
      context.beginPath();
      context.arc(x, y, 2 + hash(i, 5) * 6, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.save();
  context.translate(-minX * ppm, -minZ * ppm);
  context.scale(ppm, ppm);

  // Paved areas with a cobble speckle.
  for (const area of data.areas) {
    context.fillStyle = area.color;
    context.fillRect(area.x0, area.z0, area.x1 - area.x0, area.z1 - area.z0);
    context.fillStyle = "rgba(0,0,0,0.06)";
    for (let x = area.x0; x < area.x1; x += 1.1) {
      for (let z = area.z0; z < area.z1; z += 1.1) {
        if (hash(x, z) < 0.35) context.fillRect(x + 0.1, z + 0.1, 0.8, 0.8);
      }
    }
    context.strokeStyle = "rgba(30,20,24,0.55)";
    context.lineWidth = 0.35;
    context.strokeRect(area.x0, area.z0, area.x1 - area.x0, area.z1 - area.z0);
  }

  // Walkways.
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const path of data.paths ?? []) {
    context.strokeStyle = "#c9b7a6";
    context.lineWidth = path.width;
    context.beginPath();
    path.points.forEach(([x, z], index) => (index === 0 ? context.moveTo(x, z) : context.lineTo(x, z)));
    context.stroke();
  }

  // Circular plaza: rings + radial joints.
  for (const circle of data.circles) {
    const gradient = context.createRadialGradient(circle.x, circle.z, 0, circle.x, circle.z, circle.radius);
    gradient.addColorStop(0, circle.color);
    gradient.addColorStop(1, shade(circle.color, -0.12));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(circle.x, circle.z, circle.radius, 0, Math.PI * 2);
    context.fill();
    if (circle.radius > 8) {
      context.strokeStyle = "rgba(60,40,50,0.35)";
      context.lineWidth = 0.15;
      for (let r = 2; r < circle.radius; r += 1.6) {
        context.beginPath();
        context.arc(circle.x, circle.z, r, 0, Math.PI * 2);
        context.stroke();
      }
      context.lineWidth = 0.5;
      context.strokeStyle = "rgba(240,220,200,0.6)";
      context.beginPath();
      context.arc(circle.x, circle.z, circle.radius, 0, Math.PI * 2);
      context.stroke();
    }
  }

  // Stairs: step hatching.
  for (const stair of data.stairs ?? []) {
    context.fillStyle = "#b9a59a";
    context.fillRect(stair.x0, stair.z0, stair.x1 - stair.x0, stair.z1 - stair.z0);
    context.strokeStyle = "rgba(50,35,40,0.6)";
    context.lineWidth = 0.12;
    for (let z = stair.z0; z <= stair.z1; z += 0.45) {
      context.beginPath();
      context.moveTo(stair.x0, z);
      context.lineTo(stair.x1, z);
      context.stroke();
    }
  }

  // Tree canopies with a soft drop shadow.
  for (const [x, z] of data.trees ?? []) {
    const radius = 1.2 + hash(x, z) * 0.9;
    context.fillStyle = "rgba(0,0,0,0.25)";
    context.beginPath();
    context.arc(x + 0.4, z + 0.5, radius, 0, Math.PI * 2);
    context.fill();
    const canopy = context.createRadialGradient(x - radius * 0.3, z - radius * 0.3, 0, x, z, radius);
    canopy.addColorStop(0, "#6f9a5a");
    canopy.addColorStop(1, "#2f4f2c");
    context.fillStyle = canopy;
    context.beginPath();
    context.arc(x, z, radius, 0, Math.PI * 2);
    context.fill();
  }

  // Roofs from above: drop shadow, two-tone slopes, ridge line.
  for (const building of data.buildings) {
    const color = building.color ?? "#7a4a42";
    context.save();
    context.translate(building.x, building.z);
    context.rotate(-building.yaw);
    const w = building.width;
    const d = building.depth;
    context.fillStyle = "rgba(0,0,0,0.35)";
    context.fillRect(-w / 2 + 0.6, -d / 2 + 0.8, w, d);
    context.fillStyle = shade(color, 0.12);
    context.fillRect(-w / 2, -d / 2, w, d / 2);
    context.fillStyle = shade(color, -0.18);
    context.fillRect(-w / 2, 0, w, d / 2);
    context.strokeStyle = shade(color, 0.35);
    context.lineWidth = 0.3;
    context.beginPath();
    context.moveTo(-w / 2, 0);
    context.lineTo(w / 2, 0);
    context.stroke();
    context.strokeStyle = "rgba(20,10,10,0.8)";
    context.lineWidth = 0.25;
    context.strokeRect(-w / 2, -d / 2, w, d);
    context.restore();
  }

  context.restore();
  return { canvas, toSheet, pixelsPerMeter: ppm };
}

/** Lighten (amount > 0) or darken a #rrggbb color. */
function shade(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift: number): number => {
    const c = (value >> shift) & 255;
    return Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/** Tiny vector pictograms for zone badges (drawn centered at 0,0, ~size px). */
export function drawIcon(context: CanvasRenderingContext2D, icon: string | undefined, size: number): void {
  const s = size / 2;
  context.save();
  context.fillStyle = "#24170b";
  context.strokeStyle = "#24170b";
  context.lineWidth = Math.max(1.5, size * 0.09);
  context.lineCap = "round";
  context.lineJoin = "round";
  switch (icon) {
    case "tavern": // mug
      context.strokeRect(-s * 0.55, -s * 0.45, s * 0.8, s * 0.95);
      context.beginPath();
      context.arc(s * 0.3, 0, s * 0.3, -Math.PI / 2, Math.PI / 2);
      context.stroke();
      context.fillRect(-s * 0.55, -s * 0.6, s * 0.8, s * 0.22);
      break;
    case "builders": // hammer
      context.fillRect(-s * 0.6, -s * 0.6, s * 1.0, s * 0.38);
      context.fillRect(-s * 0.12, -s * 0.3, s * 0.24, s * 0.95);
      break;
    case "market": // awning
      context.beginPath();
      context.moveTo(-s * 0.7, -s * 0.15);
      context.lineTo(-s * 0.5, -s * 0.6);
      context.lineTo(s * 0.5, -s * 0.6);
      context.lineTo(s * 0.7, -s * 0.15);
      context.closePath();
      context.fill();
      context.fillRect(-s * 0.55, s * 0.0, s * 1.1, s * 0.55);
      break;
    case "board": // notice board
      context.strokeRect(-s * 0.6, -s * 0.5, s * 1.2, s * 0.8);
      context.beginPath();
      context.moveTo(-s * 0.4, s * 0.3);
      context.lineTo(-s * 0.4, s * 0.7);
      context.moveTo(s * 0.4, s * 0.3);
      context.lineTo(s * 0.4, s * 0.7);
      context.stroke();
      break;
    case "stage": // screen on a stage
      context.strokeRect(-s * 0.62, -s * 0.62, s * 1.24, s * 0.82);
      context.fillRect(-s * 0.36, -s * 0.4, s * 0.72, s * 0.38);
      context.fillRect(-s * 0.75, s * 0.4, s * 1.5, s * 0.24);
      break;
    case "portal": // arched gate
      context.beginPath();
      context.moveTo(-s * 0.55, s * 0.65);
      context.lineTo(-s * 0.55, -s * 0.05);
      context.arc(0, -s * 0.05, s * 0.55, Math.PI, 0);
      context.lineTo(s * 0.55, s * 0.65);
      context.stroke();
      context.beginPath();
      context.ellipse(0, s * 0.12, s * 0.22, s * 0.36, 0, 0, Math.PI * 2);
      context.fill();
      break;
    default: // monument star
      context.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? s * 0.75 : s * 0.32;
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        if (i === 0) context.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else context.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      context.closePath();
      context.fill();
  }
  context.restore();
}

export interface DialState {
  readonly playerX: number;
  readonly playerZ: number;
  readonly playerYaw: number;
  readonly cameraYaw: number;
}

const DIAL_METERS = 32;

/** Draws the round minimap dial into `canvas` (square, device pixels). */
export function drawDial(canvas: HTMLCanvasElement, sheet: MapSheet, data: MinimapData, state: DialState): void {
  const context = canvas.getContext("2d")!;
  const size = canvas.width;
  const half = size / 2;
  const inner = half - 16;
  const scale = inner / DIAL_METERS; // px per meter on the dial
  const { playerX: px, playerZ: pz, cameraYaw } = state;
  context.clearRect(0, 0, size, size);

  // Map window (rotated so camera-forward is up).
  context.save();
  context.beginPath();
  context.arc(half, half, inner, 0, Math.PI * 2);
  context.clip();
  context.fillStyle = data.background ?? "#1f2b1f";
  context.fillRect(0, 0, size, size);
  context.translate(half, half);
  context.rotate(cameraYaw);
  const [sx, sy] = sheet.toSheet(px, pz);
  const k = scale / sheet.pixelsPerMeter;
  context.scale(k, k);
  context.drawImage(sheet.canvas, -sx, -sy);
  context.restore();

  // Vignette inside the dial.
  const vignette = context.createRadialGradient(half, half, inner * 0.55, half, half, inner);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(10,6,16,0.55)");
  context.fillStyle = vignette;
  context.beginPath();
  context.arc(half, half, inner, 0, Math.PI * 2);
  context.fill();

  const project = (x: number, z: number): [number, number] => {
    const dx = (x - px) * scale;
    const dz = (z - pz) * scale;
    return [dx * Math.cos(cameraYaw) - dz * Math.sin(cameraYaw), dx * Math.sin(cameraYaw) + dz * Math.cos(cameraYaw)];
  };

  context.save();
  context.translate(half, half);

  // View cone (camera looks "up" on the dial).
  const cone = context.createRadialGradient(0, 0, 0, 0, 0, inner * 0.7);
  cone.addColorStop(0, "rgba(255,214,120,0.35)");
  cone.addColorStop(1, "rgba(255,214,120,0)");
  context.fillStyle = cone;
  context.beginPath();
  context.moveTo(0, 0);
  context.arc(0, 0, inner * 0.7, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
  context.closePath();
  context.fill();

  // Reserve the player arrow and every on-dial badge first, so labels avoid them too.
  const placedLabels: { x: number; y: number; w: number; h: number }[] = [{ x: 0, y: 0, w: 44, h: 44 }];
  for (const marker of data.markers) {
    const [bx, by] = project(marker.x, marker.z);
    if (Math.hypot(bx, by) <= inner - 22) placedLabels.push({ x: bx, y: by, w: 36, h: 36 });
  }
  const overlaps = (x: number, y: number, w: number, h: number): boolean =>
    placedLabels.some((r) => Math.abs(r.x - x) * 2 < r.w + w && Math.abs(r.y - y) * 2 < r.h + h);

  // Zone badges, clamped to the rim when out of range; labels stay upright inside the dial.
  for (const marker of data.markers) {
    let [mx, my] = project(marker.x, marker.z);
    const distance = Math.hypot(mx, my);
    const rim = inner - 22;
    const offDial = distance > rim;
    if (offDial) {
      mx = (mx / distance) * rim;
      my = (my / distance) * rim;
    }
    const radius = offDial ? 13 : 17;
    context.fillStyle = "rgba(0,0,0,0.45)";
    context.beginPath();
    context.arc(mx + 2, my + 3, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = marker.color;
    context.strokeStyle = "#f6e6c4";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(mx, my, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.save();
    context.translate(mx, my);
    drawIcon(context, marker.icon, radius * 1.15);
    context.restore();
    if (!offDial) {
      context.font = "700 19px 'Segoe UI', system-ui, sans-serif";
      const width = context.measureText(marker.label).width + 14;
      const fit = (x: number, y: number): [number, number] => {
        const reach = Math.hypot(Math.abs(x) + width / 2, Math.abs(y) + 12);
        return reach > inner - 6 ? [x * ((inner - 6) / reach), y * ((inner - 6) / reach)] : [x, y];
      };
      let [lx, ly] = fit(mx, my - radius - 16 < -inner + 30 ? my + radius + 18 : my - radius - 16);
      const candidates: [number, number][] = [
        [lx, ly],
        fit(mx, my + radius + 18),
        fit(mx + radius + width / 2 + 6, my),
        fit(mx - radius - width / 2 - 6, my),
      ];
      const free = candidates.find(([cx, cy]) => !overlaps(cx, cy, width, 24));
      if (!free) continue; // badge alone is enough
      [lx, ly] = free;
      placedLabels.push({ x: lx, y: ly, w: width, h: 24 });
      context.fillStyle = "rgba(18,12,10,0.78)";
      context.beginPath();
      context.roundRect(lx - width / 2, ly - 13, width, 24, 12);
      context.fill();
      context.fillStyle = "#f7ead2";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(marker.label, lx, ly);
    }
  }

  // Player arrow with glow (facing relative to the rotated map).
  const relative = state.playerYaw - cameraYaw;
  context.rotate(Math.PI - Math.atan2(Math.sin(relative), Math.cos(relative)));
  context.shadowColor = "rgba(255,200,90,0.9)";
  context.shadowBlur = 14;
  context.fillStyle = "#ffd36a";
  context.strokeStyle = "#3a2208";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(0, -20);
  context.lineTo(13, 13);
  context.lineTo(0, 6);
  context.lineTo(-13, 13);
  context.closePath();
  context.fill();
  context.shadowBlur = 0;
  context.stroke();
  context.restore();

  // Bronze rim with rotating cardinal ticks.
  const ring = context.createLinearGradient(0, 0, size, size);
  ring.addColorStop(0, "#e0a85a");
  ring.addColorStop(0.5, "#8a5a2a");
  ring.addColorStop(1, "#d39a4c");
  context.lineWidth = 12;
  context.strokeStyle = ring;
  context.beginPath();
  context.arc(half, half, half - 8, 0, Math.PI * 2);
  context.stroke();
  context.lineWidth = 2;
  context.strokeStyle = "rgba(30,16,6,0.9)";
  context.beginPath();
  context.arc(half, half, half - 14.5, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(half, half, half - 2, 0, Math.PI * 2);
  context.stroke();
  const cardinals: [string, number][] = [
    ["N", 0],
    ["E", Math.PI / 2],
    ["S", Math.PI],
    ["W", -Math.PI / 2],
  ];
  context.font = "800 15px 'Segoe UI', system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const [label, bearing] of cardinals) {
    // World north = -Z; on the dial, rotate by the camera yaw like the map.
    const angle = bearing + cameraYaw - Math.PI / 2;
    const x = half + Math.cos(angle) * (half - 8);
    const y = half + Math.sin(angle) * (half - 8);
    context.fillStyle = label === "N" ? "#ffe2a8" : "#2a1606";
    context.beginPath();
    context.arc(x, y, 10, 0, Math.PI * 2);
    context.fillStyle = label === "N" ? "#b8462e" : "#e8c48a";
    context.fill();
    context.fillStyle = label === "N" ? "#fff2d8" : "#2a1606";
    context.fillText(label, x, y + 1);
  }
}

/** Full map overlay: the whole sheet, north-up, with badges and the player. */
export function drawFullMap(canvas: HTMLCanvasElement, sheet: MapSheet, data: MinimapData, player: { x: number; z: number }): void {
  const context = canvas.getContext("2d")!;
  const scale = Math.min(canvas.width / sheet.canvas.width, canvas.height / sheet.canvas.height);
  const offsetX = (canvas.width - sheet.canvas.width * scale) / 2;
  const offsetY = (canvas.height - sheet.canvas.height * scale) / 2;
  context.fillStyle = data.background ?? "#1f2b1f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(sheet.canvas, offsetX, offsetY, sheet.canvas.width * scale, sheet.canvas.height * scale);
  const toScreen = (x: number, z: number): [number, number] => {
    const [sx, sy] = sheet.toSheet(x, z);
    return [offsetX + sx * scale, offsetY + sy * scale];
  };
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const marker of data.markers) {
    const [x, y] = toScreen(marker.x, marker.z);
    context.fillStyle = marker.color;
    context.strokeStyle = "#f6e6c4";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(x, y, 16, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.save();
    context.translate(x, y);
    drawIcon(context, marker.icon, 18);
    context.restore();
    context.font = "700 18px 'Segoe UI', system-ui, sans-serif";
    const width = context.measureText(marker.label).width + 16;
    context.fillStyle = "rgba(18,12,10,0.8)";
    context.beginPath();
    context.roundRect(x - width / 2, y - 42, width, 24, 12);
    context.fill();
    context.fillStyle = "#f7ead2";
    context.fillText(marker.label, x, y - 30);
  }
  const [x, y] = toScreen(player.x, player.z);
  context.shadowColor = "rgba(255,200,90,0.9)";
  context.shadowBlur = 16;
  context.fillStyle = "#ffd36a";
  context.beginPath();
  context.arc(x, y, 9, 0, Math.PI * 2);
  context.fill();
  context.shadowBlur = 0;
  context.font = "600 15px 'Segoe UI', system-ui, sans-serif";
  context.fillStyle = "#fff2d8";
  context.fillText("You are here", x, y + 24);
}
