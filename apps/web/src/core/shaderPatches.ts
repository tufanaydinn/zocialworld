import { ShaderChunk } from "three";

/**
 * Point lights in the district are short-range (8–16 m) lanterns and
 * fires, but three.js evaluates the full BRDF for every point light on
 * every lit pixel. Beyond a light's cutoff distance its attenuation is
 * exactly zero (`directLight.visible == false`), so skipping the BRDF
 * there yields bit-identical output while most pixels skip most lights.
 */
const MARKER = "/* point-light range skip */";

export function applyShaderPatches(): void {
  const chunk = ShaderChunk.lights_fragment_begin;
  if (chunk.includes(MARKER)) return;
  const start = chunk.indexOf("#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )");
  const end = chunk.indexOf("#if ( NUM_SPOT_LIGHTS > 0 )", start);
  const call = "RE_Direct( directLight,";
  const at = start < 0 || end < 0 ? -1 : chunk.indexOf(call, start);
  if (at < 0 || at > end) {
    console.warn("[renderer] lights_fragment_begin changed upstream; point-light range skip not applied");
    return;
  }
  ShaderChunk.lights_fragment_begin = `${chunk.slice(0, at)}${MARKER} if ( directLight.visible ) ${chunk.slice(at)}`;
}
