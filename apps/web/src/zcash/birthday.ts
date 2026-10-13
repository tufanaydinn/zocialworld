/**
 * "When did you create this wallet?" → a birthday height for an imported mainnet seed (ADR-018 § 1),
 * so the first scan does not start at Sapling's activation in 2018.
 *
 * A fixed anchor table of network upgrades (height and activation date), then 75-second blocks — 25-second blocks
 * after NU7 (ZIP 218) once its mainnet height is known. The estimate takes the first day of the chosen month, goes
 * back a safety margin (a wallet "created in March" may have received its first coins on March 1st, and real block
 * times drift from the target), and is clamped between Sapling's activation and the estimated chain tip.
 * "Not sure" starts at NU5 (2022-05-31): slower (years of blocks to scan), but it finds every Sapling note since.
 *
 * NU7: set NU7_ACTIVATION_HEIGHT below when the mainnet height is announced (ZIP 259; expected 2026-10-20, for
 * activation around 2026-11-05) — and rebuild the wallet engine with NU7 support.
 *
 * Pure: no DOM, no wallet engine. Times are UTC.
 */

export interface UpgradeAnchor {
  readonly name: string;
  readonly height: number;
  /** Activation date, UTC midnight, as ms since epoch. */
  readonly time: number;
}

const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

/** Mainnet upgrade anchors (height, activation day). */
export const MAINNET_ANCHORS: readonly UpgradeAnchor[] = [
  { name: "Sapling", height: 419_200, time: day("2018-10-28") },
  { name: "NU5", height: 1_687_104, time: day("2022-05-31") },
  { name: "NU6", height: 2_726_400, time: day("2024-11-23") },
  { name: "NU6.3", height: 3_428_143, time: day("2026-07-28") },
];

export const SAPLING_ACTIVATION_HEIGHT = 419_200;
export const NU5_ACTIVATION_HEIGHT = 1_687_104;
/** Block target before NU7 (Blossom onwards). */
export const PRE_NU7_BLOCK_SECONDS = 75;
/** ZIP 218: the block target after NU7. */
export const POST_NU7_BLOCK_SECONDS = 25;
/**
 * The NU7 mainnet activation height — null until announced. SET IT HERE (one constant) when ZIP 259 / librustzcash
 * fix it; the estimator then counts 25-second blocks after it.
 */
export const NU7_ACTIVATION_HEIGHT: number | null = null;
/** How far before the start of the chosen month the scan starts. */
export const SAFETY_MARGIN_DAYS = 7;

export interface BirthdayChoice {
  /** null = "not sure". */
  readonly year: number | null;
  /** 1–12; ignored when year is null. */
  readonly month: number;
}

export interface BirthdayEstimate {
  readonly height: number;
  /** "Not sure", or a date before Sapling: the scan is long (minutes to tens of minutes). */
  readonly slow: boolean;
  /** The choice was in the future or before Sapling, so the height was clamped. */
  readonly clamped: boolean;
}

/** The height the chain is estimated to have reached at `time` (ms), with an optional NU7 height. */
export function estimateHeightAt(time: number, nu7Height: number | null = NU7_ACTIVATION_HEIGHT, anchors: readonly UpgradeAnchor[] = MAINNET_ANCHORS): number {
  let anchor = anchors[0]!;
  for (const candidate of anchors) if (candidate.time <= time) anchor = candidate;
  // Before the first anchor (Sapling): extrapolate backwards — estimateBirthday clamps it to Sapling's activation.
  if (time <= anchor.time) return anchor.height - Math.floor((anchor.time - time) / 1000 / PRE_NU7_BLOCK_SECONDS);
  const seconds = (time - anchor.time) / 1000;
  const height = anchor.height + Math.floor(seconds / PRE_NU7_BLOCK_SECONDS);
  if (nu7Height === null || height <= nu7Height || anchor.height >= nu7Height) return height;
  // Past NU7: the blocks before it at 75 s, the rest at 25 s.
  const nu7Time = anchor.time + (nu7Height - anchor.height) * PRE_NU7_BLOCK_SECONDS * 1000;
  return nu7Height + Math.floor((time - nu7Time) / 1000 / POST_NU7_BLOCK_SECONDS);
}

/**
 * The birthday for a month/year (or "not sure"), at `now`. Clamped to [Sapling activation, estimated tip − 100];
 * `tipHeight`, when the wallet knows the real tip, caps it too.
 */
export function estimateBirthday(choice: BirthdayChoice, now: number, options: { readonly nu7Height?: number | null; readonly tipHeight?: number | null } = {}): BirthdayEstimate {
  const nu7 = options.nu7Height === undefined ? NU7_ACTIVATION_HEIGHT : options.nu7Height;
  const tip = Math.min(estimateHeightAt(now, nu7), options.tipHeight ?? Number.POSITIVE_INFINITY);
  const ceiling = Math.max(SAPLING_ACTIVATION_HEIGHT, tip - 100);
  if (choice.year === null) return { height: Math.min(NU5_ACTIVATION_HEIGHT, ceiling), slow: true, clamped: false };
  const month = Math.min(12, Math.max(1, Math.trunc(choice.month)));
  const start = Date.UTC(choice.year, month - 1, 1) - SAFETY_MARGIN_DAYS * 86_400_000;
  const raw = estimateHeightAt(start, nu7);
  const height = Math.min(ceiling, Math.max(SAPLING_ACTIVATION_HEIGHT, raw));
  const clamped = height !== raw || start > now;
  return { height, slow: height < NU5_ACTIVATION_HEIGHT, clamped };
}

/** Years offered in the import form: Sapling's year (2018) to this year, newest first. */
export function birthdayYears(now: number): number[] {
  const current = new Date(now).getUTCFullYear();
  const years: number[] = [];
  for (let year = current; year >= 2018; year--) years.push(year);
  return years;
}
