# apps/server

The Zocial World game server: one Node.js process (TypeScript, `ws`, no framework, no database) that
runs the shared world for every connected browser.

## What it does

| Area | What the server does | Code |
|---|---|---|
| Presence | Connection lifecycle, temporary session ids, join/leave, transform relay with sanity validation, stale-connection cleanup. Movement stays client-authoritative (ADR-005). | `src/WorldServer.ts`, `src/protocol.ts` |
| Identity | Guests and wallet holders (ADR-015): nickname validation, NFKC normalisation, case-insensitive uniqueness and the `-2`/`-3` suffix rule. The server learns one wallet-derived bit per session (`canReceive`), never an address or balance. | `src/nickname.ts`, `src/identity.ts` |
| Owned names | Optional fee-confirmed name registry (ADR-016, ADR-018 § 5): reservations, payment detection (dev, zcashd or lightwalletd backends), challenge signatures for returning players. The only persistent data the server keeps, in one small JSON file. | `src/identity/` |
| Text chat | General, nearby, whisper and Watch Hall channels; sanitised, rate-limited, relayed and forgotten (never stored or logged). | `src/chat.ts` |
| Payments | A relay for sealed player-to-player payment handshakes (ADR-013); the amount never reaches the server. Optional per-transaction cap and transfer fee (ADR-018 § 4 and § 6), checked with a viewing key. | `src/payments.ts`, `src/transferFees.ts` |
| Wallet bridge | grpc-web → gRPC bridge to lightwalletd, so the lightwalletd operator never sees players' IP addresses; health-based failover across mirrors. | `src/zcash/lwdProxy.ts`, `src/zcash/upstreamPool.ts` |
| Test chain | Test-coin faucet on a regtest/test chain run by the deployment (zcashd RPC); refused on mainnet. | `src/zcash/faucet.ts` |
| Voice | Optional LiveKit token endpoint (`POST /voice/token`, ADR-007), authorised by a per-session capability, never by a client-supplied identity. | `src/voice/` |
| Content gateway | Read-only community content (ZecHub bounties and wiki, the Zcash Community Forum, GitHub repositories) and the Watch Hall schedule and replays (ADR-009, ADR-014), fetched and cached server-side so the browser never contacts those services. | `src/content/` |
| Watch Hall | Hall membership, the stage queue, seats, raised hands, the floor, reactions, the audience vote and the host role (ADR-014). In memory only. | `src/watchHall.ts` |
| Moderation | Reports, mutes, kicks and bans by signed-in moderators, a per-network connection cap (ADR-019). Network addresses are kept only as keyed hashes. | `src/moderation/` |
| Static site | Optionally serves the built web client with a strict Content-Security-Policy, so a deployment needs one HTTPS origin. | `src/staticSite.ts` |

Message shapes are shared with the client through `@project/shared` (`packages/shared`, ADR-006); the
prose protocol is `docs/protocols/multiplayer-protocol.md`. What the server learns, keeps and never
logs is described in the threat models under `docs/privacy/` (start with
`docs/privacy/PRIVACY_MODEL.md`) and the decisions in `docs/decisions/`.

## Running it locally

From the repository root:

```bash
npm install
npm run dev          # web client + this server + a local LiveKit for voice
npm run dev:server   # this server only (tsx watch src/index.ts), voice off
```

The server listens on `127.0.0.1:8787` by default. Without any configuration it runs the public world
with guest and wallet-holder identities, chat, payments without a fee, the wallet bridge to the public
test-network lightwalletd, the content gateway with the built-in sample Watch Hall catalogue, and no
name registry, faucet, moderators or host role.

`npm run dev` also starts a local LiveKit server (`scripts/dev/livekit.mjs`): the first run downloads
`livekit-server` from the official GitHub release, checks its SHA-256 against the release checksums,
caches it under `node_modules/.cache/livekit/` and starts it in `--dev` mode on `127.0.0.1:7880`. The
game server then uses it with the `--dev` placeholder keys. On macOS install it once with
`brew install livekit`, or point `LIVEKIT_BINARY` at a binary you already have.

### Local multi-user testing

1. Run `npm run dev` and open two browser windows at `http://localhost:5174`. Microphone access works
   on `localhost`.
2. Window A: create an in-game wallet, choose a name, press **Enable Voice** and allow the microphone.
   Window B: the same, or continue as a guest and press **Listen to voices**.
3. Walk close to each other and hold `V`: the other window shows you speaking.
4. Watch Hall: A requests the stage at the podium, presses **Start sharing** and picks a tab with
   **Share tab audio** ticked; B inside the hall sees it on the big screen (a guest presses
   **Watch the stage**).

To try owned names without a chain, start the server with `NAME_REGISTRY=dev` (it confirms every
reservation after about two seconds and refuses to start with `NODE_ENV=production`). To try moderation
or the host role, set `MODERATOR_KEYS` or `WATCH_HALL_HOST_KEY` to a long random value
(`openssl rand -base64 32`).

If voice fails, the voice panel names the reason (no voice server, an insecure page, the microphone
permission, no microphone, a guest session, LiveKit unreachable, UDP blocked). Other devices on your
LAN can join the world and chat when `HOST=0.0.0.0`, but browsers block the microphone and screen
sharing on plain-HTTP LAN addresses; that needs HTTPS.

### Using your own LiveKit

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (all three) in `apps/server/.env`, or opt
out of the local one with `SKIP_LOCAL_LIVEKIT=1`. For a manual local server:

```bash
livekit-server --dev
# or
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server --dev
```

`--dev` prints the placeholder pair `devkey` / `secret` (local development only). On a machine without
IPv6, add `--bind 0.0.0.0`. Without a complete LiveKit configuration `/voice/token` answers `503`
`{"error":"voice_unconfigured"}` and everything else runs unchanged.

## Configuration

Copy `apps/server/.env.example` to `apps/server/.env`. Every variable the server reads is listed there
with its default and meaning; the file holds placeholders only. Real values for a deployment (the
LiveKit secret, host and moderator keys, viewing keys, API tokens) come from the deployment's
environment and are never committed. The main groups:

| Variables | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `HOST`, `STALE_TIMEOUT_MS`, `ALLOWED_ORIGINS`, `WEB_DIST` | Process, Origin allowlist (required in production; see `src/origin.ts`), serving the built client. |
| `LIVEKIT_*`, `SKIP_LOCAL_LIVEKIT`, `LOCAL_LIVEKIT_PORT` | Voice. |
| `GITHUB_TOKEN`, `YOUTUBE_API_KEY`, `WATCH_CATALOG_FILE` | Content gateway and Watch Hall catalogue (`src/content/watchCatalogTypes.ts` describes the file format). |
| `WATCH_HALL_HOST_KEY`, `WATCH_HALL_MAX_TURN_MS` | Watch Hall host role and stage turn cap. |
| `MODERATOR_KEYS`, `MAX_SESSIONS_PER_IP`, `TRUST_PROXY`, `LIVEKIT_API_URL` | Moderation, connection limits, reverse proxy. |
| `ZCASHD_RPC_*`, `FAUCET_ZEC`, `NAME_REGISTRY*`, `NAME_FEE_ZEC`, `NAME_MIN_CONF` | Test-chain faucet and owned names. |
| `ZCASH_NETWORK`, `LIGHTWALLETD_URL`, `PAYMENT_CAP_ZEC`, `PAYMENT_FEE_*`, `PAYMENT_MIN_CONF`, `*_FEE_USD`, `NU7_ACTIVATION_HEIGHT`, `BUILD_ID`, `CSP_MODE` | Network, payment cap, transfer fee, client build id, page security policy. |

`ZCASH_NETWORK=main` means real ZEC. On mainnet the server refuses test-chain-only settings (the faucet,
the `zcashd` and `dev` registries), and name fees and the transfer fee need the operator's explicit
`NAME_REGISTRY_MAINNET_ACK=accepted` / `PAYMENT_FEE_MAINNET_ACK=accepted`. The fee and registry
viewing key and address are generated by the operator with `scripts/tools/registry-keys.mjs` (the seed
stays offline; the server only receives the viewing key).

The server logs its effective configuration at start-up (never a secret, key or address).

## Tests

```bash
npm run test:server          # from the root; same as: npm run test --workspace apps/server
npm run typecheck
```

The suite uses Node's built-in test runner. Most tests start a real `WorldServer` or HTTP handler on an
ephemeral port and drive it with real WebSocket and `fetch` clients; the rest are pure unit tests with
injected clocks. No LiveKit, zcashd or lightwalletd is needed: those are faked, and the fee and name
checks decrypt recorded regtest transactions with the vendored `vendor/zcash-tx-decrypt` helper.
Browser end-to-end tests live in `tests/e2e/` (`npm run test:e2e` from the root).

## Production build

```bash
npm run build --workspace apps/server   # tsc -> dist/
npm run start --workspace apps/server   # tsx src/index.ts
```

Architecture-affecting changes (transport, persistence, movement authority, anything touching what
the server learns about players) need an ADR in `docs/decisions/`.
