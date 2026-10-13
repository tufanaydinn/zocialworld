import { injectUiStyles } from "../ui/styles.ts";
import type { CommunityClient } from "../community/CommunityClient.ts";
import { lessonById, tierLabel, zoneLabel, type LessonCatalog, type VisualizerRegistry } from "./catalog.ts";
import type { LearningProgress } from "./progress.ts";
import type { Lesson, QuizQuestion, Tier, VerificationKind } from "./types.ts";
import { button, el, shuffled, type CommunityView } from "./visualizers/common.ts";

const VERIFIED_LABEL: Record<VerificationKind, string> = {
  read: "READ VERIFIED",
  knowledge: "KNOWLEDGE VERIFIED",
  simulation: "SIMULATION VERIFIED",
  testnet: "TESTNET VERIFIED",
  tool: "TOOL VERIFIED",
  builder: "BUILDER VERIFIED",
  contribution: "CONTRIBUTION VERIFIED",
};

type Step = "learn" | "see" | "try" | "prove";
const STEP_INFO: Record<Step, { icon: string; label: string; hint: string }> = {
  learn: { icon: "📖", label: "LEARN", hint: "Read" },
  see: { icon: "👁", label: "SEE", hint: "Explore" },
  try: { icon: "🛠", label: "TRY", hint: "Practise" },
  prove: { icon: "🏅", label: "PROVE", hint: "Verify" },
};
/** Seconds before a failed quiz can be retried (gate quizzes wait longer). */
const COOLDOWN = { lesson: 12, gate: 25 };

/**
 * The focused learning interface a station opens:
 * the 3D station is the doorway, the lesson runs here, completion returns
 * the player to the valley and is saved on this device only.
 *
 * A lesson is LEARN → (SEE) → (TRY) → PROVE. When a lesson has a TRY task,
 * PROVE stays locked until the task is done (the player must have
 * practised, not only read). Quizzes draw from a question pool, only explain
 * the answers you got right, and a failed attempt has a short cooldown.
 */
export class LearningPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly catalog: LessonCatalog;
  private readonly visualizers: VisualizerRegistry;
  private readonly progress: LearningProgress;
  private readonly client: CommunityClient;
  private readonly openCommunity: (view: CommunityView) => void;
  private startStep: number | undefined;
  private cooldownTimer: number | undefined;

  /** `catalog` is the content's lessons and `visualizers` the SEE / TRY views its lessons name. */
  constructor(container: HTMLElement, catalog: LessonCatalog, visualizers: VisualizerRegistry, progress: LearningProgress, client: CommunityClient, openCommunity: (view: CommunityView) => void) {
    injectUiStyles();
    injectLearningStyles();
    this.catalog = catalog;
    this.visualizers = visualizers;
    this.progress = progress;
    this.client = client;
    this.openCommunity = (view) => {
      this.close();
      openCommunity(view);
    };
    this.backdrop = el("div", "zw-ui lv-backdrop");
    this.panel = el("div", "zw-panel lv-panel");
    this.backdrop.appendChild(this.panel);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });
    container.appendChild(this.backdrop);
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  /** Opens a lesson (a station). `startStep` is the pedestal number for multi-pedestal labs. */
  open(lessonId: string, startStep?: number): void {
    const lesson = lessonById(this.catalog, lessonId);
    if (!lesson) return;
    this.startStep = startStep;
    document.exitPointerLock();
    this.backdrop.classList.add("visible");
    if (!this.progress.isUnlocked(lesson) && !this.progress.isComplete(lesson.id)) this.renderLocked(lesson);
    // Pedestals of a multi-station lab open straight on the task.
    else this.renderLesson(lesson, startStep !== undefined && lesson.try ? "try" : "learn");
  }

  /** Track board view: every module of a tier with its status and where its station stands. */
  openDirectory(tier?: Tier): void {
    document.exitPointerLock();
    this.backdrop.classList.add("visible");
    this.renderDirectory(tier);
  }

  close(): void {
    window.clearInterval(this.cooldownTimer);
    this.backdrop.classList.remove("visible");
  }

  dispose(): void {
    this.backdrop.remove();
  }

  // ---------------------------------------------------------------- views

  private frame(title: string, subtitle: string, tierClass: string): HTMLDivElement {
    window.clearInterval(this.cooldownTimer);
    this.panel.replaceChildren();
    const header = el("div", "lv-header");
    const titles = el("div", "lv-titles");
    titles.append(el("div", `lv-tier ${tierClass}`, subtitle), el("div", "lv-title", title));
    const done = this.progress.completedCount;
    const ring = el("div", "lv-ring");
    const total = this.catalog.lessons.length;
    ring.style.setProperty("--lv-ring", `${Math.round((done / total) * 100)}%`);
    ring.append(el("b", "", `${done}`), el("span", "", `/${total}`));
    ring.title = `${done} of ${total} modules complete`;
    const right = el("div", "lv-header-right");
    right.append(ring, button("Close (Esc)", () => this.close()));
    header.append(titles, right);
    const body = el("div", "lv-body");
    const footer = el("div", "lv-footer", "Progress is saved on this device only — never on the server, never linked to your nickname or a wallet.");
    this.panel.append(header, body, footer);
    return body;
  }

  private renderLocked(lesson: Lesson): void {
    const body = this.frame(lesson.title, `${tierLabel(this.catalog, lesson.tier)} · ${zoneLabel(this.catalog, lesson.zone)}`, `lv-tier-${lesson.tier}`);
    body.append(el("p", "lv-summary", lesson.summary), el("div", "lv-subtitle", "🔒 Complete these first"));
    const list = el("div", "lv-requirements");
    for (const id of lesson.requires) {
      const required = lessonById(this.catalog, id);
      if (!required) continue;
      const complete = this.progress.isComplete(id);
      const row = el("div", `lv-req ${complete ? "lv-done" : ""}`);
      row.append(el("span", "lv-req-icon", complete ? "✓" : "○"), el("span", "lv-req-title", required.title), el("span", "lv-req-zone", `📍 ${zoneLabel(this.catalog, required.zone)}`));
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  private stepsOf(lesson: Lesson): Step[] {
    return ["learn", ...(lesson.see ? (["see"] as Step[]) : []), ...(lesson.try ? (["try"] as Step[]) : []), "prove"];
  }

  private proveLocked(lesson: Lesson): boolean {
    return Boolean(lesson.try) && !this.progress.hasPracticed(lesson.id);
  }

  private renderLesson(lesson: Lesson, step: Step): void {
    const body = this.frame(lesson.title, `${tierLabel(this.catalog, lesson.tier)} · ${zoneLabel(this.catalog, lesson.zone)}`, `lv-tier-${lesson.tier}`);
    const record = this.progress.record(lesson.id);
    const metaRow = el("div", "lv-meta");
    metaRow.append(
      el("span", "lv-chip-static", `Difficulty ${"●".repeat(lesson.meta.difficulty)}${"○".repeat(5 - lesson.meta.difficulty)}`),
      el("span", "lv-chip-static", lesson.meta.requiresWallet ? "Wallet needed" : "No wallet needed"),
      el("span", "lv-chip-static", lesson.meta.usesRealFunds ? "⚠ Real funds" : "No real funds"),
    );
    if (record) metaRow.appendChild(el("span", "lv-verified", `✓ ${VERIFIED_LABEL[record.kind]}`));

    // Stepper: LEARN → SEE → TRY → PROVE, with done / locked states.
    const steps = this.stepsOf(lesson);
    const stepper = el("div", "lv-stepper");
    steps.forEach((id, i) => {
      const locked = id === "prove" && this.proveLocked(lesson) && !record;
      const done = Boolean(record) || (id === "try" && this.progress.hasPracticed(lesson.id)) || steps.indexOf(step) > i;
      const tab = button("", () => {
        if (locked) return this.flash(stepper, "Finish the TRY task to unlock PROVE.");
        this.renderLesson(lesson, id);
      }, `lv-tab lv-step ${id === step ? "active" : ""} ${done ? "lv-step-done" : ""} ${locked ? "lv-step-locked" : ""}`);
      tab.append(el("span", "lv-step-icon", locked ? "🔒" : done && id !== step ? "✓" : STEP_INFO[id].icon), el("span", "lv-step-label", STEP_INFO[id].label), el("span", "lv-step-hint", STEP_INFO[id].hint));
      stepper.appendChild(tab);
      if (i < steps.length - 1) stepper.appendChild(el("span", `lv-step-line ${done ? "lv-step-line-done" : ""}`));
    });
    const content = el("div", "lv-content lv-fade");
    body.append(el("p", "lv-summary", lesson.summary), metaRow, stepper, content);

    const nextStep = steps[steps.indexOf(step) + 1];
    const goNext = (): void => {
      if (nextStep) this.renderLesson(lesson, nextStep);
    };

    if (step === "learn") {
      const cards = el("div", "lv-learn");
      lesson.learn.forEach((paragraph, i) => {
        const card = el("div", "lv-learn-card");
        card.append(el("span", "lv-learn-num", String(i + 1)), el("p", "lv-paragraph", paragraph));
        cards.appendChild(card);
      });
      content.appendChild(cards);
      if (lesson.wiki) content.appendChild(button("Read more: ZecHub wiki (Community Hub)", () => this.openCommunity("wiki"), "zw-button lv-small"));
      const source = el("div", "lv-source");
      const link = el("a", "", lesson.meta.source.name);
      link.href = lesson.meta.source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      source.append("Source: ", link, ` · ${lesson.meta.version} · last checked ${lesson.meta.lastChecked}${lesson.meta.source.license ? ` · ${lesson.meta.source.license}` : ""}`);
      content.appendChild(source);
    } else if (step === "see" || step === "try") {
      const id = step === "see" ? lesson.see! : lesson.try!;
      if (step === "try" && !record) content.appendChild(el("div", "lv-task-banner", lesson.prove.kind === "simulation" ? "🛠 Finish this task to complete the module." : "🛠 Finish this task to unlock PROVE."));
      const visualizer = this.visualizers[id];
      if (!visualizer) content.appendChild(el("p", "lv-hint", "This step is not available in this build."));
      else visualizer({
        host: content,
        client: this.client,
        openCommunity: this.openCommunity,
        reviewing: Boolean(record),
        ...(this.startStep !== undefined ? { startStep: this.startStep } : {}),
        state: {
          get: <T>() => this.progress.practiceState<T>(lesson.id),
          set: (value) => this.progress.setPracticeState(lesson.id, value),
        },
        complete: () => {
          if (step !== "try") return;
          const first = !this.progress.hasPracticed(lesson.id);
          this.progress.markPracticed(lesson.id);
          if (lesson.prove.kind === "simulation") this.finish(lesson);
          else if (first && !this.progress.isComplete(lesson.id)) {
            stepper.querySelector(".lv-step-locked")?.classList.remove("lv-step-locked");
            const unlock = button("🏅 PROVE unlocked — take the check →", () => this.renderLesson(lesson, "prove"), "zw-button zw-button-primary lv-unlock");
            content.prepend(unlock);
          }
        },
      });
    } else {
      this.renderProof(lesson, content);
    }
    if (nextStep && step !== "prove" && !(nextStep === "prove" && this.proveLocked(lesson) && !record)) {
      content.appendChild(button(`Continue: ${STEP_INFO[nextStep].label} →`, goNext, "zw-button zw-button-primary lv-continue"));
    }
  }

  private flash(host: HTMLElement, text: string): void {
    host.parentElement?.querySelector(".lv-flash")?.remove();
    const note = el("div", "lv-flash", text);
    host.after(note);
    window.setTimeout(() => note.remove(), 2400);
  }

  private renderProof(lesson: Lesson, content: HTMLElement): void {
    const record = this.progress.record(lesson.id);
    if (record) content.appendChild(el("div", "lv-feedback lv-feedback-ok", `✓ Completed — ${VERIFIED_LABEL[record.kind]}. You can still review every step.`));
    const proof = lesson.prove;
    if (proof.kind === "simulation") {
      if (!record) content.appendChild(el("p", "lv-paragraph", "This module is proven by doing: finish the TRY task and it is verified automatically."));
      return;
    }
    if (proof.kind === "read") {
      content.appendChild(button("I have read this module", () => this.finish(lesson), "zw-button zw-button-primary"));
      return;
    }
    const draw = Math.min(proof.draw ?? proof.questions.length, proof.questions.length);
    const pass = Math.min(proof.pass ?? draw, draw);
    const wait = this.progress.cooldownLeft(lesson.id, lesson.tier === "quiz" ? COOLDOWN.gate : COOLDOWN.lesson);
    if (wait > 0 && !record) {
      const box = el("div", "lv-cooldown");
      const count = el("b", "", `${wait}s`);
      box.append(el("div", "", "Take a moment — review LEARN, then try a fresh set of questions."), count);
      content.appendChild(box);
      content.appendChild(button("Review LEARN", () => this.renderLesson(lesson, "learn"), "zw-button"));
      this.cooldownTimer = window.setInterval(() => {
        const left = this.progress.cooldownLeft(lesson.id, lesson.tier === "quiz" ? COOLDOWN.gate : COOLDOWN.lesson);
        count.textContent = `${left}s`;
        if (left <= 0) this.renderLesson(lesson, "prove");
      }, 500);
      return;
    }
    this.renderQuiz(lesson, shuffled(proof.questions).slice(0, draw), pass, content);
  }

  private renderQuiz(lesson: Lesson, questions: readonly QuizQuestion[], pass: number, content: HTMLElement): void {
    const form = el("div", "lv-quiz");
    const picks: (number | null)[] = questions.map(() => null);
    const orders = questions.map((question) => shuffled(question.options.map((_, i) => i)));
    const counter = el("div", "lv-quiz-counter", `0/${questions.length} answered · pass ${pass}`);
    questions.forEach((question, qi) => {
      const block = el("div", "lv-question");
      block.appendChild(el("div", "lv-question-text", `${qi + 1}. ${question.question}`));
      orders[qi]!.forEach((optionIndex, position) => {
        const option = button("", () => {
          picks[qi] = optionIndex;
          block.querySelectorAll(".lv-option").forEach((node) => node.classList.remove("selected"));
          option.classList.add("selected");
          counter.textContent = `${picks.filter((pick) => pick !== null).length}/${questions.length} answered · pass ${pass}`;
        }, "lv-option");
        option.append(el("span", "lv-option-letter", "ABCD"[position] ?? "•"), el("span", "lv-option-text", question.options[optionIndex]!));
        block.appendChild(option);
      });
      form.appendChild(block);
    });
    const result = el("div", "lv-feedback");
    const submit = button("Submit answers", () => {
      if (picks.some((pick) => pick === null)) {
        result.className = "lv-feedback lv-feedback-bad";
        result.textContent = "Answer every question first.";
        return;
      }
      let correct = 0;
      form.querySelectorAll(".lv-question").forEach((block, qi) => {
        const question = questions[qi]!;
        const right = picks[qi] === question.answer;
        if (right) correct++;
        block.classList.toggle("lv-right", right);
        block.classList.toggle("lv-wrong", !right);
        block.querySelectorAll(".lv-option").forEach((node) => ((node as HTMLButtonElement).disabled = true));
        block.querySelector(".lv-explain")?.remove();
        // Explanations only for answers you got right — a wrong answer is not handed the solution.
        block.appendChild(el("div", "lv-explain", right ? `✓ ${question.explain}` : "✗ Not quite — the answer is in this station's LEARN cards."));
      });
      if (correct >= pass) {
        result.className = "lv-feedback lv-feedback-ok";
        result.textContent = `✓ ${correct}/${questions.length} — passed.`;
        submit.remove();
        this.finish(lesson);
      } else {
        this.progress.recordFailure(lesson.id);
        result.className = "lv-feedback lv-feedback-bad";
        result.textContent = `${correct}/${questions.length} — you need ${pass}. Review LEARN; a new set of questions is ready after a short pause.`;
        submit.textContent = "Try a new set";
        submit.onclick = () => this.renderLesson(lesson, "prove");
      }
    }, "zw-button zw-button-primary");
    content.append(counter, form, submit, result);
  }

  private finish(lesson: Lesson): void {
    if (this.progress.isComplete(lesson.id)) return;
    this.progress.complete(lesson.id, lesson.verification);
    const banner = el("div", "lv-celebrate");
    const confetti = el("div", "lv-confetti");
    for (let i = 0; i < 18; i++) {
      const piece = el("i");
      piece.style.left = `${(i * 37) % 100}%`;
      piece.style.animationDelay = `${(i % 6) * 0.08}s`;
      piece.style.background = ["#f6c560", "#7fd36a", "#5fb4ff", "#c49bff", "#ff8fc8"][i % 5]!;
      confetti.appendChild(piece);
    }
    banner.append(confetti, el("div", "lv-celebrate-title", `✓ ${VERIFIED_LABEL[lesson.verification]}`), el("div", "lv-celebrate-sub", lesson.title));
    const unlocked = this.catalog.lessons.filter((other) => other.requires.includes(lesson.id) && this.progress.isUnlocked(other) && !this.progress.isComplete(other.id));
    if (unlocked.length > 0) banner.appendChild(el("div", "lv-celebrate-unlock", `Unlocked: ${unlocked.map((other) => `${other.title} (📍 ${zoneLabel(this.catalog, other.zone)})`).join(", ")}`));
    this.panel.querySelector(".lv-body")?.prepend(banner);
    const ring = this.panel.querySelector<HTMLElement>(".lv-ring");
    if (ring) {
      const done = this.progress.completedCount;
      ring.style.setProperty("--lv-ring", `${Math.round((done / this.catalog.lessons.length) * 100)}%`);
      ring.querySelector("b")!.textContent = String(done);
    }
  }

  private renderDirectory(tier?: Tier): void {
    const body = this.frame(tier ? tierLabel(this.catalog, tier) : "Learning Valley", "Learning Valley · Journey", tier ? `lv-tier-${tier}` : "lv-tier-quiz");
    const tabs = el("div", "lv-tabs");
    tabs.appendChild(button("All", () => this.renderDirectory(), `lv-tab ${tier ? "" : "active"}`));
    for (const id of Object.keys(this.catalog.tierLabels) as Tier[]) tabs.appendChild(button(tierLabel(this.catalog, id), () => this.renderDirectory(id), `lv-tab ${tier === id ? "active" : ""}`));
    body.append(el("p", "lv-summary", this.catalog.directoryIntro), tabs);
    const lessons = this.catalog.lessons.filter((candidate) => !tier || candidate.tier === tier);
    const zones = [...new Set(lessons.map((lesson) => lesson.zone))];
    for (const zone of zones) {
      const inZone = lessons.filter((lesson) => lesson.zone === zone);
      const doneCount = inZone.filter((lesson) => this.progress.isComplete(lesson.id)).length;
      const section = el("div", "lv-zone");
      const head = el("div", "lv-zone-head");
      const bar = el("div", "lv-progress");
      const fill = el("div", "lv-progress-fill");
      fill.style.width = `${Math.round((doneCount / inZone.length) * 100)}%`;
      bar.appendChild(fill);
      head.append(el("b", "", `📍 ${zoneLabel(this.catalog, zone)}`), el("span", "lv-small-text", `${doneCount}/${inZone.length}`));
      section.append(head, bar);
      const list = el("div", "lv-directory");
      for (const lesson of inZone) {
        const record = this.progress.record(lesson.id);
        const unlocked = this.progress.isUnlocked(lesson);
        const row = el("div", `lv-dir-row ${record ? "lv-done" : unlocked ? "" : "lv-locked"}`);
        row.append(
          el("span", "lv-dir-icon", record ? "✓" : unlocked ? "▶" : "🔒"),
          el("span", "lv-dir-title", lesson.title),
          el("span", "lv-dir-meta", record ? VERIFIED_LABEL[record.kind] : unlocked ? (this.progress.hasPracticed(lesson.id) ? "Practised · PROVE open" : "Ready") : `Needs: ${lesson.requires.filter((id) => !this.progress.isComplete(id)).map((id) => lessonById(this.catalog, id)?.title ?? id).join(", ")}`),
        );
        list.appendChild(row);
      }
      section.appendChild(list);
      body.appendChild(section);
    }
    const upcoming = this.catalog.upcoming.filter((candidate) => !tier || candidate.tier === tier);
    if (upcoming.length) {
      const section = el("div", "lv-zone");
      section.appendChild(el("div", "lv-zone-head", "◇ Planned"));
      const list = el("div", "lv-directory");
      for (const item of upcoming) {
        const row = el("div", "lv-dir-row lv-upcoming");
        row.append(el("span", "lv-dir-icon", "◇"), el("span", "lv-dir-title", item.title), el("span", "lv-dir-meta", `Planned · ${item.phase}`));
        list.appendChild(row);
      }
      section.appendChild(list);
      body.appendChild(section);
    }
  }
}

let stylesInjected = false;
function injectLearningStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.lv-backdrop { position: absolute; inset: 0; z-index: 20; display: none; align-items: center; justify-content: center; background: radial-gradient(circle at 50% 40%, rgba(80,60,140,0.35), rgba(6,6,18,0.78) 65%); }
.lv-backdrop.visible { display: flex; }
.lv-panel { width: min(980px, 95vw); height: min(800px, 92vh); display: flex; flex-direction: column; padding: 0; overflow: hidden;
  background: linear-gradient(180deg, rgba(26,30,72,0.98), rgba(14,16,40,0.98)); border: 2px solid rgba(231,183,90,0.85); box-shadow: 0 0 70px rgba(150,120,255,0.25); color: #ece6f6; }
.lv-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid rgba(231,183,90,0.35); }
.lv-title { font: 700 24px Georgia, "Times New Roman", serif; color: #f6e3b4; }
.lv-tier { font: 700 11px "Segoe UI", system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: #e7b75a; }
.lv-tier-beginner { color: #8fe08f; } .lv-tier-intermediate { color: #7fc8ff; } .lv-tier-advanced { color: #c49bff; } .lv-tier-expert { color: #ffcf6a; } .lv-tier-quiz { color: #ff9ed1; }
.lv-body { flex: 1; overflow-y: auto; padding: 14px 22px 18px; }
.lv-footer { padding: 9px 20px; border-top: 1px solid rgba(231,183,90,0.25); font-size: 12px; color: #b8aed0; }
.lv-summary { margin: 0 0 10px; color: #d6cceb; font-size: 14px; }
.lv-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.lv-chip-static { padding: 3px 10px; border-radius: 999px; background: rgba(255,255,255,0.06); border: 1px solid rgba(231,183,90,0.25); font-size: 12px; color: #ddd2ef; }
.lv-verified { padding: 3px 10px; border-radius: 999px; background: rgba(110,220,140,0.18); border: 1px solid rgba(110,220,140,0.6); font: 700 12px "Segoe UI", sans-serif; color: #b8f5c8; }
.lv-tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.lv-tab { padding: 7px 16px; border-radius: 10px; border: 1px solid rgba(231,183,90,0.3); background: rgba(255,255,255,0.05); color: #e8dff5; font: 700 13px "Segoe UI", sans-serif; letter-spacing: 0.06em; cursor: pointer; }
.lv-tab.active { background: rgba(231,183,90,0.25); border-color: rgba(231,183,90,0.85); color: #fff3d6; }
.lv-content { display: flex; flex-direction: column; gap: 10px; }
.lv-paragraph { margin: 0; line-height: 1.6; font-size: 15px; color: #ece6f6; }
.lv-source { font-size: 12px; color: #a99fc4; } .lv-source a, .lv-wiki a { color: #f2b440; }
.lv-continue { align-self: flex-start; margin-top: 6px; }
.lv-hint { margin: 0; color: #c9bfe0; font-size: 13px; }
.lv-subtitle { font: 700 13px "Segoe UI", sans-serif; color: #e7b75a; margin-top: 4px; }
.lv-small, .lv-small-text { font-size: 12px; }
.lv-feedback { min-height: 18px; font-size: 13px; padding: 6px 10px; border-radius: 8px; }
.lv-feedback:empty { display: none; }
.lv-feedback-ok { background: rgba(110,220,140,0.14); color: #b8f5c8; } .lv-feedback-bad { background: rgba(255,110,110,0.14); color: #ffc0c0; } .lv-feedback-info { background: rgba(127,200,255,0.12); color: #cfe8ff; }
.lv-celebrate { margin-bottom: 12px; padding: 12px 16px; border-radius: 12px; background: linear-gradient(90deg, rgba(231,183,90,0.35), rgba(150,120,255,0.25)); border: 1px solid rgba(231,183,90,0.8); font: 700 15px "Segoe UI", sans-serif; color: #fff3d6; }
.lv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.lv-card { padding: 12px; border-radius: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(231,183,90,0.25); }
.lv-card-value { font: 800 26px Georgia, serif; color: #f6c560; } .lv-card-label { font-weight: 700; margin: 2px 0; } .lv-card-text { font-size: 12px; color: #c9bfe0; }
.lv-toggle, .lv-actions, .lv-steps { display: flex; gap: 6px; flex-wrap: wrap; }
.lv-chip { padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(231,183,90,0.35); background: rgba(255,255,255,0.05); color: #e8dff5; cursor: pointer; font: 600 12px "Segoe UI", sans-serif; }
.lv-chip.active { background: rgba(231,183,90,0.3); border-color: #e7b75a; color: #fff; } .lv-chip-done { border-color: rgba(110,220,140,0.7); } .lv-chip:disabled { opacity: 0.45; cursor: default; }
.lv-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lv-tx { padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.lv-tx-transparent { background: rgba(255,170,90,0.08); border: 1px solid rgba(255,170,90,0.45); } .lv-tx-shielded { background: rgba(120,140,255,0.1); border: 1px solid rgba(140,150,255,0.55); }
.lv-tx-title { font: 700 14px "Segoe UI", sans-serif; margin-bottom: 4px; }
.lv-tx-row { display: flex; justify-content: space-between; gap: 8px; } .lv-tx-label { color: #b8aed0; } .lv-hidden .lv-tx-value { color: #8f86ff; font-family: ui-monospace, Consolas, monospace; }
.lv-tx-note { margin-top: 6px; font-size: 12px; color: #c9bfe0; }
.lv-chain { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.lv-block { padding: 10px; border-radius: 10px; display: flex; flex-direction: column; gap: 4px; }
.lv-block-ok { background: rgba(110,220,140,0.08); border: 1px solid rgba(110,220,140,0.5); } .lv-block-bad { background: rgba(255,110,110,0.1); border: 1px solid rgba(255,110,110,0.6); }
.lv-block-title { font-weight: 700; }
.lv-input { background: rgba(0,0,0,0.35); border: 1px solid rgba(231,183,90,0.35); color: #fff; border-radius: 8px; padding: 6px 8px; font: 13px "Segoe UI", sans-serif; }
.lv-input-wide { width: 100%; box-sizing: border-box; font-size: 15px; }
.lv-mono { font: 12px ui-monospace, Consolas, monospace; color: #cfc6e8; overflow-wrap: anywhere; }
.lv-hash { font-size: 14px; letter-spacing: 0.03em; } .lv-changed { color: #ffb44a; font-weight: 700; }
.lv-scenario { font-weight: 700; color: #fff3d6; }
.lv-keytree { display: flex; flex-direction: column; gap: 6px; }
.lv-keynode { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 12px; border-radius: 10px; border: 1px solid rgba(231,183,90,0.3); background: rgba(255,255,255,0.05); color: #ece6f6; cursor: pointer; text-align: left; max-width: 520px; font: 13px "Segoe UI", sans-serif; }
.lv-keynode span { font-size: 12px; color: #c0b6da; }
.lv-right { border-color: rgba(110,220,140,0.85) !important; background: rgba(110,220,140,0.12) !important; } .lv-wrong { border-color: rgba(255,110,110,0.85) !important; background: rgba(255,110,110,0.1) !important; }
.lv-row { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; }
.lv-phone { width: 270px; padding: 14px; border-radius: 22px; background: #0b0d1f; border: 2px solid rgba(231,183,90,0.5); display: flex; flex-direction: column; gap: 6px; }
.lv-phone-net { align-self: flex-start; padding: 2px 8px; border-radius: 6px; background: #2d6a3a; color: #d8ffe0; font: 700 11px "Segoe UI", sans-serif; letter-spacing: 0.1em; }
.lv-phone-balance { font: 800 26px Georgia, serif; color: #f6c560; }
.lv-review { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.lv-missions li.lv-done, .lv-requirements li.lv-done, .lv-checklist li.lv-done { color: #9fe8b2; } .lv-missions li.lv-done::after, .lv-checklist li.lv-done::after { content: " ✓"; }
.lv-block-button { display: block; width: 100%; text-align: left; margin-top: 4px; }
.lv-pools { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.lv-pool { padding: 12px; border-radius: 12px; background: rgba(255,170,90,0.08); border: 1px solid rgba(255,170,90,0.45); text-align: center; }
.lv-pool-shielded { background: rgba(120,140,255,0.1); border-color: rgba(140,150,255,0.55); }
.lv-pool-title { font-weight: 700; } .lv-pool-value { font: 800 22px Georgia, serif; color: #f6c560; margin: 4px 0; }
.lv-log { margin: 0; padding-left: 20px; font-size: 13px; color: #ddd2ef; display: flex; flex-direction: column; gap: 3px; }
.lv-step-body { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(231,183,90,0.2); }
.lv-step-body p { margin: 0; line-height: 1.55; }
.lv-tree { display: flex; flex-direction: column; gap: 6px; align-items: center; }
.lv-tree-row { display: flex; gap: 10px; } .lv-tree-node { min-width: 26px; padding: 2px 6px; text-align: center; border-radius: 6px; background: rgba(255,255,255,0.08); font-size: 12px; }
.lv-tree-node.lv-path { background: rgba(231,183,90,0.6); color: #1b1300; }
.lv-progress { height: 10px; border-radius: 6px; background: rgba(255,255,255,0.08); overflow: hidden; } .lv-progress-fill { height: 100%; width: 0; background: linear-gradient(90deg, #e7b75a, #b48cff); transition: width 0.15s; }
.lv-scenario-box { display: flex; flex-direction: column; gap: 6px; } .lv-scenario-box p { margin: 0; }
.lv-mission-list { display: flex; flex-direction: column; gap: 8px; }
.lv-mission { padding: 10px 12px; border-radius: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(231,183,90,0.2); display: flex; flex-direction: column; gap: 4px; }
.lv-mission-live { border-color: rgba(127,200,255,0.5); }
.lv-mission-title { font-weight: 700; }
.lv-badge { align-self: flex-start; padding: 2px 8px; border-radius: 999px; font: 700 11px "Segoe UI", sans-serif; }
.lv-badge-pending { background: rgba(255,200,90,0.15); color: #ffd98a; } .lv-badge-live { background: rgba(127,200,255,0.18); color: #cfe8ff; }
.lv-explorer { margin: 0; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.45); font: 12px ui-monospace, Consolas, monospace; color: #cfe8ff; white-space: pre-wrap; }
.lv-map { width: 100%; max-height: 320px; } .lv-map text { fill: #ece6f6; font: 600 11px "Segoe UI", sans-serif; pointer-events: none; }
.lv-map rect { fill: rgba(40,44,100,0.9); stroke: rgba(231,183,90,0.6); stroke-width: 1.5; cursor: pointer; } .lv-node.active rect { fill: rgba(231,183,90,0.45); stroke: #ffd98a; }
.lv-edge { stroke: rgba(200,190,255,0.25); stroke-width: 2; } .lv-edge.active { stroke: #ffd98a; stroke-width: 3; }
.lv-quiz { display: flex; flex-direction: column; gap: 10px; }
.lv-question { padding: 10px 12px; border-radius: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(231,183,90,0.2); display: flex; flex-direction: column; gap: 5px; }
.lv-question-text { font-weight: 700; }
.lv-option { text-align: left; padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #ece6f6; cursor: pointer; font: 13px "Segoe UI", sans-serif; }
.lv-option.selected { border-color: #e7b75a; background: rgba(231,183,90,0.2); }
.lv-explain { font-size: 12px; color: #d6cceb; }
.lv-wiki { max-height: 420px; overflow-y: auto; padding: 10px; border-radius: 10px; background: rgba(0,0,0,0.25); }
.lv-wiki-prose { font-size: 14px; }
.lv-requirements { margin: 0; padding-left: 20px; }
.lv-directory { display: flex; flex-direction: column; gap: 6px; }
.lv-dir-row { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; align-items: center; padding: 9px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(231,183,90,0.18); }
.lv-dir-row.lv-done { border-color: rgba(110,220,140,0.55); } .lv-dir-row.lv-locked, .lv-dir-row.lv-upcoming { opacity: 0.6; }
.lv-dir-icon { text-align: center; } .lv-dir-title { font-weight: 700; } .lv-dir-meta { font-size: 12px; color: #c0b6da; text-align: right; }

/* ---- Lesson view: stepper, ring, cards, quiz, celebration, journey ---- */
.lv-header-right { display: flex; align-items: center; gap: 12px; }
.lv-ring { --lv-ring: 0%; width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; position: relative;
  background: conic-gradient(#e7b75a var(--lv-ring), rgba(255,255,255,0.1) 0); font: 800 14px "Segoe UI", sans-serif; color: #fff3d6; }
.lv-ring::before { content: ""; position: absolute; inset: 5px; border-radius: 50%; background: #171a40; }
.lv-ring b, .lv-ring span { position: relative; } .lv-ring span { font-size: 9px; color: #b8aed0; margin-top: 12px; position: absolute; }
.lv-ring b { margin-top: -6px; }
.lv-stepper { display: flex; align-items: center; gap: 0; margin: 4px 0 14px; }
.lv-step { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; padding: 8px 14px; min-width: 110px; text-align: left;
  border-radius: 12px; transition: transform 0.12s ease, background 0.15s ease; }
.lv-step:hover { transform: translateY(-1px); }
.lv-step-icon { grid-row: span 2; font-size: 20px; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; background: rgba(255,255,255,0.08); }
.lv-step-label { font-weight: 800; letter-spacing: 0.06em; } .lv-step-hint { font: 500 11px "Segoe UI", sans-serif; color: #b8aed0; letter-spacing: 0; }
.lv-step-done .lv-step-icon { background: rgba(110,220,140,0.25); color: #b8f5c8; }
.lv-step.active .lv-step-icon { background: #e7b75a; color: #1b1300; box-shadow: 0 0 14px rgba(231,183,90,0.6); }
.lv-step-locked { opacity: 0.55; cursor: not-allowed; }
.lv-step-line { flex: 1; min-width: 14px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.12); margin: 0 4px; }
.lv-step-line-done { background: linear-gradient(90deg, #7fd36a, #e7b75a); }
.lv-flash { margin: -6px 0 10px; padding: 6px 10px; border-radius: 8px; background: rgba(255,200,90,0.14); color: #ffd98a; font-size: 13px; }
.lv-fade { animation: lv-fade 0.22s ease; } @keyframes lv-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.lv-learn { display: flex; flex-direction: column; gap: 10px; }
.lv-learn-card { display: grid; grid-template-columns: 30px 1fr; gap: 12px; padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.045); border: 1px solid rgba(231,183,90,0.18); }
.lv-learn-num { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: rgba(231,183,90,0.22); color: #ffe2a0; font: 800 13px "Segoe UI", sans-serif; }
.lv-task-banner { padding: 9px 12px; border-radius: 10px; background: rgba(127,200,255,0.1); border: 1px dashed rgba(127,200,255,0.5); color: #cfe8ff; font-size: 13px; }
.lv-unlock { align-self: flex-start; animation: lv-pulse 1.4s ease-in-out infinite; }
@keyframes lv-pulse { 0%, 100% { box-shadow: 0 0 0 rgba(231,183,90,0); } 50% { box-shadow: 0 0 18px rgba(231,183,90,0.7); } }
.lv-cooldown { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; background: rgba(255,170,90,0.1); border: 1px solid rgba(255,170,90,0.4); }
.lv-cooldown b { font: 800 26px Georgia, serif; color: #ffcf8a; }
.lv-quiz-counter { font-size: 12px; color: #b8aed0; }
.lv-option { display: flex; align-items: center; gap: 10px; transition: background 0.12s ease, border-color 0.12s ease; }
.lv-option:hover:not(:disabled) { border-color: rgba(231,183,90,0.6); }
.lv-option-letter { flex: none; width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; background: rgba(255,255,255,0.08); font: 800 12px "Segoe UI", sans-serif; color: #e7b75a; }
.lv-option.selected .lv-option-letter { background: #e7b75a; color: #1b1300; }
.lv-celebrate { position: relative; overflow: hidden; text-align: center; padding: 16px; }
.lv-celebrate-title { font: 800 18px "Segoe UI", sans-serif; letter-spacing: 0.06em; } .lv-celebrate-sub { font: 700 16px Georgia, serif; color: #ffe9b8; }
.lv-celebrate-unlock { margin-top: 6px; font: 600 13px "Segoe UI", sans-serif; color: #d9f7e1; }
.lv-confetti { position: absolute; inset: 0; pointer-events: none; }
.lv-confetti i { position: absolute; top: -10px; width: 7px; height: 12px; border-radius: 2px; animation: lv-drop 1.4s ease-in forwards; opacity: 0.9; }
@keyframes lv-drop { to { transform: translateY(110px) rotate(260deg); opacity: 0; } }
.lv-zone { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.lv-zone-head { display: flex; justify-content: space-between; align-items: baseline; color: #f6e3b4; }
.lv-requirements { display: flex; flex-direction: column; gap: 6px; }
.lv-req { display: grid; grid-template-columns: 24px 1fr auto; gap: 8px; padding: 8px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(231,183,90,0.2); }
.lv-req.lv-done { border-color: rgba(110,220,140,0.55); color: #b8f5c8; } .lv-req-zone { font-size: 12px; color: #c0b6da; }
/* simulators */
.lv-layers .lv-chip { font-size: 12px; }
.lv-layer-focus { outline: 2px solid #e7b75a; outline-offset: 2px; border-radius: 6px; background: rgba(231,183,90,0.12); } .lv-layer-dim { opacity: 0.45; }
.lv-coins, .lv-claims { display: flex; flex-wrap: wrap; gap: 8px; }
.lv-coin { padding: 10px 14px; border-radius: 999px; border: 2px solid rgba(246,197,96,0.5); background: radial-gradient(circle at 35% 30%, rgba(246,197,96,0.35), rgba(120,80,20,0.25)); color: #ffe7b0; font: 800 13px "Segoe UI", sans-serif; cursor: pointer; }
.lv-coin.active { border-color: #ffd98a; box-shadow: 0 0 12px rgba(246,197,96,0.6); }
.lv-coin:disabled { opacity: 0.5; cursor: default; }
.lv-claim { padding: 8px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.25); color: #ece6f6; cursor: pointer; text-align: left; font: 13px "Segoe UI", sans-serif; }
.lv-claim.active { border-color: #7fd36a; background: rgba(110,220,140,0.16); }
.lv-mini-chain { display: flex; gap: 8px; align-items: center; }
.lv-mini-block { width: 74px; height: 46px; border-radius: 8px; display: grid; place-items: center; font: 700 11px "Segoe UI", sans-serif; color: #8f86b8; border: 1px dashed rgba(255,255,255,0.2); transition: all 0.25s ease; }
.lv-mini-filled { color: #fff3d6; border: 1px solid rgba(231,183,90,0.7); background: rgba(231,183,90,0.15); } .lv-mini-mine { background: rgba(110,220,140,0.22); border-color: #7fd36a; }
.lv-address { padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.35); font-size: 13px; }
.lv-seed { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.lv-seed-word { padding: 8px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(231,183,90,0.3); font: 600 13px ui-monospace, Consolas, monospace; }
.lv-seed-hidden { grid-column: 1 / -1; padding: 16px; text-align: center; border-radius: 10px; background: rgba(0,0,0,0.35); color: #c9bfe0; }
.lv-message { padding: 10px 12px; border-radius: 10px; background: rgba(0,0,0,0.3); border-left: 3px solid #e7b75a; font-size: 14px; }
.lv-pool-controls { align-items: center; }
.lv-ua { display: flex; flex-direction: column; gap: 8px; }
.lv-ua-parts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.lv-ua-part { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px; background: rgba(120,140,255,0.1); border: 1px solid rgba(140,150,255,0.4); }
.lv-network { display: flex; gap: 8px; }
.lv-node-card { flex: 1; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); transition: all 0.25s ease; }
.lv-node-ok { border-color: #7fd36a; background: rgba(110,220,140,0.14); }
.lv-walk { padding: 10px 14px; border-radius: 10px; background: linear-gradient(90deg, rgba(231,183,90,0.3), rgba(150,120,255,0.2)); border: 1px solid rgba(231,183,90,0.8); font: 700 15px "Segoe UI", sans-serif; color: #fff3d6; animation: lv-pulse 1.4s ease-in-out infinite; }
.lv-locked-step { font: 800 18px Georgia, serif; color: #ffd98a; } .lv-review-note { color: #b8aed0; }
.lv-risk { width: 100%; max-height: 260px; } .lv-risk text { fill: #ece6f6; font: 600 12px "Segoe UI", sans-serif; pointer-events: none; }
.lv-risk-edge { stroke: rgba(255,170,90,0.8); stroke-width: 2.5; transition: all 0.2s; } .lv-risk-hidden { stroke: rgba(140,150,255,0.25); stroke-dasharray: 4 6; }
.lv-risk-node rect { fill: rgba(255,170,90,0.18); stroke: rgba(255,170,90,0.8); cursor: pointer; } .lv-risk-sensitive rect { stroke-width: 2.5; }
.lv-risk-shielded rect { fill: rgba(120,140,255,0.2); stroke: rgba(140,150,255,0.8); }
.lv-risk-you { fill: rgba(231,183,90,0.35); stroke: #e7b75a; stroke-width: 2; }
.lv-levels { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.lv-level { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(231,183,90,0.3); background: rgba(255,255,255,0.05); color: #ece6f6; cursor: pointer; text-align: left; font: 13px "Segoe UI", sans-serif; }
.lv-level span { font-size: 12px; color: #c0b6da; } .lv-level.active { border-color: #e7b75a; background: rgba(231,183,90,0.2); } .lv-level-done b { color: #9fe8b2; }
.lv-badge-sample { background: rgba(200,200,200,0.15); color: #e6e0f2; }
.lv-mission-ticked { border-color: rgba(110,220,140,0.45); }
@media (max-width: 760px) { .lv-stepper { flex-wrap: wrap; gap: 6px; } .lv-step-line { display: none; } .lv-levels, .lv-ua-parts, .lv-seed { grid-template-columns: 1fr 1fr; } }
@media (max-width: 640px) { .lv-columns, .lv-pools, .lv-chain { grid-template-columns: 1fr; } }
`;
  document.head.appendChild(style);
}
