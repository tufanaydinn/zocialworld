/** Learning Valley content model. */

export type Tier = "beginner" | "intermediate" | "advanced" | "expert" | "quiz";

/** How a lesson's completion was established. */
export type VerificationKind = "read" | "knowledge" | "simulation" | "testnet" | "tool" | "builder" | "contribution";

/** The area a lesson belongs to; the catalogue's `zoneLabels` names each zone it uses. */
export type Zone = string;

/** The key of an interactive SEE or TRY view in the content's visualizer registry (`catalog.ts`). */
export type VisualizerId = string;

export interface QuizQuestion {
  readonly question: string;
  readonly options: readonly string[];
  /** Index into `options`. */
  readonly answer: number;
  readonly explain: string;
}

export type Proof =
  | {
      readonly kind: "quiz";
      /** The question pool. */
      readonly questions: readonly QuizQuestion[];
      /** Questions drawn from the pool per attempt (default: all). */
      readonly draw?: number;
      /** Correct answers needed out of the drawn questions (default: all drawn). */
      readonly pass?: number;
    }
  /** Completed when the TRY visualizer reports completion. */
  | { readonly kind: "simulation" }
  /** Completed by reading LEARN to the end. */
  | { readonly kind: "read" };

export interface LessonSource {
  readonly name: string;
  readonly url: string;
  readonly license?: string;
}

export interface LessonMeta {
  /** 1 (first steps) – 5 (expert). */
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
  readonly source: LessonSource;
  readonly version: string;
  readonly lastChecked: string;
  readonly requiresWallet: boolean;
  readonly requiresTestnet: boolean;
  readonly usesRealFunds: boolean;
}

export interface Lesson {
  readonly id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly zone: Zone;
  /** One line shown on boards and station prompts. */
  readonly summary: string;
  /** LEARN: short paragraphs. */
  readonly learn: readonly string[];
  readonly see?: VisualizerId;
  readonly try?: VisualizerId;
  readonly prove: Proof;
  readonly verification: VerificationKind;
  /** Lesson ids that must be complete first. */
  readonly requires: readonly string[];
  /** Optional ZecHub wiki article (content gateway id) for "read more". */
  readonly wiki?: string;
  readonly meta: LessonMeta;
}
