# docs/protocols

Wire formats between the browser client and the game server.

| Document | What it covers |
|---|---|
| [multiplayer-protocol.md](multiplayer-protocol.md) | The WebSocket message contract: join and presence, movement, identity and owned names, chat, private payments, Watch Hall, moderation, reconnecting and server-side validation. |

The message types themselves live in `packages/shared/src/multiplayer-protocol.ts`, which both `apps/web` and `apps/server` import, so the two sides
are checked against the same definitions at compile time. A change to a message shape updates `packages/shared`, this
documentation and the tests on both sides together.
