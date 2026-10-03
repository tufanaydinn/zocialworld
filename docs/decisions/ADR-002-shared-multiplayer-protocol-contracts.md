# ADR-002: Activate packages/shared for multiplayer wire protocol contracts

## Status

Accepted

## Context

CORE-002 originally shipped the multiplayer wire protocol's message
types declared independently in two places:

```text
apps/server/src/protocol.ts
apps/web/src/networking/protocol.ts
```

kept in sync only by `docs/protocols/multiplayer-protocol.md` and the
convention documented there ("Why the types are duplicated"). At the
time, `ADR-003` and `packages/shared/README.md` both anticipated this
exact moment — "the moment `apps/server` starts speaking the same
message shapes as `apps/web`" — as the trigger for activating a real
shared package, but CORE-002's initial delivery chose to defer that,
reasoning that the protocol surface was small enough to keep
doc-synced by hand and that activating a new workspace package was
itself a structural change outside a task whose brief said "do not
restructure CORE-001 systems."

A Markdown document is not a compile-time source of truth, and as chat,
voice presence metadata, project presence, or protocol versioning are
added, the two independent declarations can silently drift while both
sides still typecheck in isolation. Activating `packages/shared` as a
shared contract source addresses this risk, scoped narrowly.

## Decision

Activate `packages/shared` as a real TypeScript workspace package
(`packages/shared/package.json`, `tsconfig.json`, `src/`). It exports
**only multiplayer wire protocol contracts**:

- `ANIMATION_STATES` / `AnimationState`
- Every message shape: `JoinMessage`, `PlayerTransformMessage`,
  `HeartbeatMessage` (client→server); `PlayerSummary`,
  `WelcomeMessage`, `PlayerSnapshotMessage`, `PlayerJoinedMessage`,
  `PlayerLeftMessage`, `PlayerTransformBroadcastMessage`
  (server→client); and the `ClientToServerMessage` /
  `ServerToClientMessage` discriminated unions.
- Protocol-level constants both sides must agree on:
  `MAX_MESSAGE_BYTES`, `MAX_NICKNAME_LENGTH`, `DEFAULT_TICK_RATE_HZ`.

Both `apps/server/src/protocol.ts` and
`apps/web/src/networking/protocol.ts` now import these types from
`@project/shared` instead of declaring their own copies. There is
exactly one declaration of each message shape in the repository.

### What stays out of `packages/shared`

Per the review's explicit instruction and `packages/shared/README.md`'s
"no junk-drawer" rule:

- WebSocket connection handling (`NetworkClient` client-side,
  `WorldServer` server-side) — environment-specific, stays in each app.
- JSON parsing / runtime validation (`parseIncomingMessage`,
  `parseIncomingFrame`) — each side validates a *different* message
  direction using different logic, and the server's frame-size check
  uses Node's `Buffer`, unavailable in a browser. Validation functions
  stay local to each app; only the *types* they validate against moved.
- Rate limiting, stale-connection timeout — server-side policy, not a
  structural contract the client needs to agree on.

## Consequences

- A message shape can now only be wrong in one place. Changing a field
  on either side without updating `packages/shared` fails that side's
  typecheck immediately, rather than silently compiling against a
  stale local copy.
- `docs/protocols/multiplayer-protocol.md` remains the prose
  specification (semantics, rates, interpolation/validation strategy,
  privacy requirements) — this package is its typed counterpart for the
  shapes alone, not a replacement for the document.
- `packages/shared` is consumed directly as TypeScript source (no build
  step) via npm workspaces — both Vite (`apps/web`) and `tsx`
  (`apps/server`) process `.ts` source for workspace-linked packages
  natively. If a future need arises for `packages/shared` to ship
  compiled output (e.g. a consumer outside this workspace), that is a
  new decision, not implied by this one.
- Future protocol additions (chat, voice-presence metadata, project
  presence, protocol versioning) should extend this package rather than
  reintroducing per-app duplication — but each addition should be
  evaluated on whether it's genuinely a cross-app wire contract, per
  `packages/shared/README.md`, not added reflexively.
- This does not retroactively approve turning `packages/shared` into a
  general utility package. Non-protocol shared code stays in its
  originally-scoped placeholder packages (`packages/world-core`,
  `packages/player`, `packages/ui`, etc.) until each of those has its
  own activation decision.

