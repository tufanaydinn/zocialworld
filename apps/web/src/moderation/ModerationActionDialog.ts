import { MOD_KICK_MS, type ModActionMessage } from "@project/shared";
import { BAN_CHOICES, MUTE_CHOICES, formatDuration } from "./format.ts";
import { button, choiceGroup, el, openModDialog, type ModDialogParts } from "./ui.ts";

/**
 * A moderator's Mute… / Kick / Ban… (ADR-019 § 3): the duration (mute, ban) or a confirmation (kick),
 * and what the action does, before anything is sent. The target is an online player (`targetId`) or a report's
 * target (`reportId`, also after they left); a report acted on is handled. The server answers with
 * `mod_action_result` (App shows it).
 */

export type ModerationVerb = "mute" | "kick" | "ban";

export interface ModerationTargetRef {
  readonly nickname: string;
  /** The online session, if any. */
  readonly playerId?: string | null;
  /** The report this action comes from, if any. */
  readonly reportId?: string;
}

export interface ModerationActionDialogOptions {
  readonly container: HTMLElement;
  readonly verb: ModerationVerb;
  readonly target: ModerationTargetRef;
  readonly send: (message: Omit<ModActionMessage, "type">) => void;
  readonly onClose: () => void;
}

export class ModerationActionDialog {
  private readonly parts: ModDialogParts;

  constructor(options: ModerationActionDialogOptions) {
    const { verb, target } = options;
    const titles: Record<ModerationVerb, string> = { mute: `Mute ${target.nickname}`, kick: `Kick ${target.nickname}`, ban: `Ban ${target.nickname}` };
    this.parts = openModDialog(options.container, `zw-mod-action-backdrop zw-mod-action-${verb}`, titles[verb], options.onClose);
    const panel = this.parts.panel;
    const text = el("p", "zw-mod-text");
    const note = el("p", "zw-mod-note");
    let duration: (() => number | null) | null = null;
    if (verb === "mute") {
      text.textContent = `${target.nickname}'s chat, whispers and hall chat won't be delivered, and they're told until when. Their voice isn't affected — kick for voice abuse.`;
      const group = choiceGroup("How long?", "zw-mod-mute", MUTE_CHOICES.map((choice) => ({ value: choice.ms, label: choice.label })), 0);
      duration = group.value;
      // A mute follows the network too — say who else it reaches (and who it doesn't).
      note.textContent =
        "An owned name is muted by its name. A guest, or a holder without an owned name, is muted by their network — so other players on it without an owned name are muted too; players there with their own owned name are not.";
      panel.append(text, group.element, note);
    } else if (verb === "ban") {
      text.textContent = `${target.nickname} is disconnected now and kept out, and told until when. Their stage turn, queue place, floor and vote end at once.`;
      const group = choiceGroup("How long?", "zw-mod-ban", BAN_CHOICES.map((choice) => ({ value: choice.ms, label: choice.label })), 0);
      duration = group.value;
      note.textContent =
        "An owned name is banned for the time you pick (24 hours or more is kept across restarts). Their network is kept out for at most 24 hours — a guest's only key — and everyone else on it is disconnected and can't connect during that time either (moderators stay connected). If that is your own network, don't reload: another moderator would have to lift it.";
      panel.append(text, group.element, note);
    } else {
      text.textContent = `${target.nickname} is disconnected now and can't come back for ${formatDuration(MOD_KICK_MS)}. Their stage turn, queue place, floor and vote end at once.`;
      note.textContent = "Everyone else on the same network (a household) is disconnected too and can't connect during those minutes (moderators stay connected).";
      panel.append(text, note);
    }
    const actions = el("div", "zw-mod-actions");
    const confirm = el("button", `zw-button ${verb === "mute" ? "zw-button-primary" : "zw-mod-danger"}`);
    confirm.type = "submit";
    confirm.textContent = verb === "mute" ? "Mute" : verb === "kick" ? "Kick" : "Ban";
    actions.append(confirm, button("Cancel", "Close without acting", () => this.close()));
    panel.append(actions);
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      const targetFields = {
        ...(target.playerId ? { targetId: target.playerId } : {}),
        ...(target.reportId !== undefined ? { reportId: target.reportId } : {}),
      };
      if (verb === "kick") options.send({ action: "kick", ...targetFields });
      else options.send({ action: verb, ...targetFields, durationMs: duration ? duration() : null });
      this.close();
    });
    confirm.focus();
  }

  close(): void {
    this.parts.close();
  }
}
