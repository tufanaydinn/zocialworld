# packages/shared

`@project/shared`: the compile-time contracts of the multiplayer wire protocol, shared verbatim by the
game server (`apps/server`) and the web client (`apps/web`). There is exactly one declaration of each
message shape in the repository, so the two sides cannot drift apart. See
`docs/decisions/ADR-006-shared-multiplayer-protocol-contracts.md` for the decision and
`docs/protocols/multiplayer-protocol.md` for the prose specification (message semantics, rates,
interpolation and validation strategy) these types are the typed counterpart of.

## What's here

`src/multiplayer-protocol.ts` (re-exported by `src/index.ts`):

- **Presence:** `ANIMATION_STATES` / `AnimationState`, `join`, `player_transform`, `heartbeat`,
  `welcome`, `player_snapshot`, `player_joined`, `player_left` and the transform broadcast; the
  protocol limits both sides must agree on (`MAX_MESSAGE_BYTES`, `MAX_NICKNAME_LENGTH`,
  `DEFAULT_TICK_RATE_HZ`).
- **Identity and owned names** (ADR-015, ADR-016): `set_nickname`, nickname checks, name reservation,
  payment and claim messages, and their patterns and limits (`NAME_*`).
- **Text chat:** channels (`CHAT_CHANNELS`), `MAX_CHAT_LENGTH`, send/receive and rejection reasons.
- **Player payments** (ADR-013, ADR-018 § 4 and § 6): the sealed request/accept/notice handshake, the
  cancel message, the server-issued transfer-fee quote and its memo format (`PAY_*`).
- **Watch Hall** (ADR-014): the hall's public geometry contract (`WATCH_HALL_ORIGIN`,
  `WATCH_HALL_HALF_EXTENTS`, `WATCH_HALL_SEAT_COUNT`), stage, seats, hands, floor, reactions, the
  audience vote, the speaker card and host messages (`HALL_*`).
- **Moderation** (ADR-019): reports, moderator actions, notices, close codes and durations (`MOD_*`).

## What's NOT here, on purpose

This package holds **wire contracts only** — types, string-literal unions and small protocol-level
constants. It is not a general utilities package:

- No WebSocket connection handling (that stays in each app: `NetworkClient` in the client,
  `WorldServer` in the server).
- No JSON parsing or runtime validation (`parseIncomingMessage` / `parseIncomingFrame` stay in each
  app's own `protocol.ts`: they validate *different* message directions, and the server's frame-size
  check uses Node's `Buffer`, which a browser does not have).
- No rate-limiting policy or timeouts that are server-side implementation choices rather than part of
  the contract.
- No vendor SDK types. Voice's one exchange (`POST /voice/token`) is a plain HTTP request/response,
  not a message on the WebSocket protocol, so its two small shapes live with the handler
  (`apps/server/src/voice/tokenHandler.ts`).

Before adding something here, check that it is genuinely a cross-app wire contract. Non-protocol shared
code (UI primitives, world code, player composition) belongs in the app that uses it.

## Checks

```bash
npm run typecheck --workspace packages/shared
```

Both apps' typechecks (`npm run typecheck` at the root) compile against these types, and the server's
tests exercise every message shape through its parser.
