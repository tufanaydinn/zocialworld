import { test } from "node:test";
import assert from "node:assert/strict";
import type { HallStageState } from "@project/shared";
import {
  formatCooldown,
  localShareAction,
  localStagePhase,
  stageErrorText,
  stageScreenMessage,
  stageVoiceNotice,
  stageVoteView,
  talkNeeds,
  watchBannerVisible,
} from "./stageState.ts";

// The pure decisions behind StageSystem (docs/architecture/WATCH_HALL.md).

function stage(overrides: Partial<HallStageState> = {}): HallStageState {
  return { holder: null, status: "idle", since: 0, queue: [], card: null, locked: false, audio: false, ...overrides };
}

const names: Record<string, string> = { a: "Alice", b: "Bob" };
const nameOf = (id: string): string | undefined => names[id];

test("local stage phase: holder preparing / sharing, queued, none", () => {
  const preparing = stage({ holder: "me", status: "preparing", queue: ["b"] });
  assert.equal(localStagePhase({ member: true, stage: preparing, localPlayerId: "me", sharing: false }), "preparing");
  assert.equal(localStagePhase({ member: true, stage: stage({ holder: "me", status: "live" }), localPlayerId: "me", sharing: true }), "sharing");
  // Live on the server but no local share (it just ended): offer Start sharing again.
  assert.equal(localStagePhase({ member: true, stage: stage({ holder: "me", status: "live" }), localPlayerId: "me", sharing: false }), "preparing");
  assert.equal(localStagePhase({ member: true, stage: preparing, localPlayerId: "b", sharing: false }), "queued");
  assert.equal(localStagePhase({ member: true, stage: preparing, localPlayerId: "x", sharing: false }), "none");
  assert.equal(localStagePhase({ member: false, stage: preparing, localPlayerId: "me", sharing: false }), "none", "not a member: no stage role shown");
  assert.equal(localStagePhase({ member: true, stage: preparing, localPlayerId: null, sharing: false }), "none");
});

test("a local share stops when the role is lost, waits out the leave grace outside, and is kept otherwise", () => {
  assert.equal(localShareAction({ member: true, amHolder: true, sharing: true }), "keep");
  assert.equal(localShareAction({ member: true, amHolder: false, sharing: true }), "stop", "the server named someone else");
  assert.equal(localShareAction({ member: false, amHolder: false, sharing: true }), "grace", "walked out: the server keeps the turn for the leave grace");
  assert.equal(localShareAction({ member: true, amHolder: false, sharing: false }), "keep", "nothing to stop");
  assert.equal(localShareAction({ member: false, amHolder: false, sharing: false }), "keep");
});

test("screen idle face follows the stage state; a showing video hides it", () => {
  const base = { member: true, localPlayerId: "me", nameOf, showingVideo: false, voiceMode: "off" as const, voiceState: "disconnected" as const, holderBlocked: false };
  assert.deepEqual(stageScreenMessage({ ...base, stage: stage() })?.title, "Nobody on stage — request it at the podium");
  assert.equal(stageScreenMessage({ ...base, member: false, stage: stage({ holder: "a", status: "live" }) })?.title, "Nobody on stage — request it at the podium", "outside the hall nothing about the stage is known");
  assert.equal(stageScreenMessage({ ...base, stage: stage({ locked: true }) })?.title, "The stage is locked");
  assert.equal(stageScreenMessage({ ...base, stage: stage({ holder: "a", status: "preparing" }) })?.title, "Alice is getting ready…");
  assert.equal(stageScreenMessage({ ...base, stage: stage({ holder: "zz", status: "preparing" }) })?.title, "Someone is getting ready…");
  assert.match(stageScreenMessage({ ...base, stage: stage({ holder: "me", status: "preparing" }) })?.title ?? "", /You're on stage/);
  const live = stage({ holder: "a", status: "live", audio: true });
  assert.match(stageScreenMessage({ ...base, stage: live })?.subtitle ?? "", /Watch the stage/, "voice off: point at watch mode");
  assert.match(stageScreenMessage({ ...base, stage: live, voiceMode: "listen", voiceState: "connecting" })?.subtitle ?? "", /Connecting/);
  assert.match(stageScreenMessage({ ...base, stage: live, voiceMode: "listen", voiceState: "connected" })?.subtitle ?? "", /Loading/);
  assert.equal(stageScreenMessage({ ...base, stage: live, holderBlocked: true })?.title, "Hidden");
  assert.equal(stageScreenMessage({ ...base, stage: live, showingVideo: true }), null);
});

test("while nobody presents, the idle face names what's next: a host's up-next card, else the next scheduled event", () => {
  const base = { member: true, localPlayerId: "me", nameOf, showingVideo: false, voiceMode: "off" as const, voiceState: "disconnected" as const, holderBlocked: false };
  const next = stageScreenMessage({ ...base, stage: stage(), upNext: "Zcash Arborist Call · Today 15:00" });
  assert.equal(next?.title, "Nobody on stage — request it at the podium");
  assert.equal(next?.subtitle, "Up next: Zcash Arborist Call · Today 15:00");
  const card = stageScreenMessage({ ...base, stage: stage({ card: { title: "Zebra demo", speaker: "Ada" } }), upNext: "Something else" });
  assert.equal(card?.title, "Up next: Zebra demo");
  assert.match(card?.subtitle ?? "", /^Ada/);
  assert.equal(stageScreenMessage({ ...base, stage: stage({ locked: true }), upNext: "x" })?.title, "The stage is locked", "locked wins");
  assert.equal(stageScreenMessage({ ...base, stage: stage({ holder: "a", status: "preparing" }), upNext: "x" })?.title, "Alice is getting ready…", "a holder wins");
  assert.match(stageScreenMessage({ ...base, stage: stage(), upNext: null })?.subtitle ?? "", /Share a tab/);
});

test("the watch-mode button shows inside the hall while voice is off (or failed), never while connecting or connected", () => {
  assert.equal(watchBannerVisible({ inside: true, mode: "off", state: "disconnected" }), true);
  assert.equal(watchBannerVisible({ inside: true, mode: "off", state: "error" }), true);
  assert.equal(watchBannerVisible({ inside: false, mode: "off", state: "disconnected" }), false);
  assert.equal(watchBannerVisible({ inside: true, mode: "listen", state: "connected" }), false);
  assert.equal(watchBannerVisible({ inside: true, mode: "full", state: "connected" }), false);
  assert.equal(watchBannerVisible({ inside: true, mode: "listen", state: "connecting" }), false);
});

test("sharing needs full, connected voice; the notice says what is missing", () => {
  assert.equal(stageVoiceNotice({ mode: "full", state: "connected", canTalk: true }), null);
  const guest = stageVoiceNotice({ mode: "off", state: "disconnected", canTalk: false });
  assert.equal(guest?.action, "open-wallet");
  // A guest has no wallet to unlock — they are told to connect one; a holder with a locked wallet to unlock it.
  assert.match(guest?.text ?? "", /voice needs a wallet\. Connect a wallet \(Profile\), then press Enable voice/);
  assert.doesNotMatch(guest?.text ?? "", /unlock/i);
  const locked = stageVoiceNotice({ mode: "off", state: "disconnected", canTalk: false, holder: true });
  assert.equal(locked?.action, "open-wallet");
  assert.match(locked?.text ?? "", /voice needs an unlocked wallet\. Unlock your wallet, then press Enable voice/);
  assert.equal(stageVoiceNotice({ mode: "off", state: "disconnected", canTalk: true })?.action, "enable-voice");
  const watching = stageVoiceNotice({ mode: "listen", state: "connected", canTalk: true });
  assert.match(watching?.text ?? "", /watch mode/);
  assert.equal(watching?.action, "enable-voice");
  assert.equal(stageVoiceNotice({ mode: "full", state: "connecting", canTalk: true })?.action, null);
});

test("with a name registry, an unnamed holder is told to confirm a name before voice can share", () => {
  const notice = stageVoiceNotice({ mode: "off", state: "disconnected", canTalk: true, needsName: true });
  assert.equal(notice?.action, "confirm-name");
  assert.match(notice?.text ?? "", /confirmed name/);
  assert.equal(stageVoiceNotice({ mode: "off", state: "disconnected", canTalk: false, needsName: true })?.action, "open-wallet", "the wallet comes first");
  assert.equal(stageVoiceNotice({ mode: "full", state: "connected", canTalk: true, needsName: true }), null, "already talking: nothing missing");
});

test("the vote row — closed unless live and unlocked; the presenter sees the count; an unnamed player can't vote", () => {
  const live = stage({ holder: "a", status: "live" });
  const vote = { votes: 1, needed: 3, voted: false };
  const base = { member: true, stage: live, vote, localPlayerId: "me", needsName: false };
  assert.deepEqual(stageVoteView(base), { open: true, canVote: true, voted: false, countText: "1 of 3 votes to end this share", note: null });
  assert.equal(stageVoteView({ ...base, vote: { votes: 2, needed: 3, voted: true } }).voted, true);
  assert.equal(stageVoteView({ ...base, stage: stage({ holder: "a", status: "preparing" }) }).open, false, "nothing live yet");
  assert.equal(stageVoteView({ ...base, stage: { ...live, locked: true } }).open, false, "a host's lock closes the vote");
  assert.equal(stageVoteView({ ...base, vote: { votes: 0, needed: 0, voted: false } }).open, false, "the server says voting is closed");
  assert.equal(stageVoteView({ ...base, member: false }).open, false);
  const presenter = stageVoteView({ ...base, localPlayerId: "a" });
  assert.equal(presenter.canVote, false);
  assert.equal(presenter.countText, "1 of 3 votes to end your share");
  const unnamed = stageVoteView({ ...base, needsName: true });
  assert.equal(unnamed.canVote, false);
  assert.match(unnamed.note ?? "", /confirmed name/);
});

test("refusals for identity, cooldowns and votes get their own text", () => {
  assert.match(stageErrorText("identity_required", { op: "stage", namesRequired: true }) ?? "", /confirmed name/);
  assert.match(stageErrorText("identity_required", { op: "stage", namesRequired: false }) ?? "", /wallet/);
  assert.match(stageErrorText("identity_required", { op: "floor", namesRequired: true }) ?? "", /floor goes only to players with a confirmed name/);
  assert.match(stageErrorText("identity_required", { op: "vote", namesRequired: true }) ?? "", /vote/);
  assert.match(stageErrorText("cooldown", { op: "stage", retryInMs: 9 * 60_000 + 1 }) ?? "", /another 10 min/);
  assert.match(stageErrorText("cooldown", { op: "stage" }) ?? "", /only a host/);
  assert.match(stageErrorText("locked", { op: "vote" }) ?? "", /voting is off/);
  assert.match(stageErrorText("not_live", { op: "vote" }) ?? "", /nothing live/);
  assert.match(stageErrorText("invalid", { op: "vote" }) ?? "", /Stop sharing/);
  assert.equal(formatCooldown(30_000), "1 min");
  assert.equal(formatCooldown(60 * 60_000), "60 min");
  assert.equal(formatCooldown(5 * 60 * 60_000), "5 h");
});

test("stage refusals get readable text; unknown reasons stay silent", () => {
  assert.match(stageErrorText("not_in_hall") ?? "", /inside the Watch Hall/);
  assert.match(stageErrorText("queue_full") ?? "", /queue is full/);
  assert.match(stageErrorText("not_raised") ?? "", /raised a hand/);
  assert.match(stageErrorText("locked") ?? "", /locked/);
  assert.equal(stageErrorText("not_holder"), null);
  assert.equal(stageErrorText("taken"), null);
});

test("talkNeeds words the wallet step by state — a guest connects a wallet, a locked holder unlocks it", () => {
  assert.deepEqual(talkNeeds(false), { need: "a wallet", step: "Connect a wallet (Profile)", talk: "Connect a wallet to talk", open: "Connect a wallet" });
  assert.deepEqual(talkNeeds(true), { need: "an unlocked wallet", step: "Unlock your wallet", talk: "Unlock wallet to talk", open: "Open wallet" });
});
