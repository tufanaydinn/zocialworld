import { test } from "node:test";
import assert from "node:assert/strict";
import { hallContains } from "../world/hall/hallGeometry.ts";
import { sampleHallLayout as layout } from "../content/sample/hallLayout.ts";
import { HallPerfScene, PERF_STANDING, PERF_WALKERS, PerfProbe, hallPerfCrowd, perfFixedDelta, perfSceneKind, walkerPose, type HallPerfHost } from "./perfScene.ts";
import type { HallStateMessage, PlayerSummary } from "@project/shared";

const FREE_SEAT = layout.crowd.freeSeat;

// The reproducible ?perf= scenes (DEV / VITE_TEST_HOOKS builds only).

test("?perf= accepts only the known scenes", () => {
  assert.equal(perfSceneKind("?perf=hall60"), "hall60");
  assert.equal(perfSceneKind("?quality=low&perf=district"), "district");
  assert.equal(perfSceneKind("?perf=hallnet"), "hallnet", "the hall with real networked clients");
  assert.equal(perfSceneKind("?perf=1"), null);
  assert.equal(perfSceneKind(""), null);
});

test("?perfdt= gives a fixed frame step for CPU-side measurements", () => {
  assert.equal(perfFixedDelta("?perf=hall60&perfdt=60"), 1 / 60);
  assert.equal(perfFixedDelta("?perf=hall60"), 0);
  assert.equal(perfFixedDelta("?perfdt=5"), 0);
  assert.equal(perfFixedDelta("?perfdt=abc"), 0);
});

test("the hall crowd: a seated viewer on every seat but the layout's free one, standing and walking extras, all inside the hall", () => {
  const { seated, standing, walkers } = hallPerfCrowd(layout);
  assert.equal(seated.length, layout.seats.length - 1);
  assert.equal(standing.length, PERF_STANDING);
  assert.equal(walkers.length, PERF_WALKERS);
  assert.ok(seated.every((player) => player.animationState === "sit"));
  assert.ok(!seated.some((player) => player.playerId === `perf-${FREE_SEAT}`));
  const all = [...seated, ...standing, ...walkers];
  assert.equal(new Set(all.map((player) => player.playerId)).size, all.length, "unique ids");
  for (const player of all) assert.ok(hallContains(player.x, player.z), player.nickname);
  assert.deepEqual(hallPerfCrowd(layout), hallPerfCrowd(layout), "deterministic");
});

test("walkers pace the walkway and turn at both ends", () => {
  for (let t = 0; t < 40; t += 0.37) {
    for (let i = 0; i < PERF_WALKERS; i++) {
      const pose = walkerPose(layout, i, t);
      assert.ok(hallContains(pose.x, pose.z), `walker ${i} at ${t}s`);
      assert.ok(Math.abs(Math.abs(pose.rotationY) - Math.PI / 2) < 1e-9);
    }
  }
  const a = walkerPose(layout, 0, 1);
  const b = walkerPose(layout, 0, 2);
  assert.ok(Math.abs(b.x - a.x - 1.4) < 1e-9, "1.4 m/s");
});

test("the probe averages frame time and the per-section main-thread time", () => {
  const probe = new PerfProbe(8);
  let now = 1000;
  for (let frame = 0; frame < 5; frame++) {
    probe.begin(now);
    probe.mark("world", now + 1);
    probe.mark("players", now + 3);
    probe.mark("rest", now + 4);
    probe.mark("render", now + 8);
    probe.mark("overlays", now + 9);
    now += 20;
  }
  probe.begin(now);
  const summary = probe.summary();
  assert.equal(summary.frames, 5);
  assert.equal(summary.fps, 50);
  assert.deepEqual(summary.frameMs, { mean: 20, p50: 20, p95: 20 });
  assert.deepEqual(summary.sections, { world: 1, players: 2, rest: 1, render: 4, overlays: 1 });
  assert.equal(summary.mainMs, 9);
  probe.reset();
  assert.equal(probe.summary().frames, 0);
});

test("the hall scene spawns the crowd once, seats it over the server's hall state and re-seats it when that state is replaced", () => {
  const spawned = new Map<string, PlayerSummary>();
  let state: Omit<HallStateMessage, "type"> = {
    stage: { holder: null, status: "idle", since: 0, queue: [], card: null, locked: false, audio: false },
    seats: [[FREE_SEAT, "local"]],
    hands: [],
    floor: null,
    hosts: [],
    host: false,
    totals: {},
    session: { id: 0, active: false },
    vote: { votes: 0, needed: 0, voted: false },
  };
  let applied = 0;
  const host: HallPerfHost = {
    spawn: (summary) => spawned.set(summary.playerId, summary),
    has: (playerId) => spawned.has(playerId),
    receiveTransform: () => {},
    hallState: () => state,
    occupant: (seatId) => state.seats.find(([seat]) => seat === seatId)?.[1] ?? null,
    applyHallState: (message) => {
      applied++;
      const { type: _type, ...rest } = message;
      state = rest;
    },
  };
  const scene = new HallPerfScene(host, layout);
  assert.equal(spawned.size, scene.playerCount);
  assert.equal(applied, 1);
  assert.equal(state.seats.length, layout.seats.length, "every other seat synthetic, plus the local player's");
  scene.update(1.01);
  assert.equal(applied, 1, "nothing to re-apply");
  state = { ...state, seats: [] };
  scene.update(0.016);
  assert.equal(applied, 2, "re-seated on the next frame, not a second later");
  assert.equal(state.seats.length, layout.seats.length - 1);
});
