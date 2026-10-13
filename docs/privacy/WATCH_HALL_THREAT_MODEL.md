# Watch Hall Threat Model

Scope: the Watch Hall (`docs/architecture/WATCH_HALL.md`, decided in
`docs/decisions/ADR-014-watch-hall.md`). This document describes **what the implementation
actually does**; if it changes, this document changes in the same commit
(`docs/privacy/PRIVACY_MODEL.md` § 7). Server-held hall state (membership, stage queue, seats, hands,
reactions, hosts) is covered by the `MULTIPLAYER_THREAT_MODEL.md` addendum and the hall chat
channel by the `CHAT_THREAT_MODEL.md` addendum; this document covers what those do not.
No privacy claim beyond what is written here may be made about the Watch Hall.

## Stage sharing and hall audio

Code: `apps/web/src/hall/StageSystem.ts`, `apps/web/src/voice/` (`VoiceClient`, `VoiceSession`,
`VoiceAudioGraph`, `hallAudio`), `apps/server/src/watchHall.ts`,
`apps/server/src/voice/tokenHandler.ts`. The voice-layer detail is in the Watch Hall addendum
of `VOICE_THREAT_MODEL.md`.

**Data flows**

| Flow | Path | Content |
|---|---|---|
| Stage request, queue, holder | browser ⇄ game server (WebSocket) | playerIds and stage status only, members only, in memory |
| `hall_stage_live {live, audio}` | holder → game server | whether a LiveKit share runs and has audio |
| Stage share | holder → self-hosted LiveKit SFU → hall members who subscribe | screen video and its audio |
| Stage / floor mic | speaker → SFU → listeners inside the hall | microphone audio, heard at distance 0 |
| Watch mode token | browser → game server `/voice/token` | `{capability, listenOnly: true}`; a publish-nothing grant comes back |

**What each party learns**

| Party | Learns |
|---|---|
| Hall members | What the holder shares (video and audio), the holder's microphone and the floor's, who holds the stage and who queues (playerIds, resolved to nicknames from presence). |
| Players outside the hall | Nothing of the stage (no hall messages, no subscription, nothing played). The LiveKit room still lists every voice or watch participant and announces that a screen share is published (metadata, not media). |
| Game server | Stage requests, the queue, the holder, whether the share is live and has audio. Never media. Nothing is logged or persisted; all of it is dropped on disconnect. |
| Self-hosted SFU | Each participant's playerId, nickname and network address (as for voice), and the share's video and audio. No E2EE: it can technically access the media. No recording grant. |
| Third parties | None. Viewers of the stage contact only our origin and our SFU. |

**Risks and mitigations**

- **Sensitive content on screen.** The confirm dialog says everyone in the hall sees the share and
  **hears its audio**, and never to show a seed phrase, passwords or a wallet. The browser shows
  its own picker and sharing indicator; Stop works at any time (the panel or the browser).
- **Leaking other players' voices through system audio.** System audio is excluded by default.
  With the opt-in "Share my computer's sound" box, the holder's incoming hall audio is muted for
  the whole share (set before the picker opens), and the dialog warns that notifications and other
  apps' sound are shared too.
- **Rogue publisher / screen hijack.** Viewers download only the server-named holder's tracks; the
  earlier self-asserted `screen` attribute is gone. A modified client can still publish a screen
  share (the voice token allows the source) — honest clients never subscribe to it.
- **Unwanted presenter.** Local block hides a presenter's share completely (never downloaded) and
  local mute silences the stage audio. A host can stop the holder and lock the stage, and can hand
  a locked stage to a member with a raised hand even when squatters fill the queue. A lock is
  released when the last host session disconnects, so it can't freeze the stage forever. Host
  sign-in has no shared budget another session could drain (MULTIPLAYER_THREAT_MODEL.md § The host
  key). Stage moderation (`docs/architecture/WATCH_HALL.md` § 12): while a name registry runs, only owned names may
  present, take the floor or get a publishing voice grant (a modified client claiming the holder
  flag gets listen-only); the hall can **vote a share off** (bar max(3, ceil(50 % of the other
  members)); the presenter is benched for 10 minutes by name); a host can also remove players from
  the queue and bench them for up to 24 h; and a turn ends after 60 minutes when others wait and
  no host is present. Report, kick and ban are covered in § Moderation below.
- **The vote itself.** Votes reveal nothing about the voter to anyone: members see
  the count and their own vote only, the presenter included; the server holds the voter set for
  one turn and never logs it. Risks: a small hall can be brigaded by three owned names (cheap on
  the test chain), and without a registry by as many tabs as the audience — announced talks
  should run on a locked stage, which switches voting off.
- **A hall-wide microphone without consent.** The floor makes a member's microphone heard by
  everyone in the hall, whatever range they picked. The server gives it only to a member who raised
  a hand (raising it is the consent) — a modified holder client can't name anyone else — and the
  member with the floor can give it up at any time. The client tells the speaker when their
  microphone becomes hall-wide (on getting the stage and on getting the floor: a chat line, the
  stage panel header, "🎙 Hall-wide" in the voice controls), and a speaker whose avatar is outside
  the hall is never a stage mic (a holder who walks out, or teleports, during the 15 s leave grace).
- **Flooding the hall.** Stage, card, lock, floor, hand-lowering, seat, queue-removal and
  cooldown requests share a per-session budget (8, refilling 2/s), votes have their own (3, then
  one per 10 s), and unchanged requests send nothing, so one socket can't make the server broadcast
  a full stage state to every member 30 times a second. Hall chat spends the same per-session chat
  bucket as every other channel (5, then one per 2 s).
- **Spoofed position.** Hall membership comes from client-reported positions (ADR-005), so it is a
  social scope, not access control: a modified client can claim to be inside, or subscribe to the
  holder's tracks from anywhere in the room.
- **Watch mode without a wallet.** The listen-only grant cannot publish anything (no microphone, no
  screen, no data, no attributes). The client never captures the microphone in that mode.
  Listen-only viewers still appear in the room with playerId and nickname.
- **Holder walking away.** The turn ends on stop, on `hall_stage_live {live: false}`, on disconnect,
  and 15 s after the holder leaves the hall; a granted holder who never starts loses the turn after
  45 s. Losing the role stops the local share automatically.

**Not claimed:** no end-to-end encryption of stage media; no guarantee about what a holder chooses
to show; no access control beyond the honest-client subscription rule; no recording or replay of
stage shares (not built).

### Moderation (ADR-019)

- **Moderators are hosts.** A session signed in with a `MODERATOR_KEYS` key has every host power (lock, force stop,
  grant, queue removal, cooldowns) without the host key, anywhere in the hall; it appears in the host list and
  carries a "Moderator" tag on its nameplate. The role is session-only; the lock is released when the last host or
  moderator session disconnects, as before.
- **Inappropriate shares.** Viewers can report a presenter ("Inappropriate share"); moderators get it live with the
  location ("Watch Hall"). Nothing is recorded — no frame of the share is kept as evidence.
- **The SFU, too.** A host's or moderator's stop, a cooldown and a successful audience vote now also revoke the
  holder's LiveKit publish permission, and a kick or ban removes the participant (`VOICE_THREAT_MODEL.md`
  § Moderation). A kicked or banned holder's stage, floor, queue place and vote are dropped at once.

## Watch catalogue and personal player

Code: `apps/server/src/content/watch.ts`, `watchCatalogTypes.ts`, `sources.ts` (server);
`apps/web/src/watch/` (client). Decided in ADR-014 § 7–8 and the 2026-10-07 amendment of
ADR-009.

### What each party learns

| Party | Learns | Does not learn |
|---|---|---|
| **YouTube / Google, catalogue** (Data API, Atom feeds, thumbnails) | That our server asks for a few channels' uploads, a few playlists and thumbnails, from the server's IP (with an API key when the operator sets one). | Anything about players: requests are made by the server, cached, and shared by all players. |
| **Calendar hosts** (schedules) | That our server downloads the public calendars named in the catalogue and, about once an hour at most, an organiser's `.ics`. | Anything about players. |
| **YouTube / Google, personal player** — only after the viewer's consent | The viewer's **IP address**, user agent and the time; the video id; and, through the `Referer` header, the **game's origin** (for example `https://play.example.org/`). Inside the player, YouTube's own code runs and may fingerprint the browser. | The viewer's YouTube/Google cookies: the iframe is `credentialless` (no cookies or storage shared with the viewer's normal browsing) on `youtube-nocookie.com`. The page path, the player's nickname, position or anything else from the game. |
| **YouTube, new-tab fallback** (browsers without credentialless iframes) and every "Open on YouTube ↗" / "Join on Zoom ↗" / "Event page ↗" link | What any visit to that site reveals (IP, cookies of that site). Links use `noopener,noreferrer`, so not even our origin is sent. | Anything from the game. |
| **Our server** | Which catalogue routes are requested and when (like every other `/content/*` route). | Who watches what in the personal player: "Watch here" never goes through the server. |
| **Other players** | Nothing from the catalogue or the personal player. | Whether anyone opened a video. |

### Consent and the personal player

- In Chromium, "Watch here" first shows: "Watching here connects your browser to YouTube (Google): it
  sees your IP address and that you are watching from Zocial World." Nothing is loaded from YouTube
  before the viewer confirms (`tests/e2e/watch-panel.spec.ts` checks for zero YouTube requests).
- Browsers without credentialless iframes get no "Watch here" button in the Watch panel (only "Open
  on YouTube ↗", titled "Opens youtube.com in a new tab, which sees your IP address and your YouTube
  cookies"), and the speaker card's button reads "▶ Open on YouTube ↗" with the same note. Such a
  click is an ordinary youtube.com visit with the viewer's YouTube/Google cookies; no label there
  promises a consent dialog.
- The choice is remembered per device under `localStorage["zocial-world.watch.youtube-consent"]`
  (only the value `granted`; reads and writes are wrapped in try/catch, so blocked storage means
  "ask every time"). "Forget consent" in the player removes it.
- Chromium: a DOM overlay with
  `<iframe credentialless src="https://www.youtube-nocookie.com/embed/<id>?autoplay=1&rel=0"
  referrerpolicy="strict-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
  allowfullscreen>`, built with fixed attributes from an id that matches `^[A-Za-z0-9_-]{11}$`.
- **The referrer trade-off.** The production page sends `Referrer-Policy: no-referrer`; with it,
  YouTube refuses to play (Error 153, reproduced on 2026-10-07 under the dev server, which now sends
  the same header). The player therefore sets `referrerpolicy="strict-origin"`, which sends only the
  origin — never the path or query — and nothing on a downgrade to http. This is disclosed in the
  consent text ("that you are watching from Zocial World").
- Other browsers: `window.open("https://www.youtube.com/watch?v=<id>", "_blank",
  "noopener,noreferrer")` — an explicit new tab, like "Open on YouTube ↗".
- YouTube's `iframe_api` script is never loaded, and the HTML sanitizer's iframe ban for relayed
  content (`apps/web/src/community/safeHtml.ts`) is unchanged. Closing the player removes the
  iframe (playback stops) and hands keyboard focus back to the game.
- While the player is open, the stage audio is ducked to 0.2× (App wires the player's local
  `onOpenChange` signal to `VoiceSession.duck`); no data leaves the browser for this. The player's
  own sound is not part of the game's Web Audio graph, so system audio would capture it: the player
  therefore **stays closed while a computer-sound share is live** — starting the share closes it,
  "Watch here" is refused during the share, and a player opened anyway (a consent accepted mid-share)
  is closed again. A YouTube tab the holder opens themselves is still captured like any other sound.

### The catalogue (server side)

- Fixed upstreams only (`sources.ts`); collection pages exist only for listed ids (404 otherwise,
  with no upstream request).
- `YOUTUBE_API_KEY` is server-side only. It is never logged (upstream URLs are not logged, errors
  carry only `upstream <status>`, and other error text is replaced by "request failed"), never part
  of a cache key, never in a response (`watch.test.ts` checks responses and logs).
- A public calendar may mostly hold internal meetings with conference links and dial-in
  numbers. Only events whose title matches a catalogue rule are kept, before caching;
  their LOCATION, conference fields and every link are dropped, and their titles and descriptions
  are stripped of tags and URLs (also scheme-less ones like `meet.google.com/…` or
  `zoom.us/j/…?pwd=…`), meeting credentials ("Passcode: …", "Meeting ID: …") are replaced by
  "[redacted]", and the text is redacted (e-mail addresses, phone numbers, Zcash t1/t3/zs1/u1/tex1
  and Bitcoin addresses) and capped (titles 160, descriptions 600 characters). Location text and links shown for an event are
  our own constants, never the calendar's.
- Thumbnails reach the browser only through `/content/media`, and only
  `https://i.ytimg.com/vi/<id>/(mqdefault|hqdefault).jpg` — so the catalogue itself never makes the
  browser contact YouTube. Images are requested with `referrerpolicy="no-referrer"`.
- A failing source is not asked again for 5 minutes (1 hour for an organiser `.ics` that answers
  with a captcha page), so a broken upstream is not hammered.
- Nothing about catalogue requests is persisted; the in-memory cache holds only public data.

### Claims we may make

- Browsing the Watch panel (schedule, replays, thumbnails) does not contact YouTube, Google or
  Zoom from the player's browser.
- The personal player contacts YouTube only after explicit consent, without the viewer's YouTube
  cookies (Chromium), and tells YouTube only the game's origin, not the page.

### Claims we may not make

- That watching in the personal player is anonymous or private from YouTube: YouTube sees the IP
  address, the video and the game's origin.
- That the new-tab fallback or the external links are cookieless: they are ordinary visits to
  those sites.

### Possible next steps

- A self-hosted or relayed player would remove the IP exposure, but it would mean re-hosting video
  (licensing) and is out of scope.
