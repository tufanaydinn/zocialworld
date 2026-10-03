import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

/**
 * Centralized GLTF/GLB loading.
 *
 * Every future agent adding characters, props or environment pieces
 * should load them through this class instead of instantiating
 * `GLTFLoader` in scene code. That gives us, in one place:
 *
 *  - caching (a model requested twice is only downloaded/parsed once),
 *  - safe re-use (cloning skinned meshes correctly via SkeletonUtils, so
 *    multiple characters can share one source GLB without fighting over
 *    the same skeleton),
 *  - consistent error handling and load-progress reporting,
 *  - a single spot to add future Draco/Meshopt decompression.
 *
 * No external assets ship with CORE-001 (see assets/asset-registry.json);
 * this class is wired and ready for the Asset Research / Character agents.
 */

export interface LoadProgress {
  url: string;
  loadedBytes: number;
  totalBytes: number;
}

export type ProgressListener = (progress: LoadProgress) => void;

export class AssetManager {
  private readonly loader = new GLTFLoader();
  private readonly gltfCache = new Map<string, Promise<GLTF>>();
  private readonly progressListeners = new Set<ProgressListener>();

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** Loads (or returns the cached parse of) a .glb/.gltf file. */
  async loadGltf(url: string): Promise<GLTF> {
    let pending = this.gltfCache.get(url);
    if (!pending) {
      pending = new Promise<GLTF>((resolve, reject) => {
        this.loader.load(
          url,
          (gltf) => resolve(gltf),
          (event) => {
            this.progressListeners.forEach((listener) =>
              listener({ url, loadedBytes: event.loaded, totalBytes: event.total }),
            );
          },
          (error) => reject(error instanceof Error ? error : new Error(`Failed to load ${url}: ${String(error)}`)),
        );
      });
      this.gltfCache.set(url, pending);
    }
    return pending;
  }

  /**
   * Loads a GLTF and returns a fresh, independently-animatable clone of
   * its scene graph — safe to call many times for many character
   * instances from the same source file.
   */
  async instantiate(url: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
    const gltf = await this.loadGltf(url);
    const scene = cloneSkeleton(gltf.scene) as THREE.Object3D;
    return { scene, animations: gltf.animations };
  }

  /** Drops a cached entry, e.g. after a known-bad load, to allow retrying. */
  invalidate(url: string): void {
    this.gltfCache.delete(url);
  }

  dispose(): void {
    this.gltfCache.clear();
    this.progressListeners.clear();
  }
}
