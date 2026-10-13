import type { HallErrorOp, HallErrorReason, HallStageState, HallVoteState } from "@project/shared";
import type { VoiceConnectionState } from "../voice/VoiceClient.ts";
import type { VoiceConnectionMode } from "../voice/hallAudio.ts";

/**
 * Pure decisions behind the Watch Hall stage (docs/architecture/WATCH_HALL.md):
 * what the local player's stage role is, when a local share must stop, what the
 * big screen says while no video shows, when the watch-mode button appears and what voice still
 * needs before a share can start. StageSystem applies them; StageSystem.test-style unit tests
 * (stageState.test.ts) cover them without a DOM.
 */

/** The local player's place on the stage. */
export type LocalStagePhase = "none" | "queued" | "preparing" | "sharing";

export function localStagePhase(input: {
  readonly member: boolean;
  readonly stage: Readonly<HallStageState>;
  readonly localPlayerId: string | null;
  /** A local LiveKit screen share is running. */
  readonly sharing: boolean;
}): LocalStagePhase {
  if (!input.member || input.localPlayerId === null) return "none";
  if (input.stage.holder === input.localPlayerId) return input.sharing ? "sharing" : "preparing";
  if (input.stage.queue.includes(input.localPlayerId)) return "queued";
  return "none";
}

/**
 * What to do with a running local share when the hall state changes:
 *  - `stop`: the server named someone else (or nobody) while we are a member — the role is gone;
 *  - `grace`: we are not a member any more (walked out); the server keeps the turn for
 *    HALL_STAGE_LEAVE_GRACE_MS, so stop only if we have not come back by then;
 *  - `keep`: still the holder, or nothing is shared.
 */
export function localShareAction(input: { readonly member: boolean; readonly amHolder: boolean; readonly sharing: boolean }): "keep" | "stop" | "grace" {
  if (!input.sharing) return "keep";
  if (!input.member) return "grace";
  return input.amHolder ? "keep" : "stop";
}

export interface ScreenMessage {
  readonly title: string;
  readonly subtitle: string;
}

/** The big screen's idle face while no video shows (null while a video shows). */
export function stageScreenMessage(input: {
  readonly member: boolean;
  readonly stage: Readonly<HallStageState>;
  readonly localPlayerId: string | null;
  /** Resolves a holder's nickname from presence (playerIds only travel in hall state). */
  readonly nameOf: (playerId: string) => string | undefined;
  readonly showingVideo: boolean;
  readonly voiceMode: VoiceConnectionMode;
  readonly voiceState: VoiceConnectionState;
  /** The listener blocked the holder. */
  readonly holderBlocked: boolean;
  /** The next scheduled event ("Zcash Arborist Call · Today 15:00"), shown while nobody is on stage. */
  readonly upNext?: string | null;
}): ScreenMessage | null {
  if (input.showingVideo) return null;
  const stage = input.stage;
  if (!input.member || stage.holder === null) {
    if (stage.locked) return { title: "The stage is locked", subtitle: "A host hands the stage to the next presenter" };
    // A card a host set while the stage is idle is what comes next (it stays when the next turn starts).
    if (input.member && stage.card) return { title: `Up next: ${stage.card.title}`, subtitle: stage.card.speaker ? `${stage.card.speaker} · starts from the podium` : "The presenter starts from the podium" };
    if (input.upNext) return { title: "Nobody on stage — request it at the podium", subtitle: `Up next: ${input.upNext}` };
    return { title: "Nobody on stage — request it at the podium", subtitle: "Share a tab, a window or your screen — with sound — for everyone in the hall" };
  }
  const me = stage.holder === input.localPlayerId;
  const name = me ? "You" : (input.nameOf(stage.holder) ?? "Someone");
  if (stage.status === "preparing") {
    return me
      ? { title: "You're on stage — start sharing", subtitle: "Pick a tab, a window or your screen; tick “Share tab audio” for sound" }
      : { title: `${name} is getting ready…`, subtitle: "Their screen appears here when they start sharing" };
  }
  if (me) return { title: "You're live", subtitle: "Your share is on the big screen" };
  if (input.holderBlocked) return { title: "Hidden", subtitle: "You blocked the presenter — their share is never downloaded" };
  const connected = input.voiceState === "connected" && input.voiceMode !== "off";
  if (input.voiceState === "connecting") return { title: `${name} is live`, subtitle: "Connecting to the stage…" };
  if (!connected) return { title: `${name} is live`, subtitle: "Press “▶ Watch the stage” in the Stage panel to see and hear it" };
  return { title: `${name} is live`, subtitle: "Loading the picture…" };
}

/** The stage widget's "▶ Watch the stage (audio + video)" button: inside the hall while voice is off (or failed). */
export function watchBannerVisible(input: { readonly inside: boolean; readonly mode: VoiceConnectionMode; readonly state: VoiceConnectionState }): boolean {
  return input.inside && input.mode === "off" && input.state !== "connecting" && input.state !== "connected";
}

/**
 * What talking still needs, in this player's own words — a guest (no wallet on this device) needs a wallet;
 * a wallet holder whose wallet is locked needs to unlock it (the same split as VoiceControls' guest/locked hints).
 */
export function talkNeeds(holder: boolean): { readonly need: string; readonly step: string; readonly talk: string; readonly open: string } {
  return holder
    ? { need: "an unlocked wallet", step: "Unlock your wallet", talk: "Unlock wallet to talk", open: "Open wallet" }
    : { need: "a wallet", step: "Connect a wallet (Profile)", talk: "Connect a wallet to talk", open: "Connect a wallet" };
}

/**
 * What voice still needs before the stage can be shared (sharing rides on full voice, which needs an unlocked wallet
 * and, while the server runs a name registry, a confirmed name). Null when ready.
 */
export function stageVoiceNotice(input: {
  readonly mode: VoiceConnectionMode;
  readonly state: VoiceConnectionState;
  readonly canTalk: boolean;
  /** The server runs a name registry and this player has no confirmed (owned) name yet. */
  readonly needsName?: boolean;
  /** A wallet holder (locked) rather than a guest — decides "unlock" vs "connect a wallet". */
  readonly holder?: boolean;
}): { readonly text: string; readonly action: "enable-voice" | "open-wallet" | "confirm-name" | null } | null {
  if (input.mode === "full" && input.state === "connected") return null;
  if (input.mode === "full" && input.state === "connecting") return { text: "Connecting voice…", action: null };
  const base = input.mode === "listen" ? "You're in watch mode. Sharing on the stage needs voice" : "Voice is off. Sharing on the stage goes over voice";
  const needs = talkNeeds(input.holder === true);
  if (!input.canTalk) return { text: `${base}, and voice needs ${needs.need}. ${needs.step}, then press Enable voice.`, action: "open-wallet" };
  if (input.needsName) return { text: `${base}, and on this server talking and presenting need a confirmed name. Confirm one, then press Enable voice.`, action: "confirm-name" };
  return { text: `${base} — press Enable voice, then choose what to share.`, action: "enable-voice" };
}

/** "9 min" — a cooldown's remaining time, rounded up to whole minutes. */
export function formatCooldown(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 120 ? `${Math.ceil(minutes / 60)} h` : `${minutes} min`;
}

/**
 * Chat text for a refused stage-family request (null for reasons the stage UI doesn't explain). `op` and `retryInMs`
 * come from the refusal; `namesRequired` is whether the server runs a name registry (then the verified
 * identity is a confirmed name, else a connected wallet).
 */
export function stageErrorText(reason: HallErrorReason, context: { readonly op?: HallErrorOp; readonly retryInMs?: number; readonly namesRequired?: boolean } = {}): string | null {
  const { op, retryInMs, namesRequired = false } = context;
  switch (reason) {
    case "not_in_hall":
      return op === "vote" ? "Step inside the Watch Hall to vote." : "Step inside the Watch Hall to use the stage.";
    case "queue_full":
      return "The stage queue is full — try again in a bit.";
    case "locked":
      return op === "vote" ? "A host has locked the stage, so voting is off — the host decides who presents." : "The stage is locked — a host hands it to the next presenter.";
    case "rate_limited":
      return op === "vote" ? "You changed your vote a lot — try again in a few seconds." : "Slow down a little — try again in a moment.";
    case "not_queued":
      return "You can only hand the stage to someone who is in the queue.";
    case "not_host":
      return "Only a host can do that.";
    case "invalid":
      return op === "vote" ? "You're the presenter — use Stop sharing to end your share." : "That card or request wasn't accepted (check the title and links).";
    case "not_found":
      return "That player isn't in the hall any more.";
    case "not_raised":
      return "The floor goes only to someone who raised a hand — raising it is their consent to be heard hall-wide.";
    case "identity_required":
      if (op === "floor") {
        return namesRequired
          ? "That player can't be heard hall-wide: on this server the floor goes only to players with a confirmed name."
          : "That player can't be heard hall-wide: the floor goes only to players with a wallet.";
      }
      if (op === "vote") return "On this server only players with a confirmed name can vote to end a share.";
      return namesRequired
        ? "On this server presenting needs a confirmed name — confirm one in Profile → Change name, then request the stage."
        : "Presenting needs a connected wallet — connect one, then request the stage.";
    case "cooldown":
      return retryInMs !== undefined
        ? `You can't take the stage for another ${formatCooldown(retryInMs)} — the audience voted to end your share, or a host paused you.`
        : "That player is on a stage cooldown — only a host can grant them the stage now.";
    case "not_live":
      return "There's nothing live to vote on.";
    default:
      return null;
  }
}

/** What the stage widget shows about the audience vote. */
export interface StageVoteView {
  /** A live, unlocked share: the vote row shows. */
  readonly open: boolean;
  /** This viewer may cast (or take back) a vote. */
  readonly canVote: boolean;
  readonly voted: boolean;
  /** "1 of 3 votes to end this share". */
  readonly countText: string;
  /** Why this viewer can't vote, or what the row means for the presenter. */
  readonly note: string | null;
}

export function stageVoteView(input: {
  readonly member: boolean;
  readonly stage: Readonly<HallStageState>;
  readonly vote: Readonly<HallVoteState>;
  readonly localPlayerId: string | null;
  /** The server runs a name registry and this player has no confirmed name (its vote would not count). */
  readonly needsName: boolean;
}): StageVoteView {
  const { stage, vote } = input;
  const open = input.member && stage.holder !== null && stage.status === "live" && !stage.locked && vote.needed > 0;
  if (!open) return { open: false, canVote: false, voted: false, countText: "", note: null };
  const amHolder = stage.holder === input.localPlayerId;
  const countText = amHolder ? `${vote.votes} of ${vote.needed} votes to end your share` : `${vote.votes} of ${vote.needed} votes to end this share`;
  if (amHolder) return { open, canVote: false, voted: false, countText, note: "If the hall votes your share off, it ends and you can present again in 10 minutes." };
  if (input.needsName) return { open, canVote: false, voted: false, countText, note: "Voting needs a confirmed name on this server." };
  return { open, canVote: true, voted: vote.voted, countText, note: null };
}
