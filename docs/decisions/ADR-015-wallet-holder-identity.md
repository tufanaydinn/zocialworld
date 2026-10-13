# ADR-015: Wallet-holder identity, guest mode and onboarding

## Status

Accepted (2026-10-07). Amended 2026-10-08 (see the amendment below). It amends the earlier temporary-identity model and the rule that voice needs a wallet.

Product rules:
- **Payments:** payments to a guest are impossible: a guest has no wallet address, so the money would have nowhere to go.
- **Guests and voice:** talking with guests is fine, but a guest cannot open a microphone; guests can listen and write.
- **Character:** only wallet holders choose a character.
- **Name:** a wallet holder chooses a nickname and confirms it with a small on-chain fee against bots (ADR-016).

## Context

Today every player gets `Guest-####` and may rename freely, Send ZEC is offered to everyone, and voice is wallet-gated only on the client. The local player sees themselves as one KayKit model while others see a model derived from `colorSeed` (a mismatch). The product needs a clear split between wallet holders and guests, a start-of-game flow (connect wallet → character → nickname), and payments only between wallet holders.

Constraints:
- The privacy model (`docs/privacy/PRIVACY_MODEL.md`): no nickname → address → history link, and no "View Wallet".
- ADR-005: the client is authoritative for movement.
- ADR-013: payments are relayed by the server and the address is sealed end to end.
- ADR-014: watch mode is listen-only.

## Decision

1. **Two kinds of players.**
   - **Wallet holders.** The local wallet is `ready`/`syncing`, or was during this session (a sticky flag).
   - **Guests.** Everyone else.
2. **Guests:**
   - get a server-assigned `Guest-####` name and cannot rename;
   - get the default character (derived from `colorSeed`); there is no character choice;
   - cannot send or receive ZEC;
   - **cannot publish a microphone**, but may listen to nearby voices and the stage (listen-only LiveKit grant);
   - can use text chat everywhere, and can whisper and read.
3. **Wallet holders:**
   - choose a character: 5 KayKit models × 8 colours, with a live preview;
   - choose a nickname, confirmed by the ADR-016 fee registration; until it is confirmed, a holder keeps their Guest-style name;
   - may talk (full voice grant), present on the Watch Hall stage, and send and receive private ZEC.
4. **Presence on the wire.**
   - `PlayerSummary` gains `avatar {model, color}` and **`canReceive: boolean`**. That boolean is the only wallet-derived bit any peer receives.
   - Nothing about a wallet ever goes on the wire: no address, balance, network, lock state or unlock time.
   - There is no nameplate badge; the player menu shows "Can receive ZEC privately: yes/no — address never shown".
   - (A chosen nickname already implies a wallet under rule 3. This is documented, not hidden.)
5. **Server enforcement.** The server refuses:
   - `set_nickname` from guests;
   - `pay_request` to or from non-holders (`no_wallet` / `sender_no_wallet`);
   - full (publishing) voice tokens for non-holders (403 `wallet_required`); listen-only tokens are unchanged.
6. **Honour system until ADR-016.** The holder flag is client-asserted. A modified client could claim it and take a provisional, unconfirmed state, but it cannot steal or redirect money: payments still need the recipient's wallet to seal its own address (ADR-013). A confirmed name always needs the ADR-016 on-chain fee. The UI never says "verified".
7. **Onboarding before join.**
   - The flow is: Welcome ("Connect a wallet" / "Continue as guest") → wallet (the existing WalletPanel in onboarding mode) → character (holders) → nickname (holders, with an availability check and the ADR-016 confirmation) → Enter.
   - `nickname_check` is allowed before join; it reserves nothing and logs nothing.
   - The device remembers the character, plus the name for holders (`player-profile-v1`, try/catch storage).
   - Returning players see "Welcome back".
8. **Locking.**
   - A wallet that locks mid-session keeps its holder status (sticky).
   - "Forget this wallet" turns the player back into a guest: a fresh Guest name and `can_receive_updated false`.
9. **Names** are NFKC-normalised and unique case-insensitively. The Guest pattern, `system`, `admin`, `host`, `moderator` and `zocial world` are reserved; zero-width and bidi control characters are rejected.

## Consequences

**Privacy**
- **What peers learn.** One public bit per player, "can receive ZEC privately". With a chosen name it adds nothing new. It never links a name to an address, balance or history.
- **Threat models.** SOCIAL_IDENTITY, MULTIPLAYER, PLAYER_PAYMENTS and VOICE are updated in the same change.
- **Guest listening.** Guests can now hear nearby voices (listen-only). This narrows the earlier rule "voice needs a wallet" to "speaking needs a wallet". Speakers are told the audience may include guests.

**Fixes and protocol**
- **Model mismatch.** Fixed: the chosen avatar travels in presence.
- **Protocol.** `join` gains `avatar` and `wallet`. New messages: `set_wallet`, `set_avatar`, `nickname_check` / `nickname_check_result`, `avatar_updated`, `can_receive_updated`. New pay error reasons: `no_wallet`, `sender_no_wallet`. Old clients are incompatible; all clients ship together.

**Tests.** Existing tests that relied on any player being able to rename now join as holders.

**Amendment (accepted 2026-10-08): talking and presenting need a server-verified identity while a name
registry runs.** Testing showed that someone could sabotage a talk with a client that only claims the holder flag.
The amendment requires an owned name for the full voice grant, for talking and presenting only.
- While `NAME_REGISTRY` is `dev` or `zcashd` (registry live), the server grants the full (publishing) voice token,
  the Watch Hall stage and the floor only to a session showing an **owned name** (ADR-016: fee-confirmed or claimed
  by key). A holder without one gets 403 `name_required` from `/voice/token` and `identity_required` from the hall;
  the client sends them to the name step first. The client-asserted flag of § 6 no longer buys a microphone there.
- Without a registry (`off`, or a `disabled` zcashd setup) rule 6's honour system stays, and it now also gates the
  stage server-side (a guest's `hall_stage_request` is refused).
- Unchanged: guests listen; `canReceive`, payments and the nickname rules still follow the flag (§§ 4–6).
- Losing the identity (Forget this wallet, or the owner's newer session taking the name) drops the stage, the floor,
  the queue place and the vote at once; an already-connected LiveKit session keeps its proximity microphone until it
  reconnects (`docs/privacy/VOICE_THREAT_MODEL.md`).
- Design and every sabotage case: `docs/architecture/WATCH_HALL.md` § 12.
