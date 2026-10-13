import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { ModLogMessage } from "@project/shared";
import type { ReportDialog as ReportDialogType } from "./ReportDialog.ts";
import type { ModerationPanel as ModerationPanelType } from "./ModerationPanel.ts";
import type { ModerationActionDialog as ModerationActionDialogType } from "./ModerationActionDialog.ts";
import type { ModerationStore as ModerationStoreType } from "./ModerationStore.ts";
import type { PlayerContextCard as PlayerContextCardType } from "../social/PlayerContextCard.ts";
import type { NetworkClient as NetworkClientType } from "../networking/NetworkClient.ts";

/**
 * Moderation (ADR-019) in the DOM: the report dialog (reason, note, the "moderators see your nickname" notice, the
 * ack), the player menu (Report for everyone, Mute/Kick/Ban for moderators, the Moderator tag), the action dialog, the
 * Moderation panel, and the network client's close handling (no automatic reconnect after a kick, ban or refusal).
 */

let ReportDialog: typeof ReportDialogType;
let ModerationPanel: typeof ModerationPanelType;
let ModerationActionDialog: typeof ModerationActionDialogType;
let ModerationStore: typeof ModerationStoreType;
let PlayerContextCard: typeof PlayerContextCardType;
let NetworkClient: typeof NetworkClientType;
const globals = ["window", "document", "HTMLElement", "HTMLButtonElement", "HTMLDivElement", "HTMLSpanElement", "HTMLInputElement", "HTMLFormElement", "Event", "KeyboardEvent", "WebSocket"] as const;
const saved: Partial<Record<(typeof globals)[number], unknown>> = {};

before(async () => {
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  for (const key of globals) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    if (key === "WebSocket") continue;
    (globalThis as Record<string, unknown>)[key] = key === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[key];
  }
  ({ ReportDialog } = await import("./ReportDialog.ts"));
  ({ ModerationPanel } = await import("./ModerationPanel.ts"));
  ({ ModerationActionDialog } = await import("./ModerationActionDialog.ts"));
  ({ ModerationStore } = await import("./ModerationStore.ts"));
  ({ PlayerContextCard } = await import("../social/PlayerContextCard.ts"));
  ({ NetworkClient } = await import("../networking/NetworkClient.ts"));
});

after(() => {
  for (const key of globals) (globalThis as Record<string, unknown>)[key] = saved[key];
});

function container(): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}

test("report dialog: the reasons, a 280-character note, the plain notice that moderators see your nickname, and the ack", () => {
  const root = container();
  const sent: [string, string | undefined][] = [];
  const thanks: string[] = [];
  let closed = 0;
  const dialog = new ReportDialog({ container: root, nickname: "Troll", send: (reason, note) => sent.push([reason, note]), onSent: (text) => thanks.push(text), onClose: () => closed++ });
  assert.equal(root.querySelector(".zw-mod-title")!.textContent, "Report Troll");
  const reasons = [...root.querySelectorAll<HTMLInputElement>("input[type=radio]")];
  assert.equal(reasons.length, 6);
  assert.match(root.querySelector(".zw-report-privacy")!.textContent!, /Moderators will see your nickname with this report/);
  assert.match(root.querySelector(".zw-report-privacy")!.textContent!, /Troll is never told who reported them/);
  const note = root.querySelector<HTMLTextAreaElement>(".zw-report-note")!;
  assert.equal(note.maxLength, 280);
  reasons[1]!.checked = true;
  reasons[1]!.dispatchEvent(new Event("change"));
  note.value = "  said rude things  ";
  root.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.deepEqual(sent, [["harassment", "said rude things"]]);
  assert.equal(root.querySelector(".zw-mod-status")!.textContent, "Sending…");
  dialog.acknowledge("rate_limited");
  assert.match(root.querySelector(".zw-mod-status")!.textContent!, /wait/);
  assert.equal(closed, 0, "a refusal keeps the dialog open");
  root.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  dialog.acknowledge("sent");
  assert.deepEqual(thanks, ["Thanks — moderators were notified."]);
  assert.equal(closed, 1);
  assert.equal(root.querySelector(".zw-report-backdrop"), null);
});

test("reporting a moderator says the report goes to the other moderators only", () => {
  const root = container();
  const dialog = new ReportDialog({ container: root, nickname: "Moddy", moderator: true, send: () => undefined, onSent: () => undefined, onClose: () => undefined });
  const privacy = root.querySelector(".zw-report-privacy")!.textContent!;
  assert.match(privacy, /Moddy is a moderator: this report goes to the other moderators only — Moddy never sees it or who sent it\./);
  assert.match(privacy, /Moderators will see your nickname with this report/);
  dialog.close();
});

test("the mute dialog says who else on the network a mute reaches; kick and ban say others there are disconnected", () => {
  const root = container();
  const mute = new ModerationActionDialog({ container: root, verb: "mute", target: { nickname: "Troll", playerId: "p2" }, send: () => undefined, onClose: () => undefined });
  assert.match(root.querySelector(".zw-mod-note")!.textContent!, /other players on it without an owned name are muted too; players there with their own owned name are not/);
  mute.close();
  const ban = new ModerationActionDialog({ container: root, verb: "ban", target: { nickname: "Troll", playerId: "p2" }, send: () => undefined, onClose: () => undefined });
  assert.match(root.querySelector(".zw-mod-note")!.textContent!, /everyone else on it is disconnected/);
  assert.match(root.querySelector(".zw-mod-note")!.textContent!, /don't reload/);
  ban.close();
  const kick = new ModerationActionDialog({ container: root, verb: "kick", target: { nickname: "Troll", playerId: "p2" }, send: () => undefined, onClose: () => undefined });
  assert.match(root.querySelector(".zw-mod-note")!.textContent!, /disconnected too/);
  kick.close();
});

test("player menu: Report for everyone; Mute… / Kick / Ban… only for a moderator, never on another moderator; the tag", () => {
  const root = container();
  const menu = new PlayerContextCard(root);
  const reports: string[] = [];
  const actions: string[] = [];
  menu.onReport((playerId) => reports.push(playerId));
  menu.onModerate((verb, playerId) => actions.push(`${verb}:${playerId}`));
  const data = { playerId: "p2", nickname: "Troll", accentColor: "#bf4040", canReceive: false, presence: "nearby" as const, muted: false };
  menu.open(data);
  const report = root.querySelector<HTMLButtonElement>(".zw-player-menu-report")!;
  assert.equal(report.disabled, false);
  assert.equal(root.querySelector<HTMLElement>(".zw-player-menu-moderation")!.hidden, true, "no moderator tools for players");
  report.click();
  assert.deepEqual(reports, ["p2"]);
  menu.setModeratorTools(true);
  menu.open(data);
  assert.equal(root.querySelector<HTMLElement>(".zw-player-menu-moderation")!.hidden, false);
  root.querySelector<HTMLButtonElement>(".zw-player-menu-mod-kick")!.click();
  assert.deepEqual(actions, ["kick:p2"]);
  menu.open({ ...data, moderator: true });
  assert.equal(root.querySelector<HTMLElement>(".zw-moderator-tag")!.hidden, false);
  assert.equal(root.querySelector<HTMLElement>(".zw-player-menu-moderation")!.hidden, true, "moderators can't act on each other");
  menu.dispose();
});

test("action dialog: a ban sends the chosen duration (or null until lifted) with the report it came from", () => {
  const root = container();
  const sent: unknown[] = [];
  new ModerationActionDialog({ container: root, verb: "ban", target: { nickname: "Troll", playerId: null, reportId: "r4" }, send: (message) => sent.push(message), onClose: () => undefined });
  const choices = [...root.querySelectorAll<HTMLInputElement>("input[type=radio]")];
  assert.equal(choices.length, 4);
  choices[3]!.checked = true;
  root.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.deepEqual(sent.slice(), [{ action: "ban", reportId: "r4", durationMs: null }]); // a copy: deepEqual narrows its argument
  new ModerationActionDialog({ container: root, verb: "kick", target: { nickname: "Troll", playerId: "p2" }, send: (message) => sent.push(message), onClose: () => undefined });
  root.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.deepEqual(sent[1], { action: "kick", targetId: "p2" });
});

test("Moderation panel: reports with their actions, active bans and mutes with Unban / Unmute, and the log", () => {
  const root = container();
  const store = new ModerationStore();
  const state: ModLogMessage = {
    type: "mod_log",
    reports: [{ id: "r1", t: Date.now(), reporter: "Ann", target: "Troll", targetId: null, reason: "scam", note: "<b>fake giveaway</b>", location: "valley" }],
    log: [{ id: "l1", t: Date.now(), moderator: "Mod", action: "mute", target: "Loud", durationMs: 600_000 }],
    bans: [{ id: "b1", nickname: "Spammer", kind: "ban", until: Date.now() + 3_600_000, byName: false, byConnection: true }],
    mutes: [{ id: "m1", nickname: "Loud", until: Date.now() + 600_000 }],
  };
  store.handle(state);
  const sent: unknown[] = [];
  const moderated: string[] = [];
  const panel = new ModerationPanel({ container: root, store, moderate: (verb, target) => moderated.push(`${verb}:${target.reportId}:${target.playerId}`), send: (message) => sent.push(message) });
  panel.open();
  const row = root.querySelector(".zw-mod-report")!;
  assert.match(row.textContent!, /Troll/);
  assert.match(row.textContent!, /Reported by Ann/);
  assert.match(row.textContent!, /Learning Valley/);
  assert.equal(row.querySelector(".zw-mod-row-note")!.innerHTML, "&lt;b&gt;fake giveaway&lt;/b&gt;", "notes are text, never markup");
  assert.match(row.textContent!, /left/);
  [...row.querySelectorAll("button")].find((b) => b.textContent === "Ban…")!.click();
  assert.deepEqual(moderated, ["ban:r1:null"]);
  [...row.querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!.click();
  assert.deepEqual(sent, [{ action: "dismiss_report", reportId: "r1" }]);
  assert.equal(store.unseenReports, 0, "opening the reports counts them as seen");
  root.querySelector<HTMLButtonElement>('[data-tab="active"]')!.click();
  [...root.querySelectorAll(".zw-mod-ban button")].find((b) => b.textContent === "Unban")!.dispatchEvent(new Event("click"));
  [...root.querySelectorAll(".zw-mod-mute button")].find((b) => b.textContent === "Unmute")!.dispatchEvent(new Event("click"));
  assert.deepEqual(sent.slice(1), [{ action: "unban", entryId: "b1" }, { action: "unmute", entryId: "m1" }]);
  assert.match(root.querySelector(".zw-mod-ban")!.textContent!, /by network/);
  root.querySelector<HTMLButtonElement>('[data-tab="log"]')!.click();
  assert.match(root.querySelector(".zw-mod-log-line")!.textContent!, /Mod muted Loud \(10 min\)/);
  panel.close();
  assert.equal(panel.isOpen, false);
});

test("network client: a kick, ban or refusal close stops the automatic reconnect and reports the notice", () => {
  type Listener = (event: { data?: unknown; code?: number }) => void;
  class FakeSocket {
    static readonly OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    readonly sent: Record<string, unknown>[] = [];
    private readonly listeners = new Map<string, Listener[]>();
    constructor() {
      FakeSocket.instances.push(this);
    }
    addEventListener(type: string, listener: Listener): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(data: string): void {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close(): void {}
    fire(type: string, event: { data?: unknown; code?: number }): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    const closes: [string, unknown][] = [];
    const states: string[] = [];
    const client = new NetworkClient("ws://test", { onClosedByServer: (reason, notice) => closes.push([reason, notice]), onStateChange: (state) => states.push(state) });
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.readyState = FakeSocket.OPEN;
    socket.fire("open", {});
    client.sendReport("p2", "spam", "note");
    client.sendModAction({ action: "mute", targetId: "p2", durationMs: 600_000 });
    assert.deepEqual(socket.sent.slice(-2), [
      { type: "report", targetId: "p2", reason: "spam", note: "note" },
      { type: "mod_action", action: "mute", targetId: "p2", durationMs: 600_000 },
    ]);
    socket.fire("message", { data: JSON.stringify({ type: "moderation_notice", kind: "banned", until: 123 }) });
    socket.fire("close", { code: 4002 });
    assert.deepEqual(closes, [["banned", { type: "moderation_notice", kind: "banned", until: 123 }]]);
    assert.equal(states.at(-1), "disconnected");
    assert.equal(FakeSocket.instances.length, 1, "no automatic reconnect is scheduled");
    client.reconnect();
    assert.equal(FakeSocket.instances.length, 2, "the player's Try again connects once more");
    client.disconnect();
  } finally {
    globalThis.WebSocket = original;
  }
});
