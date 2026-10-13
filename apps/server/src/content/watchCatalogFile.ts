import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SAMPLE_WATCH_CATALOG } from "./watchCatalog.sample.js";
import { parseWatchCatalog, type WatchCatalog } from "./watchCatalogTypes.js";

/** Where a deployment may keep its own catalogue file when WATCH_CATALOG_FILE is not set (next to `src/`). */
export const DEFAULT_WATCH_CATALOG_FILE = fileURLToPath(new URL("../../content-production/watch-catalog.json", import.meta.url));

export interface LoadedWatchCatalog {
  readonly catalog: WatchCatalog;
  /** The file it was read from, or "sample catalogue". */
  readonly origin: string;
}

/**
 * The watch catalogue the server starts with: the JSON file named by WATCH_CATALOG_FILE; without it, the file at
 * `defaultFile` when one exists; otherwise the sample catalogue. A file that cannot be read or does not pass
 * `parseWatchCatalog` stops the start with the reason, rather than serving a different catalogue.
 */
export function loadWatchCatalog(configured: string | undefined, defaultFile = DEFAULT_WATCH_CATALOG_FILE): LoadedWatchCatalog {
  const file = configured?.trim() || (existsSync(defaultFile) ? defaultFile : "");
  if (!file) return { catalog: SAMPLE_WATCH_CATALOG, origin: "sample catalogue" };
  try {
    return { catalog: parseWatchCatalog(JSON.parse(readFileSync(file, "utf8")) as unknown), origin: file };
  } catch (error) {
    throw new Error(`watch catalogue ${file}: ${error instanceof Error ? error.message : "unreadable"}`);
  }
}
