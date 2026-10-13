# Performance — how to measure, what costs what, the rules

A low-poly world should hold its frame rate even with a full Watch Hall of 60 people. This page tells you how to
reproduce the numbers on any machine, what the profile showed, and the rules that keep a full hall fast.

## 1. The perf scenes (`?perf=`)

Only DEV builds (`npm run dev`) and `VITE_TEST_HOOKS=1` builds have them; a production build ignores the parameter.

| URL | What it does |
|---|---|
| `/?perf=hall60` | Enters as a guest (no onboarding), walks into the Watch Hall and fills it from the hall layout's crowd spots: a synthetic viewer on every seat but one free seat (59 on a 60-seat hall; seated through HallStore, so the plate policy and declutter run exactly as with real people), 4 standing and 4 walking players. You stand looking at the screen. On the sample hall the crowd is small; the numbers below were measured on a 60-seat hall. |
| `/?perf=district` | Enters as a guest and stays at the default location's spawn. |
| `/?perf=hallnet` | Enters as a guest and walks into the Watch Hall with **no** synthetic crowd — for a hall filled by real networked clients (`scripts/dev/hall-load.mts`, § 3b). |

Synthetic players exist only in your browser; nothing is sent to the server for them. With the game server running,
the scene re-seats them whenever the server's hall state replaces the seats.

Useful extra parameters:

| Parameter | Effect |
|---|---|
| `quality=high` / `quality=low` | Forces a render tier (default: auto-detected; software renderers get `low`). |
| `adaptive=0` | Turns the frame-pacing guard off (MSAA and full resolution stay on), to see the raw cost. |
| `bloom=0` | High tier without the bloom composer. |
| `stats=0` | Hides the DEV FPS / draw-call overlay (it keeps measuring). |
| `perfdt=60` | Every frame advances exactly 1/60 s. A slow software renderer then does the per-frame CPU work of a 60 FPS machine (time-based animation rates, timers). Use it only for CPU-side numbers; the FPS it shows is not real. |

In the browser console:

```js
__perf.reset();                 // start a measurement window
// wait 10–20 seconds without touching anything
__perf.summary();               // the numbers for that window
```

`summary()` returns:

- `fps`, `frameMs` (mean, p50, p95): real frame time.
- `mainMs` and `sections`: main-thread JavaScript per frame, split into `world` (camera, player, world update, HUD),
  `players` (remote players, their animation, hall presence), `rest` (network, voice, hall UI), `render` (three.js:
  culling, uniforms, draw submission) and `overlays` (nameplates, floating reactions, the DEV overlay).
- `renderer`: draw calls, triangles, compiled programs, geometries and textures of the last frame.
- `pointLights` (lights the shaders loop over) and `pointLightPool` (`size`, `used`, ADR-017).
- `remotePlayers`, and `dom` (DOM nodes, nameplates, nameplates shown).
- `msaa` and `resolutionScale`: what the frame-pacing guard currently allows.

## 2. Measuring on a real GPU

1. `npm install`, then `npm run dev` from the repository root (web, game server and local LiveKit). On a fresh clone
   the dev server uses the test network on its own; to set it yourself, first copy `apps/web/.env.example` to
   `apps/web/.env` (Windows: `copy apps\web\.env.example apps\web\.env`). The game server is not required for the
   perf scene, but without it the console shows reconnect errors.
2. Open Chrome (or Edge) with a normal window, then go full screen with F11 on the monitor you play on.
3. Open `http://localhost:5174/?perf=hall60` (the dev server's fixed port). Wait until the loading screen is gone and about 30 seconds more: the
   KayKit characters load one model at a time, and the hall is complete when every synthetic player sits, stands or walks (67 on a 60-seat hall).
4. Open DevTools (F12) → Console. Run `__perf.reset()`, wait 20 seconds without touching anything, run
   `__perf.summary()`. Copy the result.
5. Repeat with `&adaptive=0` (the raw cost at full resolution with MSAA) and with `&quality=low`.
6. Repeat with `/?perf=district`.
7. For a deeper look: DevTools → Performance → record 5 seconds. The "Main" track shows the main thread (JavaScript
   and layout) per frame; the "GPU" track shows GPU time. Whichever is longer limits the FPS.
8. Send the summaries together with: the GPU and CPU model, the browser and its version, the monitor resolution and
   the Windows display scaling (125 %, 150 %…), and whether the laptop was plugged in.

How to read the result:

- `fps` near your monitor's refresh rate (60, 120, 144): fine.
- `fps` low and `mainMs` well below `frameMs`: the GPU limits. Check `msaa` and `resolutionScale` (the guard should
  have reacted within a few seconds), the display scaling, and whether Chrome uses the discrete GPU
  (`chrome://gpu`).
- `mainMs` close to `frameMs`: the CPU limits. `sections` says where.

## 3. What a full hall costs

Measured in Chromium with SwiftShader (the GPU emulated on the CPU, 4 shared vCPUs, no GPU) at 1280 × 720, with
`?perf=hall60` on a 60-seat hall, before the optimisations below. SwiftShader exaggerates GPU work enormously, so the work was split into CPU-side and
GPU-side costs, and GPU costs were attributed by switching one thing off at a time.

GPU side (SwiftShader frame time, high tier, 67 players):

| Switched off | Effect on the frame |
|---|---|
| MSAA (4× on a half-float target) | −43 % (4.3 s → 2.5 s) |
| The 20 point lights of the two other locations (1000 m away, out of range) | −49 % of what was left (2.4 s → 1.25 s) |
| The hall's own 5 point lights | −13 % more |
| All 67 avatars (300k skinned triangles) | −45 % of what was left |
| The shadow map update (nothing in the hall casts but you) | about −2 % |

Low tier: the 67 placeholders cost 536 of the 622 draw calls and a third of the frame.

CPU side (main-thread JavaScript per frame, high tier): three.js render submission (bone texture uploads for 67
skeletons, uniforms), the scene-wide matrix update (7,000 nodes, almost half of them in the two hidden locations),
the 67 AnimationMixers, the Live Now board's once-a-second schedule bucketing (a new `Intl.DateTimeFormat` per date:
a 8 ms hitch every second on this machine), and two forced layouts per frame from reading the container size after
the nameplates had been moved.

After the optimisations (the rules in § 4; same scenes, same machine): GPU work per frame in the full hall −37 % on
the high tier (the light pool), main-thread JavaScript per frame at a 60 FPS cadence −32 % (high) and −59 % (low),
low-tier draw calls 622 → 92.

## 3b. A full hall with real networked clients

`?perf=hall60`'s players exist only in one browser, so neither the server's fan-out to 60 sockets nor a client decoding
59 networked players. A load test with at least 50 real clients covers that. The load script:

```bash
npx tsx scripts/dev/hall-load.mts --clients 59 --seconds 150 --port 8795 \
  [--page "http://127.0.0.1:5173/?perf=hallnet&quality=low"] [--out result.json]
```

It starts its own game server (names off, no LiveKit) with `scripts/dev/eventloop-probe.mjs` preloaded (event-loop
delay and CPU every 5 s, no server change), opens 59 WebSocket clients that behave like the `hall60` mix — 51 seated
(pose `sit`, one `hall_seat_claim`, heartbeats), 4 standing (a turn every ~5 s), 4 walking the promenade at the 10 Hz
tick rate — with reactions (about one per client per 20 s plus a 20-client applause burst every 30 s) and hall chat
(about one line every 2 s), and measures the server, the relay latency of a tagged hall chat line and what one seated
client receives. With `--page` (a Vite dev server started with `VITE_SERVER_ORIGIN=http://127.0.0.1:<port>`), one
Chromium page joins the same hall as a real client and its frame probe is read after a 20 s warm-up.

The seats, floor heights and standing and walking spots come from a hall layout: `--layout <module>` loads a module's
`hallLayout` export, so the clients sit on that hall's real seats; without it they use a plain 60-seat grid at floor
level inside the hall box. The server never checks positions, so either fills every seat but the layout's free one.
The measurements below used a 60-seat hall layout.

Measured on 2026-10-08 on a 4-vCPU virtual machine without a GPU (the server, the 59 clients, Vite and SwiftShader Chromium all on the same
machine), 130 s windows (`docs/architecture/perf-evidence/hall-load-59-{low,high}.json`):

| | Low tier page | High tier page |
|---|---|---|
| Server CPU (one core) | 5.3 % | 4.8 % |
| Server event-loop delay p50 / p99 / max (1 ms sampling; idle ≈ 1 ms) | 1.1 / 3.0 / 41 ms | 1.1 / 3.0 / 56 ms |
| Server memory (RSS) | 141 MB | 141 MB |
| Hall chat relay latency p50 / p95 / max | 0.4 / 1.2 / 2.0 ms | 0.4 / 1.2 / 3.7 ms |
| One seated client receives | 44.6 messages/s, 9.1 KB/s | 44.5 messages/s, 9.1 KB/s |
| Real client: FPS (SwiftShader) | 6.4 | 1.1 (the guard: MSAA off, resolution 75 %) |
| Real client: main-thread JS per frame | 5.4 ms (players 0.27, render 3.4) | 16.0 ms (players 1.6, render 11.0) |
| Real client: remote players / draw calls | 59 / 92 | 59 / 132 |

Reading it:

- **The server is far from its limit** with a full hall: about 5 % of one core and sub-millisecond relay latency. Each
  5 s window has one longest pause of 6–56 ms (p99 stays under 3 ms) — on a machine it shares with the 59 clients,
  Vite and a SwiftShader browser, so a dedicated server should see less. Each player receives about 45 messages/s (mostly the four walkers' 10 Hz transforms), about
  9 KB/s — about 0.6 MB/s of WebSocket egress for 60 players, small next to the stage video, which the SFU sends to every
  viewer (up to 3.5 Mbps for slides and 7 Mbps for video on the top layer, `docs/architecture/WATCH_HALL.md` § 6).
- **A client decodes 59 networked players cheaply**: the `players` section (remote players, their animation and hall
  presence) is 0.3 ms on the low tier and 1.6 ms on the high tier per frame — the same order as with the synthetic
  crowd (§ 3, at a 60 FPS cadence). The frame rate here is SwiftShader's GPU emulation, as in § 3:
  it says nothing about a PC with a GPU.
- Not measured: voice (no LiveKit in this run; § 2's real-GPU procedure and a hosted test cover it), more than one
  real client, other machines' networks.

## 4. Rules that keep it fast

- **Light count never changes** (it recompiles every shader). Locations own their lights as sources; the scene-level
  pool mirrors the active location (ADR-017). A location's light count may grow; the pool grows with the busiest one.
- **Nothing animates or updates off screen or in a hidden location.** Remote players outside the active location or
  the frustum don't animate; hidden locations skip the matrix update; a player whose nothing changed is frozen.
- **Distance decides animation rate** (`networking/animationLod.ts`), in seconds, not frames.
- **Placeholders are instanced** (`player/PlaceholderCrowd.ts`): add parts to the rig's `parts` list, never extra
  meshes outside it.
- **DOM overlays write only on change and never read layout after writing** (`ui/Nameplates.ts`): read sizes first,
  pass the cached viewport size.
- **No allocation in per-frame loops**: reuse vectors (`headPositionInto`, `sampleInto`), entry objects and arrays.
- **Formatters, regexes and other expensive objects are built once** (`watch/schedule.ts`).
- **The frame-pacing guard counts real time** (`core/framePacing.ts`): MSAA first, then resolution (to 75 %), then the
  crowd's animation detail.
