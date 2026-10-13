/**
 * Which third-party model packs this build can load. The packs live under `/assets/<category>/<pack>/` and are not
 * part of every checkout: `npm run assets:fetch` downloads and verifies them (assets/asset-registry.json). The dev
 * server and the build list the complete packs in `VITE_ASSET_PACKS` (apps/web/vite.config.ts), and the asset
 * manager never requests a file of a pack outside that list, so a checkout without the packs shows the procedural
 * placeholders instead of a wall of failed requests.
 */

/** The installed pack folders ("characters/kaykit-adventures", ...), or null when the build did not say (all assumed present). */
export function installedAssetPacks(listed: string | undefined = import.meta.env?.VITE_ASSET_PACKS): ReadonlySet<string> | null {
  if (listed === undefined) return null;
  return new Set(listed.split(",").map((pack) => pack.trim()).filter((pack) => pack.length > 0));
}

/** The pack folder a runtime asset URL belongs to ("/assets/props/kaykit-dungeon/keg.glb" -> "props/kaykit-dungeon"), or null. */
export function assetPackOf(url: string): string | null {
  const match = /^\/assets\/([^/]+)\/([^/]+)\/./.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** False only for a file of a pack the build knows is missing; URLs outside the packs are always allowed. */
export function isAssetAvailable(url: string, installed: ReadonlySet<string> | null = installedAssetPacks()): boolean {
  if (installed === null) return true;
  const pack = assetPackOf(url);
  return pack === null || installed.has(pack);
}

/** The error a load of a missing pack's file rejects with (callers keep their placeholder). */
export class AssetPackMissingError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`${url} belongs to a model pack that is not installed (npm run assets:fetch)`);
    this.name = "AssetPackMissingError";
    this.url = url;
  }
}
