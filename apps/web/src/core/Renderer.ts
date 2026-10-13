import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { detectQuality, type QualityTier } from "./quality.ts";
import { applyShaderPatches } from "./shaderPatches.ts";
import { initialPacing, pace, type PacingState } from "./framePacing.ts";

applyShaderPatches();

const MSAA_SAMPLES = 4;

/**
 * Thin wrapper around THREE.WebGLRenderer.
 *
 * Owns the canvas, pixel-ratio policy and resize handling so no other
 * module needs to touch `window.innerWidth/innerHeight` or renderer
 * settings directly. Performance-sensitive defaults (capped pixel ratio,
 * no unnecessary antialiasing cost on high-DPI screens) live here.
 *
 * A light bloom pass (half-resolution UnrealBloom) is applied so the
 * district's lanterns, windows and fires glow in the dusk lighting.
 * It can be disabled with `?bloom=0` for low-end GPUs / comparisons.
 */
export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly domElement: HTMLCanvasElement;
  readonly quality: QualityTier;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private readonly bloomEnabled: boolean;
  private width = 1;
  private height = 1;

  /** Adaptive resolution (high tier): the base pixel ratio, scaled by the pacing state's resolutionScale. */
  private readonly basePixelRatio: number;
  private readonly adaptiveEnabled: boolean;
  /**
   * Frame pacing (core/framePacing.ts): resolution scale, and scene-target MSAA (bloom path, DPR < 1.5), which is
   * dropped first when frames run slow, before any resolution loss.
   */
  private readonly pacing: PacingState;
  private lastAdaptAt = 0;

  constructor(container: HTMLElement) {
    this.quality = detectQuality();
    this.bloomEnabled = this.quality === "high" && new URLSearchParams(window.location.search).get("bloom") !== "0";
    // With bloom the scene renders into the composer's (non-multisampled) target and only a full-screen quad reaches the
    // canvas, so canvas MSAA would cost bandwidth every frame without changing a single pixel.
    this.webgl = new THREE.WebGLRenderer({
      antialias: !this.bloomEnabled,
      powerPreference: "high-performance",
    });

    // Capping DPR keeps retina/4K displays from tanking fill-rate; software
    // rasterizers are fill-bound, so the low tier renders at reduced resolution.
    this.basePixelRatio = this.quality === "low" ? 0.4 : Math.min(window.devicePixelRatio, 2);
    this.webgl.setPixelRatio(this.basePixelRatio);
    this.adaptiveEnabled = this.quality === "high" && new URLSearchParams(window.location.search).get("adaptive") !== "0";
    this.pacing = initialPacing(this.bloomEnabled && this.basePixelRatio < 1.5);
    this.webgl.shadowMap.enabled = this.quality === "high";
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.1;

    // The bloom composer issues several render calls per frame; reset stats once per frame in render() instead,
    // so DebugStats reports the whole frame (scene + post passes), not just the last pass.
    this.webgl.info.autoReset = false;

    this.domElement = this.webgl.domElement;
    container.appendChild(this.domElement);

    this.resize(container.clientWidth, container.clientHeight);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.webgl.setSize(this.width, this.height, false);
    this.composer?.setSize(this.width, this.height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.webgl.info.reset();
    if (!this.bloomEnabled) {
      this.webgl.render(scene, camera);
      return;
    }
    if (!this.composer || !this.renderPass) {
      // Multisampled scene target: real antialiasing on the bloom path. High-DPI screens (≥1.5) already render enough
      // pixels for clean edges, so they skip the cost.
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.pacing.msaaOn ? MSAA_SAMPLES : 0 });
      this.composer = new EffectComposer(this.webgl, target);
      this.renderPass = new RenderPass(scene, camera);
      this.composer.addPass(this.renderPass);
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.width / 2, this.height / 2), 0.55, 0.45, 0.82));
      this.composer.addPass(new OutputPass());
      this.composer.setSize(this.width, this.height);
    }
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    this.composer.render();
  }

  /**
   * Frame-pacing guard (core/framePacing.ts): when frames run slow for a while (weaker GPU,
   * big window, 4K screen) MSAA goes first, then the render resolution steps down so motion
   * stays smooth instead of stuttering; it climbs back when there is headroom. Bounded to
   * 75–100% of the base pixel ratio (lower made text visibly soft). It measures
   * real elapsed time between calls (the game loop's step is clamped to 1/15 s), and reports
   * `crowdReduced` when even the floor is too slow.
   */
  adapt(_deltaSeconds: number, now = performance.now()): void {
    if (!this.adaptiveEnabled) return;
    const frame = this.lastAdaptAt > 0 ? (now - this.lastAdaptAt) / 1000 : 1 / 60;
    this.lastAdaptAt = now;
    const action = pace(this.pacing, frame);
    if (action === "msaa-off" || action === "msaa-on") this.setMsaa(this.pacing.msaaOn);
    else if (action === "resolution") {
      this.webgl.setPixelRatio(this.basePixelRatio * this.pacing.resolutionScale);
      this.composer?.setPixelRatio(this.basePixelRatio * this.pacing.resolutionScale);
      this.resize(this.width, this.height);
    }
  }

  /** Frames stay slow with MSAA off and the resolution at its floor — the crowd should animate with less detail. */
  get crowdReduced(): boolean {
    return this.pacing.crowdReduced;
  }

  private setMsaa(on: boolean): void {
    if (!this.composer) return;
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      target.samples = on ? MSAA_SAMPLES : 0;
      target.dispose();
    }
  }

  /** Current render-resolution fraction (1 = full), for the debug overlay. */
  get currentResolutionScale(): number {
    return this.pacing.resolutionScale;
  }

  /** Whether the bloom path's scene target is multisampled right now (the adaptive guard drops it first). */
  get msaaActive(): boolean {
    return this.pacing.msaaOn;
  }

  /**
   * Compiles every material/program the scene needs up front, so the
   * first time the camera turns toward new content there is no shader
   * compile hitch ("freeze on first look").
   */
  async warmUp(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    if (this.quality === "high") this.raiseAnisotropy(scene);
    try {
      await this.webgl.compileAsync(scene, camera);
      // Upload every texture now too, so the first look at a board or a first visit to another location doesn't stall.
      // GPUs only: a software rasterizer builds mipmaps on the CPU, so there it's cheaper to upload lazily on first sight.
      if (this.quality === "high") scene.traverse((object) => {
        const materials = (object as THREE.Mesh).material;
        if (!materials) return;
        for (const material of Array.isArray(materials) ? materials : [materials]) {
          for (const value of Object.values(material)) if ((value as THREE.Texture)?.isTexture) this.webgl.initTexture(value as THREE.Texture);
        }
      });
    } catch (error) {
      console.warn("[renderer] shader warm-up skipped:", error);
    }
  }

  /** Sharper ground/wall textures at grazing angles on GPUs (cheap there; very costly on software rasterizers). */
  private raiseAnisotropy(scene: THREE.Scene): void {
    const level = Math.min(8, this.webgl.capabilities.getMaxAnisotropy());
    scene.traverse((object) => {
      const materials = (object as THREE.Mesh).material;
      if (!materials) return;
      for (const material of Array.isArray(materials) ? materials : [materials]) {
        const map = (material as THREE.MeshStandardMaterial).map;
        if (map && map.anisotropy < level) {
          map.anisotropy = level;
          map.needsUpdate = true;
        }
      }
    });
  }

  dispose(): void {
    this.composer?.dispose();
    this.webgl.dispose();
    this.domElement.remove();
  }
}
