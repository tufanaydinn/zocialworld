/**
 * Stage share quality (docs/architecture/WATCH_HALL.md "Share quality").
 *
 * LiveKit's default screen-share encoding (1080p at 15 fps, 2.5 Mbps) would cap a shared video at
 * 15 fps, so the presenter picks a
 * mode in the share dialog:
 *
 *  - **Slides** (the default): sharp text at 30 fps. contentHint `detail` and the encoder keeps the
 *    resolution when bandwidth drops (`maintain-resolution`), at up to 3.5 Mbps.
 *  - **Video**: smooth motion at 60 fps when the capture supports it. contentHint `motion` and the
 *    encoder keeps the frame rate (`maintain-framerate`), at up to 7 Mbps.
 *
 * Both publish two extra simulcast layers — 720p at 30 fps and 360p at 15 fps — so a viewer on a weak
 * link (the SFU picks a lower layer) or on the low render tier (which asks for the medium layer) still
 * gets a picture. Pure data: VoiceClient turns it into LiveKit options; the unit tests check it.
 */

export type StageShareMode = "slides" | "video";

export const STAGE_SHARE_MODES: readonly StageShareMode[] = ["slides", "video"];

export interface StageLayer {
  readonly width: number;
  readonly height: number;
  /** Bits per second. */
  readonly maxBitrate: number;
  readonly maxFramerate: number;
}

export interface StageShareQuality {
  /** The MediaStreamTrack content hint (W3C mst-content-hint). */
  readonly contentHint: "detail" | "motion";
  /** What getDisplayMedia is asked for (ideal values; the browser caps them to what the surface can give). */
  readonly capture: { readonly width: number; readonly height: number; readonly frameRate: number };
  /** The top (full-resolution) layer. */
  readonly encoding: { readonly maxBitrate: number; readonly maxFramerate: number };
  /** The extra simulcast layers, lowest first (LiveKit's order). */
  readonly layers: readonly StageLayer[];
  /** What the encoder gives up first when bandwidth or CPU runs short. */
  readonly degradationPreference: "maintain-resolution" | "maintain-framerate";
}

/** 360p at 15 fps — the floor for weak links (LiveKit's h360fps15 bitrate). */
export const STAGE_LAYER_LOW: StageLayer = { width: 640, height: 360, maxBitrate: 400_000, maxFramerate: 15 };
/** 720p at 30 fps — what the low render tier asks for (LiveKit's h720fps30 bitrate). */
export const STAGE_LAYER_MEDIUM: StageLayer = { width: 1280, height: 720, maxBitrate: 2_000_000, maxFramerate: 30 };

const QUALITY: Record<StageShareMode, StageShareQuality> = {
  slides: {
    contentHint: "detail",
    capture: { width: 1920, height: 1080, frameRate: 30 },
    encoding: { maxBitrate: 3_500_000, maxFramerate: 30 },
    layers: [STAGE_LAYER_LOW, STAGE_LAYER_MEDIUM],
    degradationPreference: "maintain-resolution",
  },
  video: {
    contentHint: "motion",
    capture: { width: 1920, height: 1080, frameRate: 60 },
    encoding: { maxBitrate: 7_000_000, maxFramerate: 60 },
    layers: [STAGE_LAYER_LOW, STAGE_LAYER_MEDIUM],
    degradationPreference: "maintain-framerate",
  },
};

export function stageShareQuality(mode: StageShareMode): StageShareQuality {
  return QUALITY[mode];
}

/** The most the presenter's browser sends for one share (every layer, plus the stereo tab audio at 128 kbps). */
export function presenterUploadBps(mode: StageShareMode): number {
  const quality = QUALITY[mode];
  return quality.encoding.maxBitrate + quality.layers.reduce((sum, layer) => sum + layer.maxBitrate, 0) + STAGE_AUDIO_BPS;
}

/** The stereo tab audio (LiveKit's musicHighQualityStereo preset). */
export const STAGE_AUDIO_BPS = 128_000;

/** The most the SFU sends for the stage to `viewers` viewers who all ask for the top layer (the worst case for the server's upload). */
export function serverUploadBps(mode: StageShareMode, viewers: number): number {
  return Math.max(0, viewers) * (QUALITY[mode].encoding.maxBitrate + STAGE_AUDIO_BPS);
}

const MODE_KEY = "watch-hall-share-mode-v1";

/** The mode this device picked last time (a per-viewer convenience; slides when nothing is stored or storage is blocked). */
export function readShareMode(storage: Pick<Storage, "getItem"> | null = safeStorage()): StageShareMode {
  try {
    const value = storage?.getItem(MODE_KEY);
    return value === "video" ? "video" : "slides";
  } catch {
    return "slides";
  }
}

export function writeShareMode(mode: StageShareMode, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(MODE_KEY, mode);
  } catch {
    // Private mode / blocked storage: the dialog just starts on Slides next time.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
