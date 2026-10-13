# Social Identity Threat Model

Scope: the social identity and nearby-interaction layer on top of the
presence relay — nickname selection/change
(`set_nickname`/`nickname_updated`), nickname uniqueness, nearby-player
detection, player selection/context card, and local block state
(`apps/web/src/social/`, `apps/server/src/nickname.ts`). This document
describes **what this specific implementation actually does** — not an
aspiration, not a future state. If the implementation changes, this
document must be updated in the same commit (per `docs/privacy/PRIVACY_MODEL.md`
§ 7).

No privacy claim beyond what's written here may be made about social
identity (`docs/privacy/PRIVACY_MODEL.md`, § Rule). This
document narrows, and does not relax, `docs/privacy/MULTIPLAYER_THREAT_MODEL.md`
— everything that document says about `playerId`/`colorSeed`/network
metadata is unchanged by this layer.

## What does another player learn?

Exactly the same fields the presence relay already broadcasts
(`docs/protocols/multiplayer-protocol.md`), plus the ability for a
nickname to change mid-session:

- `nickname` — now mutable post-join via `nickname_updated`. Still
  whatever string the client chose (server-validated/possibly
  conflict-suffixed — see "Can a nickname reveal real identity
  voluntarily?" below), never persisted.
- Whether another player has selected/interacted with them — **no.**
  Selection (`SocialStore.select`) and opening the player context card
  are purely local UI state on the selecting client. No message exists
  in the protocol for "player X selected/viewed player Y" — another
  player never learns they were looked at, same as they never learn they
  were blocked (see below).
- Nothing about "nearby" status is transmitted either — see "Is nearby
  state networked?" below.

## What does the application server learn?

Everything the presence relay already learns, plus:

- `set_nickname` requests (the raw requested string, and what the server
  resolved it to) — processed in-memory only, not logged beyond the
  operator-facing lines already described in
  `MULTIPLAYER_THREAT_MODEL.md` § What is logged?, which this layer does
  not change.
- **Nothing about block state.** See "Does blocked state leave the
  client?" below — this is a hard requirement of the social layer,
  and it is architectural, not just a policy: `SocialStore`
  (`apps/web/src/social/SocialStore.ts`) has no reference to
  `NetworkClient` or any networking type, and the wire protocol
  (`packages/shared/src/multiplayer-protocol.ts`) has no message type for
  reporting a block — there is no field to put it in even if some future
  code tried.

## What social identifiers exist?

- `nickname` (now mutable, same lifetime/scope as in the presence relay — see below).
- `colorSeed` — unchanged from the presence relay; still session-level pseudonymous
  tint metadata, not an identity.
- Local-only, never-transmitted: `selectedPlayerId` (which player's
  context card is open on this client) and `blockedPlayerIds` (which
  players this client has blocked). Neither is a "social identifier" in
  the sense of being shown to or learnable by anyone else — they are
  this client's own private UI/relationship state.

## Which identifiers are ephemeral?

All of them, same as in the presence relay:

- `nickname`: still tied to the connection's lifetime. A `set_nickname`
  change does not extend or reset that lifetime — disconnecting still
  discards it entirely; a reconnect is a new `playerId` and a fresh
  nickname negotiation (initial default or client-chosen, subject to
  conflict resolution again).
- `selectedPlayerId` / `blockedPlayerIds`: scoped to the current browser
  tab's `SocialStore` instance. Lost on page reload, tab close, or
  navigating away — by design, not as a gap to fix later: block state does not need
  persistence across a browser restart.

## Can a nickname reveal real identity voluntarily?

**Yes, and this is expected, not a flaw to fix.** The server validates
nickname *shape* (length, no control characters, no raw markup
delimiters — see `apps/server/src/nickname.ts`) and *uniqueness*
(deterministic `-2`/`-3`/… suffixing), not *content* or *meaning*. A user
is free to pick a nickname that is their real name, a handle they use
elsewhere, or anything else identifying. Nothing in this implementation
stops that, and nothing in this implementation should be read as
implying it does.

**A nickname is pseudonymous social metadata, not proof of anonymity.**
No code in the social layer claims otherwise, and no UI text may claim a nickname
provides anonymity — per `docs/privacy/PRIVACY_MODEL.md`'s binding rule, a
privacy claim like that would need its own reviewed threat model, and
this document explicitly does not make that claim.

## Can social identity be linked to wallet identity by this implementation?

(Since ADR-015 presence carries one capability
bit, `canReceive`, and only wallet holders choose names — see § Wallet
holders and guests at the end. Still no address, balance or history is
linked to a nickname anywhere.)

**No new link, for the same reasons `MULTIPLAYER_THREAT_MODEL.md`
already gives.** The social layer adds no wallet code, no wallet-adjacent field,
and no code path that reads or stores wallet data alongside `nickname`,
`playerId`, `selectedPlayerId`, or `blockedPlayerIds`. The player context
card (`apps/web/src/social/PlayerContextCard.ts`) shows nickname,
presence, and a color swatch — nothing else, and critically **no "View
Wallet" action or anything resembling one**, consistent with
`docs/privacy/PRIVACY_MODEL.md` § 1's binding rule.

The external-correlation caveats in `MULTIPLAYER_THREAT_MODEL.md`
("Can multiplayer identity be correlated with wallet identity?") apply
unchanged here: a chosen nickname can itself be identifying (see above),
and nothing at the protocol level can rule out correlation that happens
outside this implementation's own code paths.

## What external correlation risks still exist?

Unchanged from `MULTIPLAYER_THREAT_MODEL.md`, plus one addition specific to
the social layer:

- A player who renames mid-session (`set_nickname`) is still the same
  `playerId` to the server and to every other connected client for the
  rest of that session — renaming does not grant a fresh identity within
  a session, only a fresh *label*. Anyone who already associated the old
  nickname with this player (by having them selected, or simply by
  having observed them) can trivially observe the rename, since
  `nickname_updated` carries the same `playerId`.
- Everything already listed in `MULTIPLAYER_THREAT_MODEL.md` (nickname
  content choice, timing/behavioral correlation, operator/network
  metadata, future unrelated services, voluntary self-identification)
  continues to apply unchanged.

## Is nearby state networked?

**No.** "Nearby" is computed entirely client-side
(`apps/web/src/social/nearby.ts`'s `getNearbyPlayers`), from positions
the client already has (its own `LocalPlayer.position` and the transform
data the presence relay already relays for every visible remote player — see
`docs/protocols/multiplayer-protocol.md`). No new message, no new field,
no server involvement. Each client only ever learns "who is nearby *to
me*" — it has no way to ask whether it is nearby to anyone else (though
by the symmetry of the distance check, if A is within radius of B, B is
also within radius of A on B's own client, computed independently and
never exchanged).

## What does blocking do?

Entirely a local presentation change on the blocking client, implemented
in `RemotePlayerManager.setBlocked()`
(`apps/web/src/networking/RemotePlayerManager.ts`):

- The blocked player's nameplate is removed from the blocking client's
  screen.
- The blocked player is unregistered from `InteractionSystem`, so they
  can never become the "nearest interactable" and the "[E] View
  &lt;nickname&gt;" prompt never appears for them again on the blocking
  client.
- `SocialStore.isBlocked()` becomes `true` for that `playerId` on the
  blocking client — a query hook any future chat/voice feature can call
  before delivering a message or opening an audio channel from that
  player. Voice and chat use it: a blocked player's voice is never
  subscribed and their chat lines are hidden on the blocking client.
- The blocked player's 3D avatar **remains visible** in the world for
  spatial consistency (the documented preferred behaviour) —
  only the nameplate and interaction affordance are suppressed, not the
  character model.
- The blocked player is **not disconnected, not kicked, not rate-limited,
  not penalized in any way** by the server — the server does not
  participate in this at all (see next section).

## Does blocked state leave the client?

**No, by construction, not just by policy.** Two independent guarantees:

1. **`SocialStore` has no networking dependency.** It imports nothing
   from `apps/web/src/networking/`, holds no reference to
   `NetworkClient`, and calling `block()`/`unblock()`/`select()` only
   ever mutates in-memory `Set`/`string|null` fields and calls local
   listener callbacks. There is no code path from `SocialStore` to a
   WebSocket frame.
2. **The wire protocol has no block-related message type.** Every
   client→server message is enumerated in
   `packages/shared/src/multiplayer-protocol.ts`'s `ClientToServerMessage`
   union (`join`, `player_transform`, `heartbeat`, `set_nickname`, and the
   later chat, payment, hall and moderation messages) — none of them carry or resemble block state, and the server's parser
   (`apps/server/src/protocol.ts`) drops anything it doesn't recognize
   silently (see `WorldServer.test.ts`'s "the protocol has no
   block-related message type" test, which sends a `block_player`-shaped
   message and confirms the server simply ignores it).

The blocked player receives no signal of any kind — no message, no
visible state change, no behavior change in how the blocking client
treats them over the wire (their transforms are still relayed to the
blocking client exactly as before; only that client's own rendering
suppresses the nameplate/interaction locally).

## Is blocked state persisted?

**No.** `blockedPlayerIds` lives only in the `SocialStore` instance
`App.ts` constructs for the current page load. Reloading the page,
closing the tab, or restarting the browser all discard it completely —
this is the documented behaviour, not a gap. A future
persistent block/mute/report system (if ever built) would be a new,
separately-reviewed feature, likely requiring its own privacy review per
`docs/privacy/PRIVACY_MODEL.md` § 7, not an extension of this local-only store.

## What must never be exposed?

Everything `MULTIPLAYER_THREAT_MODEL.md` already lists, plus, specific to
the social layer:

- Another player's selection of you, or the fact that your context card
  was opened by someone.
- Whether you have been blocked by another client, or by whom.
- Block/mute/report state of any kind, to the server or to any other
  client.
- Wallet data of any kind in the player context card or anywhere else in
  this feature (no "View Wallet" action — see `docs/privacy/PRIVACY_MODEL.md`
  § 1).

None of these have a field or code path in the social layer. Adding one
would be an architecture-affecting change requiring a new ADR, and this
document would need a corresponding update before such a change could ship.

## Security / nickname rendering

A nickname is always rendered as text — `textContent`, a DOM text node,
or an `<input>`'s `.value` property assignment (itself safe regardless of
content) — never `innerHTML`, never string-concatenated into markup. See
`apps/web/src/ui/Nameplates.ts`, `apps/web/src/social/PlayerContextCard.ts`,
and `apps/web/src/social/NicknameControls.ts`. Server-side,
`apps/server/src/nickname.ts` additionally rejects (not sanitizes) a
nickname containing control characters or raw `<`/`>` delimiters outright
— a defense that stops a malicious nickname from ever being accepted in
the first place, independent of the client-side rendering guarantee.
Both layers are tested: `apps/server/src/nickname.test.ts` (server-side
rejection) and `tests/e2e/social.spec.ts` (client-side rendering safety,
using real browser DOM assertions against `<script>…</script>` and an
`onerror`-style payload).

## Wallet holders and guests (ADR-015)

ADR-015 (accepted 2026-10-07) splits players
in two: **wallet holders** (the in-game wallet reached ready/syncing at
least once this page session — a sticky, client-asserted flag) and
**guests**. Only holders choose a nickname and a character; guests get a
server-assigned `Guest-####` and the default character, cannot rename,
cannot send or receive ZEC, and may listen to voices but never speak.

### What other players learn

- **One bit: `canReceive`** ("can receive ZEC privately"), in presence
  and in `can_receive_updated`. Never an address, balance, network,
  transaction, lock state or unlock time. Because only holders can choose
  a name, a chosen name already implies the bit — this is documented,
  not hidden.
- **The chosen character**: one of 5 models and 8 colours (`avatar`), a
  cosmetic choice. The colour is an accent (nameplate underline, menu
  chip, the low-tier placeholder's belt and hat).
- **No badge.** The bit is shown only in the player menu ("Can receive
  ZEC privately: Yes/No — address never shown") and as the Send ZEC
  button's state. Nameplates carry no wallet marker, so a crowd is not a
  list of who to scam.
- **Changes are visible**: a guest becoming a holder (and choosing a
  name), a holder changing character or name, and "Forget this wallet"
  (a fresh `Guest-####`). Locking and unlocking are not visible.

### What the server learns and keeps

The boolean, the avatar and the name, in memory on the session only,
dropped on disconnect — no persistence (that arrives only with ADR-016's
name registry, which has its own threat model:
`docs/privacy/IDENTITY_THREAT_MODEL.md`). The `nickname_check`
request (allowed before join, so onboarding can check while you type)
reserves nothing and is never logged.

### Names: look-alikes and impersonation

- Names are **NFKC-normalised** and **unique case-insensitively**, so
  "Alice", "alice" and a fullwidth "Ａｌｉｃｅ" cannot be on screen at once.
- **Zero-width and bidi-control characters are rejected**, so two names
  that render identically cannot both exist through invisible characters.
- The **Guest pattern and its look-alikes are reserved**, so a holder
  cannot pose as a guest (and nobody can fake a server-style guest
  number), and `system`, `admin`, `host`, `moderator` and `zocial world`
  are reserved, so nobody can pose as the system.
- Not covered: cross-script confusables (a Cyrillic "е" in "Alice"), and
  squatting a famous name first-come within one live world. ADR-016's
  owned names address squatting; confusables need a future decision.

### Honour system — what a modified client can and cannot do

The holder flag is client-asserted until ADR-016. A modified client can
claim it: it then gets a chosen name, a character and a full voice
grant, exactly what an honest holder gets. It **cannot** receive money it
has no wallet for, steal or redirect a payment (the recipient's own
wallet seals its own address end to end, ADR-013), or obtain an owned,
confirmed name (ADR-016 requires an on-chain fee). The UI never says
"verified".

### What the device remembers

`player-profile-v1` in `localStorage`: the chosen character and, for
holders only, the chosen name, plus how the player entered last time —
so a returning player sees "Welcome back". Never a guest number, never an
address or anything else from the wallet. Reads and writes are wrapped in
try/catch; corrupt data means the first-visit flow. It links a player's
visits on that device only as weakly as a public name and a low-entropy
look already do, and it is never sent anywhere except as the `join`
fields.
