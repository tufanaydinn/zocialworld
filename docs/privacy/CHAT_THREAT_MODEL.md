# Text chat and whispers — threat model

Scope: the text chat — General, Nearby and Whisper (private 1:1)
messages relayed by `apps/server` (`WorldServer` + `chat.ts`). Required by
`docs/privacy/PRIVACY_MODEL.md` § 7 ("private/direct messaging") before
public release.

## What each party learns

| Party | Learns |
|---|---|
| **Other players** | General: every line plus the sender's nickname. Nearby: only lines from players within 20 m. Whisper: only the two participants see it. No one sees IP addresses, wallet data or account ids. A player's `playerId` (random per session) is visible to clients, as it already is for presence. |
| **Application server** | Every message in transit, in plaintext inside TLS (wss): sender session, recipient session for whispers, text and time. **It stores nothing and logs no text**; lines exist only in memory while being relayed. Sessions are ephemeral: no account, no persistent identifier. |
| **Network observers** | With wss, only that a client talks to the server, and the traffic volume. Without TLS (local dev only), everything. |
| **Wallet layer** | Nothing. Chat has no wallet field and never touches the wallet adapter. |

## Identifiers, retention, logging

- **Identifiers:** session `playerId` (random UUID per connection) and the
  temporary nickname. No account, device id or fingerprint.
- **Retention:** server none (relay only). Each client keeps the last 120
  lines per tab in memory until the page closes.
- **Logging:** the server logs no chat content or metadata. Rejections are
  sent back to the sender only.

## Abuse controls

- **Rate limit:** a burst of 5, then one line every 2 s, on top of the
  generic 30 messages/s frame limit. Frames over 2 KB are dropped.
- **Sanitizing:** controls, bidi overrides and zero-width characters are
  removed, which prevents spoofed or reversed lines. Clients render with
  `textContent` only, so markup stays inert text (e2e-tested).
- **Block (local):** hides a player's lines, bubbles, name and voice for
  the blocker. The other player is not told.
- **Not built:** reporting and moderation (needs a moderation service and
  policy), word filters, and a persistent block list.

## Claims we may make

- "Chat messages are not stored or logged by the game server."
- "Whispers are delivered only to the recipient."

## Claims we may not make

- "End-to-end encrypted" — whispers are readable by the relay server in
  memory.
- "Anonymous" — nicknames and session ids are visible to other players.

## Possible next step

End-to-end encrypted whispers (ECDH between clients, with the server
relaying ciphertext only). This needs key verification to resist a
malicious relay; out of scope for the prototype.

## Addendum: the Hall channel (ADR-014)

The Watch Hall adds a third channel, `hall`, sent with the same
`chat_send` message and shown in the Hall tab (and, on the hall's
Discussion Corner board, as the last few lines).

| Party | Learns |
|---|---|
| **Other players** | Hall lines plus the sender's nickname, if they are Watch Hall members — sessions whose last reported position is inside the hall (2 m exit hysteresis). Players outside the hall get nothing. The Discussion Corner board shows recent lines to anyone looking at it inside the hall. |
| **Application server** | The same as for General: the line in transit, in memory only while it is relayed. It stores nothing and logs no text. It also uses the sender's hall membership, which it derives from positions it already has. |

- **Delivery:** members only, plus the sender's echo. A sender outside the
  hall gets `chat_rejected{not_in_hall}` (to the sender only). Membership
  is checked before the rate limit, so a refused line costs no chat token.
- **Same rules otherwise:** the same sanitizer, the same per-session rate
  limit (shared with General, Nearby and Whispers), the same local block.
- **No speech bubbles** for hall lines: they stay in the Hall tab and on the
  board.
- **Not a private room.** Membership is a social scope, not access control:
  positions are client-authoritative (ADR-005), so anyone can walk or
  teleport into the hall and read along. Treat hall chat as public to the
  hall, like General is public to the world.

**Claims we may make:** "Hall chat goes only to players inside the Watch
Hall, and is not stored or logged by the game server."

**Claims we may not make:** "private", "members-only" in an access-control
sense, or "end-to-end encrypted".

## Addendum: moderation (ADR-019)

- **Chat mute.** A moderator can mute a player for 10 minutes, 1 hour or 24 hours. The server then **drops** every
  chat line, whisper and hall line from that player before anything is relayed (nothing is stored), and answers
  each with `moderation_notice {muted, until}`; the client says "A moderator muted you until …" and shows it in the
  chat input. Voice is not affected. The mute follows the owned name's key and the connection hash
  (`MULTIPLAYER_THREAT_MODEL.md` § Moderation), so a reconnect does not escape it; moderators are never muted (a
  household's shared connection hash can include one). The connection hash only mutes sessions **without** an owned
  name: other guests on a muted guest's network are muted too — the mute dialog says so — but a
  player there with their own owned name keeps chatting. Lifting a mute tells every session it had silenced
  (`unmuted`). Mutes live in memory only, at most 24 h (the connection hash at most 24 h from when it was seen).
- **Reports.** "Report" in the player menu sends a reason and an optional note (≤ 280 characters, sanitized like a
  chat line). **No chat history is attached** — the server keeps none — and the report is never written to disk or
  logged. Moderators see the reporter's nickname (the dialog says so); the reported player is never told — a reported
  moderator included: reports about a moderator reach the other moderators only.
- **Logging.** Unchanged: no chat text, no note and no nickname reaches the server log; a mute logs only
  `moderation action: mute`.
- **Claims.** We may say: "the server drops a muted player's lines and never stores chat, notes or reports on
  disk". We may not say moderators can review past chat — they can't; there is none.
