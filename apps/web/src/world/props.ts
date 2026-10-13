import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { drawEmblem, flameTexture, glowTexture, seededRandom, signTexture, stoneBlockTexture } from "./district/textures.ts";
import { compactFaceGroups, texturedBox } from "./geometry.ts";

/**
 * Procedural props built from Three.js primitives and canvas textures, with no external files: carved signs,
 * boards with a canvas face, striped awnings, bunting, string lights, the shared glow-point and flame systems,
 * pillars and planters.
 */

const woodMaterial = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.85 });
const darkWoodMaterial = new THREE.MeshStandardMaterial({ color: 0x2e1d12, roughness: 0.9 });

// ---------------------------------------------------------------- signs

/** Carved wooden sign with a title and an optional subtitle. Front faces local +Z. */
export function buildSign(title: string, subtitle: string | undefined, width: number, height: number): THREE.Mesh {
  const face = new THREE.MeshStandardMaterial({
    map: signTexture({ title, ...(subtitle ? { subtitle } : {}) }),
    roughness: 0.8,
    emissive: 0xffffff,
    emissiveMap: signTexture({ title, ...(subtitle ? { subtitle } : {}) }),
    emissiveIntensity: 0.12,
  });
  const mesh = new THREE.Mesh(compactFaceGroups(new THREE.BoxGeometry(width, height, 0.14), [0, 0, 0, 0, 1, 0]), [darkWoodMaterial, face]);
  mesh.castShadow = true;
  mesh.name = `Sign:${title}`;
  return mesh;
}

/** Board with an arbitrary canvas face (notice boards, featured-projects board). Front faces local +Z. */
export function buildBoard(texture: THREE.Texture, width: number, height: number, postHeight: number, doubleSided = false): THREE.Group {
  const group = new THREE.Group();
  // Unlit and just under the bloom threshold: bloom on bright glyphs is what made board text look blurry.
  texture.anisotropy = 16;
  const face = new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(0.8, 0.8, 0.8) });
  // Double-sided boards show the face on the back too (readable from both sides).
  const board = new THREE.Mesh(compactFaceGroups(new THREE.BoxGeometry(width, height, 0.12), [0, 0, 0, 0, 1, doubleSided ? 1 : 0]), [darkWoodMaterial, face]);
  board.position.y = postHeight + height / 2;
  board.castShadow = true;
  group.add(board);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, postHeight + height + 0.35, 0.18), woodMaterial);
    post.position.set(side * (width / 2 + 0.05), (postHeight + height + 0.35) / 2, -0.02);
    post.castShadow = true;
    group.add(post);
  }
  // Little gabled cap over the board.
  const cap = new THREE.Mesh(new THREE.BoxGeometry(width + 0.6, 0.12, 0.6), darkWoodMaterial);
  cap.position.set(0, postHeight + height + 0.4, 0.1);
  cap.castShadow = true;
  group.add(cap);
  return group;
}

// ---------------------------------------------------------------- awnings

function awningTexture(colorA: string, colorB: string): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 16;
  const context = canvas.getContext("2d")!;
  const stripes = 8;
  for (let i = 0; i < stripes; i++) {
    context.fillStyle = i % 2 === 0 ? colorA : colorB;
    context.fillRect((i * canvas.width) / stripes, 0, canvas.width / stripes, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

/**
 * Striped canvas awning sloping out from a facade, with a scalloped
 * valance. Local frame: attached along local X at the origin, sloping
 * toward +Z and down.
 */
export function buildAwning(width: number, depth: number, drop: number, colorA = "#c8343a", colorB = "#f3e6d0"): THREE.Mesh {
  const texture = awningTexture(colorA, colorB);
  texture.repeat.set(width / 2.2, 1);
  const material = new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.85 });
  const slopeLength = Math.hypot(depth, drop);
  const canopy = new THREE.PlaneGeometry(width, slopeLength);
  canopy.rotateX(-Math.PI / 2 + Math.atan2(drop, depth));
  canopy.translate(0, -drop / 2, depth / 2);
  const scallops: THREE.BufferGeometry[] = [canopy];
  const count = Math.max(2, Math.round(width / 0.55));
  const scallopWidth = width / count;
  for (let i = 0; i < count; i++) {
    const scallop = new THREE.CircleGeometry(scallopWidth / 2, 8, Math.PI, Math.PI);
    const uv = scallop.getAttribute("uv") as THREE.BufferAttribute;
    for (let j = 0; j < uv.count; j++) uv.setXY(j, (i + uv.getX(j)) / count * (width / 2.2), 0.5);
    scallop.translate(-width / 2 + scallopWidth * (i + 0.5), -drop, depth);
    scallops.push(scallop);
  }
  const mesh = new THREE.Mesh(mergeGeometries(scallops), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "Awning";
  return mesh;
}

// ---------------------------------------------------------------- bunting & string lights

/** Points along a sagging rope between a and b. */
export function catenary(a: THREE.Vector3, b: THREE.Vector3, sag: number, segments: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const point = a.clone().lerp(b, t);
    point.y -= Math.sin(Math.PI * t) * sag;
    points.push(point);
  }
  return points;
}

const BUNTING_COLORS = [0xd8433a, 0xf2b440, 0x3e6fb8, 0x7a4fa0, 0xe9e0cf, 0x4f9a6a];

/** Triangular pennant strings — every rope in one merged, vertex-colored mesh. */
export function buildBunting(ropes: readonly { a: THREE.Vector3; b: THREE.Vector3; sag: number }[]): THREE.Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  const random = seededRandom(99);
  for (const rope of ropes) {
    const length = rope.a.distanceTo(rope.b);
    const flags = Math.max(3, Math.floor(length / 0.55));
    const points = catenary(rope.a, rope.b, rope.sag, flags);
    for (let i = 0; i < flags; i++) {
      const p0 = points[i]!;
      const p1 = points[i + 1]!;
      const mid = p0.clone().lerp(p1, 0.5);
      mid.y -= 0.42;
      color.setHex(BUNTING_COLORS[Math.floor(random() * BUNTING_COLORS.length)]!);
      for (const p of [p0, p1, mid]) {
        positions.push(p.x, p.y, p.z);
        colors.push(color.r, color.g, color.b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9, emissive: 0x221510 }),
  );
  mesh.name = "Bunting";
  return mesh;
}

// ---------------------------------------------------------------- glow points

export interface GlowPoint {
  readonly position: THREE.Vector3;
  readonly size: number;
  readonly color?: THREE.ColorRepresentation;
}

/**
 * Additive camera-facing glow halos (lanterns, windows, string lights)
 * as ONE `THREE.Points` draw call with per-point size and color.
 */
export function buildGlowPoints(points: readonly GlowPoint[]): THREE.Points {
  const positions = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  const sizes = new Float32Array(points.length);
  const color = new THREE.Color();
  points.forEach((point, index) => {
    positions.set([point.position.x, point.position.y, point.position.z], index * 3);
    color.set(point.color ?? 0xffb35c);
    colors.set([color.r, color.g, color.b], index * 3);
    sizes[index] = point.size;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: glowTexture() }, scale: { value: window.innerHeight * 0.5 } },
    vertexShader: /* glsl */ `
      attribute float size;
      varying vec3 vColor;
      uniform float scale;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vColor * t.rgb * 1.6, t.a);
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Points(geometry, material);
  mesh.name = "GlowPoints";
  mesh.frustumCulled = false;
  return mesh;
}

/** Tiny emissive bulbs (string lights) — instanced spheres, bloom does the glow. */
export function buildBulbs(positions: readonly THREE.Vector3[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.06, 6, 4),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.9, 0.8) }),
    Math.max(1, positions.length),
  );
  const matrix = new THREE.Matrix4();
  positions.forEach((position, index) => mesh.setMatrixAt(index, matrix.makeTranslation(position.x, position.y, position.z)));
  mesh.count = positions.length;
  mesh.computeBoundingSphere();
  mesh.name = "StringLights";
  return mesh;
}

// ---------------------------------------------------------------- fire

export interface FireInstance {
  readonly group: THREE.Group;
  update(time: number): void;
}

/** Animated billboard flame (2 crossed sprites) for fire pits and braziers. */
export function buildFire(scale = 1, seed = 1): FireInstance {
  const group = new THREE.Group();
  const material = new THREE.SpriteMaterial({
    map: flameTexture(),
    color: new THREE.Color(1.35, 0.85, 0.42),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const sprites = [0, 1, 2].map((i) => {
    const sprite = new THREE.Sprite(material);
    sprite.position.set((i - 1) * 0.12 * scale, 0.45 * scale, (i % 2) * 0.08 * scale);
    group.add(sprite);
    return sprite;
  });
  return {
    group,
    update(time) {
      sprites.forEach((sprite, i) => {
        const flicker = 0.85 + 0.15 * Math.sin(time * (9 + i * 2.3) + seed * 3.1 + i) + 0.08 * Math.sin(time * 23 + i);
        sprite.scale.set(0.55 * scale * (1.1 - i * 0.15), 1.1 * scale * flicker * (1 - i * 0.12), 1);
      });
    },
  };
}

// ---------------------------------------------------------------- misc procedural

/** Stone pillar with a cap — terrace gateposts that carry a lantern and a banner. */
let sharedStone: THREE.MeshStandardMaterial | null = null;
let sharedSoil: THREE.MeshStandardMaterial | null = null;
function propStone(): THREE.MeshStandardMaterial {
  sharedStone ??= new THREE.MeshStandardMaterial({ map: stoneBlockTexture(), color: 0xded2cc, roughness: 0.92 });
  return sharedStone;
}

export function buildPillar(height: number): THREE.Mesh {
  const stone = propStone();
  const parts = [texturedBox(0.75, height, 0.75, 1.2).translate(0, height / 2, 0), texturedBox(0.95, 0.2, 0.95, 1).translate(0, height + 0.1, 0)];
  const mesh = new THREE.Mesh(mergeGeometries(parts), stone);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Rectangular stone planter box (filled with flowers by the caller). */
export function buildPlanter(width: number, depth: number, height = 0.55): THREE.Group {
  const group = new THREE.Group();
  const box = new THREE.Mesh(texturedBox(width, height, depth, 1.2), propStone());
  box.position.y = height / 2;
  box.castShadow = true;
  box.receiveShadow = true;
  sharedSoil ??= new THREE.MeshStandardMaterial({ color: 0x2c261f });
  const soil = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.2, depth - 0.2), sharedSoil);
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = height + 0.005;
  group.add(box, soil);
  return group;
}

export interface FeaturedProjectCard {
  readonly name: string;
  readonly description: string;
  readonly hue: number;
}

/** "Featured Projects" board face: up to three project cards, each with its name, description and two button chips. */
export function featuredProjectsTexture(cards: readonly FeaturedProjectCard[]): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 768;
  const context = canvas.getContext("2d")!;
  const background = context.createLinearGradient(0, 0, 0, canvas.height);
  background.addColorStop(0, "#3b2717");
  background.addColorStop(1, "#2a1b10");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f3e2bd";
  context.font = "700 64px Georgia, serif";
  context.textAlign = "left";
  context.fillText("Featured Projects", 48, 86);
  drawEmblem(context, canvas.width - 80, 64, 70, "#f2b440");

  cards.slice(0, 3).forEach((card, index) => {
    const top = 130 + index * 205;
    context.fillStyle = "rgba(20,14,10,0.75)";
    context.beginPath();
    context.roundRect(40, top, canvas.width - 80, 180, 18);
    context.fill();
    const art = context.createLinearGradient(60, top + 20, 220, top + 160);
    art.addColorStop(0, `hsl(${card.hue}, 60%, 55%)`);
    art.addColorStop(1, `hsl(${(card.hue + 50) % 360}, 55%, 25%)`);
    context.fillStyle = art;
    context.beginPath();
    context.roundRect(60, top + 20, 160, 140, 12);
    context.fill();
    drawEmblem(context, 140, top + 90, 70, "rgba(255,240,210,0.55)");
    context.fillStyle = "#f6ead2";
    context.font = "700 44px 'Segoe UI', system-ui, sans-serif";
    context.fillText(card.name, 250, top + 64);
    context.fillStyle = "#d8c7a8";
    context.font = "400 28px 'Segoe UI', system-ui, sans-serif";
    wrapText(context, card.description, 250, top + 104, 450, 32, 2);
    // Visual "button" chips — the real actions live in the project panel (press E).
    chip(context, 730, top + 30, 240, 50, "#3a3f4a", "#e9e2d6", "View Project");
    chip(context, 730, top + 100, 240, 50, "#e39a2d", "#24170b", "Support with ZEC");
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function chip(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bg: string, fg: string, label: string): void {
  context.fillStyle = bg;
  context.beginPath();
  context.roundRect(x, y, w, h, 10);
  context.fill();
  context.fillStyle = fg;
  context.font = "700 22px 'Segoe UI', system-ui, sans-serif";
  context.textAlign = "center";
  context.fillText(label, x + w / 2, y + h / 2 + 9);
  context.textAlign = "left";
}

function wrapText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): void {
  const words = text.split(" ");
  let line = "";
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (context.measureText(test).width > maxWidth && line) {
      context.fillText(lines === maxLines - 1 ? `${line}…` : line, x, y + lines * lineHeight);
      lines++;
      if (lines >= maxLines) return;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) context.fillText(line, x, y + lines * lineHeight);
}
