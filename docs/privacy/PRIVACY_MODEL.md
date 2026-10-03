# Privacy Model

This document describes the privacy principles, binding architecture rules, and threat models for each system in the ZocialWorld prototype (CORE-001 through CORE-005).

---

## Binding Architecture Rule: Social Identity Separation

**Social identity** (nickname, avatar, bio, badges, project affiliation, presence) **must never automatically expose** financial identity (wallet address, balance, transaction history).

No feature may create: `nickname → wallet address → chain history`

This is a binding architectural rule. The multiplayer protocol, social identity system, and voice layer all enforce this separation.

## Shielded ZEC Payments (Future)

The intended future ZEC support/donation/payment experience is privacy-preserving by design, not by accident:

- Support/donation/payment flows are intended to use shielded ZEC where technically possible.
- Donor wallet identity must not become public social metadata by default.
- Recipient/project pages must not publicly expose the donor's wallet address.
- Public acknowledgement of a donor's social nickname must be explicit opt-in, never automatic.
- Wallet balance must not be exposed to project owners or other users.
- Transaction history must not become a social profile feature.

**No "fully anonymous" or "untraceable" claim may be made** without a complete payment threat model.

## Wallet Adapter Architecture (Future)

The intended future Zcash wallet integration uses a clean adapter/interface pattern rather than inventing a competing wallet implementation:

```
Social World
    |
Wallet Adapter
    |
Zcash Wallet Core
    |
Zcash Network
```

This separation ensures the application remains independent of wallet implementation details.

## Payment Threat Model Requirement (Future)

Before any ZEC support/donation/payment functionality ships, a threat model document must answer:

- What does the sender learn?
- What does the recipient learn?
- What does the application server learn?
- What does the wallet layer learn?
- What does a public chain observer learn?
- What identifiers are stored?
- What metadata is logged?
- How long is it retained?
- Can social identity and financial identity be correlated?

No payment-related privacy claim may ship without this review.

---

## Multiplayer Presence (CORE-002)

**What other players learn:**
- Random `playerId` (UUID, no relationship to real identity)
- Nickname (server-generated or client-supplied)
- Real-time position, yaw, animation state (~10 Hz)

**What is NOT transmitted:**
- IP addresses
- Device fingerprints
- Wallet data
- Camera position
- Raw input data
- Any persistent account identifier

**Network metadata:** The server knows the connection's source IP (inherent to TCP), but `WorldServer.ts` never reads, stores, or forwards this value.

**Identifiers are temporary:** `playerId`, `nickname`, and `colorSeed` are all generated per-connection and discarded on disconnect. No persistence, no reuse across reconnects.

**Logging:** Only operator-facing process output (server start/stop, errors). No per-connection or per-IP logging. No IP retention.

**Can multiplayer identity be correlated with wallet identity?**
CORE-002 introduces no application-level link. The protocol transmits no wallet identifiers. This implementation contains no code path that reads, stores, or transmits wallet data alongside multiplayer identity.

External correlation is not preventable by protocol design (timing/behavioral patterns, player's chosen nickname, future services), but CORE-002 itself creates no link.

---

## Social Identity (CORE-003)

**What is exposed:**
- Nickname (unvalidated text)
- Player presence (nearby-player detection)
- Context card (block state, mute state)

**What is NOT exposed:**
- Wallet address
- Wallet identity
- Financial data
- Real-world identity

**Block & Mute behavior:** Both suppress a player's visibility/voice locally, instantly, without notifying them. No server-side effect.

**Security:** All player text (nicknames, UI labels) is rendered via `textContent`, never `innerHTML`. No injection attacks possible.

---

## Proximity Voice (CORE-004)

**Transport:** LiveKit SFU (Selective Forwarding Unit), NOT raw peer-to-peer WebRTC.

Why SFU: Peer-to-peer WebRTC would expose each participant's IP address to every other participant. SFU means participants only connect to the server — no IP exposure to other players.

**What is exposed:**
- Proximity-based audio (distance-attenuated)
- Speaker identity (which player is speaking)

**What is NOT exposed:**
- IP addresses
- Wallet data
- Microphone metadata
- Voice processing details

**User control:** Microphone access is never requested automatically. Voice remains OFF until the player clicks "Enable Voice". Mute and Block both suppress voice locally.

**Provider data retention:** See LiveKit documentation. CORE-004 does not control LiveKit's retention policy.

---

## Project Discovery (CORE-005)

**What is exposed:**
- Static project registry (name, description, category, tags, URLs)
- No per-player tracking

**What is NOT exposed:**
- Which projects a player browses, searches for, or views
- Search history
- Viewing history
- Wallet data
- Any player-specific information

**Client-side only:** All search, filtering, and detail views are pure client-side function calls. No server round-trip. No network transmission of project browsing.

**External URLs:** Project links are rendered with `rel="noopener noreferrer"`. Once clicked, the destination site is a separate privacy boundary. CORE-005 makes no promise about third-party site behavior.

**URL safety:** Only `http`/`https` URLs are rendered as links. `javascript:`, `data:`, and malformed strings are rejected outright.

---

## No Analytics

There is no Google Analytics, Mixpanel, Amplitude, PostHog, tracking pixel, click-tracking, or search-tracking code anywhere in this codebase. No event resembling "project viewed," "search performed," or "link clicked" is recorded, locally or remotely.

---

## Future: Wallet Integration

Before any ZEC support/donation/payment functionality is approved, the Zcash Integration task must produce a threat model answering:

```
What does the sender learn?
What does the recipient learn?
What does the application server learn?
What does the wallet layer learn?
What does a public chain observer learn?
What identifiers are stored?
What metadata is logged?
How long is it retained?
Can social identity and financial identity be correlated?
```

No payment-related privacy claim may ship without this review.

**Intended architecture:** Social World → Wallet Adapter → Zcash Wallet Core → Zcash Network

This separation ensures independence from wallet implementation details.

---

## Rule

No privacy marketing claim ("anonymous", "untraceable", "the server knows nothing") may be made unless backed by a corresponding section in this document.

