# tests/e2e

Playwright end-to-end tests for the running application. They live at the
repository root (not inside `apps/web`) because they drive the app as a
whole — see `/playwright.config.ts`.

The suite runs on the sample content (`ZW_CONTENT=sample` in
`/playwright.config.ts`): the prototype plaza, the sample Watch Hall and
the sample lessons. Specs never hard-code world coordinates; they stand a
player at the app's named anchors (`window.__anchors`, names in
`apps/web/src/debug/anchors.ts`, helper in `support/anchors.ts`), such as
`projects.board`, `hall.door`, `hall.floor` and `hall.podium`, and read
seats from the hall's own seat list. The model packs are not needed: the
sample content uses procedural placeholders.

```bash
npm run test:e2e        # from the repository root
```

The suite runs against the Vite **dev server**, not a production
preview build, so that the `import.meta.env.DEV`-gated debug hooks in
`apps/web/src/core/App.ts` (`window.__localPlayer`,
`window.__networkClient`, `window.__remotePlayers`, …) are available for
tests to read application state through. Production build correctness
is covered separately by `npm run build`.

`playwright.config.ts`'s `webServer` starts **both** `apps/server` and
`apps/web`: the client connects to the multiplayer server on load, and
without a server the refused WebSocket connection would show up as a
console error. Multiplayer behaviour itself (join/leave/transform relay)
is covered by `apps/server/src/WorldServer.test.ts` and
`apps/web/src/networking/interpolation.test.ts`, not by this suite.

Names (ADR-016): the test server runs the **dev name registry**
(`NAME_REGISTRY=dev` in `playwright.config.ts`). A chosen name is
fee-confirmed. The dev registry confirms every reservation after ~2 s,
and its quotes name a placeholder address that the client never pays.
Specs that give a player a name do two things:
- activate a random test name key (`activateNameKeyFromSeed` in
  `apps/web/src/zcash/nameKey.ts`);
- call `window.__confirmName(name)`.

`set_nickname` is ignored for holders while a registry runs.

`E2E_SHOTS=<dir>` makes the layout, voice-error and hall-session specs
write screenshots there; `MODERATION_SHOTS=<dir>` does the same for
`moderation.spec.ts`.

## Default suite

| Spec | What it checks |
|---|---|
| `app.spec.ts` | A: the app loads with no console/page errors; B: holding `W` moves the player; C: next to the project board the `[E] View Projects` prompt appears; D: `E` opens the project panel; E: `Esc` closes it; F: resizing the viewport resizes the canvas 1:1. C–E teleport the player through `window.__localPlayer` instead of walking: the interaction system re-checks distance every frame, so this is faster and more deterministic. |
| `social.spec.ts` | Nickname rendering safety: a nickname shaped like `<script>…` or `<img onerror=…>` renders as inert text. The players are spawned through `window.__remotePlayers`, because the server already rejects such names (`apps/server/src/nickname.test.ts`); this proves the client's own defence in depth (`docs/privacy/SOCIAL_IDENTITY_THREAT_MODEL.md`). |
| `chat.spec.ts` | Text chat between two real clients: General reaches others (with a speech bubble), whispers reach only the recipient, a blocked player's lines are hidden, markup stays inert text. |
| `identity.spec.ts` | Wallet holders and guests (ADR-015): Send ZEC disabled on a guest with the reason, enabled on a holder; a forged `pay_request` to a guest is refused (`no_wallet`); the chosen character model and live `set_avatar`. |
| `onboarding.spec.ts` | The start-of-game flow from empty storage (ADR-015 § 7): guest, first-time holder (a second client is told the name is taken), returning holder with the inline unlock; Escape never closes onboarding. |
| `names.spec.ts` | Fee-confirmed names on the dev registry: the fee step in onboarding, the "taken" answer, the returning player's signed claim (no payment). |
| `onboarding-layout.spec.ts` | Every onboarding step at 1280×720, 1366×768, 1536×864, 1920×1080, 2560×1440, the browser viewports 1366×657, 1536×730 and 1280×600, and 1280×720 / 1536×864 at device scale 1.25: the card, its step header and its action footer stay inside the window, only the body scrolls, nothing wraps or truncates, the preview keeps 4:5; the wallet panel fits too. |
| `projects.spec.ts` | Project discovery: the board and a booth open the panel, featured/category filters and search, the detail view and back, hostile project text rendered as text, no link buttons for a project without URLs. |
| `voice.spec.ts` | Typing `v` into a text input never activates push-to-talk; releasing `V` after focus moved into a text input still clears it; a voice backend failure (`/voice/token` → 503 — the suite's server has no `LIVEKIT_*` settings) shows an error without any uncaught page error, and movement and multiplayer keep working. |
| `voice-errors.spec.ts` | Against the default server (no LiveKit, `/voice/token` → 503 `voice_unconfigured`): a wallet holder's Enable Voice and a guest's "Listen to voices" both show "Voice isn't set up on this game server." (card + chat line, the `npm run dev` hint in dev). |
| `watch-panel.spec.ts` | Offline (`/content/watch*` and `/content/media` from fixtures, youtube-nocookie.com stubbed, the clock fixed to Thursday 2026-10-15 15:30 UTC): the Watch panel's tabs, filters and safe links; zero YouTube requests before consent, then a `credentialless` youtube-nocookie iframe; the consent is remembered; the `window.open` fallback when `credentialless` is missing. |
| `watch-stage.spec.ts` | The Watch Hall stage against the default server (no LiveKit): take the stage at the podium, queue, the share confirm dialog (nothing is captured), handing on, the watch-mode button. With the dev registry, an unlocked wallet without a confirmed name gets **Confirm a name** and a hand-made `hall_stage_request` is refused (`identity_required`). The share dialog offers **Slides** (30 fps, default) and **Video** (60 fps). A second test: an audience vote (B plus two raw WebSocket members) ends a live share and benches the presenter; B unlocks host tools with the test-only `WATCH_HALL_HOST_KEY` from `playwright.config.ts` (override with `E2E_HALL_HOST_KEY`), removes a queued member and sets a cooldown. |
| `watch-hall.spec.ts` | The hall's social UI with three clients (C stays outside): the door, zone label, title card, Hall chat tab and stage widget; hall chat and reaction batches reach B, never C; takeaways on the board; blocked players and hostile markup; the stage widget (request, vote row, queue, raised hands, the speaker card editor and its safe links); promotion when the holder's browser closes. |
| `watch-hall-seats.spec.ts` | Seats (E at a free seat, "taken" for a second claimant, WASD stands up), the emote wheel (hold G) and raised hands (H), seen from a second client. |
| `watch-hall-session.spec.ts` | (`hall` project) The Discussion Corner counter resets with every stage turn ("This session" from zero → "Last session" kept while idle → zero again) with the same server totals on two clients; the Watch panel, the stage widget and the speaker card fit 1280×720 … 2560×1440. |
| `moderation.spec.ts` | (one serial test, ~10–13 min) Three clients, each with its own client address (the game socket is relayed with `X-Forwarded-For` by `support/clientAddress.ts`; the config's server trusts 127.0.0.1 with `TRUST_PROXY`, so a ban keyed by the connection hash never locks out the rest of the suite). The moderator signs in from Profile with the config's test-only `MODERATOR_KEYS`; report, mute, kick, 1 h ban (a raw socket from the banned address closes 4002), unban and the log (ADR-019). |
| `community.spec.ts` | The Community Hub opens and closes whether or not the upstream sites are reachable; its HTML sanitizer is exercised with hostile input. |
| `learning-panel.spec.ts` | The Learning panel on the sample lessons, opened through the `__learningPanel` hook: the directory, a visualizer step, a quiz and a lab complete their lessons, the gate quiz unlocks. |
| `support-flow.spec.ts` | The wallet and project-support UI paths (create, import with a public BIP-39 test vector, the support confirmation, cancel, failure isolation); steps whose elements a build does not show are skipped, and nothing is sent on a real chain. |

Do not add `extraHTTPHeaders` to the moderation specs: Chromium does not send them on WebSocket upgrades, and on
cross-origin fetches they trigger CORS preflights that break the name flow (use `support/clientAddress.ts` instead).

## Real LiveKit specs — NOT part of the default suite

`voice-integration.spec.ts`, `watch-stage-integration.spec.ts`, `watch-hall-voice-real.spec.ts` and
`moderation-livekit-real.spec.ts` are skipped unless `VOICE_INTEGRATION=1` is set: they need a real
self-hosted LiveKit SFU, which `npm run test:e2e` and CI cannot assume. Run them with the local LiveKit
that `npm run dev` uses, passing its keys through the config's game server:

```bash
LIVEKIT_NODE_IP=127.0.0.1 node scripts/dev/livekit.mjs &
VOICE_INTEGRATION=1 LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  npx playwright test tests/e2e/voice-integration.spec.ts tests/e2e/watch-hall-voice-real.spec.ts \
  tests/e2e/watch-stage-integration.spec.ts tests/e2e/moderation-livekit-real.spec.ts
```

The four specs share one SFU; on a slow machine `voice-integration.spec.ts` is more reliable on its own
(`--workers=1`) than next to the moderation spec's three pages. The config's game server runs the dev
name registry, so players that talk or present are wallet holders **and confirm a name** first — a
holder without one gets the name step, not a connection. For an SFU bound to 127.0.0.1 the specs pass
Chromium's `--allow-loopback-in-peer-connection` and `--disable-features=WebRtcHideLocalIpsWithMdns`
(test environment only).

| Spec | What it checks |
|---|---|
| `voice-integration.spec.ts` | Two real Chromium contexts (with `--use-fake-device-for-media-stream` instead of a microphone) join the world, enable voice and each subscribe to the other's published track through the SFU; a local mute or block on one side drops that participant's Web Audio gain to exactly `0` (and back) without affecting the other side. Each page waits for the OTHER test page by its playerId, because the server is shared with the hall specs running in parallel. It cannot prove audible sound (see the manual test below). |
| `watch-stage-integration.spec.ts` | A (wallet gate passed, a dev-registry name, full voice) shares a tab with Chromium's fake display-media capture (video and tab audio); B, a guest in watch mode (listen-only), subscribes to exactly A's ScreenShare + ScreenShareAudio, plays the audio, hears A's mic as a stage mic, sees frames advance for 15 s, and drops everything after walking out. A shares once in **Slides** and once in **Video** mode: the sender's top layer (30 fps / 3.5 Mbps / `detail`, then 60 fps / 7 Mbps / `motion`) is checked, and the simulcast layers, stats and the viewer's frame rate are logged (on a software renderer the rate says more about the machine than the encoding). |
| `watch-hall-voice-real.spec.ts` | Against the local LiveKit that `npm run dev` starts (`LOCAL_LIVEKIT_PORT=7900 LIVEKIT_NODE_IP=127.0.0.1 node scripts/dev/livekit.mjs` + `LOCAL_LIVEKIT_PORT=7900 npm run dev:local-voice --workspace apps/server`, or the LIVEKIT_* variables as above): two wallet holders with names press Enable Voice, the mic publishes and each hears the other; A shares a tab with audio from the podium and B receives frames and audio; with the microphone permission refused, voice still connects for listening and the card says "Microphone access is blocked for this site." |
| `moderation-livekit-real.spec.ts` | (`hall` project: it takes the stage) Checked through LiveKit's own RoomService `ListParticipants`: a presenter has `canPublish: true` and its tracks; after a moderator's stage cooldown the server's revoke leaves `canPublish: false` and no tracks, and the client drops to listening in the same room; Enable Voice publishes again; after a kick the participant is gone. Needs the game server with `TRUST_PROXY=127.0.0.1` and a moderator key — the config's server has both — and `E2E_LIVEKIT_HTTP` when LiveKit is not on 7880. |

## MANUAL ACCEPTANCE TEST — social scenario

Not automated: the full nickname/selection/block flow across two real
browser clients adds little over the unit and integration coverage
(`apps/server/src/nickname.test.ts`, `apps/server/src/WorldServer.test.ts`,
`apps/web/src/social/*.test.ts`), so it is a manual check.

**Procedure:**

1. `npm run dev` (from the repository root).
2. Open two browser tabs/windows at the dev URL.
3. In tab A, set nickname to `Alice`; in tab B, set nickname to
   `Builder` (the nickname control).
4. Confirm A sees a `Builder` nameplate and B sees an `Alice` nameplate.
5. Walk A within ~5m of B. Select B (E while B is the nearest
   interactable). Confirm the context card shows `Builder` and
   `Nearby`.
6. Click **Block**. Confirm the card closes and `Builder`'s nameplate
   disappears from A's view, B is not disconnected, and B's own window
   shows no sign of being blocked.
7. Confirm the project board `[E] View Projects` interaction still works
   on A after the block.
8. Open a third tab, also set its nickname to `Alice`; confirm it
   receives `Alice-2` (or the next free suffix).

## MANUAL ACCEPTANCE TEST — proximity voice (real audible sound)

**Not automated, and cannot be** — an automated browser has no real
microphone or speakers, so no automated test can confirm a human would
actually hear anything (`voice-integration.spec.ts` proves the real
connection/subscription/gain pipeline, without audible sound). Run this
with a real microphone and speakers/headphones before shipping voice
changes to players.

**Procedure:**

1. Run a local LiveKit (`node scripts/dev/livekit.mjs`, or
   `livekit-server --dev`; see `apps/server/README.md`) and give the game
   server its URL and keys.
2. `npm run dev` (from the repository root).
3. Open two browser tabs/windows (ideally on two different physical
   devices/rooms, or with one muted at the OS level, to avoid a feedback
   loop between a real mic and real speakers) at the dev URL.
4. In both tabs, click **Enable Voice**. Grant the browser microphone
   permission when prompted. Confirm the voice status reads connected in
   both.
5. In tab A, hold `V` and speak. Confirm B hears A's voice, and A's
   nameplate on B's screen shows the speaking indicator (🔊) and briefly
   plays its talk animation.
6. Walk A and B apart in the world. Confirm A's voice gets quieter on B
   as distance increases past `VOICE_FULL_VOLUME_RADIUS_METERS` (3m),
   and becomes inaudible entirely past `VOICE_MAX_AUDIBLE_RADIUS_METERS`
   (12m). Walk back together; confirm volume returns.
7. On B, open A's player context card and click **Mute**. Confirm A
   becomes inaudible to B specifically — A keeps talking, A's own
   screen shows nothing different, and A's nameplate/avatar remain fully
   visible and interactable on B's screen (unlike Block).
8. Click **Unmute** on B; confirm A becomes audible again.
9. On B, click **Block** on A instead. Confirm: A's nameplate disappears
   from B's screen, A becomes inaudible to B, A is NOT disconnected
   (A's own voice/world state is completely unaffected and A receives
   no indication of being blocked), and B can still interact with the
   rest of the world normally.
10. Release `V` on A; confirm A's push-to-talk indicator returns to
    muted and B stops receiving new audio from A (B may still be
    subscribed — only transmission stops).

## MANUAL ACCEPTANCE TEST — camera orbit / mouse-look

**Not automated.** Pointer Lock, as exercised through Chromium's
automation protocol in a headless CI environment, does not reliably
reproduce real user mouse-look input — `document.pointerLockElement`
state and relative `movementX/Y` deltas under automation are
inconsistent across environments in practice. Rather than ship a test
that is flaky for reasons unrelated to the actual feature, this is a
manual check.

**Procedure:**

1. `npm run dev` (from the repository root or `apps/web`).
2. Open the app in a real browser, click the canvas once.
3. Confirm the cursor disappears (pointer lock engaged) and moving the
   mouse orbits the camera around the player smoothly, with pitch
   clamped (cannot flip over the top/bottom) and no jitter.
4. Scroll the mouse wheel; confirm the camera zooms in/out within its
   clamped distance range.
5. Walk toward a placeholder building; confirm the camera pulls in
   instead of clipping through the wall (raycast-based collision
   avoidance — `apps/web/src/camera/ThirdPersonCamera.ts`).
6. Press `Esc`; confirm the pointer unlocks (cursor reappears).
