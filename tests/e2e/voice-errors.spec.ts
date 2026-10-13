import { test, expect, type Page } from "@playwright/test";

/**
 * A voice failure says why (instead of a bare error after "Enable Voice"). The
 * default test server has no LiveKit, so `/voice/token` answers 503 `voice_unconfigured`: the voice panel's error card
 * and a chat line say "Voice isn't set up on this game server", with the `npm run dev` hint in a dev build — for a
 * wallet holder's Enable Voice and for a guest's "Listen to voices" alike. The rest of the app keeps working.
 * (The other causes — permission, no device, insecure page, guest, unreachable SFU — are unit-tested in
 * apps/web/src/voice/voiceErrors.test.ts; the refused microphone also runs against a real LiveKit in
 * watch-hall-voice-real.spec.ts.) E2E_SHOTS=<dir> writes a screenshot of the card.
 */

const SHOTS = process.env.E2E_SHOTS ?? "";

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?quality=low");
  await page.waitForFunction(() => (window as unknown as { __networkClient?: { joined: boolean } }).__networkClient?.joined === true, null, { timeout: 120_000 });
}

test.describe("voice failures are explained", () => {
  test.setTimeout(180_000);

  test("a wallet holder's Enable Voice on a server without LiveKit: 'Voice isn't set up on this game server' + the npm run dev hint", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await open(page);
    // The e2e server runs the DEV name registry: talking needs an owned name there, so the holder
    // confirms one first — otherwise Enable Voice asks for the name instead of reaching /voice/token.
    const name = `Vox${Math.random().toString(36).slice(2, 6)}`;
    await page.evaluate(async (nickname) => {
      const modulePath = "/src/zcash/participation.ts"; // a variable: Vite serves it, tsc must not resolve it
      const participation = (await import(/* @vite-ignore */ modulePath)) as { updateParticipationState(status: string): void };
      participation.updateParticipationState("ready");
      const nameKeyPath = "/src/zcash/nameKey.ts";
      const nameKey = (await import(/* @vite-ignore */ nameKeyPath)) as { activateNameKeyFromSeed(seed: Uint8Array, network: string): Promise<unknown> };
      await nameKey.activateNameKeyFromSeed(crypto.getRandomValues(new Uint8Array(64)), "test");
      await (window as unknown as { __confirmName(nickname: string): Promise<void> }).__confirmName(nickname);
    }, name);
    await page.waitForFunction((nickname) => (window as unknown as { __identity?: () => { nickname: string } }).__identity?.().nickname === nickname, name, { timeout: 30_000 });
    const button = page.locator(".zw-voice-controls .zw-button-primary");
    await expect(button).toHaveText("Enable Voice");
    await button.click();
    const card = page.locator(".zw-voice-error");
    await expect(card).toBeVisible();
    await expect(card.locator(".zw-voice-error-title")).toHaveText("Voice isn't set up on this game server.");
    await expect(card.locator(".zw-voice-error-detail")).toContainText("npm run dev");
    await expect(page.locator(".zw-voice-controls")).toContainText("Voice: ERROR");
    await expect(page.locator(".zw-chat-line", { hasText: "Voice isn't set up on this game server." })).toBeVisible();
    // The card fits on screen above the voice panel.
    const box = await card.boundingBox();
    expect(box && box.y >= 0 && box.x >= 0 && box.x + box.width <= 1280).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/voice-error-unconfigured.png` });
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toBeHidden();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a guest's 'Listen to voices' gets the same precise reason", async ({ page }) => {
    await open(page);
    const button = page.locator(".zw-voice-controls .zw-button-primary");
    await expect(button).toHaveText("Listen to voices (guests can't talk)");
    await button.click();
    await expect(page.locator(".zw-voice-error-title")).toHaveText("Voice isn't set up on this game server.");
  });
});
