# Project Discovery Threat Model

Scope: the project discovery and project-booth layer — the static project registry, search/filter, the discovery list and
detail panels, and the world-placed project booths
(`apps/web/src/projects/`, `apps/web/src/world/PrototypePlaza.ts`'s booth
placements). This document describes **what this specific implementation
actually does** — not an aspiration, not a future state. If the
implementation changes, this document must be updated in the same commit
(per `docs/privacy/PRIVACY_MODEL.md` § 7).

No privacy claim beyond what's written here may be made about project
discovery (`docs/privacy/PRIVACY_MODEL.md`, § Rule).
This document narrows, and does not relax, `docs/privacy/MULTIPLAYER_THREAT_MODEL.md`
and `docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md` — nothing those
documents say about `playerId`/`nickname`/network metadata is changed by
project discovery. It adds **no networking of its own** — see below.

## What information does project discovery expose, and to whom?

Only the static registry content itself (`apps/web/src/projects/projectData.ts`):
name, short/long description, category, status, tags, and whichever of
website/repository/social URLs a project happens to list. This is
repository-curated fixture data, not information about any player — see
"Data ownership" below. It is rendered locally in the browser
(`ProjectDiscoveryPanel`/`ProjectDetailPanel`) and exposed to no one but
the local user viewing their own screen; there is no multiplayer
broadcast, no server round-trip, and no other player can observe what
project another player is browsing, searching, or has opened.

## Is project browsing linked to wallet identity?

**No, and there is no code path that could link them.** Project discovery
introduces no wallet code, no wallet-adjacent field anywhere in
`ProjectTypes.ts`'s `Project` interface, and no code that reads or stores
wallet data alongside a project's id/slug, a player's `playerId`, or
search/filter state. There is no "connect wallet to view projects" step
anywhere in this feature — see the next section.

## Is a wallet connection required to use this feature?

**No.** Every discovery/search/filter/detail-view code path
(`getAllProjects`, `searchProjects`, `getProjectsByCategory`,
`getFeaturedProjects`, `ProjectDiscoveryPanel.open()`/`openProject()`,
`ProjectBoothInteractable.interact()`) works identically whether or not
the player has ever connected a wallet. Nothing in the discovery
feature checks, requires, or waits on wallet state. The one exception
sits next to it, not inside it: the detail panel's "Support with ZEC"
button belongs to the wallet (`apps/web/src/zcash/SupportFlow.ts`), is
disabled without an unlocked wallet, and is analysed in
`docs/privacy/ZCASH_WALLET_THREAT_MODEL.md`.

## Is project browsing, searching, or selection sent to the server?

**No.** `ProjectRegistry.ts`'s data (`PROJECTS`) is a module-level TypeScript
constant bundled into the client at build time — there is no `fetch`,
no API endpoint, no server-side registry, and no server code anywhere in
`apps/server/` that knows about projects at all. Searching
(`searchProjects`), filtering (category/featured), opening the discovery
panel, selecting a project, and opening a project's detail view are all
pure client-side function calls and local DOM updates. The multiplayer
protocol (`packages/shared/src/multiplayer-protocol.ts`) has no
project-related message type in either direction — there is no field to
carry this information even if some future code tried, the same
structural guarantee `SOCIAL_IDENTITY_THREAT_MODEL.md` documents for
block state.

## Is search history, browsing history, or selection history persisted?

**No.** `ProjectDiscoveryPanel`'s search input value and active filter
are held only in that panel's own in-memory fields
(`this.searchInput.value`, `this.activeFilter`), reset to empty/`"all"`
every time `open()` runs (the board path). They are never written to
`localStorage`, `sessionStorage`, a cookie, IndexedDB, or sent anywhere.
Reloading the page, closing the tab, or navigating away discards all of
it. There is no history/recently-viewed feature in this implementation.

## Does this feature use analytics, telemetry, or tracking of any kind?

**No.** There is no Google Analytics, Mixpanel, Amplitude, PostHog,
tracking pixel, click-tracking, or search-tracking code anywhere in
`apps/web/src/projects/` or the files that wire it into `App.ts`. No
event resembling "project viewed," "search performed," or "link clicked"
is recorded, locally or remotely. This matches the project's standing
no-analytics baseline.

## Are external project links (Website/Repository/Social) a privacy boundary?

**Yes, and this implementation treats them as a hard boundary it has no
visibility into.** `createSafeExternalLink()`
(`apps/web/src/projects/urlSafety.ts`) renders every external URL as a
real `<a target="_blank" rel="noopener noreferrer">`:

- `rel="noopener noreferrer"` means the opened page gets no
  `window.opener` reference back into this application and no
  `Referer` header naming this application's specific project-detail URL
  as the origin, beyond whatever a browser's default cross-origin
  referrer policy already sends for any outbound link.
- Once a player clicks through, the destination site is a completely
  separate privacy boundary this project does not control, does not
  audit, and cannot make claims about — it may run its own analytics,
  cookies, or tracking, exactly as any third-party website might. This
  implementation makes no promise about what happens after navigation,
  and no UI text here claims otherwise.
- Only `http`/`https` URLs that parse successfully are ever rendered as
  a link at all (`isSafeExternalUrl()`) — `javascript:`, `data:`,
  `vbscript:`, and malformed strings are rejected outright, so a hostile
  or malformed registry entry can never become a clickable attack
  surface (script execution, a dangling `data:` navigation, etc.).

## What is stored locally by this feature?

**Nothing, beyond the bundled static registry itself.** No
`localStorage`/`sessionStorage`/cookie/IndexedDB usage exists anywhere in
`apps/web/src/projects/`. Search text and the active filter live only in
transient in-memory DOM state (see "Is search history... persisted?"
above) and vanish on panel close/reopen or page reload.

## What is NOT implemented yet (do not assume otherwise)?

None of the following exist in project discovery, and no UI text or
code here should be read as implying they do:

- Wallet connection or ZEC payment flows inside the discovery feature.
  The "Support with ZEC" button is the wallet's own flow, with its own
  threat model (`docs/privacy/ZCASH_WALLET_THREAT_MODEL.md`); a project
  can be supported only once the operator configures a recipient for
  it.
- Project owner accounts, submission forms, editing UI, or an admin/
  moderation panel. The registry is static and repository-curated only
  — there is no way for anyone, including a project's real-world team,
  to self-list or edit an entry through this application.
- Any backend, database, or API for projects — `ProjectRegistry.ts` is a
  plain in-memory module, not a service.
- Project comments, ratings, chat, or direct messaging tied to a project.
- Ranking, "trending," or engagement-metric algorithms of any kind —
  `featured` is a static boolean set in the fixture data, not a computed
  score.
- Embedded third-party content (iframes, auto-fetched previews, scraped
  metadata, screenshots) — every card/detail view renders only the
  registry's own static text fields.

## What must never be exposed?

Everything `MULTIPLAYER_THREAT_MODEL.md` and
`SOCIAL_IDENTITY_THREAT_MODEL.md` already list, plus, specific to
project discovery:

- Which project(s) a player has viewed, searched for, or selected — to
  the server, to any other player, or to any analytics system. There is
  no code path for this (see "Is project browsing... sent to the
  server?" above).
- Wallet identity of any kind, anywhere in a project card, detail view,
  or booth interaction (no "View Wallet" action — per
  `docs/privacy/PRIVACY_MODEL.md` § 1 — and no wallet field exists on
  `Project` at all).
- A donor's wallet identity on a project page (`docs/privacy/PRIVACY_MODEL.md`
  § 2): the support flow's memo is empty and nothing about a supporter is
  shown to the project or to other players.

None of these have a field or code path in project discovery. Adding one
would be an architecture-affecting or privacy-affecting change requiring
an ADR (and, for a wallet/payment feature specifically, its own reviewed
threat model), and this document would need a corresponding update before
such a change could ship.

## Security / project text rendering

Every piece of project text (name, descriptions, tags, status/category
labels) is rendered via `textContent` or a freshly created DOM element's
property assignment — never `innerHTML`, never string-concatenated
markup, in either `ProjectDiscoveryPanel.ts` or `ProjectDetailPanel.ts`.
External links are only ever constructed through `createSafeExternalLink()`,
which itself refuses anything that isn't an `isSafeExternalUrl()`-checked
`http`/`https` URL. A project with no optional URL field simply produces
no link element for that field — never a disabled/dead button (see
`tests/e2e/projects.spec.ts`'s Test 14). This is tested at two levels:
`apps/web/src/projects/urlSafety.test.ts` (pure URL-safety logic, Node
test runner) and `tests/e2e/projects.spec.ts`'s Test 13 (real-browser DOM
assertion that a synthetic hostile `Project` — `<script>`/`<img onerror>`
content — renders as inert text with zero injected `<script>`/`<img>`
elements), using the same dev-only test-injection pattern
`tests/e2e/social.spec.ts` already established for nickname rendering.
