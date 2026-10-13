import { defaultPlayerAvatar, type HallStateMessage, type PlayerSummary, type PlayerTransformBroadcastMessage } from "@project/shared";
import { toWorldXZ, type HallLayout } from "../world/hall/hallGeometry.ts";

/**
 * Reproducible performance scenes and a frame probe — DEV and VITE_TEST_HOOKS builds only (App.ts never creates
 * them otherwise). `?perf=hall60` travels into the Watch Hall and fills it with a synthetic crowd placed by the
 * content's hall layout: a seated player on every seat but the layout's free seat (59 in a 60-seat hall), four
 * standing and four walking ones; `?perf=district` measures the spawn; `?perf=hallnet` travels into the hall with no
 * synthetic crowd, for a hall filled by real networked clients (scripts/dev/hall-load.mts).
 * `window.__perf.summary()` then reports frame times, main-thread time per section, renderer.info and DOM counts
 * (docs/architecture/PERFORMANCE.md).
 *
 * Synthetic players only exist in this browser: nothing is sent to the server for them.
 */

export type PerfSceneKind = "hall60" | "district" | "hallnet";

export function perfSceneKind(search: string): PerfSceneKind | null {
  const value = new URLSearchParams(search).get("perf");
  return value === "hall60" || value === "district" || value === "hallnet" ? value : null;
}

/**
 * `?perfdt=<fps>` (with a perf scene): a fixed frame step of 1/fps seconds, so a software renderer at 1 FPS still does
 * the per-frame CPU work of a machine running at `fps` (animation LOD, timers). 0 when absent or out of 10…240.
 */
export function perfFixedDelta(search: string): number {
  const fps = Number(new URLSearchParams(search).get("perfdt"));
  return Number.isFinite(fps) && fps >= 10 && fps <= 240 ? 1 / fps : 0;
}

export const PERF_STANDING = 4;
export const PERF_WALKERS = 4;
const PERF_ID_PREFIX = "perf-";

/** The walkers pace the layout's walkway from side to side, each on its own lane and phase. */
export function walkerPose(layout: HallLayout, index: number, seconds: number): { x: number; z: number; rotationY: number } {
  const { walkway } = layout.crowd;
  const lane = walkway.z + index * walkway.laneSpacing;
  const span = walkway.length;
  const speed = 1.4; // m/s, a walk
  const period = (2 * span) / speed;
  const t = (seconds + index * 3.7) % period;
  const forward = t < period / 2;
  const travelled = forward ? t * speed : (period - t) * speed;
  const local = { x: -span / 2 + travelled, z: lane };
  const world = toWorldXZ(local.x, local.z);
  return { x: world.x, z: world.z, rotationY: forward ? Math.PI / 2 : -Math.PI / 2 };
}

/** The synthetic crowd of `?perf=hall60` in `layout`: deterministic ids, models and colours. */
export function hallPerfCrowd(layout: HallLayout): { seated: PlayerSummary[]; standing: PlayerSummary[]; walkers: PlayerSummary[] } {
  const summary = (index: number, nickname: string, x: number, y: number, z: number, rotationY: number, animationState: PlayerSummary["animationState"]): PlayerSummary => ({
    playerId: `${PERF_ID_PREFIX}${index}`,
    nickname,
    colorSeed: index * 7 + 3,
    avatar: defaultPlayerAvatar(index * 7 + 3),
    canReceive: false,
    x,
    y,
    z,
    rotationY,
    animationState,
  });
  const seated = layout.seats.filter((seat) => seat.id !== layout.crowd.freeSeat).map((seat) => summary(seat.id, `Viewer-${String(seat.id).padStart(2, "0")}`, seat.x, seat.y, seat.z, seat.yaw, "sit"));
  const standing = layout.crowd.standing.slice(0, PERF_STANDING).map((spot, i) => {
    const world = toWorldXZ(spot.x, spot.z);
    return summary(100 + i, `Standing-${i + 1}`, world.x, layout.heightAt(world.x, world.z), world.z, spot.yaw, "idle");
  });
  const walkers = Array.from({ length: PERF_WALKERS }, (_, i) => {
    const pose = walkerPose(layout, i, 0);
    return summary(200 + i, `Walker-${i + 1}`, pose.x, layout.heightAt(pose.x, pose.z), pose.z, pose.rotationY, "walk");
  });
  return { seated, standing, walkers };
}

/** Per-frame section timings (ms of main-thread time), kept for the last `capacity` frames. */
export const PERF_SECTIONS = ["world", "players", "rest", "render", "overlays"] as const;
export type PerfSection = (typeof PERF_SECTIONS)[number];

export interface PerfSummary {
  readonly frames: number;
  readonly fps: number;
  readonly frameMs: { readonly mean: number; readonly p50: number; readonly p95: number };
  /** Main-thread JS time per frame in update + render (mean ms), and its sections. */
  readonly mainMs: number;
  readonly sections: Readonly<Record<PerfSection, number>>;
}

export class PerfProbe {
  private readonly capacity: number;
  private readonly frameTimes: Float64Array;
  private readonly sectionTimes: Record<PerfSection, Float64Array>;
  private count = 0;
  private head = 0;
  private frameStart = 0;
  private lastMark = 0;
  private previousFrameStart = 0;
  private readonly current: Record<PerfSection, number> = { world: 0, players: 0, rest: 0, render: 0, overlays: 0 };

  constructor(capacity = 600) {
    this.capacity = capacity;
    this.frameTimes = new Float64Array(capacity);
    this.sectionTimes = { world: new Float64Array(capacity), players: new Float64Array(capacity), rest: new Float64Array(capacity), render: new Float64Array(capacity), overlays: new Float64Array(capacity) };
  }

  /** Start of a frame (App.update). */
  begin(now = performance.now()): void {
    if (this.previousFrameStart > 0) this.commit(now - this.previousFrameStart);
    this.previousFrameStart = now;
    this.frameStart = now;
    this.lastMark = now;
    for (const section of PERF_SECTIONS) this.current[section] = 0;
  }

  /** Ends `section` (the time since the previous mark or the frame start). Marks may skip sections; time between mark calls of different frames is ignored. */
  mark(section: PerfSection, now = performance.now()): void {
    if (this.frameStart === 0) return;
    this.current[section] += now - this.lastMark;
    this.lastMark = now;
  }

  /** Time not spent in update/render (idle, GPU waits, other tasks) is excluded: render() is followed by mark("overlays"). */
  private commit(frameMs: number): void {
    this.frameTimes[this.head] = frameMs;
    for (const section of PERF_SECTIONS) this.sectionTimes[section][this.head] = this.current[section];
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.previousFrameStart = 0;
  }

  summary(): PerfSummary {
    const n = this.count;
    const frames = Array.from(this.frameTimes.subarray(0, n)).sort((a, b) => a - b);
    const mean = (values: ArrayLike<number>): number => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += values[i]!;
      return n ? sum / n : 0;
    };
    const quantile = (q: number): number => (n ? frames[Math.min(n - 1, Math.floor(q * n))]! : 0);
    const sections = {} as Record<PerfSection, number>;
    let main = 0;
    for (const section of PERF_SECTIONS) {
      sections[section] = round(mean(this.sectionTimes[section]));
      main += sections[section];
    }
    const frameMean = mean(this.frameTimes);
    return {
      frames: n,
      fps: frameMean > 0 ? round(1000 / frameMean) : 0,
      frameMs: { mean: round(frameMean), p50: round(quantile(0.5)), p95: round(quantile(0.95)) },
      mainMs: round(main),
      sections,
    };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** What the hall scene drives (App wires these; all DEV / test-hook only). */
export interface HallPerfHost {
  spawn(summary: PlayerSummary): void;
  has(playerId: string): boolean;
  receiveTransform(message: PlayerTransformBroadcastMessage): void;
  /** The hall store's current state (server-sent or empty) and a way to apply a synthetic hall_state over it. */
  hallState(): Omit<HallStateMessage, "type">;
  /** Who sits on `seatId` now (a cheap per-frame check that the synthetic seats survived a server hall_state). */
  occupant(seatId: number): string | null;
  applyHallState(message: HallStateMessage): void;
}

/**
 * Keeps the synthetic hall crowd alive: spawns it, seats it in HallStore (so the hall's seated rules, plate policy and
 * declutter run exactly as with real players), walks the walkers at the network's 10 Hz, and re-spawns or re-seats
 * players a reconnect or a server hall_state dropped. Call `update` once per frame.
 */
export class HallPerfScene {
  private readonly host: HallPerfHost;
  private readonly layout: HallLayout;
  private readonly crowd: ReturnType<typeof hallPerfCrowd>;
  private readonly seatPairs: [number, string][];
  private clock = 0;
  private sendTimer = 0;
  private checkTimer = 0;
  private seq = 0;

  constructor(host: HallPerfHost, layout: HallLayout) {
    this.host = host;
    this.layout = layout;
    this.crowd = hallPerfCrowd(layout);
    this.seatPairs = this.crowd.seated.map((player) => [Number(player.playerId.slice(PERF_ID_PREFIX.length)), player.playerId]);
    this.ensure();
  }

  get playerCount(): number {
    return this.crowd.seated.length + this.crowd.standing.length + this.crowd.walkers.length;
  }

  update(deltaSeconds: number): void {
    this.clock += deltaSeconds;
    this.sendTimer += deltaSeconds;
    this.checkTimer += deltaSeconds;
    // A server hall_state (entering the hall, a reconnect) replaces the seats: put the crowd back at once, so no frame
    // runs with 59 unseated players (their plates would all show).
    const first = this.seatPairs[0];
    if (this.checkTimer >= 1 || (first !== undefined && this.host.occupant(first[0]) !== first[1])) {
      this.checkTimer = 0;
      this.ensure();
    }
    if (this.sendTimer < 0.1) return;
    this.sendTimer = 0;
    this.crowd.walkers.forEach((walker, index) => {
      const pose = walkerPose(this.layout, index, this.clock);
      this.host.receiveTransform({ type: "player_transform", playerId: walker.playerId, x: pose.x, y: this.layout.heightAt(pose.x, pose.z), z: pose.z, rotationY: pose.rotationY, animationState: "walk", seq: ++this.seq, t: Date.now() });
    });
  }

  private ensure(): void {
    for (const player of [...this.crowd.seated, ...this.crowd.standing, ...this.crowd.walkers]) if (!this.host.has(player.playerId)) this.host.spawn(player);
    const state = this.host.hallState();
    const seated = new Map(state.seats);
    if (this.seatPairs.every(([seat, playerId]) => seated.get(seat) === playerId)) return;
    for (const [seat, playerId] of this.seatPairs) seated.set(seat, playerId);
    this.host.applyHallState({ type: "hall_state", ...state, seats: [...seated] });
  }
}
