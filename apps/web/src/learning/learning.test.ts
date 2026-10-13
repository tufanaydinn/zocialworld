import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSend, classifyAddress, conventionalFeeZec } from "./addresses.ts";
import { lessonById, validateCatalog, type LessonCatalog } from "./catalog.ts";
import { LearningProgress, type ProgressStorage } from "./progress.ts";
import type { Lesson } from "./types.ts";
import { BASIC_VISUALIZERS } from "./visualizers/basics.ts";
import { SAMPLE_CURRICULUM } from "../content/sample/sampleCurriculum.ts";

// The learning framework on the sample catalogue (content/sample/sampleCurriculum.ts) and small fixtures.

const memory = (): ProgressStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
};

const SAMPLE_IDS = SAMPLE_CURRICULUM.lessons.map((lesson) => lesson.id);

test("addresses: prefixes map to network and pool", () => {
  assert.deepEqual(classifyAddress("utest1exampleONLYtestnetunified"), { network: "testnet", pool: "unified", shielded: true });
  assert.deepEqual(classifyAddress("u1exampleONLYmainnetunified"), { network: "mainnet", pool: "unified", shielded: true });
  assert.equal(classifyAddress("ztestsapling1qqqqqqqqqqqqqqqqqqqqq")?.pool, "sapling");
  assert.equal(classifyAddress("zs1qqqqqqqqqqqqqqqqqqqqqqqqqq")?.network, "mainnet");
  assert.equal(classifyAddress("tmKairo4transparent8Q2W6E0R4T8")?.shielded, false);
  assert.equal(classifyAddress("t1abcdefghijklmnopqrstuvw")?.network, "mainnet");
  assert.equal(classifyAddress("bc1qxyz"), null);
  assert.equal(classifyAddress("not an address at all!!"), null);
});

test("addresses: ZIP-317 conventional fee and send checks", () => {
  assert.equal(conventionalFeeZec(1), 0.0001);
  assert.equal(conventionalFeeZec(2), 0.0001);
  assert.equal(conventionalFeeZec(4), 0.0002);
  const wrong = checkSend("testnet", 1, "u1exampleONLYmainnetunified", 0.25);
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.reason, "wrong-network");
  const broke = checkSend("testnet", 0.3, "utest1exampleONLYtestnetunified", 0.3);
  assert.equal(!broke.ok && broke.reason, "insufficient-funds");
  assert.equal(checkSend("testnet", 1, "utest1exampleONLYtestnetunified", 0.25).ok, true);
});

test("catalogue: the sample catalogue is consistent and every SEE / TRY view it names is a basic visualizer", () => {
  assert.deepEqual(validateCatalog(SAMPLE_CURRICULUM, BASIC_VISUALIZERS), []);
  const kinds = SAMPLE_CURRICULUM.lessons.map((lesson) => lesson.prove.kind);
  assert.ok(kinds.includes("quiz") && kinds.includes("simulation"), "a quiz lesson and a simulation lesson");
  const gate = lessonById(SAMPLE_CURRICULUM, Object.values(SAMPLE_CURRICULUM.gates)[0]!);
  assert.equal(gate?.tier, "quiz");
  assert.deepEqual([...gate!.requires].sort(), SAMPLE_CURRICULUM.lessons.filter((lesson) => lesson.tier !== "quiz").map((lesson) => lesson.id).sort());
  for (const lesson of SAMPLE_CURRICULUM.lessons) {
    assert.equal(lesson.meta.source.license, "CC BY-SA 4.0", `${lesson.id} credits its source licence`);
    assert.equal(lesson.meta.usesRealFunds, false);
  }
});

test("catalogue: validateCatalog reports each broken rule", () => {
  const base = SAMPLE_CURRICULUM.lessons[0]!;
  const lesson = (id: string, extra: Partial<Lesson>): Lesson => ({ ...base, id, see: undefined, try: undefined, requires: [], ...extra });
  const broken: LessonCatalog = {
    ...SAMPLE_CURRICULUM,
    lessons: [
      lesson("a", { requires: ["b"] }),
      lesson("b", { requires: ["a"] }),
      lesson("dup", {}),
      lesson("dup", {}),
      lesson("c", { requires: ["missing"], zone: "nowhere" }),
      lesson("d", { prove: { kind: "simulation" } }),
      lesson("e", { see: "no-such-view" }),
      lesson("f", { prove: { kind: "quiz", draw: 2, questions: [{ question: "?", options: ["x"], answer: 3, explain: "" }, { question: "!", options: ["y"], answer: 0, explain: "" }] } }),
      lesson("g", { prove: { kind: "quiz", pass: 3, questions: [{ question: "?", options: ["x"], answer: 0, explain: "" }, { question: "?", options: ["y"], answer: 0, explain: "" }] } }),
      lesson("h", { meta: { ...base.meta, source: { name: "x", url: "http://example.com" } } }),
    ],
    gates: { front: "b" },
  };
  const problems = validateCatalog(broken, BASIC_VISUALIZERS).join("\n");
  for (const expected of [
    "duplicate lesson id dup",
    "c requires unknown missing",
    "c: zone nowhere has no label",
    "prerequisite cycle",
    "d is proven by simulation but has no TRY step",
    "e: no visualizer no-such-view",
    'f: no valid answer for "?"',
    "f: pool no larger than one attempt",
    "g: pass mark above the drawn count",
    "g: duplicate questions",
    "h: source is not an https URL",
    "gate front must open with a quiz lesson",
  ]) {
    assert.ok(problems.includes(expected), `missing "${expected}" in:\n${problems}`);
  }
});

test("progress: completions unlock dependents and persist locally", () => {
  const storage = memory();
  const progress = new LearningProgress(SAMPLE_IDS, storage);
  const quiz = lessonById(SAMPLE_CURRICULUM, "first-steps-quiz")!;
  assert.equal(progress.isUnlocked(quiz), false);
  let changes = 0;
  progress.onChange(() => changes++);
  for (const id of quiz.requires) progress.complete(id, "simulation");
  assert.equal(progress.isUnlocked(quiz), true);
  assert.equal(changes, quiz.requires.length);
  const reloaded = new LearningProgress(SAMPLE_IDS, storage);
  assert.equal(reloaded.isComplete(quiz.requires[0]!), true);
  assert.equal(reloaded.completedCount, quiz.requires.length);
});

test("progress: corrupt or missing storage never throws", () => {
  const storage = memory();
  storage.data.set("learning-valley-progress-v1", "{not json");
  assert.equal(new LearningProgress(SAMPLE_IDS, storage).completedCount, 0);
  const throwing: ProgressStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const progress = new LearningProgress(SAMPLE_IDS, throwing);
  progress.complete("zcash-in-brief", "knowledge");
  assert.equal(progress.isComplete("zcash-in-brief"), true);
  assert.equal(new LearningProgress(SAMPLE_IDS, null).completedCount, 0);
});

test("progress: practice state and quiz cooldown stay on the device", () => {
  const storage = memory();
  const progress = new LearningProgress(SAMPLE_IDS, storage);
  assert.equal(progress.hasPracticed("chain-of-blocks"), false);
  progress.markPracticed("chain-of-blocks");
  progress.setPracticeState("zcash-in-brief", { reached: 3, note: 2 });
  const reloaded = new LearningProgress(SAMPLE_IDS, storage);
  assert.equal(reloaded.hasPracticed("chain-of-blocks"), true);
  assert.deepEqual(reloaded.practiceState("zcash-in-brief"), { reached: 3, note: 2 });
  // Completed lessons count as practised; entries for other ids are never read.
  reloaded.complete("first-steps-quiz", "knowledge");
  assert.equal(reloaded.hasPracticed("first-steps-quiz"), true);
  storage.data.set("learning-valley-practice-v1", JSON.stringify({ "not-a-lesson": { tried: true }, "chain-of-blocks": "junk" }));
  assert.equal(new LearningProgress(SAMPLE_IDS, storage).hasPracticed("not-a-lesson"), false);
  assert.equal(new LearningProgress(SAMPLE_IDS, storage).hasPracticed("chain-of-blocks"), false);
  // Cooldown after a failed attempt counts down, and is per session (not persisted).
  progress.recordFailure("first-steps-quiz", 1_000);
  assert.equal(progress.cooldownLeft("first-steps-quiz", 25, 11_000), 15);
  assert.equal(progress.cooldownLeft("first-steps-quiz", 25, 40_000), 0);
  assert.equal(new LearningProgress(SAMPLE_IDS, storage).cooldownLeft("first-steps-quiz", 25), 0);
});

test("progress: entries for lessons of another catalogue survive a save untouched", () => {
  const storage = memory();
  storage.data.set("learning-valley-progress-v1", JSON.stringify({ "other-lesson": { kind: "knowledge", at: "2026-01-01T00:00:00.000Z" } }));
  storage.data.set("learning-valley-practice-v1", JSON.stringify({ "other-lesson": { tried: true, state: { step: 2 } } }));
  const progress = new LearningProgress(SAMPLE_IDS, storage);
  assert.equal(progress.completedCount, 0);
  assert.equal(progress.isComplete("other-lesson"), false);
  progress.complete("zcash-in-brief", "knowledge");
  progress.markPracticed("chain-of-blocks");
  const completions = JSON.parse(storage.data.get("learning-valley-progress-v1")!) as Record<string, { kind: string }>;
  assert.deepEqual(Object.keys(completions).sort(), ["other-lesson", "zcash-in-brief"]);
  assert.equal(completions["other-lesson"]!.kind, "knowledge");
  const practice = JSON.parse(storage.data.get("learning-valley-practice-v1")!) as Record<string, unknown>;
  assert.deepEqual(practice["other-lesson"], { tried: true, state: { step: 2 } });
  assert.equal(new LearningProgress(["other-lesson"], storage).isComplete("other-lesson"), true);
});
