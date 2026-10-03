import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * CORE-004 §33 Tests 7 and 8.
 *
 * Both are specifically about push-to-talk input isolation and failure
 * isolation at the whole-app level, so a real browser is the right tool
 * (same reasoning `app.spec.ts`/`social.spec.ts` already follow) rather
 * than a Node-side unit test — neither InputManager's DOM event wiring
 * nor "does the app survive a real failed fetch" can be exercised
 * without one.
 *
 * `apps/server` runs for this suite (see `playwright.config.ts`) but
 * with no `LIVEKIT_*` env vars set (only `.env.example` exists, never a
 * real `.env` in this repository/CI) — so `/voice/token` deterministically
 * responds 503, giving Test 8 a real, reproducible "voice backend
 * unavailable" condition to assert against, without needing a running
 * LiveKit server at all.
 */

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err: Error) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Only uncaught exceptions ("pageerror") — never a console.error. Used by Test 8 below, where a deliberately-failing fetch (503, by design — voice is unconfigured) causes Chromium to log its own "Failed to load resource" network-panel message as a console error regardless of whether the application code handles the failure gracefully (which `VoiceSession.enableVoice()`'s `.catch()` does — see the assertions below) — that intrinsic browser logging is not evidence of an app crash, only an uncaught exception would be. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err: Error) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test.describe("CORE-004 — voice", () => {
  test("Test 7 — typing 'v' into the nickname text input does not activate push-to-talk", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    const nicknameInput = page.locator(".zw-nickname-controls input");
    await nicknameInput.click();

    await page.keyboard.down("KeyV");
    await page.waitForTimeout(150);

    // Mic label must still read "Muted" — if push-to-talk had fired while
    // the nickname input was focused, App.ts's updateVoice() would have
    // flipped it to "Push-to-talk active" (see VoiceControls.setMicActive()).
    await expect(page.locator(".zw-voice-controls")).toContainText("Mic: Muted");

    await page.keyboard.up("KeyV");

    // Sanity check: releasing focus and holding V normally DOES activate
    // push-to-talk — proves the guard above is actually suppressing
    // something, not just always-off regardless of input.
    await nicknameInput.evaluate((el: HTMLElement) => el.blur());
    await page.keyboard.down("KeyV");
    await page.waitForTimeout(150);
    await expect(page.locator(".zw-voice-controls")).toContainText("Push-to-talk active");
    await page.keyboard.up("KeyV");
  });

  test("PTT focus-change bug fix — releasing V after focus moved into a text input still clears push-to-talk", async ({ page }) => {
    // CORE-004 security revision (
    // PR #4), merge blocker §2: the original onKeyUp guard ignored a
    // keyup whose event.target was a text input — so holding V outside
    // the nickname box (push-to-talk starts), then focusing the
    // nickname box WHILE STILL HOLDING V, then releasing V, left
    // push-to-talk stuck "pressed" (microphone logically still
    // transmitting) because the release event itself was dropped. Fixed
    // by never gating onKeyUp on text-input focus — only onKeyDown
    // blocks a NEW activation; release must always go through.
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    // Step 1: hold V outside any text input — push-to-talk activates.
    await page.keyboard.down("KeyV");
    await page.waitForTimeout(150);
    await expect(page.locator(".zw-voice-controls")).toContainText("Push-to-talk active");

    // Step 2: move focus into the nickname text input WHILE STILL HOLDING V.
    const nicknameInput = page.locator(".zw-nickname-controls input");
    await nicknameInput.click();

    // Step 3: release V — its keyup event now targets the text input.
    await page.keyboard.up("KeyV");
    await page.waitForTimeout(150);

    // Must clear, not get stuck — the bug this test guards against.
    await expect(page.locator(".zw-voice-controls")).toContainText("Mic: Muted");

    // Window blur must also still clear held state (unrelated code path,
    // unaffected by this fix, but worth confirming it's still intact).
    // Blur the nickname input first — it's still focused from step 2,
    // and onKeyDown's (unchanged, still-correct) text-input guard would
    // otherwise block this next press from activating at all.
    await nicknameInput.evaluate((el: HTMLElement) => el.blur());
    await page.keyboard.down("KeyV");
    await page.waitForTimeout(150);
    await expect(page.locator(".zw-voice-controls")).toContainText("Push-to-talk active");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.waitForTimeout(150);
    await expect(page.locator(".zw-voice-controls")).toContainText("Mic: Muted");
    await page.keyboard.up("KeyV"); // release the now-already-cleared key, harmless no-op
  });

  test("Test 8 — a voice backend failure does not crash core app state", async ({ page }) => {
    const errors = collectPageErrors(page);

    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__localPlayer));

    await page.locator(".zw-voice-controls button", { hasText: "Enable Voice" }).click();
    // /voice/token responds 503 (no LIVEKIT_* configured) — App.ts's
    // enableVoice().catch() must turn this into an ERROR state, never an
    // uncaught exception.
    await expect(page.locator(".zw-voice-controls")).toContainText("Voice: ERROR", { timeout: 5000 });

    // The rest of the app must be completely unaffected: movement still
    // works, the canvas is still rendering, and nothing threw as an
    // uncaught page error.
    await expect(page.locator("canvas[data-engine]")).toBeVisible();
    const before = await page.evaluate(() => ({ ...window.__localPlayer!.position }));
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(500);
    await page.keyboard.up("KeyW");
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ ...window.__localPlayer!.position }));
    expect(after).not.toEqual(before);

    expect(errors, `Uncaught page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
