# ADR-009: Read-only community content gateway (ZecHub, Zcash forum, GitHub)

## Status

Accepted (2026-10-05). Amended 2026-10-06 (wider read scope, images)
and 2026-10-07 (watch catalogue, personal player).

## Context

Players should be able to read community content in-world, on boards and
in an in-game reader, without leaving the game: ZecHub bounties (open
work), the ZecHub wiki, the Zcash Community Forum and ecosystem GitHub
repositories, and later reply on the forum.

Fetching those sites directly from the browser would hand every player's
IP address and browser fingerprint to each third party on every board
load, which conflicts with the privacy baseline (`docs/privacy/PRIVACY_MODEL.md`:
minimize exposure of network metadata). Embedding the sites in iframes is
ruled out: it would leak the same metadata and hand third-party code a
frame inside the game.

## Decision

- `apps/server` serves `GET /content/*`, a read-only gateway with a fixed
  upstream allowlist (`src/content/sources.ts`): ZecHub bounty API
  (`zechub.zone/api/bounties`), forum category/topic JSON, GitHub REST +
  raw README for listed repositories, ZecHub wiki Markdown for listed
  articles (raw GitHub, CC BY-SA 4.0, attributed in the UI).
- Responses are reshaped to small typed JSON with length caps; personal
  fields are dropped (bounty creators' real names/avatars, emails,
  wallet addresses). Public forum handles are kept.
- 10-minute in-memory cache, de-duplicated in-flight requests, last-good
  copy served on upstream failure; listing endpoints degrade to
  `{ available: false }` instead of HTTP errors.
- Same Origin allowlist + CORS policy as the voice endpoint; GET only.
- The client renders third-party Markdown/HTML through DOMPurify with all
  media removed (no remote image loads) and https-only, new-tab links.
- **Posting forum replies is not implemented.** It requires per-user
  forum authorization (Discourse User API Keys), which the forum admins
  must enable for this app's redirect URL. The UI says so and offers an
  explicit "Reply on the forum ↗" link.

## Consequences

- Players' IPs never reach ZecHub, the forum or GitHub through the game;
  those services see only the server.
- Upstream schema changes break only the mapper functions (unit-tested
  with fixtures in `communityContent.test.ts`).
- The server becomes a (tiny) content cache — operational owner needed.
- In-game replies need a follow-up: forum partnership + an ADR for the
  Discourse User API Key flow (key held client-side; posts relayed
  without logging).

## Amendment — wider read scope (2026-10-06)

So that players do not have to leave the game to read, the gateway's
read-only scope grew within the same rules:

- **Forum:** every public category (Community Grants first) with paging,
  full threads (chunks of 20 by post id, jump to a post), and search
  (validated, cached, capped at 20 uncached searches per minute).
- **Wiki:** the whole English ZecHub wiki, indexed from the repository tree
  (GitHub API, cached 1 h; curated list as fallback). Only indexed paths
  can be fetched.
- **z.cash/learn:** a curated index of links only — the site blocks
  automated access and publishes no content license.
- **Images:** this replaces "all media removed". Images from a short host
  and path allowlist (forum uploads/emoji, zechub.wiki images, listed
  repositories) are relayed by `/content/media`: raster only (bytes
  sniffed, no SVG), no redirects followed, 3 MB cap, byte-budgeted cache,
  uncached fetches capped per minute; avatars are never relayed. The
  privacy rationale is unchanged — the browser still never contacts those
  hosts. Every other image is still a text note.
- **Correction:** Discourse User API keys do *not* require the forum to
  enable anything with default settings. Only the redirect flavour needs an
  allowlist entry. In-game posting would need its own ADR.

## Amendment — watch catalogue and personal player (2026-10-07)

Accepted together with ADR-014 (Watch Hall); see
`docs/decisions/ADR-014-watch-hall.md` § 7–8 and
`docs/architecture/WATCH_HALL.md` § 7–8. Same rules as above: fixed
upstreams in `sources.ts`, reshaped and capped JSON, cache with a stale
fallback, and listings that degrade instead of failing.

**New routes.** `GET /content/watch` (live and upcoming streams, the
schedule from now − 12 h to now + 30 days, latest replays, collections;
`Cache-Control: max-age=30`) and `GET /content/watch/collection/:id?page=n`
(only the ids listed in the server's watch catalogue, else 404). Code:
`apps/server/src/content/watch.ts` and `watchCatalogTypes.ts`.

**The watch catalogue is data.** What the gateway may list comes from a
catalogue the operator provides as a JSON file (`WATCH_CATALOG_FILE`),
checked at start by `parseWatchCatalog`; without one, the server uses the
sample catalogue in `apps/server/src/content/watchCatalog.sample.ts`. A
catalogue names the allowlisted YouTube channels, replay collections with
verified fallback entries, recurring events (an RRULE in UTC, with an
optional organiser `.ics` that is used only when it really is a calendar),
public calendars with title rules, curated one-off events and credit
lines.

**New upstreams**, each degrading to the next:

- *YouTube Data API v3* (`www.googleapis.com/youtube/v3`), only when the
  operator sets `YOUTUBE_API_KEY`: `playlistItems.list` and `videos.list`
  (1 quota unit each), never `search.list`. It is the only source of
  live/upcoming status and viewer counts. The key is server-side only: it
  is never logged (upstream URLs are not logged; errors carry only
  `upstream <status>`), never part of a cache key and never in a response.
  Videos are kept only from the catalogue's allowlisted channels.
- *YouTube Atom feeds* (`www.youtube.com/feeds/videos.xml`, no key) for the
  same channels and listed playlists. A failure is remembered for 5 minutes
  (negative cache), so a dead feed is not asked on every request.
- *The catalogue's own replays*: video ids, titles, upload times and
  durations verified when the catalogue was curated. They always answer,
  so Replays is never empty.
- *Schedules.* Public `.ics` calendars are parsed (a small RFC 5545
  subset: unfolding, unescaping, UTC times, weekly RRULE, EXDATE,
  RECURRENCE-ID), and only events whose title matches a catalogue rule
  are kept — before caching. LOCATION, conference fields and links from a
  calendar are never relayed. An `.ics` that answers automated clients
  with a captcha page is treated as unavailable; the gateway does not work
  around it. Curated one-off events fill in when a calendar is unreachable.
- Relayed free text (calendar descriptions) is stripped of tags and links,
  redacted (e-mail addresses, phone numbers, Zcash and Bitcoin addresses)
  and capped.

**Media allowlist.** `/content/media` also relays YouTube thumbnails, but
only `https://i.ytimg.com/vi/<11-character id>/(mqdefault|hqdefault).jpg`:
an exact path pattern (no prefix match, no query, no dot segments), mirrored
in the client's `MEDIA_HOSTS` (`apps/web/src/community/safeHtml.ts`). The
gateway builds these URLs from validated ids; it never relays a thumbnail
URL taken from upstream data.

**The personal-player exception (ADR-014 § 7).** This ADR's Context rules
iframes out. ADR-014 makes one exception: after explicit consent, a viewer
may open a YouTube video in a credentialless `youtube-nocookie.com` iframe
(Chromium) or a new tab (other browsers). It is the viewer's own choice
and contacts YouTube directly; the gateway is not involved. The DOMPurify
pipeline keeps banning iframes in relayed content, and YouTube's
`iframe_api` script is never loaded.
