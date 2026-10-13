import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_RESOLUTION_SCALE, initialPacing, pace, type PacingAction } from "./framePacing.ts";

// The high tier's frame-pacing guard. It runs on real time and asks for less crowd detail when even
// the lowest resolution is too slow (the hall's budget lever).

function run(state: ReturnType<typeof initialPacing>, frameSeconds: number, seconds: number): PacingAction[] {
  const actions: PacingAction[] = [];
  for (let t = 0; t < seconds; t += frameSeconds) {
    const action = pace(state, frameSeconds);
    if (action !== "none") actions.push(action);
  }
  return actions;
}

test("at 60 FPS nothing changes", () => {
  const state = initialPacing(true);
  assert.deepEqual(run(state, 1 / 60, 20), []);
  assert.equal(state.msaaOn, true);
  assert.equal(state.resolutionScale, 1);
  assert.equal(state.crowdReduced, false);
});

test("slow frames drop MSAA first, then the resolution, decided on real time even at 2 FPS", () => {
  const state = initialPacing(true);
  // 2 FPS: 4 s of real time is only 8 frames. The old guard, counting a step clamped to 1/15 s, needed 23 frames per decision.
  const actions = run(state, 0.5, 4.5);
  assert.equal(actions[0], "msaa-off");
  assert.equal(actions[1], "resolution");
  assert.equal(state.msaaOn, false);
  assert.ok(state.resolutionScale < 1);
});

test("at the resolution floor and still slow, the crowd is reduced; lasting headroom brings everything back", () => {
  const state = initialPacing(true);
  run(state, 1 / 20, 30);
  assert.equal(state.resolutionScale, MIN_RESOLUTION_SCALE);
  assert.equal(state.crowdReduced, true);
  // Fast again (60 FPS): the crowd comes back first, then the resolution climbs, then MSAA is retried once.
  const actions = run(state, 1 / 60, 45);
  assert.equal(state.crowdReduced, false);
  assert.equal(state.resolutionScale, 1);
  assert.ok(actions.includes("msaa-on"));
  assert.equal(state.msaaOn, true);
});

test("a long hitch (hidden tab, breakpoint) counts as half a second, not as a slow stretch", () => {
  const state = initialPacing(true);
  run(state, 1 / 60, 2);
  assert.equal(pace(state, 30), "none");
  assert.deepEqual(run(state, 1 / 60, 2), []);
  assert.equal(state.msaaOn, true);
});

test("in between (42–57 FPS) the guard holds still", () => {
  const state = initialPacing(false);
  assert.deepEqual(run(state, 1 / 50, 20), []);
  assert.equal(state.resolutionScale, 1);
});
