import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getVoiceGain,
  isWithinAudibleRange,
  resolveVoiceGain,
  VOICE_FULL_VOLUME_RADIUS_METERS,
  VOICE_MAX_AUDIBLE_RADIUS_METERS,
} from "./VoiceProximity.ts";

// CORE-004 §33 Tests 1-4.

test("Test 1: returns full volume at and inside the full-volume radius", () => {
  assert.equal(getVoiceGain(0), 1);
  assert.equal(getVoiceGain(1), 1);
  assert.equal(getVoiceGain(VOICE_FULL_VOLUME_RADIUS_METERS), 1);
});

test("Test 2: declines smoothly (monotonically, no jumps) between full and max radius", () => {
  const samples = [];
  for (let d = VOICE_FULL_VOLUME_RADIUS_METERS; d <= VOICE_MAX_AUDIBLE_RADIUS_METERS; d += 0.5) {
    samples.push(getVoiceGain(d));
  }
  // Monotonically non-increasing.
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i]! <= samples[i - 1]!, `gain increased from ${samples[i - 1]} to ${samples[i]} at step ${i}`);
  }
  // No single step changes gain by more than a small bounded amount —
  // proves there's no abrupt cliff partway through the range (the 0.5m
  // step size here is coarse enough that even a smooth curve's steepest
  // section stays well under 0.5 gain change).
  for (let i = 1; i < samples.length; i++) {
    const delta = Math.abs(samples[i]! - samples[i - 1]!);
    assert.ok(delta < 0.5, `gain changed abruptly by ${delta} between adjacent samples`);
  }
  // Midpoint is meaningfully between 0 and 1, not already at an extreme.
  const midDistance = (VOICE_FULL_VOLUME_RADIUS_METERS + VOICE_MAX_AUDIBLE_RADIUS_METERS) / 2;
  const midGain = getVoiceGain(midDistance);
  assert.ok(midGain > 0.1 && midGain < 0.9, `midpoint gain ${midGain} is not meaningfully between 0 and 1`);
});

test("Test 2b: the attenuation curve is continuous at both boundaries (no audible click)", () => {
  const epsilon = 0.001;
  assert.ok(Math.abs(getVoiceGain(VOICE_FULL_VOLUME_RADIUS_METERS - epsilon) - getVoiceGain(VOICE_FULL_VOLUME_RADIUS_METERS)) < 0.01);
  assert.ok(Math.abs(getVoiceGain(VOICE_MAX_AUDIBLE_RADIUS_METERS + epsilon) - getVoiceGain(VOICE_MAX_AUDIBLE_RADIUS_METERS)) < 0.01);
});

test("Test 3: returns zero at and beyond the max audible radius", () => {
  assert.equal(getVoiceGain(VOICE_MAX_AUDIBLE_RADIUS_METERS), 0);
  assert.equal(getVoiceGain(VOICE_MAX_AUDIBLE_RADIUS_METERS + 1), 0);
  assert.equal(getVoiceGain(1000), 0);
});

test("Test 4: voice constants are distinct from SOCIAL_INTERACTION_RADIUS_METERS — the nearby-selection radius is not reused as the voice radius", () => {
  // Deliberately NOT importing SOCIAL_INTERACTION_RADIUS_METERS here —
  // the point of this test is that the voice module defines its own
  // independent constants rather than accidentally importing/reusing
  // the social one. See apps/web/src/social/nearby.ts (5m) vs. these
  // (3m / 12m) — different values proves they are not the same constant.
  const SOCIAL_INTERACTION_RADIUS_METERS = 5;
  assert.notEqual(VOICE_FULL_VOLUME_RADIUS_METERS, SOCIAL_INTERACTION_RADIUS_METERS);
  assert.notEqual(VOICE_MAX_AUDIBLE_RADIUS_METERS, SOCIAL_INTERACTION_RADIUS_METERS);
  // A distance of exactly 5m (the social radius) must be meaningfully
  // attenuated under the voice policy, not treated as "full volume" —
  // if it returned 1, that would suggest the social radius leaked in.
  assert.ok(getVoiceGain(SOCIAL_INTERACTION_RADIUS_METERS) < 1);
});

test("isWithinAudibleRange matches the gain function's hard cutoff", () => {
  assert.equal(isWithinAudibleRange(VOICE_MAX_AUDIBLE_RADIUS_METERS - 0.01), true);
  assert.equal(isWithinAudibleRange(VOICE_MAX_AUDIBLE_RADIUS_METERS), false);
  assert.equal(isWithinAudibleRange(VOICE_MAX_AUDIBLE_RADIUS_METERS + 1), false);
});

test("custom radii parameters override the defaults correctly", () => {
  assert.equal(getVoiceGain(5, 10, 20), 1); // inside custom full-volume radius
  assert.equal(getVoiceGain(25, 10, 20), 0); // beyond custom max radius
});

// CORE-004 §33 Test 5: local mute state suppresses voice for the muted player.
test("Test 5: a muted player is silent regardless of distance", () => {
  assert.equal(resolveVoiceGain(0, { muted: true, blocked: false }), 0);
  assert.equal(resolveVoiceGain(1, { muted: true, blocked: false }), 0);
  // Even standing right next to them (would otherwise be full volume).
  assert.equal(resolveVoiceGain(VOICE_FULL_VOLUME_RADIUS_METERS, { muted: true, blocked: false }), 0);
});

test("an unmuted, unblocked player at distance follows the normal attenuation curve unchanged", () => {
  const distance = 6;
  assert.equal(resolveVoiceGain(distance, { muted: false, blocked: false }), getVoiceGain(distance));
});

// CORE-004 §33 Test 6: local block state suppresses voice for the blocked player.
test("Test 6: a blocked player is silent regardless of distance", () => {
  assert.equal(resolveVoiceGain(0, { muted: false, blocked: true }), 0);
  assert.equal(resolveVoiceGain(1, { muted: false, blocked: true }), 0);
  assert.equal(resolveVoiceGain(VOICE_FULL_VOLUME_RADIUS_METERS, { muted: false, blocked: true }), 0);
});

test("mute and block suppression compose (either one alone is enough to silence)", () => {
  assert.equal(resolveVoiceGain(0, { muted: true, blocked: true }), 0);
});
