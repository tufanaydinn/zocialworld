# ADR-014: Watch Hall — hall-scoped server state, stage sharing with audio, opt-in personal player

## Status

Accepted (2026-10-07).

The choices this ADR settles:

1. **Playback:** a shared screen plus an optional personal YouTube player.
   - The big screen is fed by the stage holder's shared tab, with audio, over our SFU.
   - A viewer may open a personal YouTube player after explicit consent.
2. **Watching is free, talking needs a wallet.**
   - A listen-only connection needs no wallet.
   - Proximity voice and taking the stage still need an unlocked wallet.
3. **Remote avatars:** other players render as KayKit characters on the high tier.
4. **Host role:** a secret host key.
5. **Technical plan:** the server derives hall membership from positions and relays the new hall
   message family.

Location placement follows ADR-010. Design details are in `docs/architecture/WATCH_HALL.md`.

## Context

The world needs a Watch Hall for talks and community calls, with:

- live streams, a replay archive and a schedule;
- watching together on a big screen;
- live chat, reactions and raise hand;
- a speaker/project card;
- 50–60 seats.

It replaces an earlier outdoor screen-sharing spot.

Constraints:

- ADR-005: movement is client-authoritative.
- ADR-006: the shared protocol package holds only contracts.
- ADR-007: one self-hosted LiveKit SFU room.
- ADR-009: the browser contacts no third party; iframes are ruled out.
- ADR-010: each location has a unique far origin; server knowledge of location is a protocol
  change.
- The earlier screen sharing was video-only. A participant attribute named the screen, which
  gave no arbitration and left a stale-claimant bug.
- The privacy baseline (`docs/privacy/PRIVACY_MODEL.md`).

## Decision

1. **Location.** The hall is the third ADR-010 location, at `WATCH_HALL_ORIGIN = (-1000, 0)`.
   `apps/web/src/world/locations.ts` becomes the single location test, replacing the two
   duplicated split tests in World.ts. Players enter by a door the content defines or the
   portal, and leave by the hall exit door or the portal.

2. **Hall-scoped server state.**
   - The game server derives membership from each session's last pose, using an AABB with a 2 m
     exit hysteresis. The bounds are protocol constants in packages/shared; each app implements
     the predicate.
   - New `hall_*` messages carry:
     - the stage queue (request, cancel, stop, handover, live, card, lock);
     - the floor;
     - reactions, batched every 250 ms;
     - raised hands;
     - seats (server-arbitrated, 60);
     - host authentication.
   - A `hall` chat channel is added. Hall messages go only to members. State is in memory only,
     never logged, and dropped on disconnect.
   - Membership is a **social scope, not access control**: positions can be spoofed (ADR-005).

3. **Stage arbitration on the game server, not in LiveKit.**
   - Viewers subscribe only to the ScreenShare and ScreenShareAudio tracks of the holder that the
     server names. A rogue publisher's track is therefore never downloaded (`autoSubscribe:false`).
   - The earlier `screen` participant attribute is removed, along with its stale-claimant bug.

4. **Tab audio, and optional computer audio.** The stage share captures tab audio and is
   published as ScreenShareAudio, which the token already allows. The holder may share any
   browser tab, any application window or the whole screen.
   - System audio is excluded by default, so the game's own playback of other players' voices is
     never re-broadcast.
   - The confirm dialog offers an opt-in "Share my computer's sound" box. With it, the share asks
     for system audio (`systemAudio:"include"`; Windows/ChromeOS Chrome/Edge only). While that
     share is live, **the holder's own hall audio is muted** (incoming voices and the stage), so
     nothing the game plays is captured back. The dialog warns that notifications and other apps'
     sound (for example another call) are shared too.
   - Optional computer sound was chosen so that a player can project their own PC screen, not
     only a browser tab.
   - Viewers inside the hall hear it through a non-positional stage channel.
   - The holder's mic, and the mic of a player given the floor, is heard hall-wide (gain at
     distance 0), from server state only.

5. **Watch mode.** `/voice/token` accepts `listenOnly:true` and mints `canPublish:false`. The
   server only ever narrows the grant. Listen-only clients subscribe only to stage tracks and
   stage mics. This narrows the earlier rule "voice needs a wallet" to "talking and presenting
   need a wallet".

6. **Host role.**
   - Set by `WATCH_HALL_HOST_KEY` (≥ 24 characters, else disabled).
   - Compared in constant time on SHA-256 digests, with attempt limits.
   - Held per session only; never logged, echoed or persisted.
   - Powers: force stop, grant/hand over, lock the stage, give the floor, lower hands, set the
     card while idle.

7. **Personal YouTube player (amends ADR-009's "no iframes" rule and the earlier "no in-game web
   browser" decision, for this case only).**
   - It requires explicit consent and is never automatic.
   - Chromium uses `<iframe credentialless>` on youtube-nocookie.com with
     `referrerpolicy="strict-origin"`. The production `no-referrer` policy breaks the embed
     (Error 153).
   - Other browsers open a new tab.
   - YouTube's `iframe_api` script is never loaded into the page. safeHtml's iframe ban stays.

8. **Watch catalogue (ADR-009 amendment).** `/content/watch` serves schedules and replays from:
   - the YouTube Data API (server key, optional);
   - the Atom feed, with backoff;
   - a curated, oEmbed-verified catalogue of replays;
   - recurring events and public calendars named in the catalogue, filtered by title rules.

   Thumbnails come from `i.ytimg.com` through the media proxy, under a strict path regex.

9. **Interaction priority.** `Interactable.priority` breaks the "nearest wins" rule for seats
   and hall boards, so that neighbours' player cards don't capture E in a full hall.

10. **Emote wheel and two new animation states.** Hold G to choose dance, raise hand, wave or a
    reaction.
    - `ANIMATION_STATES` gains `"dance"` and `"cheer"`. This is a protocol change: old clients
      drop transforms carrying them, and all clients ship together.
    - Wave, dance and cheer are plain animation states in `player_transform`. Raise hand and the
      reactions stay hall messages.
    - Dance is a procedural bone layer, so there is no new asset and no licence surface.
11. **Remote avatars.** High tier: KayKit characters, merged into one skinned draw call per
    player. Low tier: the placeholder, per ADR-008. Clients may skip unchanged transforms.

## Consequences

- **Protocol.** Hall messages are part of the multiplayer protocol. The protocol doc gains a Watch
  Hall section, and its drift is fixed (pay_* and voiceCapability were undocumented). The chat,
  voice and multiplayer threat models are updated, and a new `WATCH_HALL_THREAT_MODEL.md` is
  added.
- **Server knowledge.** The server learns which session is in the hall, seated, queued or has a
  hand raised. It is all in memory and never logged. Peers learn the same through the hall
  messages, and could already infer most of it from transforms.
- **What the stage holder exposes.** Their shared tab, video and audio, is visible to the SFU and
  to everyone in the hall. There is no E2EE claim.
- **Listen-only viewers.** They appear in the LiveKit room as non-publishing participants
  (playerId and nickname).
- **Personal player.** A viewer who opts in reveals to YouTube/Google their IP address and the
  game's origin. That is documented in the consent text and the threat model.
- **Rendering cost.**
  - KayKit remote avatars cost one skinned draw plus mixer work per player, against about 15
    draws for the placeholder.
  - Transform fan-out (O(n²)) stays the capacity limit. Skipping unchanged transforms mitigates
    it for a seated audience.
- **Point lights.** The hall adds at most 5. Every point light is scene-level and therefore paid
  in every location (ADR-010). This is flagged for a future light-pool change (done in ADR-017).
- **Not in v1.**
  - Recording and VOD of stage shares.
  - Synchronised YouTube playback across viewers.
  - Moderation beyond host powers and local mute/block. (Added on 2026-10-08 inside the existing
    design: an audience vote to end a share, host queue removal and per-player stage cooldowns, a 60-minute default
    max turn, and server-verified identity for presenting — `docs/architecture/WATCH_HALL.md` § 12. Report, kick and
    ban followed in ADR-019.)
  - Hall-scoped persistence.
