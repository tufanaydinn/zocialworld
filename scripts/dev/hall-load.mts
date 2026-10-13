/**
 * A Watch Hall load test with REAL networked clients (50 or more). ?perf=hall60's synthetic players exist only in one
 * browser, so they measure neither the server's fan-out nor the client's decoding of 59 networked players; this does.
 *
 *   npx tsx scripts/dev/hall-load.mts [--clients 59] [--seconds 90] [--port 8795] [--page <url>] [--out <file.json>] [--layout <module>]
 *
 *  1. Starts the game server (apps/server, NAME_REGISTRY=off, no LiveKit) on --port with scripts/dev/eventloop-probe.mjs
 *     preloaded: event-loop delay and CPU every 5 s, without changing the server.
 *  2. Opens --clients WebSocket clients that behave like a full hall (the ?perf=hall60 mix): seated viewers on every seat
 *     but one (pose "sit", one hall_seat_claim, then heartbeats), 4 standing (a turn every ~5 s), 4 walking the
 *     promenade (transforms at the server's tick rate, 10 Hz); reactions (each client about one per 20 s, plus an
 *     "applause" burst of 20 clients every 30 s) and hall chat (about one line every 2 s across the room).
 *  3. Measures: the server's event-loop delay (p50/p99/max) and CPU, the relay latency of hall chat (a probe client's
 *     line → another client), and messages and bytes per second that one seated client receives.
 *  4. With --page (a running Vite dev server whose VITE_SERVER_ORIGIN points at --port, e.g.
 *     http://127.0.0.1:5173/?perf=hallnet&quality=low), one Chromium page joins the same hall (the real client) and its
 *     frame probe (window.__perf.summary()) is read after the warm-up: frame time, main-thread time per section.
 *
 * Seats, floor heights and the standing and walking spots come from a hall layout: `--layout <module>` loads the
 * `hallLayout` export of a module (for example the content's hall layout file); without it the clients use a plain
 * 60-seat grid at floor level inside the hall box. The server does not check positions, so either fills the hall.
 *
 * The clients are guests on a server with names off. Nothing here is for production.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { HALL_REACTIONS, WATCH_HALL_SEAT_COUNT } from "../../packages/shared/src/multiplayer-protocol.ts";
import { seatRows, toWorldXZ, type HallLayout } from "../../apps/web/src/world/hall/hallGeometry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const CLIENTS = Number(args.get("clients") ?? 59);
const SECONDS = Number(args.get("seconds") ?? 90);
const PORT = Number(args.get("port") ?? 8795);
const PAGE = args.get("page") ?? "";
const OUT = args.get("out") ?? "";
const LAYOUT = args.get("layout") ?? "";
const ORIGIN = "http://127.0.0.1:5173";
const WARMUP_S = 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

// ---------------------------------------------------------------- the hall layout
type LoadLayout = Pick<HallLayout, "seats" | "heightAt" | "crowd">;
/** Five rows of twelve seats at floor level, facing the stage end, with standing spots in front and a walkway behind. */
const GRID: LoadLayout = {
  seats: seatRows({ rows: Array.from({ length: 5 }, (_, r) => ({ z: -4 + 2 * r, y: 0, standZ: -3.2 + 2 * r })), seatsPerBlock: 6, firstX: 2, pitch: 1.2, facing: { x: 0, z: -14 } }),
  heightAt: () => 0,
  crowd: {
    standing: [-9, -3, 3, 9].map((x) => ({ x, z: -8, yaw: Math.PI })),
    walkway: { z: 7, laneSpacing: 0.9, length: 14 },
    freeSeat: 54,
  },
};
const layout: LoadLayout = LAYOUT ? ((await import(pathToFileURL(resolve(LAYOUT)).href)) as { hallLayout: LoadLayout }).hallLayout : GRID;

// ---------------------------------------------------------------- the server
const serverLog: string[] = [];
const eventLoop: { p50Ms: number; p99Ms: number; maxMs: number; meanMs: number; cpuMs: number; rssMb: number; at: number }[] = [];
const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", "--import", join(ROOT, "scripts/dev/eventloop-probe.mjs"), "src/index.ts"], {
  cwd: join(ROOT, "apps/server"),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", NAME_REGISTRY: "off", ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:5174,http://localhost:5173,http://localhost:5174`, LIVEKIT_URL: "", ZCASHD_RPC_URL: "", STALE_TIMEOUT_MS: "30000", MAX_SESSIONS_PER_IP: "0" /* the per-IP session cap: every client is 127.0.0.1 */ },
  stdio: ["ignore", "pipe", "pipe"],
});
const started = Date.now();
server.stdout!.on("data", (d) => serverLog.push(String(d)));
server.stderr!.on("data", (d) => {
  for (const line of String(d).split("\n")) {
    const match = /^\[eventloop\] (.*)$/.exec(line.trim());
    if (match) eventLoop.push({ ...(JSON.parse(match[1]!) as Omit<(typeof eventLoop)[number], "at">), at: Math.round((Date.now() - started) / 1000) });
    else if (line.trim()) serverLog.push(line);
  }
});
const stopServer = () => {
  if (!server.killed) server.kill("SIGTERM");
};
process.on("exit", stopServer);
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/version`)).ok) break;
  } catch {
    /* not yet */
  }
  await sleep(500);
}

// ---------------------------------------------------------------- the clients
interface Client {
  readonly index: number;
  readonly ws: WebSocket;
  id: string;
  received: number;
  bytes: number;
  chats: Map<string, number>;
}

const clients: Client[] = [];
const latencies: number[] = [];
const sentChats = new Map<string, number>();

function connect(index: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { origin: ORIGIN } });
    const client: Client = { index, ws, id: "", received: 0, bytes: 0, chats: new Map() };
    ws.on("error", reject);
    ws.on("message", (data: Buffer) => {
      client.received++;
      client.bytes += data.length;
      const text = data.toString();
      if (!client.id && text.includes('"welcome"')) {
        client.id = (JSON.parse(text) as { playerId: string }).playerId;
        resolve(client);
      }
      // Relay latency: the probe's tagged hall chat line, timed when client #1 receives it.
      if (index === 1 && text.includes("load-probe-")) {
        const tag = /load-probe-(\d+)/.exec(text)?.[1];
        const sentAt = tag ? sentChats.get(tag) : undefined;
        if (sentAt !== undefined) latencies.push(performance.now() - sentAt);
      }
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", nickname: `Load-${String(index).padStart(2, "0")}` })));
  });
}

const send = (client: Client, message: Record<string, unknown>) => {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
};
const transform = (client: Client, x: number, z: number, rotationY: number, animationState: string, seq: number) =>
  send(client, { type: "player_transform", x, y: layout.heightAt(x, z), z, rotationY, animationState, seq });

// The layout's free seat stays free for the --page client, as in ?perf=hall60.
const seats = layout.seats.filter((seat) => seat.id !== layout.crowd.freeSeat);
const timers: ReturnType<typeof setInterval>[] = [];
for (let i = 0; i < CLIENTS; i++) clients.push(await connect(i));
const roles = clients.map((client, i) => (i < CLIENTS - 8 ? "seated" : i < CLIENTS - 4 ? "standing" : "walking"));
let seq = 1;
for (const [i, client] of clients.entries()) {
  if (roles[i] === "seated") {
    const seat = seats[i % seats.length]!;
    transform(client, seat.x, seat.z, seat.yaw, "sit", seq++);
    setTimeout(() => send(client, { type: "hall_seat_claim", seatId: seat.id % WATCH_HALL_SEAT_COUNT }), 500 + Math.random() * 1500);
  } else if (roles[i] === "standing") {
    const standing = layout.crowd.standing[i % layout.crowd.standing.length]!;
    const spot = toWorldXZ(standing.x, standing.z);
    let yaw = Math.random() * Math.PI * 2;
    transform(client, spot.x, spot.z, yaw, "idle", seq++);
    timers.push(setInterval(() => transform(client, spot.x, spot.z, (yaw += 0.4), "idle", seq++), 4000 + Math.random() * 2000));
  } else {
    const { walkway } = layout.crowd;
    const lane = walkway.z + (i % 4) * walkway.laneSpacing;
    const t0 = performance.now() + i * 3700;
    timers.push(
      setInterval(() => {
        const seconds = (performance.now() - t0) / 1000;
        // A walk at 1.4 m/s, there and back along the walkway.
        const period = (2 * walkway.length) / 1.4;
        const phase = ((seconds % period) + period) % period;
        const forward = phase < period / 2;
        const local = { x: -walkway.length / 2 + (forward ? phase : period - phase) * 1.4, z: lane };
        const world = toWorldXZ(local.x, local.z);
        transform(client, world.x, world.z, forward ? Math.PI / 2 : -Math.PI / 2, "walk", seq++);
      }, 100),
    );
  }
  timers.push(setInterval(() => send(client, { type: "heartbeat" }), 5000));
}
// Reactions: about one per client per 20 s, and an applause burst (20 clients within 2 s) every 30 s.
timers.push(setInterval(() => send(pick(clients), { type: "hall_react", reaction: pick(HALL_REACTIONS) }), (20_000 / CLIENTS) | 0));
timers.push(
  setInterval(() => {
    for (let k = 0; k < 20; k++) setTimeout(() => send(pick(clients), { type: "hall_react", reaction: "clap" }), Math.random() * 2000);
  }, 30_000),
);
// Hall chat: about one line every 2 s across the room; client #0 is the latency probe (its lines are tagged).
let probe = 0;
timers.push(
  setInterval(() => {
    const tag = String(++probe);
    sentChats.set(tag, performance.now());
    send(clients[0]!, { type: "chat_send", channel: "hall", text: `load-probe-${tag}` });
  }, 2000),
);
timers.push(setInterval(() => send(pick(clients.slice(2)), { type: "chat_send", channel: "hall", text: "nice slide" }), 4000));

// ---------------------------------------------------------------- the real client (optional)
let pageSummary: unknown = null;
let pageError: string | null = null;
const pagePromise = (async () => {
  if (!PAGE) return;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(PAGE);
    await page.waitForFunction(() => (window as unknown as { __perf?: { ready(): boolean } }).__perf?.ready() === true, null, { timeout: 300_000 });
    await page.waitForFunction((n) => ((window as unknown as { __remotePlayers?: { size: number } }).__remotePlayers?.size ?? 0) >= n, Math.min(CLIENTS, 50), { timeout: 120_000 });
    await sleep(WARMUP_S * 1000);
    await page.evaluate(() => (window as unknown as { __perf: { reset(): void } }).__perf.reset());
    await sleep(Math.max(20, SECONDS - WARMUP_S - 30) * 1000);
    pageSummary = await page.evaluate(() => (window as unknown as { __perf: { summary(): unknown } }).__perf.summary());
  } catch (error) {
    pageError = String(error).slice(0, 500);
  } finally {
    await browser.close();
  }
})();

// ---------------------------------------------------------------- measure
await sleep(WARMUP_S * 1000);
const sample = clients[5]!;
const before = { received: sample.received, bytes: sample.bytes, at: performance.now() };
const latencyStart = latencies.length;
const loopStart = eventLoop.length;
await sleep((SECONDS - WARMUP_S) * 1000);
const elapsedS = (performance.now() - before.at) / 1000;
await pagePromise;
for (const timer of timers) clearInterval(timer);
for (const client of clients) client.ws.close();

const sorted = latencies.slice(latencyStart).sort((a, b) => a - b);
const pct = (values: number[], p: number) => (values.length ? Math.round(values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]! * 10) / 10 : null);
const windowLoop = eventLoop.slice(loopStart);
const result = {
  at: new Date().toISOString(),
  clients: CLIENTS,
  mix: { seated: roles.filter((r) => r === "seated").length, standing: roles.filter((r) => r === "standing").length, walking: roles.filter((r) => r === "walking").length },
  measuredSeconds: Math.round(elapsedS),
  server: {
    eventLoop: {
      p50Ms: windowLoop.length ? Math.max(...windowLoop.map((w) => w.p50Ms)) : null,
      p99Ms: windowLoop.length ? Math.max(...windowLoop.map((w) => w.p99Ms)) : null,
      maxMs: windowLoop.length ? Math.max(...windowLoop.map((w) => w.maxMs)) : null,
    },
    cpuPercentOfOneCore: windowLoop.length ? Math.round((windowLoop.reduce((sum, w) => sum + w.cpuMs, 0) / (windowLoop.length * 5000)) * 1000) / 10 : null,
    rssMb: windowLoop.length ? Math.max(...windowLoop.map((w) => w.rssMb)) : null,
    windows: windowLoop,
  },
  relayLatencyMs: { samples: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted.length ? Math.round(sorted.at(-1)! * 10) / 10 : null },
  perSeatedClient: { messagesPerSecond: Math.round(((sample.received - before.received) / elapsedS) * 10) / 10, kilobytesPerSecond: Math.round(((sample.bytes - before.bytes) / elapsedS / 1024) * 10) / 10 },
  page: PAGE ? { url: PAGE, summary: pageSummary, error: pageError } : null,
  serverLog: serverLog.filter((line) => /error|warn/i.test(line)).slice(0, 20),
};
console.log(JSON.stringify({ ...result, server: { ...result.server, windows: undefined } }, null, 1));
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`);
}
stopServer();
process.exit(0);
