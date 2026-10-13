import { test, expect as baseExpect, type Locator, type Page } from "@playwright/test";
import { SAMPLE_CURRICULUM } from "../../apps/web/src/content/sample/sampleCurriculum.ts";

// Software rendering with parallel workers can take seconds per frame; panel updates appear on the next frame.
const expect = baseExpect.configure({ timeout: 15_000 });

/**
 * The Learning panel on the sample lessons (`content/sample/sampleCurriculum.ts`) in the sample world
 * (`?world=prototype`), opened through the `__learningPanel` test hook instead of a lesson station: the directory
 * lists the catalogue, a SEE step shows its visualizer, a quiz and a lab complete their lessons, and the gate quiz
 * unlocks once both are done. Progress is local-only, so the test starts from a fresh browser context.
 */

type PanelHook = { open(lessonId: string): void; openDirectory(): void };

async function enterSampleWorld(page: Page): Promise<void> {
  await page.goto("/?world=prototype");
  await page.waitForFunction(() => (window as unknown as { __worldReady?: boolean }).__worldReady === true, null, { timeout: 60_000 });
}

const openLesson = (page: Page, lessonId: string) => page.evaluate((id) => (window as unknown as { __learningPanel: PanelHook }).__learningPanel.open(id), lessonId);

/** Answers every drawn question correctly, looking each one up in the catalogue's pool. */
async function passQuiz(panel: Locator, lessonId: string): Promise<void> {
  const lesson = SAMPLE_CURRICULUM.lessons.find((candidate) => candidate.id === lessonId)!;
  const pool = lesson.prove.kind === "quiz" ? lesson.prove.questions : [];
  const blocks = panel.locator(".lv-question");
  const count = lesson.prove.kind === "quiz" ? (lesson.prove.draw ?? pool.length) : 0;
  await expect(blocks).toHaveCount(count);
  for (let i = 0; i < count; i++) {
    const text = (await blocks.nth(i).locator(".lv-question-text").textContent())!.replace(/^\d+\.\s*/, "");
    const question = pool.find((candidate) => candidate.question === text)!;
    await blocks.nth(i).locator(".lv-option", { hasText: question.options[question.answer]! }).click();
  }
  await panel.getByRole("button", { name: "Submit answers" }).click();
}

test.describe("Learning panel (sample lessons)", () => {
  test.describe.configure({ timeout: 90_000 });

  test("the directory lists the catalogue; a quiz and a lab complete their lessons and unlock the gate quiz", async ({ page }) => {
    await enterSampleWorld(page);
    const panel = page.locator(".lv-backdrop");

    await page.evaluate(() => (window as unknown as { __learningPanel: PanelHook }).__learningPanel.openDirectory());
    await expect(panel).toHaveClass(/visible/);
    await expect(panel).toContainText(SAMPLE_CURRICULUM.directoryIntro);
    await expect(panel.locator(".lv-tabs .lv-tab")).toHaveText(["All", "Beginner", "Quizzes"]);
    await expect(panel).toContainText("📍 First Steps");
    for (const lesson of SAMPLE_CURRICULUM.lessons) await expect(panel).toContainText(lesson.title);
    await expect(panel).toContainText("Needs: Zcash in Brief, A Chain of Blocks");
    await expect(panel.locator(".lv-ring")).toContainText(`0/${SAMPLE_CURRICULUM.lessons.length}`);

    // A quiz lesson: LEARN credits its source, SEE shows the ZEC facts cards, PROVE passes.
    await openLesson(page, "zcash-in-brief");
    await expect(panel.locator(".lv-title")).toHaveText("Zcash in Brief");
    await expect(panel).toContainText("Beginner · First Steps");
    await expect(panel.locator(".lv-source")).toContainText("ZecHub wiki");
    await expect(panel.locator(".lv-source")).toContainText("CC BY-SA 4.0");
    await panel.locator(".lv-tab", { hasText: "SEE" }).click();
    await expect(panel.locator(".lv-card-label", { hasText: "Maximum supply" })).toBeVisible();
    await panel.locator(".lv-tab", { hasText: "PROVE" }).click();
    await passQuiz(panel, "zcash-in-brief");
    await expect(panel).toContainText("KNOWLEDGE VERIFIED");

    // A simulation lesson: rewrite block #1, then re-mine the broken blocks in order.
    await openLesson(page, "chain-of-blocks");
    await panel.locator(".lv-tab", { hasText: "TRY" }).click();
    const blocks = panel.locator(".lv-block");
    await expect(blocks).toHaveCount(4);
    await blocks.nth(1).locator("input").fill("Alice → Mallory 1.0");
    await blocks.nth(1).locator("input").dispatchEvent("change");
    for (const index of [2, 3]) {
      const remine = panel.locator(".lv-block").nth(index).getByRole("button", { name: "⛏ Re-mine" });
      await remine.click();
      await expect(remine).toHaveCount(0);
    }
    await expect(panel).toContainText("SIMULATION VERIFIED");

    // Both lessons done: the gate quiz is open and passes.
    await openLesson(page, "first-steps-quiz");
    await expect(panel.locator(".lv-title")).toHaveText("First Steps Quiz");
    await panel.locator(".lv-tab", { hasText: "PROVE" }).click();
    await passQuiz(panel, "first-steps-quiz");
    await expect(panel).toContainText("KNOWLEDGE VERIFIED");

    // Progress stays on the device, under the same key as every catalogue.
    const stored = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("learning-valley-progress-v1") ?? "{}") as object).sort());
    expect(stored).toEqual(["chain-of-blocks", "first-steps-quiz", "zcash-in-brief"]);
  });
});
