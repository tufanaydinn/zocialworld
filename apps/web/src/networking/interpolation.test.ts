import { test } from "node:test";
import assert from "node:assert/strict";
import { InterpolationBuffer } from "./interpolation.ts";

test("returns null before any sample is pushed", () => {
  const buffer = new InterpolationBuffer();
  assert.equal(buffer.sample(0), null);
});

test("returns the single sample verbatim when only one exists", () => {
  const buffer = new InterpolationBuffer();
  buffer.push({ t: 1000, x: 5, y: 0, z: -3, rotationY: 1 });
  assert.deepEqual(buffer.sample(5000), { x: 5, y: 0, z: -3, rotationY: 1 });
});

test("lerps position linearly between two bracketing samples", () => {
  const buffer = new InterpolationBuffer();
  buffer.push({ t: 0, x: 0, y: 0, z: 0, rotationY: 0 });
  buffer.push({ t: 100, x: 10, y: 0, z: 0, rotationY: 0 });

  const atStart = buffer.sample(0);
  const atQuarter = buffer.sample(25);
  const atMid = buffer.sample(50);
  const atEnd = buffer.sample(100);

  assert.equal(atStart?.x, 0);
  assert.equal(atQuarter?.x, 2.5);
  assert.equal(atMid?.x, 5);
  assert.equal(atEnd?.x, 10);
});

test("holds at the latest sample instead of extrapolating on buffer underrun", () => {
  const buffer = new InterpolationBuffer();
  buffer.push({ t: 0, x: 0, y: 0, z: 0, rotationY: 0 });
  buffer.push({ t: 100, x: 10, y: 0, z: 0, rotationY: 0 });

  // renderTime far past the newest sample (e.g. a dropped packet)
  const result = buffer.sample(10_000);
  assert.deepEqual(result, { x: 10, y: 0, z: 0, rotationY: 0 });
});

test("holds at the earliest sample when renderTime is before the buffer starts", () => {
  const buffer = new InterpolationBuffer();
  buffer.push({ t: 500, x: 3, y: 0, z: 0, rotationY: 0 });
  buffer.push({ t: 600, x: 4, y: 0, z: 0, rotationY: 0 });

  const result = buffer.sample(0);
  assert.deepEqual(result, { x: 3, y: 0, z: 0, rotationY: 0 });
});

test("takes the shortest path when interpolating rotation across the +/-PI wrap", () => {
  const buffer = new InterpolationBuffer();
  const almostPi = Math.PI - 0.1;
  const almostNegPi = -Math.PI + 0.1;
  buffer.push({ t: 0, x: 0, y: 0, z: 0, rotationY: almostPi });
  buffer.push({ t: 100, x: 0, y: 0, z: 0, rotationY: almostNegPi });

  const mid = buffer.sample(50);
  // The short way across the wrap passes through +/-PI, so the midpoint's
  // absolute rotation must be large in magnitude (near +/-PI), not near 0
  // (which is what a naive non-wrapping lerp would incorrectly produce).
  assert.ok(Math.abs(mid!.rotationY) > Math.PI / 2, `expected a wrap-aware midpoint, got ${mid!.rotationY}`);
});

test("evicts the oldest sample once the buffer exceeds its cap", () => {
  const buffer = new InterpolationBuffer();
  for (let i = 0; i < 20; i++) {
    buffer.push({ t: i * 100, x: i, y: 0, z: 0, rotationY: 0 });
  }
  assert.ok(buffer.sampleCount <= 10);
  // The earliest surviving sample should be recent, not t=0.
  const earliest = buffer.sample(0);
  assert.ok(earliest!.x > 0);
});

test("inserts an out-of-order sample in the correct position", () => {
  const buffer = new InterpolationBuffer();
  buffer.push({ t: 0, x: 0, y: 0, z: 0, rotationY: 0 });
  buffer.push({ t: 200, x: 20, y: 0, z: 0, rotationY: 0 });
  buffer.push({ t: 100, x: 10, y: 0, z: 0, rotationY: 0 }); // arrives late, but timestamped in between

  const mid = buffer.sample(150);
  // Between the t=100 (x=10) and t=200 (x=20) samples, at the 50% mark.
  assert.equal(mid?.x, 15);
});
