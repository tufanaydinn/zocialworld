import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCH_HALL_EXIT_MARGIN_METERS, WATCH_HALL_HALF_EXTENTS, WATCH_HALL_ORIGIN } from "@project/shared";
import {
  STAGE_DUCK_GAIN,
  STAGE_VOLUME_DEFAULT,
  STAGE_VOLUME_STORAGE_KEY,
  clampStageVolume,
  effectiveSpeakerDistance,
  hasStageMic,
  loadStageVolume,
  nextInsideHall,
  resolveMicGain,
  resolveStageGain,
  saveStageVolume,
  shouldSubscribeSpeaker,
  stageSubscriptionTarget,
  type StageAudioContext,
} from "./hallAudio.ts";
import { resolveSpeakerGain } from "./VoiceProximity.ts";

// Hall audio policy (ADR-014 §§ 3–5, docs/architecture/WATCH_HALL.md).

test("stage gain is stageVolume × master × duck, zero when the holder is muted, clamped to 0–2", () => {
  assert.equal(resolveStageGain({ stageVolume: 1, masterVolume: 1, ducked: false, holderMuted: false }), 1);
  assert.equal(resolveStageGain({ stageVolume: 0.5, masterVolume: 1.5, ducked: false, holderMuted: false }), 0.75);
  assert.equal(resolveStageGain({ stageVolume: 1, masterVolume: 1, ducked: true, holderMuted: false }), STAGE_DUCK_GAIN);
  assert.equal(resolveStageGain({ stageVolume: 2, masterVolume: 1, ducked: false, holderMuted: true }), 0);
  assert.equal(resolveStageGain({ stageVolume: 2, masterVolume: 2, ducked: false, holderMuted: false }), 2);
  assert.equal(resolveStageGain({ stageVolume: 0, masterVolume: 2, ducked: false, holderMuted: false }), 0);
  // An out-of-range stage volume is clamped before use.
  assert.equal(resolveStageGain({ stageVolume: 7, masterVolume: 0.5, ducked: false, holderMuted: false }), 1);
});

test("stage volume is clamped to 0–2 and falls back to the default on garbage", () => {
  assert.equal(clampStageVolume(1.4), 1.4);
  assert.equal(clampStageVolume(-1), 0);
  assert.equal(clampStageVolume(5), 2);
  assert.equal(clampStageVolume("0.5"), 0.5);
  assert.equal(clampStageVolume("loud"), STAGE_VOLUME_DEFAULT);
  assert.equal(clampStageVolume(Number.NaN), STAGE_VOLUME_DEFAULT);
  assert.equal(clampStageVolume(undefined), STAGE_VOLUME_DEFAULT);
  assert.equal(clampStageVolume(""), STAGE_VOLUME_DEFAULT);
});

test("stage volume is remembered per device and survives a storage that throws", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.equal(loadStageVolume(storage), STAGE_VOLUME_DEFAULT);
  saveStageVolume(storage, 1.6);
  assert.equal(store.get(STAGE_VOLUME_STORAGE_KEY), "1.6");
  assert.equal(loadStageVolume(storage), 1.6);
  saveStageVolume(storage, 9);
  assert.equal(loadStageVolume(storage), 2);

  const broken = {
    getItem: (): string | null => {
      throw new Error("SecurityError");
    },
    setItem: (): void => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(loadStageVolume(broken), STAGE_VOLUME_DEFAULT);
  assert.doesNotThrow(() => saveStageVolume(broken, 0.3));
  assert.equal(loadStageVolume(null), STAGE_VOLUME_DEFAULT);
});

test("the inside-hall flag enters at the box and leaves only beyond the 2 m margin (both axes)", () => {
  const ox = WATCH_HALL_ORIGIN.x;
  const oz = WATCH_HALL_ORIGIN.z;
  const edgeX = ox + WATCH_HALL_HALF_EXTENTS.x;
  assert.equal(nextInsideHall(false, ox, oz), true);
  assert.equal(nextInsideHall(false, edgeX + 0.5, oz), false, "outside the box: not entered yet");
  assert.equal(nextInsideHall(true, edgeX + 0.5, oz), true, "inside the exit margin: still in");
  assert.equal(nextInsideHall(true, edgeX + WATCH_HALL_EXIT_MARGIN_METERS - 0.01, oz), true);
  assert.equal(nextInsideHall(true, edgeX + WATCH_HALL_EXIT_MARGIN_METERS + 0.01, oz), false, "beyond the margin: out");
  const edgeZ = oz + WATCH_HALL_HALF_EXTENTS.z;
  assert.equal(nextInsideHall(false, ox, edgeZ + 1), false);
  assert.equal(nextInsideHall(true, ox, edgeZ + 1), true);
  assert.equal(nextInsideHall(true, ox, edgeZ + 3), false);
  // The district and the valley are never "inside".
  assert.equal(nextInsideHall(true, 0, 0), false);
  assert.equal(nextInsideHall(false, 1000, 0), false);
});

test("stage mic: the holder and the floor are heard at distance 0 by listeners inside the hall only", () => {
  const inside: StageAudioContext = { holder: "h", floor: "f", inside: true };
  const outside: StageAudioContext = { ...inside, inside: false };
  const inHall = { x: WATCH_HALL_ORIGIN.x + 3, z: WATCH_HALL_ORIGIN.z - 8 };
  assert.equal(hasStageMic("h", inside, inHall), true);
  assert.equal(hasStageMic("f", inside, inHall), true);
  assert.equal(hasStageMic("x", inside, inHall), false, "an audience mic keeps its proximity range");
  assert.equal(hasStageMic("h", outside, inHall), false, "outside the hall the holder is an ordinary voice");
  assert.equal(hasStageMic("h", { holder: null, floor: null, inside: true }, inHall), false);
  // The holder walked out (leave grace) or teleported to the plaza: their talk there is never hall-wide.
  assert.equal(hasStageMic("h", inside, { x: 0, z: 0 }), false, "a speaker outside the hall is not a stage mic");
  assert.equal(hasStageMic("h", inside, { x: WATCH_HALL_ORIGIN.x, z: WATCH_HALL_ORIGIN.z + WATCH_HALL_HALF_EXTENTS.z + 1 }), true, "the doorway hysteresis applies to the speaker too");
  assert.equal(hasStageMic("h", inside, null), false, "no avatar, no stage mic");
  assert.equal(effectiveSpeakerDistance(25, true), 0);
  assert.equal(effectiveSpeakerDistance(25, false), 25);

  // 25 m away with a whisper range: inaudible normally, full volume as a stage mic.
  const base = { mode: "full" as const, muted: false, blocked: false, range: "whisper" as const, playerVolume: 1, masterVolume: 1 };
  assert.equal(resolveMicGain({ ...base, stageMic: false, distance: 25 }), 0);
  assert.equal(resolveMicGain({ ...base, stageMic: true, distance: effectiveSpeakerDistance(25, true) }), 1);
  // Mute and block still win over the stage.
  assert.equal(resolveMicGain({ ...base, stageMic: true, distance: 0, muted: true }), 0);
  assert.equal(resolveMicGain({ ...base, stageMic: true, distance: 0, blocked: true }), 0);
  // Volumes still apply.
  assert.equal(resolveMicGain({ ...base, stageMic: true, distance: 0, playerVolume: 0.5, masterVolume: 1.5 }), 0.75);
});

test("listen mode (guests, watch mode) hears nearby voices by proximity and the stage mics, exactly like full voice (ADR-015: guests may listen, never talk)", () => {
  const base = { stageMic: false, blocked: false, distance: 2, range: "talk" as const, currently: false };
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "full" }), true);
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "listen" }), true, "a guest hears the player next to them");
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "listen", distance: 100 }), false, "…but far voices stay unsubscribed in listen mode too");
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "listen", blocked: true }), false, "blocked always loses");
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "listen", stageMic: true }), true);
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "full", stageMic: true, distance: 0 }), true);
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "full", stageMic: true, blocked: true }), false, "a blocked holder is never downloaded");
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "off", stageMic: true }), false);
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "full", distance: 100 }), false, "far voices stay unsubscribed");
  assert.equal(shouldSubscribeSpeaker({ ...base, mode: "full", distance: Number.POSITIVE_INFINITY, stageMic: false }), false, "no avatar, no audio");

  const gain = { distance: 2, muted: false, blocked: false, range: "talk" as const, playerVolume: 1, masterVolume: 1 };
  assert.equal(resolveMicGain({ ...gain, mode: "listen", stageMic: false }), resolveSpeakerGain(2, { muted: false, blocked: false }, "talk"));
  assert.equal(resolveMicGain({ ...gain, mode: "listen", stageMic: false, muted: true }), 0, "mute still wins for a guest");
  assert.equal(resolveMicGain({ ...gain, mode: "listen", stageMic: true }), resolveSpeakerGain(2, { muted: false, blocked: false }, "talk"));
  assert.equal(resolveMicGain({ ...gain, mode: "full", stageMic: false }), resolveSpeakerGain(2, { muted: false, blocked: false }, "talk"));
  assert.equal(resolveMicGain({ ...gain, mode: "off", stageMic: true }), 0);
});

test("stage subscription: only the server-named holder, only inside, connected, not blocked, never ourselves", () => {
  const base = { holder: "h", localPlayerId: "me", inside: true, connected: true, blocked: false };
  assert.equal(stageSubscriptionTarget(base), "h");
  assert.equal(stageSubscriptionTarget({ ...base, inside: false }), null, "outside the hall nothing is downloaded");
  assert.equal(stageSubscriptionTarget({ ...base, connected: false }), null);
  assert.equal(stageSubscriptionTarget({ ...base, blocked: true }), null, "blocking hides the share too");
  assert.equal(stageSubscriptionTarget({ ...base, holder: null }), null, "an idle stage subscribes to nobody (a rogue publisher is ignored)");
  assert.equal(stageSubscriptionTarget({ ...base, holder: "me" }), null, "the holder previews their own local track");
});
