/**
 * Runtime URLs for the curated CC0 asset library in
 * `apps/web/public/assets/`. One helper per source pack so layout code
 * never hand-builds paths (and a typo'd pack folder fails in one place).
 * Provenance for every pack: `assets/asset-registry.json` +
 * `assets/LICENSES.md`.
 */

const BASE = "/assets";

/** Kenney Fantasy Town Kit 2.0 (CC0) — modular walls, roofs, stairs, stalls, lanterns. */
export const town = (name: string): string => `${BASE}/environment/kenney-fantasy-town/${name}.glb`;
/** Kenney Nature Kit 2.1 (CC0) — trees, flowers, rocks, cliffs. */
export const nature = (name: string): string => `${BASE}/environment/kenney-nature/${name}.glb`;
/** Kenney Castle Kit 2.0 (CC0) — towers, walls and flags for the far skyline. */
export const castle = (name: string): string => `${BASE}/environment/kenney-castle/${name}.glb`;
/** KayKit Dungeon Remastered 1.0 (CC0) — tables, barrels, candles, banners. */
export const dungeon = (name: string): string => `${BASE}/props/kaykit-dungeon/${name}.glb`;
/** KayKit Restaurant Bits 1.0 (CC0) — produce crates, round tables, chairs. */
export const restaurant = (name: string): string => `${BASE}/props/kaykit-restaurant/${name}.gltf`;
/** KayKit Halloween Bits 1.0 (CC0) — hanging/standing lanterns, benches, plaques. */
export const halloween = (name: string): string => `${BASE}/props/kaykit-halloween/${name}.gltf`;
/** KayKit Medieval Hexagon Pack 1.0 (CC0) — crates, sacks, flags, workshop props. */
export const medieval = (name: string): string => `${BASE}/props/kaykit-medieval/${name}.gltf`;
/** KayKit Character Pack: Adventures 1.0 (CC0) — rigged NPC characters (weapons stripped, clips pruned). */
export const character = (name: string): string => `${BASE}/characters/kaykit-adventures/${name}.glb`;
