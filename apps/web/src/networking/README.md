# networking

The client half of the multiplayer connection: one WebSocket to the game server, the validation of every
message that arrives on it, and the remote players it describes. The wire protocol is documented in
`docs/protocols/multiplayer-protocol.md`; the message shapes live in `@project/shared`
(`docs/decisions/ADR-006-shared-multiplayer-protocol-contracts.md`), and the server half is in
`apps/server/src/`.

## Files

| File | Purpose |
|---|---|
| `NetworkClient.ts` | Owns the WebSocket only: connect, deferred join (onboarding runs before the player exists for anyone), heartbeats, the transform publish (unchanged poses are skipped), automatic reconnection with jittered backoff, and typed send helpers for chat, payments, names, the Watch Hall and moderation. Parsed messages reach the app through callbacks. No scene or player access. |
| `protocol.ts` | Runtime validation of raw server messages. Every message is rebuilt from known fields; arrays are capped, so a protocol mismatch can never hand the renderer or the UI unbounded data. Mirrors `apps/server/src/protocol.ts`. |
| `interpolation.ts` | Engine-agnostic entity interpolation buffer, keyed by local receive time (there is no clock synchronization with the server). |
| `RemotePlayer.ts` | A networked player: the placeholder character or, on the high tier, the player's rigged avatar, driven by the interpolation buffer instead of input. It never goes through collision (`docs/decisions/ADR-005-client-authoritative-movement.md`). |
| `RemotePlayerManager.ts` | The `Map<playerId, RemotePlayer>`: spawn and despawn, per-frame update with frustum and active-location culling, nameplates, speech bubbles, badges and tags, block presentation, and registration with the interaction system. |
| `remoteAvatars.ts` | Loads each avatar model once and hands out clones for remote players (high tier only; ADR-014, ADR-015). |
| `animationLod.ts` | Animation level of detail: distant avatars animate at a reduced rate, and a player whose pose did not change is frozen for the frame. |
| `config.ts` | Resolves the WebSocket endpoint from `VITE_WS_URL` (see `apps/web/.env.example`), falling back to the page's own host on port 8787 for local development. |

`core/App.ts` is the only file that wires `NetworkClient` to the rest of the app. None of the files above
know about `App` or `World`; only `RemotePlayerManager` touches the scene, the nameplate manager and the
interaction system.

## What this is not

Not chat, voice, authentication or persistent accounts. Chat UI is in `ui/`, voice in `voice/`, and
social identity (nickname choice, player selection, block) in `social/`. What is and is not transmitted is
described in `docs/privacy/MULTIPLAYER_THREAT_MODEL.md` and `docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md`.
