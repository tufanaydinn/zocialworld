import type * as THREE from "three";
import { MeshLambertMaterial as LambertMaterial } from "three";

/**
 * Render quality tier.
 *
 *  - "high": bloom, shadow map, full-resolution canvas, full NPC crowd.
 *  - "low": no bloom, no shadow map, reduced render resolution, a lighter
 *    crowd — for machines without GPU acceleration (software rasterizers
 *    such as SwiftShader / llvmpipe), where the district would otherwise
 *    drop to ~1 FPS.
 *
 * Auto-detected from the WebGL renderer string; `?quality=high|low`
 * overrides the detection (useful for comparisons and screenshots).
 */
export type QualityTier = "high" | "low";

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export function detectQuality(): QualityTier {
  const override = new URLSearchParams(window.location.search).get("quality");
  if (override === "high" || override === "low") return override;
  // Probe a throwaway context: the tier decides how the real renderer's context is created (e.g. antialiasing).
  const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
  if (!gl) return "low";
  let renderer = String(gl.getParameter(gl.RENDERER) ?? "");
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (debugInfo) renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? renderer);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return SOFTWARE_RENDERER.test(renderer) ? "low" : "high";
}

/**
 * Low-tier material pass: swaps every MeshStandardMaterial under `root`
 * for an equivalent MeshLambertMaterial (same color/map/emissive) and
 * hides point lights. On a software rasterizer per-pixel PBR with a
 * dozen lights is the dominant cost; Lambert + emissive glows keeps the
 * look recognizably the same at a fraction of the fill cost.
 */
export function simplifyForLowQuality(root: THREE.Object3D, cache = new Map<string, THREE.Material>()): void {
  root.traverse((object) => {
    if ((object as THREE.PointLight).isPointLight) {
      object.visible = false;
      return;
    }
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (material: THREE.Material): THREE.Material => {
      const standard = material as THREE.MeshStandardMaterial;
      if (!standard.isMeshStandardMaterial) return material;
      let lambert = cache.get(standard.uuid);
      if (!lambert) {
        lambert = new LambertMaterial({
          color: standard.color,
          map: standard.map,
          emissive: standard.emissive,
          emissiveMap: standard.emissiveMap,
          emissiveIntensity: standard.emissiveIntensity,
          vertexColors: standard.vertexColors,
          transparent: standard.transparent,
          opacity: standard.opacity,
          side: standard.side,
          alphaTest: standard.alphaTest,
          flatShading: standard.flatShading,
        });
        cache.set(standard.uuid, lambert);
      }
      return lambert;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}
