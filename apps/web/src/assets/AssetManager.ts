import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AssetPackMissingError, installedAssetPacks, isAssetAvailable } from "./assetPacks.ts";

/**
 * Centralized GLTF/GLB loading.
 *
 * Code that adds characters, props or environment pieces should load them through this class instead of instantiating
 * `GLTFLoader` in scene code. That gives us, in one place:
 *
 *  - caching (a model requested twice is only downloaded/parsed once),
 *  - safe re-use (cloning skinned meshes correctly via SkeletonUtils, so
 *    multiple characters can share one source GLB without fighting over
 *    the same skeleton),
 *  - consistent error handling and load-progress reporting,
 *  - a single spot to add future Draco/Meshopt decompression.
 *
 * Third-party model packs are listed in assets/asset-registry.json and
 * downloaded separately; a missing pack is never requested (assetPacks.ts).
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
  private readonly installedPacks = installedAssetPacks();

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** Loads (or returns the cached parse of) a .glb/.gltf file. */
  async loadGltf(url: string): Promise<GLTF> {
    let pending = this.gltfCache.get(url);
    if (!pending && !isAssetAvailable(url, this.installedPacks)) {
      // A file of a pack this checkout does not have: fail at once, without a request (callers keep their placeholder).
      pending = Promise.reject(new AssetPackMissingError(url));
      this.gltfCache.set(url, pending);
    }
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
