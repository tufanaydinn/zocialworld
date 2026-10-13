# ADR-019: Moderation tools — report, kick, ban, chat mute, per-IP connection cap, LiveKit publisher revoke

## Status

Accepted (2026-10-09). The tool set — report, kick, ban, a per-IP connection cap, and revoking a misbehaving publisher's
LiveKit grant from the server — was needed before the first invited test. Chat mute is added because chat spam is the most
common abuse, and it is the mildest tool.
This ADR records how the tools work within the privacy baseline (`docs/privacy/PRIVACY_MODEL.md` § 5). It amends ADR-014 (host powers) and ADR-015/016 (identity).

## Context

**What exists today**
- The Watch Hall has a secret host key (ADR-014) with stage powers: stop, lock, grant, queue removal and stage cooldowns. There is an audience vote, and an owned-name gate for talking and presenting.

**What is missing**
- There is no way to report a player, and no way to remove a player from the world or keep them out.
- Nothing limits how many sockets one machine opens. Queue squatting and sock-puppet votes are bounded only by the name fee.
- The server cannot revoke a LiveKit grant it already minted. A benched or rogue publisher keeps uploading until it reconnects. Honest viewers do not subscribe to it.

**Constraints**
- Never log chat, keys or IPs; store IPs no longer than security needs require.
- No nickname ↔ address link.
- No new npm dependencies.
- The client stays authoritative for movement (ADR-005).

## Decision

### 1. Roles

- **Moderators.**
  - A moderator is a session that presents one of the operator's moderator keys (`MODERATOR_KEYS`: a comma-separated list of secrets of at least 24 characters).
  - Keys are compared as SHA-256 digests with timingSafeEqual, like the host key, and fail closed when too short or weak.
  - Moderator powers work everywhere in the world. A moderator also has every Watch Hall host power.
  - The existing `WATCH_HALL_HOST_KEY` keeps its hall-only powers.
- **Visible.** A moderator's nameplate shows a small "Moderator" tag, so players know who can act. Whether a player is a moderator is never inferred from anything else.

### 2. Report (every player, guests included)

- **How.** The player menu gains **Report**: a reason (spam, harassment, impersonation, scam, inappropriate share, other) and an optional note of at most 280 characters. The reporter gets a short "Thanks — moderators were notified" acknowledgement.
- **Delivery.**
  - Reports go to online moderators in real time, and into an in-memory queue: the last 100 reports, each dropped after 24 hours or when handled.
  - They are **never written to disk and never logged.**
- **What moderators see.** The reported nickname, the reason, the note, the time and the location name (district, valley or hall). They also see the reporter's nickname, so false reports can be judged.
  - The reported player is never told who reported them.
  - No chat history is attached; the server keeps none.
- **Rate limit.** At most 3 reports per reporter per 10 minutes, and one per reporter–target pair per 10 minutes.

### 3. Moderator actions (player menu and a Moderation panel)

- **Chat mute** (10 min, 1 h, 24 h).
  - The target's chat, whispers and hall chat are dropped by the server. The target is told "You are muted for …".
  - Their voice is unaffected; use kick for voice abuse.
- **Kick.**
  - The target's socket is closed with reason `kicked` and a short message.
  - The same identity cannot rejoin for 10 minutes (§ 4 keys).
  - Any stage, floor, queue place or vote is dropped at once.
- **Ban** (1 h, 24 h, 7 days, or until lifted). Like kick, for the chosen duration, with a message that says until when.
- **Unban / unmute** from the Moderation panel.
- **Moderation log.** Every action goes into an in-memory log visible to moderators only: the last 200 entries, with moderator nickname, action, target nickname, duration and time. It is not written to disk or the server log; the server log records only "moderation action: kick", with no names.

### 4. What a kick or ban is keyed by

- **Owned names** (ADR-016) are keyed by the name's key hash.
  - A ban of 24 hours or longer on an owned name is stored in that name's record in `names.json`: `bannedUntil` only, no reason and no moderator. It therefore survives a restart, and a new fee-paid name is the only way around it.
  - Shorter bans are in memory.
- **Guests and holders without an owned name** are keyed by a per-process keyed hash of the connection's IP address: HMAC-SHA-256 with a random key generated at start-up and never stored.
  - These entries live **in memory only**, last at most 24 hours (longer bans are capped at 24 hours for this key), and disappear on restart.
  - The raw IP is never stored, logged or shown; the keyed hash cannot be compared across restarts or servers.
- **Both keys at once.** A moderator acting on a player with an owned name blocks both the name and, for at most 24 hours, the connection hash.

### 5. Per-IP connection cap

- **The cap.**
  - At most `MAX_SESSIONS_PER_IP` concurrent game sockets (default 4, so a household or a small LAN party still works) and at most 10 new connections per minute per IP.
  - Counted with the same in-memory keyed hash as § 4; nothing is stored or logged.
  - A refused connection gets a plain "Too many connections from your network" message.
- **Behind a reverse proxy**, the server takes the client IP from `X-Forwarded-For` only when `TRUST_PROXY` names the proxy's address. Otherwise it uses the socket address, so a client cannot spoof the header.
- **What it bounds.** Queue squatting and sock-puppet votes from one machine. A determined attacker with many IPs is still bounded mainly by the name fee.

### 6. LiveKit publisher revoke

- **When the server acts.** A turn ends by stop, vote, cooldown or kick; a ban; or a loss of identity (ADR-015 amendment).
- **What it does.** It calls LiveKit's RoomService over its HTTP (Twirp) API with a short-lived admin token signed by the existing `LIVEKIT_API_SECRET` (no new dependency).
  - It sets the participant's `canPublish` to false (stage end, identity loss), or removes the participant (kick, ban).
  - A failure is retried once and then only noted in the server log as "livekit revoke failed" (no names). Viewers still never subscribe to a non-holder.
- This closes the gap where a token minted before an identity loss stayed valid.

### 7. What this is not

- No automatic moderation, no word filter, no chat recording, no IP display and no permanent IP bans.
- No public ban list.
- Moderators cannot see wallet data, addresses or payments; there is nothing to see.

## Consequences

**Privacy**
- **New data.** Two kinds of data are new, both minimal:
  - in-memory keyed IP hashes for the connection cap and short guest bans (≤ 24 h, per process, never stored);
  - a `bannedUntil` field on owned-name records.
- **Reports** reveal the reporter's nickname to moderators, which is needed to judge abuse. The UI says so in the report dialog.
- **Threat models.** The multiplayer, identity, chat, voice and Watch Hall threat models and `docs/privacy/PRIVACY_MODEL.md` § 7 record these points.

**Protocol and operations**
- **Protocol.** New messages: `report`, `report_ack`, `mod_report`, `mod_action`, `mod_action_result`, `mod_log`, `moderation_notice`. The `kicked` and `banned` close reasons and the moderator tag in presence are also new. packages/shared, both parsers and the protocol document change together.
- **Operations.**
  - New variables: `MODERATOR_KEYS`, `MAX_SESSIONS_PER_IP`, `TRUST_PROXY`.
  - A deployment generates at least one moderator key, like the host key, and gives its moderators a short playbook.

**Limits**
- **IP-based limits.** People behind one carrier-grade NAT share an IP, which the default of 4 sessions allows for. VPNs bypass the IP hash; the name fee remains the main deterrent.
- **Kick and ban are server-side only.** A banned owned name can still hold and use its wallet outside the game; nothing about money changes.

## As built (2026-10-09)

The decision above is built as written. Where it left a detail open, this is what was chosen:

- **Sign-in.** The moderator key goes in the existing `hall_host_auth` field ("the same field accepts both"); it works
  anywhere in the world, and Profile → "Moderator sign-in" opens the same dialog outside the hall. Every attempt counts
  toward the session's 5.
- **Two small protocol additions.** `moderator_updated {playerId, moderator}` carries the tag when a player signs in
  mid-session (the "moderator tag in presence"), and `report_ack` has an `unavailable` status for a server without
  moderator keys (the report isn't kept, and the reporter is told so instead of "moderators were notified"). A refused
  connection closes with `4003 too_many_connections`, next to `4001 kicked` and `4002 banned`.
- **Mutes** are keyed like bans (§ 4): the owned name's key and the connection hash, so a reconnect does not escape
  one — but a mute's connection key covers only sessions *without* an owned name, so an unrelated owned-name holder on
  the same network keeps chatting. Moderators are never muted, and cannot act on each other.
- **LiveKit revoke scope.** `canPublish: false` when a turn is *taken* from its holder (a host's or moderator's stop or
  grant to someone else, the vote, a cooldown) and on identity loss; removal on kick or ban. A turn the holder ends
  itself, and the timeouts, don't revoke (the client unpublishes anyway). On a revoke the client releases its
  microphone and share but keeps the room and drops to listening, and says why. `LIVEKIT_API_URL`
  (optional) points the server at RoomService over an internal network.
- **Per-IP cap details.** `MAX_SESSIONS_PER_IP=0` turns both limits off (local load tests and the e2e suite only).
- **Reports** keep their target's keys server side (memory, ≤ 24 h), so a moderator can still mute or ban from a report
  after the reported player left.

### Refinements (2026-10-09)

- **"Disconnected now" means every live session.** A kick or ban closes every live session its entry covers — the
  target, a reconnect of it (also when acting from a report after the target left), another tab, an onboarding socket,
  and everyone else on a kicked or guest-banned network (who could not connect again anyway). Moderators are skipped: a
  moderator who shares the network stays connected but cannot reconnect until the key ends or another moderator lifts it.
- **A reported moderator is not told** (§ 2 holds for moderators too): reports about a moderator go to the other
  moderators only, live and in the state, matched by session or owned name (never the shared connection hash); the
  dismissal of such a report is left out of that moderator's log. The report dialog says so when the target is a
  moderator.
- **Report limits** count against every key the reporter has (owned name *and* connection); the pair's target is its
  owned name, or else its session.
- **The 24-hour connection limit is kept literally.** A connection hash is dropped from an entry once its 24 hours end
  (the name part of a long ban runs on), and an action taken from a report ends its connection key 24 hours after the
  report. A stored `bannedUntil` that ended while the server was down is cleared at start-up; one evicted to keep the
  list bounded is cleared too.
- **`mod_action_result.until`** says when an action really ends (a guest's 7-day ban: 24 hours), and the moderator's
  line says so; the log's `durationMs` is the effective length.
- **A trusted proxy forwarding a private address.** The server warns once when the trusted proxy forwards a private
  address, because then many visitors may share one key.
