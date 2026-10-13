import type { Lesson, Tier, Zone } from "./types.ts";
import type { Visualizer } from "./visualizers/common.ts";

/** A module announced in the directory before it exists. */
export interface UpcomingModule {
  readonly title: string;
  readonly tier: Tier;
  /** Short release label shown next to the title. */
  readonly phase: string;
}

/**
 * The lessons a content ships and how the learning UI names and groups them. The content provider supplies one
 * catalogue (`content/types.ts`); the Learning panel, the progress store and any location with lesson stations read
 * it. `validateCatalog` checks the rules every catalogue must keep.
 */
export interface LessonCatalog {
  readonly lessons: readonly Lesson[];
  /** Directory tab names in tab order; a tier without a label gets no tab and shows its id. */
  readonly tierLabels: Readonly<Partial<Record<Tier, string>>>;
  /** Display name of every zone the lessons use. */
  readonly zoneLabels: Readonly<Record<Zone, string>>;
  /** Planned modules listed after the lessons (may be empty). */
  readonly upcoming: readonly UpcomingModule[];
  /** Named gates (a barrier in a location, for example) and the quiz lesson that opens each. */
  readonly gates: Readonly<Record<string, string>>;
  /** The line under the directory tabs: where and how this content's lessons are started. */
  readonly directoryIntro: string;
}

/** Visualizer id → the function that renders it into a lesson's SEE or TRY step. */
export type VisualizerRegistry = Readonly<Record<string, Visualizer>>;

export function lessonById(catalog: LessonCatalog, id: string): Lesson | undefined {
  return catalog.lessons.find((lesson) => lesson.id === id);
}

export function tierLabel(catalog: LessonCatalog, tier: Tier): string {
  return catalog.tierLabels[tier] ?? tier;
}

export function zoneLabel(catalog: LessonCatalog, zone: Zone): string {
  return catalog.zoneLabels[zone] ?? zone;
}

/**
 * Everything wrong with a catalogue, as readable lines (empty when it is consistent): unique lesson ids, known and
 * acyclic prerequisites, answerable quizzes whose pools are larger than one attempt, simulation proofs with a TRY
 * step, https sources, labelled zones, gates that point at quiz lessons and, when a registry is given, a visualizer
 * for every SEE and TRY step.
 */
export function validateCatalog(catalog: LessonCatalog, visualizers?: VisualizerRegistry): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const lesson of catalog.lessons) {
    if (ids.has(lesson.id)) problems.push(`duplicate lesson id ${lesson.id}`);
    ids.add(lesson.id);
  }
  for (const lesson of catalog.lessons) {
    for (const required of lesson.requires) if (!ids.has(required)) problems.push(`${lesson.id} requires unknown ${required}`);
    if (!(lesson.zone in catalog.zoneLabels)) problems.push(`${lesson.id}: zone ${lesson.zone} has no label`);
    if (!lesson.meta.source.url.startsWith("https://")) problems.push(`${lesson.id}: source is not an https URL`);
    if (lesson.prove.kind === "simulation" && !lesson.try) problems.push(`${lesson.id} is proven by simulation but has no TRY step`);
    if (lesson.prove.kind === "quiz") {
      const { questions, draw, pass } = lesson.prove;
      const drawn = draw ?? questions.length;
      if (questions.length === 0) problems.push(`${lesson.id}: empty question pool`);
      if (drawn > questions.length) problems.push(`${lesson.id}: draws more than the pool`);
      if ((pass ?? drawn) > drawn) problems.push(`${lesson.id}: pass mark above the drawn count`);
      // A pool larger than one attempt, so a retry is not the same quiz.
      if (draw !== undefined && questions.length <= draw) problems.push(`${lesson.id}: pool no larger than one attempt`);
      if (new Set(questions.map((question) => question.question)).size !== questions.length) problems.push(`${lesson.id}: duplicate questions`);
      for (const question of questions) {
        if (!(question.answer >= 0 && question.answer < question.options.length)) problems.push(`${lesson.id}: no valid answer for "${question.question}"`);
      }
    }
    if (visualizers) {
      for (const id of [lesson.see, lesson.try]) if (id !== undefined && !(id in visualizers)) problems.push(`${lesson.id}: no visualizer ${id}`);
    }
  }
  // Prerequisites form no cycles.
  const byId = new Map(catalog.lessons.map((lesson) => [lesson.id, lesson]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      problems.push(`prerequisite cycle through ${id}`);
      return;
    }
    visiting.add(id);
    for (const required of byId.get(id)?.requires ?? []) visit(required);
    visiting.delete(id);
    done.add(id);
  };
  for (const lesson of catalog.lessons) visit(lesson.id);
  for (const [gate, lessonId] of Object.entries(catalog.gates)) {
    if (byId.get(lessonId)?.tier !== "quiz") problems.push(`gate ${gate} must open with a quiz lesson, not ${lessonId}`);
  }
  return problems;
}
