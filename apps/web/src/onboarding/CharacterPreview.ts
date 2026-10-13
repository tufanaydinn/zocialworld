import * as THREE from "three";
import type { PlayerAvatar } from "@project/shared";
import type { RemoteAvatarLibrary } from "../networking/remoteAvatars.ts";
import { avatarColor, avatarColorCss } from "../player/avatarPalette.ts";

/**
 * The live character preview of the onboarding character step (ADR-015 § 3): the
 * chosen KayKit model on a turntable, standing on a ring in the chosen palette colour (the models
 * share one atlas material, so the colour is an accent — exactly how other players will see it).
 *
 * It has its own small WebGL renderer, separate from the world's. It renders only while attached
 * to the document, at most ~30 fps, auto-rotates and can be dragged. `dispose()` frees the renderer
 * with `forceContextLoss()` (browsers cap live WebGL contexts) and the clone's own skeleton; the
 * model geometry and material are the shared avatar templates and stay. If WebGL or the model
 * cannot load, a flat silhouette in the chosen colour stands in — onboarding never depends on it.
 */

export interface CharacterPreviewHandle {
  /** The element to place in the page (a canvas, or the fallback silhouette). */
  readonly element: HTMLElement;
  /** Shows `avatar` (loads its model if needed; the ring colour changes at once). */
  show(avatar: PlayerAvatar): void;
  dispose(): void;
}

export interface CharacterPreviewOptions {
  readonly avatars: RemoteAvatarLibrary;
  readonly width?: number;
  readonly height?: number;
}

const FRAME_MS = 1000 / 30;
const AUTO_ROTATE_RADIANS_PER_SECOND = 0.45;

export function createCharacterPreview(options: CharacterPreviewOptions): CharacterPreviewHandle {
  try {
    return new TurntablePreview(options);
  } catch (error) {
    console.warn("[onboarding] character preview unavailable, showing a silhouette:", error);
    return new SilhouettePreview();
  }
}

class TurntablePreview implements CharacterPreviewHandle {
  readonly element: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly turntable = new THREE.Group();
  private readonly ringMaterial: THREE.MeshStandardMaterial;
  private readonly glowMaterial: THREE.MeshBasicMaterial;
  private readonly avatars: RemoteAvatarLibrary;
  private readonly fallback = new SilhouettePreview();
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private wanted: PlayerAvatar | null = null;
  private loadedModel: string | null = null;
  private frame = 0;
  private lastRender = 0;
  private dragging: { x: number; rotation: number } | null = null;
  private idleSince = 0;
  private disposed = false;

  constructor(options: CharacterPreviewOptions) {
    const width = options.width ?? 320;
    const height = options.height ?? 400;
    this.avatars = options.avatars;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    const canvas = this.renderer.domElement;
    canvas.className = "zw-onb-preview-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Your character, turning slowly — drag to rotate");

    const wrap = document.createElement("div");
    wrap.className = "zw-onb-preview";
    wrap.append(canvas, this.fallback.element);
    this.fallback.element.hidden = true;
    this.element = wrap;

    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 50);
    this.camera.position.set(0, 1.25, 5.4);
    this.camera.lookAt(0, 0.95, 0);
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x2a2350, 1.6));
    const key = new THREE.DirectionalLight(0xffe2b8, 2.2);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb8ff, 1.2);
    rim.position.set(-3, 2.5, -2.5);
    this.scene.add(rim);

    this.ringMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.1 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.05, 10, 48), this.ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.02;
    this.glowMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false });
    const glow = new THREE.Mesh(new THREE.CircleGeometry(0.6, 40), this.glowMaterial);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.01;
    this.scene.add(ring, glow, this.turntable);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.frame = requestAnimationFrame(this.tick);
  }

  show(avatar: PlayerAvatar): void {
    this.wanted = { ...avatar };
    const color = avatarColor(avatar.color);
    this.ringMaterial.color.copy(color);
    this.ringMaterial.emissive.copy(color).multiplyScalar(0.35);
    this.glowMaterial.color.copy(color);
    this.fallback.show(avatar);
    this.element.dataset.model = avatar.model;
    this.element.dataset.color = String(avatar.color);
    if (this.loadedModel === avatar.model) return;
    const model = avatar.model;
    this.avatars
      .instantiate({ model })
      .then(({ model: object, clips }) => {
        if (this.disposed || this.wanted?.model !== model) {
          disposeSkeletons(object);
          return;
        }
        this.setModel(object, clips, model);
      })
      .catch((error: unknown) => {
        console.warn("[onboarding] preview model unavailable:", error);
        if (!this.model) this.showFallback();
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.clearModel();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && (mesh.material === this.ringMaterial || mesh.material === this.glowMaterial)) mesh.geometry.dispose();
    });
    this.ringMaterial.dispose();
    this.glowMaterial.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.element.remove();
  }

  private setModel(object: THREE.Object3D, clips: THREE.AnimationClip[], model: string): void {
    this.clearModel();
    this.model = object;
    this.loadedModel = model;
    this.turntable.add(object);
    this.mixer = new THREE.AnimationMixer(object);
    const idle = THREE.AnimationClip.findByName(clips, "Idle");
    if (idle) this.mixer.clipAction(idle).play();
    this.element.dataset.loaded = model;
    this.renderer.domElement.hidden = false;
    this.fallback.element.hidden = true;
  }

  private clearModel(): void {
    if (!this.model) return;
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.model);
    this.mixer = null;
    this.turntable.remove(this.model);
    disposeSkeletons(this.model);
    this.model = null;
    this.loadedModel = null;
  }

  private showFallback(): void {
    this.renderer.domElement.hidden = true;
    this.fallback.element.hidden = false;
  }

  private readonly tick = (time: number): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    // Only while on the page, and at most ~30 fps: the world behind onboarding is loading at the same time.
    if (!this.element.isConnected || time - this.lastRender < FRAME_MS) return;
    const step = this.lastRender ? Math.min(0.1, (time - this.lastRender) / 1000) : 0;
    this.lastRender = time;
    if (!this.dragging && time - this.idleSince > 600) this.turntable.rotation.y += AUTO_ROTATE_RADIANS_PER_SECOND * step;
    this.mixer?.update(step);
    this.renderer.render(this.scene, this.camera);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.dragging = { x: event.clientX, rotation: this.turntable.rotation.y };
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.turntable.rotation.y = this.dragging.rotation + (event.clientX - this.dragging.x) * 0.012;
  };

  private readonly onPointerUp = (): void => {
    if (!this.dragging) return;
    this.dragging = null;
    this.idleSince = performance.now();
  };
}

/** The no-WebGL stand-in: a flat character silhouette in the chosen colour. */
class SilhouettePreview implements CharacterPreviewHandle {
  readonly element: HTMLElement;
  private readonly body: SVGElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "zw-onb-preview zw-onb-silhouette";
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", "Your character (simple preview)");
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 100 160");
    const shape = document.createElementNS(ns, "path");
    // Head, shoulders, body and legs — one path, filled with the palette colour.
    shape.setAttribute("d", "M50 8a16 16 0 1 1 0 32a16 16 0 1 1 0-32Zm-24 40h48c8 0 13 6 13 14v34c0 4-3 6-6 6h-6v50h-14v-40h-10v40h-14v-50h-6c-3 0-6-2-6-6v-34c0-8 5-14 13-14Z");
    svg.appendChild(shape);
    this.body = shape;
    this.element.appendChild(svg);
  }

  show(avatar: PlayerAvatar): void {
    this.body.setAttribute("fill", avatarColorCss(avatar.color));
    this.element.dataset.model = avatar.model;
    this.element.dataset.color = String(avatar.color);
  }

  dispose(): void {
    this.element.remove();
  }
}

function disposeSkeletons(root: THREE.Object3D): void {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skeletons.add((object as THREE.SkinnedMesh).skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
}
