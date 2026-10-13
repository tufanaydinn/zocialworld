# scripts

Repository-wide tooling. None of it is application code: nothing here is imported by `apps/` or
`packages/`, and the client and server never depend on it at runtime.

| Directory | What it holds |
|---|---|
| `dev/` | Local development helpers. `livekit.mjs` downloads (checksum-verified), caches and starts a local LiveKit server for `npm run dev`; `with-env.mjs` runs a command with environment variables set the same way on Linux, macOS and Windows (used by `npm run dev:main`); `hall-load.mts` is a Watch Hall load test with real networked clients, and `eventloop-probe.mjs` is the preload it uses to measure the game server's event-loop delay and CPU. |
| `assets/` | `npm run assets:fetch`: downloads the third-party model packs listed in `assets/asset-registry.json`, checks every file against its recorded SHA-256 and writes it under `apps/web/public/assets/`. Includes the deterministic character rebuild and a minimal ZIP reader. |
| `tools/` | `registry-keys.mjs`: the operator's one-time tool that derives the name-registry and transfer-fee account and prints the values the game server needs. The seed phrase stays with the operator, offline. |

The wallet engine's build scripts are published separately.

## Tests

```bash
npm run test:scripts
```

runs the `node:test` suites of `dev/`, `assets/` and `tools/`.

## Load test

```bash
npx tsx scripts/dev/hall-load.mts --clients 59 --seconds 90
```

starts a game server on a spare port, fills the Watch Hall with networked clients and reports the server's
event-loop delay, CPU, hall-chat relay latency and per-client traffic. See the header of `dev/hall-load.mts`
for every option, and `docs/architecture/PERFORMANCE.md` for how the results are read.
