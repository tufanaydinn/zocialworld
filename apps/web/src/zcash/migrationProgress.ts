/**
 * ADR-018 § 3: the estimated progress of the one-time rescan that restores a Stage 1 wallet on the Stage 2 engine.
 * The engine holds its database for the whole scan and reports nothing until it ends, so the wallet panel shows an
 * estimate — labelled as one — from the number of blocks to scan and the Stage 2 engine's measured mainnet speed:
 * 30,000 blocks in 800.7 s (≈ 37 blocks/s, headless Chromium, 4 threads; 922 s on a loaded machine). A slower machine simply
 * sits at the cap until the scan ends. Pure: no DOM, no wallet engine.
 */

/** Blocks per second the estimate assumes (a little under the measured 37, so it rather finishes early than late). */
export const MIGRATION_BLOCKS_PER_SECOND = 33;
/** The bar never claims more than this until the rescan has actually finished. */
export const MIGRATION_PROGRESS_CAP = 0.95;

export interface MigrationProgress {
  /** Blocks to scan (tip − birthday), or null while the tip is unknown. */
  readonly blocks: number | null;
  /** Estimated fraction done, 0 … MIGRATION_PROGRESS_CAP (0 while the tip is unknown). */
  readonly fraction: number;
  /** Estimated total minutes for the rescan (at least 1), or null while the tip is unknown. */
  readonly etaMinutes: number | null;
  readonly elapsedSeconds: number;
}

export function migrationProgress(migration: { readonly fromHeight: number; readonly tipHeight: number | null; readonly startedAt: number }, now: number): MigrationProgress {
  const elapsedSeconds = Math.max(0, Math.floor((now - migration.startedAt) / 1000));
  if (migration.tipHeight === null || !Number.isFinite(migration.tipHeight)) return { blocks: null, fraction: 0, etaMinutes: null, elapsedSeconds };
  const blocks = Math.max(0, migration.tipHeight - migration.fromHeight);
  const totalSeconds = Math.max(1, blocks / MIGRATION_BLOCKS_PER_SECOND);
  const fraction = Math.min(MIGRATION_PROGRESS_CAP, elapsedSeconds / totalSeconds);
  return { blocks, fraction, etaMinutes: Math.max(1, Math.ceil(totalSeconds / 60)), elapsedSeconds };
}

/** 75 → "1:15"; 3725 → "1:02:05". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}
