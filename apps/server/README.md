# apps/server

**Implemented as of CORE-002**: a minimal WebSocket presence relay for
multiplayer. See `docs/protocols/multiplayer-protocol.md` for the wire
protocol and `packages/multiplayer/README.md` for the full
client+server architecture overview.

## What this is

```text
Node.js + TypeScript + ws
```

Connection lifecycle, temporary session identity, join/leave/presence,
transform relay, sanity validation, and stale-connection cleanup. As of
CORE-003, also nickname validation and deterministic uniqueness
resolution (`src/nickname.ts`) for both `join` and `set_nickname` — see
`docs/protocols/multiplayer-protocol.md` § Nickname validation and
conflict resolution. As of CORE-004, also a small, structurally separate
voice-token-minting endpoint (`src/voice/`, see its own section below) —
`WorldServer` itself remains a presence relay only and has no voice
responsibilities. No framework (no NestJS/Fastify), no database, no
Redis — none of those were needed for CORE-002's, CORE-003's, or
CORE-004's scope.

## What this is NOT

Still true as of CORE-002 through CORE-004, and not changed by any of
them:

```text
wallet identity
Zcash address
payments
authentication
persistent accounts
chat history
voice RECORDING, transcription, or moderation (voice TRANSPORT itself is
  implemented as of CORE-004 — see "Voice (CORE-004)" below)
projects
database
inventory
economy
block/mute/report lists (local-session client state only — see
  docs/privacy/PRIVACY_MODEL.md)
```

See `docs/privacy/PRIVACY_MODEL.md` for exactly what this server does
and doesn't learn, log, or transmit.

## Origin validation

Every WebSocket handshake's `Origin` header is checked against an
allowlist (`src/origin.ts`), resolved based on `NODE_ENV`: outside of
`NODE_ENV=production`, local dev origins (`localhost:5173`,
`127.0.0.1:5173`) are always allowed on top of whatever `ALLOWED_ORIGINS`
adds; under `NODE_ENV=production`, the dev origins are excluded and the
allowlist is exactly `ALLOWED_ORIGINS` (see `.env.example`) — an empty
production allowlist makes the server refuse to start rather than run
with zero allowed browser origins. A present-but-unlisted Origin is
rejected, and a missing Origin is allowed either way (non-browser
clients, including this project's own tests, legitimately send none).
**This is a configuration safety check, not authentication** — there is
no auth system in CORE-002 — see `docs/protocols/multiplayer-protocol.md` §
Origin validation for the full reasoning.

## Running it

From the repository root:

```bash
npm run dev:server      # tsx watch src/index.ts — restarts on change
```

or `npm run dev` from the root to run both `apps/web` and `apps/server`
together. Copy `.env.example` to `.env` to override the default port
(8787), host, or stale-connection timeout — see that file for details.
No secrets exist in this server's configuration (except, optionally, the
voice signing key pair below — see its own security notes).

## Voice (CORE-004)

Voice (`/voice/token`, `src/voice/`) is **optional** — the server starts
and runs the same with or without it configured; see
`docs/decisions/ADR-003-proximity-voice-transport.md` for why
self-hosted LiveKit was chosen and `docs/privacy/PRIVACY_MODEL.md`
(CORE-004 section) for the full privacy review.

### 1. Run a local LiveKit server

The normal path, for a developer with ordinary internet access, is one
of:

```bash
# Option A — prebuilt binary (see https://github.com/livekit/livekit-server/releases)
livekit-server --dev

# Option B — Docker (no local Go toolchain needed)
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server --dev
```

`--dev` mode starts a single-node server with placeholder credentials
(`devkey`/`secret`) printed to its own console — local development only,
never a production credential, and never committed anywhere in this
repository. If your machine has no IPv6 support, add `--bind 0.0.0.0`
(this was required in this project's own CI/sandbox verification — see
ADR-007's "Verification performed" section).

Docker is the only external infrastructure CORE-004 introduces, and only
for this one narrowly-scoped local service — not required, not used for
anything else, no Kubernetes, no cloud deployment, no paid account (see
`packages/voice/README.md`).

### 2. Configure this server

Copy the devkey/secret `--dev` printed to the console into your `.env`:

```bash
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_ROOM_NAME=public-world
```

See `.env.example`'s own comments for the full explanation of each
variable. If any of the three required variables (`LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `LIVEKIT_URL`) is left unset, `/voice/token`
responds `503` and nothing else about the server is affected —
`src/voice/config.ts`'s `loadVoiceConfig()` returns `null` rather than
throwing.

### 3. Configure the client

`apps/web/.env.example`'s `VITE_VOICE_TOKEN_URL` already points at this
server's default port/path — no change needed for local dev with both
apps on `localhost`.

### Security notes

- `LIVEKIT_API_SECRET` signs voice tokens; it is read only by
  `src/voice/tokenHandler.ts` and never sent to a browser in any form —
  the browser only ever receives the already-signed, short-lived JWT.
- Never put a real production LiveKit secret in `.env.example` or commit
  a real `.env` file (already `.gitignore`d, same as the rest of this
  repo's environment files).

## Testing

```bash
npm run test --workspace apps/server
```

Runs `apps/server/src/WorldServer.test.ts` (the six CORE-002 tests plus
CORE-003's nickname-conflict/rename integration tests),
`apps/server/src/origin.test.ts` (Origin allowlist behavior),
`apps/server/src/nickname.test.ts` (pure-function nickname
validation/conflict-resolution coverage), and
`apps/server/src/voice/tokenHandler.test.ts` (CORE-004: token
request validation, JWT grant structure — no recording grant, short TTL
— and the same Origin/method/body-size handling as the rest of this
server, via a real `http.Server` + `fetch()`) — the integration tests
run against a real server instance on an ephemeral port, no running
`livekit-server` required (token minting is tested in isolation from the
actual SFU connection).

## Production build

```bash
npm run build --workspace apps/server   # tsc -> dist/
npm run start --workspace apps/server    # node dist/index.js
```

## Future architecture changes

Architecture-affecting changes (switching transport, adding a
persistence layer, changing movement authority) require an ADR documented
in `docs/decisions/` before implementation.
