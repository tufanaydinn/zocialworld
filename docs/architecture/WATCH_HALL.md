# Watch Hall — systems design

How the Watch Hall works: the stage, seats, boards, chat and reactions, media, the personal player,
the content gateway, the client UI, privacy, tests and stage moderation. Decisions are recorded in
`docs/decisions/ADR-014-watch-hall.md`. A hall is content: the client builds whichever hall the
content provider supplies, through the contract in section 3. When this document and the code
disagree, fix one of them in the same commit.

## 1. Product scope

1. **Live streams.** Zcash community calls, conference sessions, developer talks, project
   demos, grant updates. Shown as Live Now (in-hall stage, YouTube live when the server has an
   API key, calendar events in progress) and playable on the big screen through the stage.
2. **Replay archive.** Curated collections from the operator's catalogue, served by the content
   gateway (`/content/watch`).
3. **Schedule.** Tabs Live / Today / Upcoming / Replays in the Watch panel. Today is grouped by
   the viewer's local date.
4. **Watching together.** A player takes the stage (server-arbitrated queue) and shares a browser
   tab or screen **with tab audio** onto the big screen, through our LiveKit SFU. Everyone inside
   the hall sees and hears it; nobody outside does.
   - Viewers never contact third parties.
   - Optional **personal player**: a viewer may open a YouTube video in their own overlay after an
     explicit consent. This contacts YouTube; it uses a credentialless iframe in Chromium and opens
     a new tab elsewhere.
5. **Live chat, reactions, raise hand.**
   - A `hall` chat channel, shown as the Hall tab and on the Discussion Corner board.
   - Eight emoji reactions (keys 1–8), floating over the reacting player, with live counts.
   - Raise hand (H).
   - The presenter or a host can **give the floor** to a player who raised a hand (raising it is the
     consent): that player's mic is heard hall-wide, they are told so, and they can give it up.
6. **Speaker / project card** under the screen: who is on stage, the title, speaker, project,
   and GitHub / docs / ZecHub / forum links. A DOM card with clickable links opens from the
   podium area or the HUD.

Also:

- Up to 60 numbered seats (the protocol's seat ids; a hall may have fewer).
- On the high tier, other players render as rigged KayKit characters (seated, waving).
- Host role through a secret key.

## 2. Location and travel

- **Slot.** The hall occupies the west location slot (ADR-010): `WATCH_HALL_ORIGIN`
  (`packages/shared`) is its origin, and `apps/web/src/world/locations.ts` assigns every point with
  x < −500 to it. Only the active location is rendered and updated.
- **Local frame.** World = origin + local. +z points toward the entrance and the stage is at −z,
  so arriving players face −z.
- **Travel.** The content lists two destinations with fixed ids (`world/hall/contract.ts`):
  `watch-hall` (the arrival point inside the hall, facing the screen) and the unlisted
  `watch-hall-exit` (where the exit door leads). The Watch panel's "Go to hall", the exit door and
  the performance scenes travel to them; an id the content does not list does nothing.
- **Interior.** The hall location reports `interior: true`, so the atmosphere switches to its
  interior profile while the hall is active.

## 3. Hall contract (`apps/web/src/world/hall/hallGeometry.ts`, `contract.ts`)

A hall is built by the location module in the `hall` slot from a `HallLayout`, which the content
provider also exposes as `ContentProvider.hallLayout`. The hall systems never import a particular
hall: the seat system, the hall presence and the people list get the built hall's seats, the
performance scene gets the layout.

**Fixed by the protocol, the same for every hall:**

- Membership: `hallContains(x, z, margin)` is true when |x − ox| ≤ 20 + margin and
  |z − oz| ≤ 15 + margin (`WATCH_HALL_HALF_EXTENTS`). Client and server use enter = 0 and
  leave = 2 (`WATCH_HALL_EXIT_MARGIN_METERS`) as hysteresis. The voice policy (`voice/hallAudio.ts`),
  the stage system and the people list all use this box.
- Seat ids: 0 … `WATCH_HALL_SEAT_COUNT` − 1 (60). The server arbitrates ids and does not know seat
  positions, so a hall may have fewer seats.

**`HallLayout`** (hall-local metres unless noted):

| Member | Meaning |
|---|---|
| `seats` | `HallSeat`s: id, row (0 = front), side (`left` is −x, seen facing the stage), index (from the centre aisle outward), the world seat point and yaw (facing the screen) and the stand point behind it, within the seat's 0.9 m reach so a player who stood up can sit straight back down. `seatRows()` builds rows of two blocks either side of a centre aisle. |
| `stage` | The platform rectangle and its floor height; `isOnStage(x, z)` tests it (world). |
| `screen` | The picture's centre and size, 16:9, facing +z. |
| `speakerCard` | The strip under the screen, and the spot where a player opens the card. |
| `podium` | Its position on the stage, and the spot where a player takes the stage. |
| `boards` | The Live Now and Discussion Corner boards: position, yaw, size, bottom edge and use spot. |
| `arrival`, `exit` | Where arriving players stand; the exit door's interaction point. |
| `crowd` | Standing spots, a walkway and a free seat for the load and performance scenes. |
| `heightAt(x, z)` | The walkable floor height (world). |
| `registerColliders()` | The hall's colliders; the stand points, the arrival, the exit and the use spots stay open. |
| `minimap()` | The hall's map, titled "Watch Hall". |

`hallLayoutProblems(layout)` lists inconsistencies (seat ids, points outside the hall box, stand
points out of reach, seats off their floor, the podium spot off the stage); each layout's unit test
asserts that the list is empty.

**Seat labels.** `seatLabel(seat)` names a seat from its fields, for example "Row 2 · left 3". The
people list shows it; a seat id the hall does not have gets no label.

**What the built hall hands over** (`WatchHallHandles`, exposed as `world.watchHall`, null when the
content has no hall): the screen (`HallScreenHandle`), the Live Now, Discussion Corner and
speaker-card faces, the seats and the podium position. The builder registers its interactables with
priority 1, above players' cards (0):

| Interactable | Does |
|---|---|
| `wh-live-now` | Opens the Watch panel. |
| `wh-discussion` | Opens the Discussion menu. |
| `wh-card` | Opens the DOM speaker card. |
| `wh-podium` | Requests the stage. |
| `wh-exit` | Travels to `watch-hall-exit`. |
| `wh-portal` (optional) | Opens the portal panel. |
| `wh-seat-<id>` | Registered by the seat system, not the builder: radius 0.9, priority 2. |

**Sample hall.** Without a deployment content module the client builds the sample hall
(`content/sample/hall.ts` and `hallLayout.ts`): a box room of primitives filling the hall box, a
low stage with the screen, the speaker-card strip and a podium, the two boards in the front corners
and one row of four seats. The stage, seats, boards, voice and `?perf=hall60` all run on it.

## 4. Presentation (screen and boards)

The faces every hall mounts are shared: `world/hall/screen.ts` (the big screen) and
`world/hall/boardFaces.ts` (the boards, the speaker-card strip, the screen's idle face and its LIVE
pill). The hall around them is the content's.

- **Screen.** An unlit panel at brightness ≤ 0.8 with `fog: false` (bloom threshold 0.82), in front
  of a black backing, so a video with another aspect ratio is letterboxed. A VideoTexture handed to
  `setTexture` gets trilinear mipmaps and anisotropic filtering, so a shared slide's body text stays
  legible from far seats. Presenters should keep anything the whole hall must read at 40 px or more
  on a 1920 × 1080 share.
- **Idle face** (nobody on stage): a gold ZEC emblem in a gold ring on a deep navy-to-purple field
  with a soft glow, and a title and subtitle under it (`setIdleMessage`; default "Watch Hall" /
  "Nobody on stage — request it at the podium"). Drawn at 2048 × 1152.
- **Boards.** Canvas textures following the LiveBoard / textMaterial conventions (brightness 0.8,
  anisotropy 16, Georgia titles, a wood gradient, cream text, gold accents). They redraw only when
  their data changes (≤ 1 Hz). Thumbnails load only from the page's own origin and the content
  gateway's media proxy.
- **Lights.** Point lights are rationed (ADR-017): a hall's PointLights become hidden sources that a
  fixed pool of scene-level lights mirrors while the hall is active, so the light count never
  changes and no shader recompiles on travel. The interior atmosphere profile changes intensities
  and colours only, never the light count, `castShadow` or the fog type.
- **HUD.** The top-left title card reads "WATCH HALL — Zocial World" while the hall is active. Its
  subtitle names the keys that matter there — "WASD: move · E: sit / use · Hold G: emotes · H:
  raise hand · 1–8: react" — and, while seated, "Seated · WASD: stand up · Hold G: emotes · H: raise
  hand · 1–8: react".

## 5. Networking (ADR-014; `packages/shared/src/multiplayer-protocol.ts` § Watch Hall)

The server derives hall membership from each session's last pose, with hysteresis. All hall
state lives in memory in `apps/server/src/watchHall.ts` (a pure class with an injected clock).
It is never logged, never persisted, and forgotten on disconnect. Membership is a **social
scope, not access control** (ADR-005: positions are client-authoritative).

### Client → server

| Message | Rule |
|---|---|
| `hall_stage_request` | Members only. Joins the FIFO queue (max 12). Idempotent. Needs a **server-verified identity** (an owned name while a name registry runs, else the holder flag; `identity_required`) and no stage cooldown (`cooldown` + `retryInMs`). (The client sends it only with an unlocked wallet — presenting needs full voice — and, with a registry, a confirmed name; otherwise it says why.) |
| `hall_stage_cancel` | Leaves the queue. |
| `hall_stage_stop` | The holder ends their turn; a host force-stops the holder. |
| `hall_stage_handover {to}` | Holder or host. `to` must already be queued; queuing is the consent. A host inside the hall may also hand over to a member with a raised hand (raising it is the consent), so a queue full of squatters can never keep a presenter off a locked stage. |
| `hall_stage_live {live, audio}` | Holder only. Reports that LiveKit publishing started or ended, and whether tab audio is included. |
| `hall_stage_card {card \| null}` | Holder or host. Text is sanitised; links are https on `HALL_CARD_LINK_HOSTS` only, ≤ 4; `videoId` matches `/^[A-Za-z0-9_-]{11}$/`; `eventId` matches `/^[a-z0-9-]{1,48}$/`. Cleared when the turn ends. |
| `hall_stage_lock {locked}` | Host only. While locked, the queue does not auto-advance; a host grants the stage by handover. Released automatically when the last host session disconnects (the host role is session-only). |
| `hall_floor {playerId \| null}` | Holder or host. Gives one member a hall-wide mic, or takes it back. **Only to a member who raised a hand** (raising it is the consent; `not_raised` otherwise), or to the sender itself. Lowers that member's hand. The member who has the floor may give it up with `null`. Cleared when that member leaves or the turn ends. |
| `hall_react {reaction}` | One of `HALL_REACTIONS`. Bucket burst 8, refill 3/s. |
| `hall_hand {raised}` | Bucket burst 3, refill 0.2/s. At most `HALL_HANDS_MAX` (128) hands up (`full`); clients truncate longer lists instead of dropping the frame. |
| `hall_hand_lower {playerId \| "*"}` | Holder or host. |
| `hall_seat_claim {seatId}` | 0..59. Free seats only. A new claim frees your old seat. |
| `hall_seat_release` | Also automatic on leaving the hall, on disconnect, or on a walk/jog transform more than 1.5 s after the claim. |
| `hall_host_auth {key}` | Compared to `WATCH_HALL_HOST_KEY` (24–128 chars with ≥ 10 distinct characters, else host features are disabled) as SHA-256 digests with timingSafeEqual. 5 attempts per session, every attempt counted. No process-wide budget: a shared one could be kept empty by anyone and lock real hosts out; the key's strength is the bound. At most 32 hosts (`full`). Session-only, never logged, never echoed. |
| `hall_stage_vote {end}` | Members but the holder vote to end the live, unlocked share (owned names only with a registry). Bar max(3, ceil(50 % of the other members)); at the bar the turn ends and the holder gets a 10-minute cooldown. Bucket burst 3, one per 10 s. § 12. |
| `hall_stage_dequeue {playerId}` | Host only: remove a player from the queue. |
| `hall_stage_cooldown {playerId, ms}` | Host only: bench a player for up to 24 h (0 lifts it); ends their turn and drops their queue place. Follows the owned name. |

**Broadcast budget.** The requests that make the server broadcast to every member (request, handover, a
changing `live:true`, card, lock, giving the floor, lowering hands, seat claims, queue removal
and cooldowns) share one per-session bucket (burst 8, refill 2/s; `rate_limited`); votes have their own (burst 3,
one per 10 s). Requests that only end something are never limited, and a
request that changes nothing (the same card again) costs nothing and sends nothing.

The chat channel `hall` reuses `chat_send`. Members only; otherwise
`chat_rejected{not_in_hall}`, checked before the chat bucket is spent. Hall lines get no speech
bubbles.

### Server → client

Sent to hall members only, except `hall_error`, which goes to the sender.

| Message | When |
|---|---|
| `hall_state {stage, seats, hands, floor, hosts, host, totals, session}` | On entering the hall and after host auth. `host` is whether the recipient is a host. `totals` / `session`: the reaction session (below). |
| `hall_exit` | On leaving the hall. The client drops its hall state. |
| `hall_stage {stage}` | On every stage change. |
| `hall_seat {seatId, playerId \| null}` | On each seat change. |
| `hall_hands {hands}` | Raised hands, in raise order. |
| `hall_floor {playerId \| null}` | When the floor changes. |
| `hall_hosts {hosts}` | When the host list changes. |
| `hall_reactions {counts, sample, totals, session}` | Aggregated, flushed at most every 250 ms. `sample` has ≤ 16 entries. `totals` / `session`: the reaction session (below); a session start or end also sends one with empty counts. |
| `hall_vote {votes, needed, voted}` | The vote count and its bar (0 while voting is closed); `voted` is the recipient's own vote. Never who voted. Also in `hall_state.vote`. |
| `hall_error {op, reason, retryInMs?}` | To the sender of a refused request (`retryInMs` with a `cooldown`). |

**Reaction sessions.** A session is one stage turn: it starts when a player becomes holder (`session.id` + 1, totals from zero)
and ends with the turn (`active: false`; the totals stay as "Last session" until the next turn). Only reactions during
an active session count. The server's totals go to every member, so every board shows the same numbers. Details:
`docs/protocols/multiplayer-protocol.md` § Reaction sessions.

### Stage state machine

1. When the stage is idle and unlocked, the queue head becomes holder with status `preparing`.
2. It becomes `live` on `hall_stage_live{live:true}`.
3. If that doesn't arrive within `HALL_STAGE_PREPARE_TIMEOUT_MS` (45 s; the browser picker needs
   a click), the turn is skipped.
4. The turn ends on `hall_stage_live{false}` after live, on stop, or on disconnect. If the holder
   leaves the hall, it ends after `HALL_STAGE_LEAVE_GRACE_MS` (15 s).
5. Becoming holder lowers the player's hand.
6. `WATCH_HALL_MAX_TURN_MS` (env, capped at 24 h; **60 minutes when unset**, `0` turns it off) ends a
   turn while the stage is unlocked, others are queued and no host is present. A locked stage is host-managed: the cap
   never cuts off the speaker a host chose.
7. An audience vote at the bar ends the turn (10-minute cooldown for the holder); a turn also ends when
   the holder loses their verified identity or a host benches them. The next queue head that still qualifies takes
   over. Details and every sabotage case: § 12.

Carry playerIds, not nicknames; clients resolve names from player presence.

**Client capacity.** Clients may skip a `player_transform` when the pose has not changed, since
heartbeats prove liveness. A seated audience then sends almost nothing.

## 6. Media (LiveKit; ADR-007 room `public-world`)

**Publishing (stage holder)**
- `setScreenShareEnabled(true, { audio: { echoCancellation:false, noiseSuppression:false,
  autoGainControl:false }, systemAudio:"exclude", selfBrowserSurface:"exclude",
  surfaceSwitching:"include", video:{ displaySurface:"browser" }, contentHint, resolution },
  { audioPreset: musicHighQualityStereo, dtx:false, forceStereo:true, screenShareEncoding,
  screenShareSimulcastLayers, degradationPreference })` — the last three per share mode (below).
- **Share quality (`apps/web/src/voice/stageShareQuality.ts`).** LiveKit's default screen-share encoding (1080p at
  **15 fps**, 2.5 Mbps) would cap a shared video at 15 fps, so the confirm dialog asks "What are you sharing?"
  (remembered per device):

  | Mode | Content hint | Capture asked for | Top layer | Encoder gives up first | Extra layers |
  |---|---|---|---|---|---|
  | **Slides — sharp text, 30 fps** (default) | `detail` | 1920×1080 at 30 fps | 30 fps, ≤ 3.5 Mbps | frame rate (`maintain-resolution`) | 720p30 ≤ 2 Mbps, 360p15 ≤ 0.4 Mbps |
  | **Video — smooth, 60 fps** | `motion` | 1920×1080 at 60 fps (when the surface can) | 60 fps, ≤ 7 Mbps | resolution (`maintain-framerate`) | the same |

  Viewers ask for the top layer on the high render tier and the 720p30 layer on the low tier (re-applied on every
  update, so a tier switch mid-share takes effect); the SFU drops a viewer on a weak link to a lower layer, and
  dynacast pauses a layer nobody asks for. The presenter's upload is at most the sum of the layers plus the stereo
  audio: about **6 Mbps for slides and 9.5 Mbps for video** — a presenter on a slower uplink gets what WebRTC's
  bandwidth estimator allows (fewer frames for slides, lower resolution for video).
- **Measured** (local LiveKit 1.13.8, Chromium with SwiftShader, 4 shared vCPUs at a load average of about 6, fake
  capture; `watch-stage-integration.spec.ts` and a bare-pipeline run without the game). The sender is configured as asked —
  top layer 30 fps / 3.5 Mbps (slides) and 60 fps / 7 Mbps (video), `detail`/`motion`, three simulcast layers — but
  the test machine's software encoder and renderer cap the frame rate far below it: in the game (the holder shares its
  own SwiftShader-rendered tab, which repaints at 3–6 fps) the viewer received **4.3 fps** in both modes; without the
  game (a page repainting at 60 fps, 1080p capture) the viewer received **13.6 fps (slides, 1080p)**, **13.5 (slides,
  720p layer)**, **7.2 (video, 1080p)** and **14.9 (video, 720p layer)**, with the sender's outbound rate at 4–16 fps.
  Those numbers say nothing about a real PC with a GPU and hardware encoding; 30/60 fps there is the configuration's
  intent, **not yet measured**.
- The holder may share any tab, window or the whole screen. `displaySurface:"browser"` is only
  the picker's default.
- Start only from the holder's click. The confirm dialog warns that everyone in the hall sees the
  shared content **and hears its audio**, and says never to show a seed.
- The dialog has an opt-in "Share my computer's sound (whole screen or window; Windows/ChromeOS)"
  box (ADR-014 § 4). When it is ticked:
  - `systemAudio:"include"`;
  - while the share is live, the holder's incoming hall audio (voices and stage) is muted, so the
    game's own playback is never captured;
  - the warning names notifications and other apps (calls).

  Default: system audio is excluded.
- If there is no audio track, show "Tick 'Share tab audio' in Chrome to share sound".
- Report `hall_stage_live`. Live and ended are driven by LiveKit events, because the game loop
  pauses when the presenter switches tabs.
- Losing the holder role stops the share automatically.

**Viewing**
- Inside the hall, subscribe ONLY to the server-named holder's ScreenShare and ScreenShareAudio.
  Ignore every other screen publication (a rogue publisher is never downloaded).
- Call `publication.setEnabled(true)` after subscribing. `adaptiveStream` would otherwise pause
  a detached video.
- Video goes to a VideoTexture on the hall screen.
- Audio goes to a **non-positional stage entry** in VoiceAudioGraph, not keyed by playerId (so it
  never collides with the holder's mic), at gain `stageVolume × masterVolume`, ducked while a
  personal YouTube player is open. Use the muted `<audio>` element workaround for Chromium.
- **Stage mic:** the holder's and floor holder's mic gain is computed as distance 0 for listeners
  inside the hall, from server state, never from a participant attribute — and only while the
  speaker's avatar is inside the hall too (a holder who walks out keeps the turn for the 15 s grace,
  but a conversation outside never plays hall-wide).
- **Telling the speaker.** Becoming holder announces "Everyone in the hall now hears your
  microphone"; getting the floor announces it too and the stage widget offers "Give up the floor";
  the header line keeps "🎙 You have the floor" (also collapsed), and VoiceControls shows
  "🎙 Hall-wide" next to the (overridden) range buttons.
- Audience mics keep normal proximity ranges. Blocking a player hides their stage share too.

**Watch mode**
- Watching needs no wallet: a **listen-only** LiveKit connection. `/voice/token` takes
  `{capability, listenOnly:true}` and grants `canPublish:false`.
- It subscribes to stage tracks and the stage/floor mics, and to nearby microphones by the
  normal proximity rules: listen-only is also every guest's voice mode ("Listen to voices
  (guests can't talk)", ADR-015). Talking and taking the stage need an unlocked wallet.
- The Watch-mode button appears on entering the hall; the AudioContext resumes in that click.
  Leaving the hall does not disconnect listen-only mode (outside, only the stage stops being
  downloaded).

## 7. Personal YouTube player (ADR-014 amends ADR-009's "no iframe" rule)

- **Consent.** The first time, a dialog says "Watching here connects your browser to YouTube
  (Google): it sees your IP address and that you are watching from Zocial World." The choice is
  remembered per device (try/catch localStorage).
- **Chromium** (`"credentialless" in HTMLIFrameElement.prototype`): a DOM overlay with
  `<iframe credentialless src="https://www.youtube-nocookie.com/embed/<id>?autoplay=1&rel=0"
  referrerpolicy="strict-origin" allow="autoplay; encrypted-media; picture-in-picture;
  fullscreen" allowfullscreen>`.
  - `strict-origin` is required: the production `Referrer-Policy: no-referrer` triggers YouTube
    Error 153.
  - The overlay has a visible Close button and gives keyboard focus back to the game.
- **Other browsers:** `window.open("https://www.youtube.com/watch?v=<id>", "_blank",
  "noopener,noreferrer")` — a plain youtube.com visit with that site's cookies. The UI never promises a
  consent dialog there: the Watch panel shows only "Open on YouTube ↗" (no "Watch here"), and the speaker
  card's button reads "▶ Open on YouTube ↗" with "Opens youtube.com in a new tab, which sees your IP
  address and your YouTube cookies."
- **Never** load YouTube's `iframe_api` script. Never relax safeHtml's iframe ban.

## 8. Content gateway (`/content/watch`, ADR-009 amendment)

| Endpoint | Returns |
|---|---|
| `GET /content/watch` | `{available, stale, generatedAt, live[], schedule[], latest[], collections[], notice?, sources?}` (`sources`: the catalogue's credit lines for the panel footer) |
| `GET /content/watch/collection/:id?page=n` | Listed ids only. |

**Sources** (each degrades to the next):
1. YouTube Data API v3 when `YOUTUBE_API_KEY` is set (`playlistItems.list`, `videos.list`;
   never `search.list`).
2. The Atom feed, with a 5-minute failure backoff (it returned 404 early on 2026-10-07 and 200
   later that day).
3. The **catalogue's own replays**: collections with video ids, titles, upload dates and
   durations, verified when the catalogue was curated.

**Catalogue.** What the gateway may list is data, read once at start
(`apps/server/src/content/watchCatalogFile.ts`): the JSON file named by `WATCH_CATALOG_FILE`; without it, a
catalogue file the deployment keeps next to `src/`; otherwise the built-in sample
(`watchCatalog.sample.ts`: one channel, one collection of two replays, a weekly meetup in the hall). The shape and
its checks are `watchCatalogTypes.ts` (`parseWatchCatalog`); a file that fails them stops the server at start. A
catalogue holds:
- `channels`: the YouTube channels whose uploads and live streams may be listed;
- `collections`: replay collections, each fed live by a playlist or by the channel's uploads filtered by title, with
  verified fallback entries;
- `recurringEvents`: series on an RRULE (UTC) with our own title, place, location text and links. An optional
  organiser `.ics` replaces the rule when it answers with `BEGIN:VCALENDAR` (a failure is remembered for an hour);
  its LOCATION, description and links are never used;
- `calendars`: public `.ics` feeds with title rules. Only events whose trimmed SUMMARY matches a rule are kept,
  filtered before caching, optionally renamed by the rule, and shown with the rule's own location text and link.
  LOCATION, conference fields and links are never relayed;
- `curatedEvents`: one-off events; an umbrella entry can stand in until a calendar lists its sessions
  (`fallbackForCalendar`);
- `sources`: the credit lines under the Watch panel.

**Rules:**
- Free text — descriptions and calendar titles — is redacted (emails, phone numbers, crypto
  addresses), stripped of links with or without a scheme (`meet.google.com/…`, `zoom.us/j/…?pwd=…`)
  and of meeting credentials ("Passcode: …", "Meeting ID: …"), capped and passed through `cleanText`.
- Thumbnails: `https://i.ytimg.com/vi/<11>/mqdefault.jpg` through `/content/media`, under a
  strict regex allowlist.
- Live data uses `Cache-Control: max-age=30`.
- The API key never appears in responses or logs.

## 9. Client UI (`apps/web/src/watch/`, `apps/web/src/hall/`)

**Watch panel** (action bar "Watch", the Live Now board, the portal):
- Tabs Live / Today / Upcoming / Replays.
- Collection chips and a filter.
- Cards with proxied thumbnails, plus "Watch here (YouTube, opt-in)", "Open on YouTube ↗" and
  "Join on Zoom ↗" where available.
- For the stage holder: "Show on the big screen". This opens the video in a new tab, sets the
  card from the catalogue, then guides "Start sharing → pick that tab → tick Share tab audio".

**Stage widget** (`hall/StageWidget.ts`; in the hall, bottom-right above the nickname box,
compact and collapsible):
- Holder and status (getting ready with a countdown, LIVE with 🔊 or "no sound"), the queue
  with your place, and raised hands / the floor.
- Request / Leave queue.
- Without an unlocked wallet, "Request the stage" is disabled and the panel says "Presenting needs
  voice — voice needs an unlocked wallet" with an Open wallet button (the podium says the same).
- With a name registry and no confirmed name yet, it says "On this server presenting needs a confirmed
  name" with a **Confirm a name** button (the name step; the podium only explains — a modal opened on the E keydown
  would swallow its keyup). Enable Voice in that state opens the name step instead of asking for a grant the server
  would refuse.
- A **vote row** under who is on stage, while a share is live and unlocked: "🗳 1 of 3 votes to end this
  share" with **End this share** / **Take back my vote** (the presenter sees "… votes to end your share" and a note;
  an unnamed player on a registry server sees why they can't vote).
- For the holder: Start sharing / Stop / Hand over / Edit card (validated before sending; "Pick
  from catalogue" opens the Watch panel) / Give the floor (from raised hands, in order) / Take
  the floor back / Lower hands (one or all). The voice/wallet notice sits right under "Start
  sharing", never below the fold.
- The member with the floor: "Give up the floor".
- Host tools (last, behind a small "⋯ Host" toggle until unlocked): unlock with the key (a password
  field, never in a URL); lock / unlock, force stop, grant to a queued player or to a raised hand,
  lower all hands, the card while idle ("up next"). Each queue row gets **Remove** and a **Cooldown…**
  menu (10 min / 30 min / 1 hour / Lift cooldown), and the presenter gets its own row with **Stop presenter** and the
  same menu; the name sits on its own line so it is never cut to an initial.
- A "Watch mode" or "Enable voice" hint.
- A stage-volume slider (the same setting as the voice settings slider), inside the scrolling body.
- Layout: only the header and the watch button are fixed; the body scrolls (thin visible
  scrollbar). On viewports up to 820 px tall the "Now on stage" chip hides while the panel is
  expanded and the long notes drop out. On viewports up to 760 px tall the minimap shrinks to 240 px
  (WorldHud) and the panel starts right under it, so the right column never overlaps the minimap
  (measured: 1366×700, 1366×768 and 1280×600).
- Refusals (`hall_error`) become short chat lines.

**Boards** (`hall/HallBoards.ts`, `hall/boardFeeds.ts`): fed at most once a second, only while
the hall is the active location. Live Now: the in-hall stage, YouTube live, today's events, the
latest replays (the catalogue is refetched at most every 60 s). Discussion Corner: the last hall
lines (blocked players filtered), the reaction tallies — the server's per-turn totals labelled "This session"
(a turn is on) or "Last session" (idle after a turn), or the last 60 s seen before any turn ("Last minute") — and the member count. The
speaker-card strip, and the screen's idle "Up next: …", from the stage or the next scheduled
event; StageSystem stays the only writer of the screen's idle text.

**Emote wheel** (everywhere, not only in the hall):

- **Opening.** Hold **G** (≥ 180 ms) and a radial wheel opens at the screen centre.
  - Move the mouse toward a slice to highlight it. With pointer lock, use movementX/Y
    accumulated into a direction; without it, use the cursor angle from the centre.
  - Release G to run the highlighted slice. Clicking a slice also works. Esc, or releasing in
    the dead zone, cancels.
  - A quick tap of G waves.
- **Main slices:**

  | Slice | Effect | Where |
  |---|---|---|
  | 👋 Wave | animation state `wave` | Anywhere |
  | 💃 Dance | new state `dance`, looping until you move or pick Stop | Anywhere |
  | 🙌 Cheer | new state `cheer` | Anywhere |
  | ✋ Raise hand / Lower hand | `hall_hand` | Hall only; greyed outside |
  | 😀 Reactions ▸ | opens a sub-wheel with the 8 reactions (`hall_react`) | Hall only; greyed outside |
  | ⏹ Stop | ends the current emote | Anywhere |

- **Rendering** (`apps/web/src/player/PlayerAnimation.ts`, `emoteLayer.ts`).
  - KayKit avatars: Cheer uses the `Cheer` clip. Dance is a procedural bone layer over Idle (hips
    twist, spine sway, chest counter-twist, head nod and tilt, alternating arm pumps, a small
    bounce; no new asset, no licence surface). Wave is a procedural right-arm layer too: the
    pack has no wave clip, and mapping Wave to the Cheer clip would make the two identical.
  - Emotes also work **seated**: the layers play over the Sit clip, the bounce and hip twist are
    dropped, and a seated cheer is both arms up (a layer, since the Cheer clip stands).
  - The KayKit characters are chibi (shoulders ≈ 0.83 m under a head spanning ≈ 0.93–1.72 m), so
    a hand can never rise above the head: raised arms swing out to the side with the forearm up
    beside the head, where they read from the front and from behind.
  - The low-tier placeholder gets procedural equivalents (one arm waving, both arms up for
    cheer, a bounce with arm pumps for dance, the right arm up for a raised hand).
  - Raised hands show as a raised-arm bone override (with a slow sway) plus a ✋ badge on the
    nameplate, driven by HallStore.hands — on remote players and on your own avatar.
- **Rules.**
  - Moving (WASD) ends wave, cheer and dance. Dance loops until you move or pick Stop; wave
    (2.6 s) and cheer (3.2 s) end by themselves. An emote while seated keeps the seat.
  - The wheel never opens while typing, and keys 1–8 still send reactions directly in the hall
    (H raises or lowers your hand). Client buckets mirror the server's (reactions burst 8 then
    3/s, hands burst 3 then one per 5 s), so your own floating reaction appears only when the
    server accepts it.
  - While the wheel is open under pointer lock, the mouse picks a slice instead of turning the
    camera. "Reactions ▸" turns the wheel to the sub-wheel, which waits for a click, G or 1–8.
  - Reduced motion: floating reactions fade instead of rising; the wheel fades without scaling.
- **Floating reactions** (`apps/web/src/social/FloatingReactions.ts`): the emoji rises over the
  reacting avatar, with at most 24 live (oldest first). Sources: HallStore reaction batches (the
  server's `sample`; your own echo and blocked players are skipped) and your own sends.
- **Mouse users** get a small 😀 button next to the chat in the hall that opens the same wheel.

**Discussion Corner menu:**
- Live Chat & Reactions: shows the Hall tab and opens the emote wheel's reactions sub-wheel.
- Share Takeaways: Hall chat prefilled with "💡 ".
- Start a Discussion: opens the in-game forum, at the card's forum link if any.
- Find Your People: a list of hall members with seat, hand and speaking state; clicking opens
  the player menu.

**Speaker card (DOM):** title, presenter, speaker, project, links (in-game routing for GitHub /
ZecHub / forum, otherwise an https new tab), and "Watch here" when the card has a `videoId`. It
opens from the `wh-card` interactable or a HUD "Now on stage" chip, shown while the hall is
active and the stage has a card.

**Chat:** a "Hall" tab is visible while in the hall (HallStore.member), with an unread count. The
Discussion Corner board shows the last lines; takeaways are highlighted in both.

**Computer sound and the personal player** (ADR-014 § 4): the personal YouTube player stays closed
while a computer-sound share is live (system audio would capture it). Starting such a share closes it
first, "Watch here" is refused during the share with a chat note ("Stop sharing your computer's sound
first"), and anything that still opens it (a consent accepted mid-share) is closed again.

**Seats** (`apps/web/src/hall/SeatSystem.ts`):
- 60 `wh-seat-<id>` interactables ("Sit down", radius 0.9, priority 2) at the seat points on the
  row floors, registered only while you are a hall member, the seat is free and you are not
  seated.
- E at a free seat claims it. On `hall_seat` with you, the player snaps to the seat
  (`PlayerController.setSeat`: movement skipped, x/z/yaw pinned, ground follow kept), animation
  `sit`, and `camera.snapTo(yaw + π, −8, 3.2)` with the camera's target height raised to
  `SEATED_TARGET_HEIGHT` (2.8, so the pivot is ≈ 2.5 m over the row floor) while seated. The
  camera sits behind and above the head of the player in the row behind and looks slightly up, so the
  whole screen is framed over every seated head from every seat (each hall layout's unit tests
  project it). Looking down from a standing-height pivot would cut off the top of the screen in the
  front rows. The camera model is unchanged (same orbit, smoothing
  and collision); only its pitch/distance and target-height inputs differ. The zoom from before
  sitting comes back on standing.
- WASD (or the jog key) stands up at the stand point and releases the seat. Leaving the hall,
  a teleport or a disconnect clears it. `hall_error {seat, taken}` is a chat line.
- **Interaction priority:** `Interactable.priority` (seats 2, hall boards 1, players 0).
  Seat interactables are disabled while you are seated; E then opens the nearest player's card.

**Remote avatars** (`apps/web/src/networking/RemotePlayer.ts`, `remoteAvatars.ts`):
- High tier: KayKit characters, the model chosen from colorSeed among the five, loaded once per
  model through the local avatar's path (merged into one skinned draw, no shadow-map casting, a
  blob shadow hidden while seated) and SkeletonUtils-cloned per player, so geometry and
  material are shared. Animations idle/walk/jog/sit/cheer plus the procedural
  wave/dance/raised-hand layers; talking stays Idle (the pack has no talk clip). The placeholder
  shows until the model has loaded. Players outside the active location are hidden and not
  animated; players outside the camera frustum are hidden and their animation deferred.
- Low tier: the placeholder (ADR-008). Inside the hall (no point lights on the low tier) its
  materials get a warm emissive lift (a uniform change, no recompile), so remote players don't read
  almost black.
- **A full hall (`docs/architecture/PERFORMANCE.md`).**
  - Every remote placeholder is drawn by `player/PlaceholderCrowd.ts`: one InstancedMesh per part
    (six draws for the whole crowd instead of eight per player). Each player keeps its own rig and
    materials; the crowd copies the matrices and accent colours, so the pixels are the same.
  - Animation LOD (`networking/animationLod.ts`): beyond 10 m an avatar steps its animation at
    30/20/15 Hz by distance (a walk keeps 30 Hz), the time in between applied in one step; off-screen
    avatars don't animate. When nothing under a player changed in a frame (no move, no step) its
    matrices and bone texture are left as they are.
  - The frame-pacing guard (`core/framePacing.ts`, high tier) drops MSAA, then resolution; if frames
    stay slow at the floor, it halves the crowd's animation rates (the hall's budget lever).
- In the hall, nameplates of seated players further than 8 m (4 m while you are seated too) are
  hidden unless they are speaking, have a raised hand, hold the stage or have the floor. Overlapping
  plates are thinned out on screen: nearest first, badged or speaking players before everyone, and a
  plate that would overlap one already placed is skipped that frame. Badges: 🎤 stage holder,
  🎙 floor, ✋ raised hand. Nameplates use no backdrop blur (60 blurred compositor layers over the
  big screen would be too costly); a denser panel and a text shadow keep them legible.
- A plate's style is written only when it changes (shown or hidden, or moved by half a pixel
  or more); plates off screen or beyond 80 m are hidden; declutter sizes are read before the frame's writes,
  and App passes the viewport size cached at resize, so drawing plates never forces a layout.

**Global key, Esc and Enter rules**
- Esc closes the Watch panel, the speaker card, the Discussion menu, the personal player and the
  share confirm dialog.
- The Watch panel is a modal dialog: opening it moves focus to the active tab (arrow keys switch
  tabs), closing it returns focus to what opened it.
- The emote wheel works from the keyboard: Space on the 😀 button opens it with focus on the first
  slice, arrow keys turn it (they never reach the world), Enter/Space runs a slice, and focus returns
  to the button. With G held, arrows pick the slice the release runs.
- Find Your People updates its rows in place when only speaking/hand/seat state changes, so keyboard
  focus and a click in progress survive; when the list itself changes, focus returns to the same
  person (or Back).
- The ChatPanel Enter guard knows the new backdrops and the open emote wheel.
- Keys 1–8 and H work only in the hall and never while typing.

## 10. Privacy

- Viewers contact only our origin unless they opt into the personal player, or open a
  YouTube/Zoom link in a new tab themselves.
- The stage share (video and tab audio) is visible to the self-hosted SFU and to everyone in
  the hall. There is no end-to-end encryption claim.
- The server keeps hall state in memory only and never logs chat, reactions, seats, the host key
  or IPs.
- Related documents:
  - `docs/privacy/WATCH_HALL_THREAT_MODEL.md`;
  - `docs/privacy/VOICE_THREAT_MODEL.md` (tab audio, stage mic, listen-only);
  - `docs/privacy/CHAT_THREAT_MODEL.md` (the hall channel);
  - `docs/privacy/MULTIPLAYER_THREAT_MODEL.md` (server-held hall state);
  - `docs/privacy/PRIVACY_MODEL.md` § 7.

## 11. Tests

**Server:** `watchHall.test.ts`, pure with a fake clock:

- membership hysteresis, FIFO and queue cap, prepare timeout, leave grace;
- handover only to queued players, the floor, the host cases, seat races and auto-release;
- hand and reaction buckets, reaction batching;
- floor consent (raised hand) and stepping down, host auth never locked out by other
  sessions, weak/over-long keys fail closed, a lock released with the last host, the max turn never
  on a locked stage, the hands and hosts caps, the broadcast budget, a host granting a full locked
  stage to a raised hand, a token bucket under a backwards clock.

Also socket tests (members-only delivery, `not_in_hall`, disconnect cleanup), gateway
mapping/ICS/redaction/allowlist tests, and token `listenOnly` tests.

**Web:** the hall contract helpers and each hall layout (`hallGeometry.test.ts`, the layout
tests), the protocol parser, the YouTube id/embed builder, schedule bucketing, stage gain; interaction priority (`InteractionSystem.test.ts`), the seat system against a real
HallStore (`SeatSystem.test.ts`), seated mode and emotes in the player controller, the
animation-state → clip/layer mapping and the bone layer (`PlayerAnimation.test.ts`), the emote
wheel's slice math, G hold/tap/release rules and keyboard path (`EmoteWheel.test.ts`, jsdom), the
nameplate policy, the client reaction/hand buckets, the remote avatar model choice, and the seated
view from every seat of each hall layout (every screen corner in frame).

**E2E:**
- `tests/e2e/watch-hall.spec.ts`, serial: door to hall and back; hall chat and reactions between
  two clients inside versus one outside; raise hand; the stage queue with a fake getDisplayMedia
  (init script); seating; the speaker card escaping; schedule tabs with routed `/content` stubs;
  the YouTube opt-in (route stub, credentialless iframe, the fallback).
- An opt-in real-LiveKit spec checks that frames keep advancing for 15 s.
- `tests/e2e/watch-hall-seats.spec.ts`, serial, two clients, `?quality=low`: E at a free seat
  (the seat outranks the neighbour's card) keeps A in `sit` at the seat; B sees A seated; a
  second claimer gets the "taken" line; WASD stands A up and frees the seat on both clients;
  hold G + Dance → `dance` locally and on B; H raises a hand → ✋ on A's nameplate on B.

Stage moderation is covered by `apps/server/src/stageModeration.test.ts` (verified identity, the vote and its bar, cooldowns by
identity, host queue removal and cooldowns, the parser shapes, the wire with a dev name registry, the shared chat
bucket), the vote and cooldown cases in `watchHall.test.ts` (the 60-minute default max turn), `name_required` in
`tokenHandler.test.ts`, and on the web `stageShareQuality.test.ts`, the vote view and refusal texts in
`stageState.test.ts` and `HallPresence.test.ts` (a blocked player's reactions never float). E2E:
`watch-stage.spec.ts` (the name gate, the share modes, an audience vote by a browser client and two raw WebSocket
members, the host's queue removal and cooldown), the vote count in `watch-hall.spec.ts`, and the share modes measured
through a real SFU in `watch-stage-integration.spec.ts`.

The performance of a full hall is covered by web unit tests for the light pool and its dark slots
(`world/lightPool.test.ts`), the animation LOD and frozen avatars (`networking/animationLod.test.ts`), the instanced
placeholder crowd (`player/PlaceholderCrowd.test.ts`), the nameplates' write-on-change and culling
(`ui/Nameplates.test.ts`, jsdom), the frame-pacing guard (`core/framePacing.test.ts`), the perf scene
(`core/perfScene.test.ts`) and `InterpolationBuffer.sampleInto`. Measurements: `docs/architecture/PERFORMANCE.md`.

## 12. Stage moderation and sabotage

How taking and managing the stage works, and whether someone could sabotage a talk: the model as built (§ 12.1), every realistic sabotage vector with what stops it and what is
left (§ 12.2), and what a host does when it happens (§ 12.3). Code: `apps/server/src/watchHall.ts` (the rules),
`WorldServer.ts` (who counts as a verified identity), `voice/tokenHandler.ts` (who may publish).

### 12.1 How the stage works

**Who is who.**

| Role | How you get it | Lasts |
|---|---|---|
| Member | Your last reported position is inside the hall (enter at the walls, leave 2 m beyond them). | Until you walk out or disconnect. A **social scope, not access control**: positions are client-reported (ADR-005). |
| Verified identity | While a name registry runs (`NAME_REGISTRY=dev`/`zcashd` on a test chain, or `lightwalletd`, the mainnet backend — ADR-018 § 5, where the fee is real ZEC): an **owned name** — confirmed with the on-chain fee or claimed again by signing with the wallet's name key (ADR-016). Without a registry: the wallet-holder flag (ADR-015, client-asserted). A `disabled` registry counts as "without one". | While the session shows that name; forgetting the wallet, or the owner's newer session taking the name over, ends it at once. |
| Queued | `hall_stage_request` as a verified member, not on a cooldown, while fewer than 12 wait. | Until you leave the queue, leave the hall, disconnect, are removed by a host, lose your verified identity or get a cooldown. |
| Holder | The queue head when the stage is free and **unlocked**, or a handover. Status `preparing` (45 s to start sharing), then `live`. | Until Stop, the share ending, a handover, the 45 s prepare timeout, 15 s outside the hall, disconnect, a host's stop or cooldown, an audience vote, the max turn, or losing your verified identity. |
| Floor | The holder or a host gives it to a member **who raised a hand** (the consent) and has a verified identity. | Until given back, taken back, the member leaves, or the turn ends. |
| Host | `WATCH_HALL_HOST_KEY` typed into "Unlock host tools" (24–128 characters, compared as digests in constant time, 5 tries per session, at most 32 hosts). | The session only; host powers need the host to be in the hall. |
| Moderator (ADR-019) | A `MODERATOR_KEYS` key typed into the same field — or Profile → "Moderator sign-in", anywhere in the world. Same key rules. | The session only. Every host power (not counted toward the 32), plus report handling, mute, kick and ban everywhere (§ 12.5); a "Moderator" tag on the nameplate. |

**The queue and the turn.** One FIFO queue of at most 12. When the stage is free and unlocked the head becomes the
holder, `preparing`; the browser picker needs a click, so a turn that doesn't go `live` within 45 s passes on. A live
turn ends on Stop (or the browser's own "Stop sharing"), when the holder disconnects (at once), or 15 s after the
holder walks out of the hall. While the stage is **unlocked, someone is waiting and no host is in the hall**, a turn
also ends after the **max turn: 60 minutes by default** (`WATCH_HALL_MAX_TURN_MS`; `0` turns it off; a locked stage is
never cut off — a host chose that speaker). When a turn ends, the card, the floor and the votes are cleared and the
next verified, non-benched player in the queue takes over; anyone who no longer qualifies is skipped.

**Handover.** The holder may pass the turn only to someone already in the queue (queuing is the consent) who has a
verified identity and is not on a cooldown. A host may also grant the stage to a member with a raised hand — so twelve
squatters in the queue can never keep a real presenter off a locked stage — and a host's grant overrides a cooldown
(never the verified-identity rule).

**The lock.** A host locks the stage: the queue stays open but never advances by itself; hosts grant the stage by
hand. The lock also **closes the audience vote** and drops the votes cast. It is released automatically when the
last host session disconnects, so a forgotten lock can't freeze the stage.

**The audience vote** (`hall_stage_vote`). While a share is live and the stage is unlocked, every member except the
holder may vote "End this share" (and take the vote back). While a registry runs only owned names vote. The bar is
**max(3, ceil(50 % × the other members present))**, where "the other members" are everyone in the hall but the
holder — guests included, so a guest-heavy hall needs more named voters, never fewer. At the bar the turn ends and the
holder gets a **10-minute stage cooldown**. Votes belong to one turn and to the people present: a voter who leaves
takes the vote along (a departure can also lower the bar enough to end the share), and the next turn starts at zero.
Members see only the count ("2 of 3 votes to end this share") and whether their own vote counts; **nobody — the
presenter included — learns who voted**, and the server never logs it.

**Host powers.** Force stop · hand over / grant (also to a raised hand, also over a cooldown) · lock and unlock ·
give or take back the floor · lower one or all hands · set the speaker card (also the "up next" card while idle) ·
**remove a player from the queue** (`hall_stage_dequeue`; not a ban) · **put a player on a stage cooldown**
(`hall_stage_cooldown`: 10 min / 30 min / 1 hour from the widget, up to 24 h on the wire, 0 lifts it; it also ends
their turn and drops their queue place). Cooldowns follow the owned name while a registry runs, so a reconnect does
not escape them.

**What a non-host can and cannot do.**

| Anyone in the hall | Only with a verified identity | Only the holder | Only a host |
|---|---|---|---|
| Chat, react, raise a hand, sit, watch (listen-only voice) · vote (every member without a registry) | Queue for the stage, be granted it, receive the floor, publish voice (talk) · vote (with a registry) | Start/stop sharing, hand over to the queue, give the floor to a raised hand, lower hands, edit the card | Lock, force stop, grant to a raised hand, remove from the queue, set cooldowns, the idle card |

A non-host can **not** stop someone else's share (except through the vote), skip the queue, give anyone the floor
without a raised hand, change the lock, or make anyone's microphone hall-wide.

**Server-verified identity, not the client's word.** The client's own check ("presenting needs an unlocked wallet")
is not trusted, and neither is a client's claim to the holder flag: while a registry runs, the server itself requires an owned name for `hall_stage_request`, for
being granted the stage, for `hall_floor` and for the full voice grant (403 `name_required`; a guest still gets 403
`wallet_required`). A modified client that only claims the holder flag gets nothing beyond listen-only voice.

**Rogue publishers.** The voice token lets a talker publish a screen share, so a modified client can publish one at
any time — but every honest viewer subscribes only to the tracks of the holder the **server** names
(`autoSubscribe:false`), so a rogue share is never downloaded or shown. Likewise, a microphone is heard hall-wide only
when the server's state names that player as holder or floor, and only while their avatar is inside the hall.

**Rate limits** (per session; a refused request changes nothing).

| What | Limit |
|---|---|
| Any message | 30 per second per connection; frames over 4 KiB close the socket. |
| Chat, all channels together (hall, general, nearby, whispers) | burst 5, then one per 2 s — switching to the Hall tab doesn't reset it. Hall lines need membership, checked first. |
| Reactions | burst 8, then 3/s; flushed to members at most every 250 ms with at most 16 samples. |
| Raise / lower your hand | burst 3, then one per 5 s; at most 128 hands up. |
| Broadcast ops (request, handover, a live report that changes something, card, lock, floor, lowering hands, seat claims, queue removal, cooldowns) | burst 8, then 2/s. Requests that only end something are never limited; unchanged ones cost nothing. |
| Votes (casting or taking back) | burst 3, then one per 10 s. |
| Host sign-in | 5 attempts per session, no shared budget (one could be drained by anyone). |

**Local block and mute** (client-side, private to you): a blocked player's hall lines vanish from chat and the
Discussion Corner board, their reactions never float, their stage share is never downloaded (the screen says
"Hidden"), and their voice is never subscribed. Mute silences a voice (and a muted holder's stage audio). Neither tells
the other player anything.

### 12.2 Sabotage vectors

| # | Vector | What stops it now | What is left |
|---|---|---|---|
| 1 | Taking the stage to show something offensive or shocking. | A verified identity is needed (an owned name costs a fee and a wallet), the browser picker and a 45 s window. Viewers can block the presenter (share never downloaded). The hall can vote the share off (bar ≥ 3) — the presenter is benched 10 min, by name. A host stops it at once and can bench for up to 24 h. | Until the vote or a host acts, the hall sees it. No content filter, no recording, no report backend. Keep a host in the hall during announced talks. |
| 2 | Queue squatting: filling the 12 places with idle accounts. | Each place needs a verified identity (an owned name each, while a registry runs). A squatter granted the stage who never shares loses it after 45 s. A host can remove squatters, bench them, or lock and grant the real presenter (also from a raised hand). | Without a registry the holder flag is client-asserted, so squatting is cheap; a public deployment should run a registry. |
| 3 | Hogging a live turn (an idle or endless share). | The 60-minute default max turn when others wait and no host is present; the audience vote; host stop/cooldown; leave grace 15 s. | A host-free hall with nobody queued has no limit (by design: nothing is waiting). |
| 4 | Publishing a rogue screen share straight to LiveKit. | Honest viewers subscribe only to the server-named holder; the rogue track is never downloaded. A host's or moderator's stop, a cooldown or a vote sets the holder's LiveKit `canPublish` to false (RoomService), and a kick or ban removes the participant. | A still-allowed talker can publish a rogue share between turns (never downloaded by honest viewers; a moderator kicks). |
| 5 | Making a microphone hall-wide without being the holder. | Hall-wide gain comes only from server state (holder or floor), never a participant attribute; the floor needs a raised hand and a verified identity. | Normal proximity voice near the stage (whisper/talk/shout ranges) still reaches nearby seats; viewers can mute or block. |
| 6 | A modified client claiming the wallet-holder flag to talk or present. | **Closed while a registry runs**: the stage, the floor and the full voice grant need an owned name the server verified. Losing the identity also revokes the LiveKit publish permission at once. | Without a registry, or with a `disabled` one, the honour system remains (ADR-015 § 6). |
| 7 | Brigading the vote to silence a legitimate speaker (sybil voters). | Owned names only (one fee each) while a registry runs; the bar counts every member present, guests included, and never drops below 3; votes reset each turn; a host's lock switches voting off; a host can grant the stage back over the cooldown. Votes are rate-limited. | Three cheap test-chain names can end a share in a tiny hall (the faucet pays the fee on the test chain; the real deterrent comes with mainnet fees). Without a registry every member votes and sessions are free: a determined griefer with as many tabs as the audience can vote a share off. Announced talks should run locked with a host present. |
| 8 | Leaving and rejoining (or reconnecting) to escape a cooldown. | With a registry the cooldown follows the owned name across sessions. | Without a registry it follows the session; a reconnect escapes it. A second owned name (a second fee and key) also escapes it. |
| 9 | Walking out and in to shift the vote bar. | Leavers lose their vote, and membership hysteresis (2 m) keeps the door from flapping. | Leaving can lower the bar (that is the rule: a majority of those present). |
| 10 | Flooding the hall (chat, reactions, hands, stage messages, votes). | The per-session limits above; chat shares one bucket across channels; reactions are batched; unchanged requests send nothing. At most 4 sockets and 10 new connections a minute per network; a moderator mutes, kicks or bans. | A griefer with many networks (VPNs) still gets many sessions; local block hides one player's lines and reactions. |
| 11 | Abusing the floor (a holder hands it to an accomplice). | The accomplice must raise a hand and hold a verified identity; the holder or a host takes it back; the turn ending clears it. | Two cooperating verified players can share the stage mic; the vote or a host handles it. |
| 12 | Hostile speaker cards (links, markup). | Text is sanitised and rendered as text; links must be https on an allowlist of Zcash hosts, at most 4; ids match strict patterns. | Text content itself is not moderated. |
| 13 | Spoofed position to vote, queue or watch from outside. | Membership is only a social scope; voting and queueing still need a verified identity; spoofing doesn't widen any power. | A spoofer can stand "in" the hall from anywhere and download the stage (it is not access control). |
| 14 | Guessing or stealing the host key. | 24+ characters, constant-time digest compare, 5 tries per session, never logged or echoed. | Unlimited sessions mean unlimited tries in principle; the key's strength (`openssl rand -base64 32`) is the bound. A leaked key makes its holder a full host until the key is rotated (restart with a new key). |
| 15 | A host abusing powers (benching people, locking). | Hosts are trusted operators holding a secret key; the lock dies with the last host session. | No audit trail or second-host override beyond "another host can lift a cooldown or unlock". |
| 16 | Too many connections (DoS). | Frame and message-rate caps per connection; the per-IP cap (`MAX_SESSIONS_PER_IP`, default 4, and 10 new connections a minute per network) and kick/ban. | Many networks; people behind one carrier-grade NAT share the cap. |

### 12.3 What a host does

- Before an announced talk: unlock host tools, **lock the stage**, grant it to the speaker (from the queue or a
  raised hand). A locked stage has no max turn and no audience vote: the host decides.
- During an open session (unlocked): let the queue run; the vote and the 60-minute max turn handle most trouble
  without you.
- Trouble: **Stop presenter**, then the presenter row's **Cooldown…** (10 min / 30 min / 1 hour). Squatters in the
  queue: **Remove** or **Cooldown…** on their row. A stuck stage: lock it, grant it by hand, unlock when done.
- A legitimate speaker voted off by a brigade: lock, then grant them the stage again (a host's grant overrides the
  cooldown).
- A presenter who keeps coming back, or abuse beyond the stage: a **moderator** (§ 12.5) mutes, kicks or bans.

### 12.4 Not covered yet

A word filter; recording for evidence (by design: nothing is recorded); a public ban list; permanent IP bans (by
design); owned names for payments and `canReceive` (still the honour-system flag; the verified-identity rule covers
presenting and talking only). Report, kick, ban, chat mute, the per-IP cap and the LiveKit publisher revoke are
described in § 12.5.

### 12.5 Moderators (ADR-019)

- **Who.** A session that signed in with a `MODERATOR_KEYS` key (the host-key field, or Profile → "Moderator
  sign-in"). Everyone sees the "Moderator" tag on its nameplate. In the hall it has every host power above.
- **Reports.** Every player can report another from the player menu (spam, harassment, impersonation, scam,
  inappropriate share, other; an optional note). Moderators see the report live with the reporter's nickname; the
  reported player is never told — a reported moderator included (the report goes to the other moderators only). In
  memory only (100, ≤ 24 h).
- **Mute** (10 min / 1 h / 24 h): chat, whispers and hall chat dropped; voice unaffected. **Kick**: out now, 10 minutes.
  **Ban** (1 h / 24 h / 7 days / until lifted): out now, for that long — every live session the kick or ban covers
  (another tab, a reconnect, the rest of a guest's network; not a moderator). A kick or ban drops the holder's stage
  turn, the floor, their queue place and vote at once, and removes their LiveKit participant.
- **Keys.** Owned names by their key hash (a ban ≥ 24 h is stored in `names.json`); every connection by a keyed hash
  of its network, for at most 24 hours (the only key a guest has).
- **LiveKit.** A host's or moderator's stop, a grant over a live holder, a cooldown and a successful vote also set the
  holder's `canPublish` to false at the SFU (the holder's client releases its microphone and share, keeps listening
  — the next presenter's share included — and says why). The holder's own stop doesn't.
