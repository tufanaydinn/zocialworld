import {
  MOD_BAN_DURATIONS_MS,
  MOD_BAN_FOREVER,
  MOD_CONNECTION_KEY_MAX_MS,
  MOD_KICK_MS,
  MOD_MUTE_DURATIONS_MS,
  type ModAction,
  type ModActionError,
  type ModCloseReason,
  type ReportAckStatus,
  type ReportLocation,
  type ReportReason,
} from "@project/shared";

/**
 * The words the moderation UI uses (ADR-019) — reasons, places, durations, "until …", what an action
 * did and why one was refused. Pure functions (no DOM), so the wording is tested once and used everywhere.
 */

export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  spam: "Spam",
  harassment: "Harassment",
  impersonation: "Impersonation",
  scam: "Scam",
  inappropriate_share: "Inappropriate share",
  other: "Other",
};

export const LOCATION_LABELS: Readonly<Record<ReportLocation, string>> = {
  district: "District",
  valley: "Learning Valley",
  hall: "Watch Hall",
};

/** "10 min", "1 hour", "24 hours", "7 days"; null → "until lifted". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "until lifted";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/** The chat mutes a moderator can pick. */
export const MUTE_CHOICES: readonly { readonly ms: number; readonly label: string }[] = MOD_MUTE_DURATIONS_MS.map((ms) => ({ ms, label: formatDuration(ms) }));
/** The bans a moderator can pick (null: until lifted). */
export const BAN_CHOICES: readonly { readonly ms: number | null; readonly label: string }[] = [...MOD_BAN_DURATIONS_MS.map((ms) => ({ ms, label: formatDuration(ms) })), { ms: null, label: "Until lifted" }];

/** A clock time for `until`: "14:32" today, "Mon 14:32" within a week, else "12 Oct, 14:32". */
export function formatClock(until: number, now: number = Date.now()): string {
  const date = new Date(until);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  if (until - now < 6 * 24 * 60 * 60_000) return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

/** "until 14:32" — or "until a moderator lifts it". */
export function formatUntil(until: number, now: number = Date.now()): string {
  if (until >= MOD_BAN_FOREVER) return "until a moderator lifts it";
  return `until ${formatClock(until, now)}`;
}

/** What the reporter is told after sending (or trying to send) a report. */
export function reportAckText(status: ReportAckStatus, nickname: string): string {
  switch (status) {
    case "sent":
      return "Thanks — moderators were notified.";
    case "rate_limited":
      return "You've sent several reports in the last few minutes — please wait a little before reporting again.";
    case "unknown_player":
      return `${nickname} isn't online any more, so the report wasn't sent.`;
    case "self":
      return "You can't report yourself.";
    case "invalid":
      return "That note is too long — keep it under 280 characters.";
    case "unavailable":
      return "This server has no moderators set up, so reports can't be sent. You can still Block the player.";
  }
}

/** Why a moderator's action was refused. */
export function actionErrorText(error: ModActionError, target?: string): string {
  const who = target ?? "That player";
  switch (error) {
    case "not_moderator":
      return "Only moderators can do that.";
    case "unknown_player":
      return `${who} isn't online any more — act from their report instead.`;
    case "unknown_entry":
      return "That entry is gone already (it ran out or another moderator handled it).";
    case "invalid":
      return "That action wasn't accepted.";
    case "self":
      return "You can't moderate yourself.";
    case "moderator":
      return `${who} is a moderator — moderators can't act on each other (the operator removes a moderator by changing the keys).`;
  }
}

/** Clock skew allowed when telling a capped ban (24 h) from the chosen one (7 days or until lifted). */
const CAP_SKEW_MS = 60 * 60_000;

/**
 * The acting moderator's confirmation line. `durationMs`: what the moderator chose; `until`: when the server says it
 * really ends (mod_action_result.until). A guest — no owned name — is kept out by its network for at most 24 hours, so a
 * longer ban says so instead of repeating the chosen length.
 */
export function actionDoneText(action: ModAction, target: string | undefined, durationMs?: number | null, until?: number, now: number = Date.now()): string {
  const who = target ?? "the player";
  switch (action) {
    case "mute":
      if (until !== undefined) return `Muted ${who} ${formatUntil(until, now)}.`;
      return `Muted ${who}${durationMs ? ` for ${formatDuration(durationMs)}` : ""}.`;
    case "unmute":
      return `${who} can chat again.`;
    case "kick":
      return `Kicked ${who} — they can't come back for ${formatDuration(MOD_KICK_MS)}.`;
    case "ban": {
      const longer = durationMs === null || (durationMs !== undefined && durationMs > MOD_CONNECTION_KEY_MAX_MS);
      if (until !== undefined && longer && until - now <= MOD_CONNECTION_KEY_MAX_MS + CAP_SKEW_MS) {
        return `Banned ${who} ${formatUntil(until, now)} — without an owned name, a player is kept out by their network for at most 24 hours.`;
      }
      if (until !== undefined) return `Banned ${who} ${formatUntil(until, now)}.`;
      return durationMs === null ? `Banned ${who} until a moderator lifts it.` : `Banned ${who}${durationMs ? ` for ${formatDuration(durationMs)}` : ""}.`;
    }
    case "unban":
      return `${who} may come back now.`;
    case "dismiss_report":
      return `Report about ${who} dismissed.`;
  }
}

/** What a player whose connection the server closed on purpose is told (the full-screen notice). */
export function removedText(reason: ModCloseReason, until: number | null, now: number = Date.now()): { readonly title: string; readonly detail: string } {
  switch (reason) {
    case "kicked":
      return {
        title: "A moderator removed you from Zocial World",
        detail: until !== null ? `You can come back ${formatUntil(until, now).replace(/^until /, "at ")}.` : "You can come back in a few minutes.",
      };
    case "banned":
      return {
        title: "You're banned from this server",
        detail: until !== null ? (until >= MOD_BAN_FOREVER ? "The ban lasts until a moderator lifts it." : `The ban lasts ${formatUntil(until, now)}.`) : "A moderator banned you.",
      };
    case "too_many_connections":
      return {
        title: "Too many connections from your network",
        detail: "Close other Zocial World tabs or devices on this network, wait a minute, then try again.",
      };
  }
}

/** The muted player's chat line. */
export function mutedText(until: number, now: number = Date.now()): string {
  return `A moderator muted you ${formatUntil(until, now)} — your chat, whispers and hall chat aren't delivered. Voice still works.`;
}

/** A line the muted player sent anyway (the server answers it with the same notice): short, the rule was said once. */
export function mutedRepeatText(until: number, now: number = Date.now()): string {
  return `Not sent — you're muted ${formatUntil(until, now)}.`;
}
