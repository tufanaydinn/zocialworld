import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_SHARE_MODES, presenterUploadBps, readShareMode, serverUploadBps, stageShareQuality, writeShareMode } from "./stageShareQuality.ts";

// The stage share's encoding per mode (docs/architecture/WATCH_HALL.md "Share quality").

test("slides: sharp text at 30 fps (detail, keep the resolution, ~3.5 Mbps); video: smooth 60 fps (motion, keep the frame rate, ~7 Mbps)", () => {
  const slides = stageShareQuality("slides");
  assert.equal(slides.contentHint, "detail");
  assert.deepEqual(slides.capture, { width: 1920, height: 1080, frameRate: 30 });
  assert.deepEqual(slides.encoding, { maxBitrate: 3_500_000, maxFramerate: 30 });
  assert.equal(slides.degradationPreference, "maintain-resolution");
  const video = stageShareQuality("video");
  assert.equal(video.contentHint, "motion");
  assert.deepEqual(video.capture, { width: 1920, height: 1080, frameRate: 60 });
  assert.deepEqual(video.encoding, { maxBitrate: 7_000_000, maxFramerate: 60 });
  assert.equal(video.degradationPreference, "maintain-framerate");
  assert.ok(video.encoding.maxBitrate > 6_000_000 && video.encoding.maxBitrate <= 8_000_000);
  assert.ok(slides.encoding.maxBitrate >= 3_000_000 && slides.encoding.maxBitrate <= 4_000_000);
});

test("both modes publish 360p15 and 720p30 simulcast layers, lowest first, below the top layer", () => {
  for (const mode of STAGE_SHARE_MODES) {
    const quality = stageShareQuality(mode);
    assert.deepEqual(
      quality.layers.map((layer) => [layer.height, layer.maxFramerate]),
      [
        [360, 15],
        [720, 30],
      ],
      mode,
    );
    for (const layer of quality.layers) assert.ok(layer.maxBitrate < quality.encoding.maxBitrate, `${mode}: a lower layer costs less`);
  }
});

test("bandwidth: the presenter sends every layer; the server sends the top layer to each viewer (worst case)", () => {
  assert.equal(presenterUploadBps("slides"), 3_500_000 + 2_000_000 + 400_000 + 128_000);
  assert.equal(presenterUploadBps("video"), 7_000_000 + 2_000_000 + 400_000 + 128_000);
  assert.equal(serverUploadBps("slides", 59), 59 * 3_628_000);
  assert.equal(serverUploadBps("video", 59), 59 * 7_128_000);
  assert.equal(serverUploadBps("video", -1), 0);
});

test("the dialog remembers the last mode per device; slides when nothing (or garbage) is stored or storage throws", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.equal(readShareMode(storage), "slides");
  writeShareMode("video", storage);
  assert.equal(readShareMode(storage), "video");
  store.set("watch-hall-share-mode-v1", "8k");
  assert.equal(readShareMode(storage), "slides");
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readShareMode(broken), "slides");
  assert.doesNotThrow(() => writeShareMode("video", broken));
  assert.equal(readShareMode(null), "slides");
});
