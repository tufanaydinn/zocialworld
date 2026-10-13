import type { Lesson, VerificationKind } from "./types.ts";

/**
 * Learning progress, stored only in this browser (ADR-010 § 4): never sent
 * to the server, never linked to the nickname or a wallet. Storage access
 * can throw (private windows, blocked site data) — progress then lives for
 * the session only.
 */

const STORAGE_KEY = "learning-valley-progress-v1";
/** Practice state (TRY done, lab step reached, mission checklist) — same local-only rules as completions. */
const PRACTICE_KEY = "learning-valley-practice-v1";

export interface PracticeRecord {
  /** The lesson's TRY task was finished at least once (PROVE unlocks). */
  readonly tried?: boolean;
  /** Visualizer-owned state (e.g. the shielded lab's reached step), JSON-serialisable. */
  readonly state?: unknown;
}

export interface CompletionRecord {
  readonly kind: VerificationKind;
  readonly at: string;
}

type Listener = () => void;

export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class LearningProgress {
  private completed: Record<string, CompletionRecord>;
  private practice: Record<string, PracticeRecord>;
  /** The lesson ids of the active catalogue; stored entries for other ids are kept as they are, never read. */
  private readonly known: ReadonlySet<string>;
  private foreignCompleted: Record<string, unknown> = {};
  private foreignPractice: Record<string, unknown> = {};
  /** Failed quiz attempts this session (lesson id → time in ms), for the retry cooldown. Not persisted. */
  private readonly failedAt = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly storage: ProgressStorage | null;

  constructor(lessonIds: readonly string[], storage: ProgressStorage | null = safeLocalStorage()) {
    this.known = new Set(lessonIds);
    this.storage = storage;
    this.completed = this.load();
    this.practice = this.loadPractice();
  }

  /** Whether the lesson's TRY task has been finished (completed lessons count as practised). */
  hasPracticed(lessonId: string): boolean {
    return this.isComplete(lessonId) || this.practice[lessonId]?.tried === true;
  }

  markPracticed(lessonId: string): void {
    if (this.practice[lessonId]?.tried) return;
    this.practice = { ...this.practice, [lessonId]: { ...this.practice[lessonId], tried: true } };
    this.savePractice();
    for (const listener of this.listeners) listener();
  }

  practiceState<T>(lessonId: string): T | undefined {
    return this.practice[lessonId]?.state as T | undefined;
  }

  setPracticeState(lessonId: string, state: unknown): void {
    this.practice = { ...this.practice, [lessonId]: { ...this.practice[lessonId], state } };
    this.savePractice();
    for (const listener of this.listeners) listener();
  }

  /** Seconds left before a failed quiz can be retried (0 = ready). */
  cooldownLeft(lessonId: string, seconds: number, now = Date.now()): number {
    const at = this.failedAt.get(lessonId);
    if (at === undefined) return 0;
    return Math.max(0, Math.ceil(seconds - (now - at) / 1000));
  }

  recordFailure(lessonId: string, now = Date.now()): void {
    this.failedAt.set(lessonId, now);
  }

  isComplete(lessonId: string): boolean {
    return lessonId in this.completed;
  }

  record(lessonId: string): CompletionRecord | undefined {
    return this.completed[lessonId];
  }

  /** Lessons whose prerequisites are all complete. */
  isUnlocked(lesson: Lesson): boolean {
    return lesson.requires.every((id) => this.isComplete(id));
  }

  complete(lessonId: string, kind: VerificationKind): void {
    if (this.isComplete(lessonId)) return;
    this.completed = { ...this.completed, [lessonId]: { kind, at: new Date().toISOString() } };
    this.save();
    for (const listener of this.listeners) listener();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get completedCount(): number {
    return [...this.known].filter((id) => this.isComplete(id)).length;
  }

  private load(): Record<string, CompletionRecord> {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      const result: Record<string, CompletionRecord> = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!this.known.has(id)) {
          this.foreignCompleted[id] = value;
          continue;
        }
        const record = value as Partial<CompletionRecord> | null;
        if (record && typeof record.kind === "string" && typeof record.at === "string") result[id] = { kind: record.kind as VerificationKind, at: record.at };
      }
      return result;
    } catch {
      return {};
    }
  }

  private loadPractice(): Record<string, PracticeRecord> {
    try {
      const raw = this.storage?.getItem(PRACTICE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      const result: Record<string, PracticeRecord> = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!this.known.has(id)) {
          this.foreignPractice[id] = value;
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const record = value as { tried?: unknown; state?: unknown };
        result[id] = { ...(record.tried === true ? { tried: true } : {}), ...(record.state !== undefined ? { state: record.state } : {}) };
      }
      return result;
    } catch {
      return {};
    }
  }

  private savePractice(): void {
    try {
      this.storage?.setItem(PRACTICE_KEY, JSON.stringify({ ...this.foreignPractice, ...this.practice }));
    } catch {
      // Storage unavailable — keep practice state for this session only.
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({ ...this.foreignCompleted, ...this.completed }));
    } catch {
      // Storage unavailable — keep progress for this session only.
    }
  }
}

function safeLocalStorage(): ProgressStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
