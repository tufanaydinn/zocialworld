import { test } from "node:test";
import assert from "node:assert/strict";
import { HALL_CARD_NAME_MAX, HALL_CARD_TITLE_MAX, MAX_MESSAGE_BYTES } from "@project/shared";
import { draftFromCard, linkKindLabel, parseCardDraft, suggestLinkKind, type CardDraft } from "./cardForm.ts";
import { validateHallCard } from "./hallCard.ts";

// The stage widget's "Edit card" form (docs/architecture/WATCH_HALL.md).

const empty: CardDraft = { title: "", speaker: "", project: "", links: [] };

test("a minimal card: just a title, cleaned like the server does", () => {
  const result = parseCardDraft({ ...empty, title: "  Building​  Together ‮ " });
  assert.ok(result.ok);
  assert.deepEqual(result.card, { title: "Building Together" });
  assert.deepEqual(validateHallCard(result.card), result.card, "exactly what the server accepts");
});

test("a full card keeps speaker, project, links in order and the catalogue ids", () => {
  const result = parseCardDraft({
    title: "Weekly Builders Call",
    speaker: "Luna",
    project: "Zebra",
    links: [
      { kind: "github", url: "github.com/ZcashFoundation/zebra" },
      { kind: "web", url: "" },
      { kind: "forum", url: "https://forum.zcashcommunity.com/t/builders-call/12345" },
    ],
    videoId: "vidAAAA0001",
    eventId: "builders-20261015",
  });
  assert.ok(result.ok);
  assert.deepEqual(result.card, {
    title: "Weekly Builders Call",
    speaker: "Luna",
    project: "Zebra",
    links: [
      { kind: "github", url: "https://github.com/ZcashFoundation/zebra" },
      { kind: "forum", url: "https://forum.zcashcommunity.com/t/builders-call/12345" },
    ],
    eventId: "builders-20261015",
    videoId: "vidAAAA0001",
  });
  assert.ok(new TextEncoder().encode(JSON.stringify({ type: "hall_stage_card", card: result.card })).length < MAX_MESSAGE_BYTES);
});

test("missing or too-long fields get one message each", () => {
  const missing = parseCardDraft(empty);
  assert.ok(!missing.ok);
  assert.match(missing.errors.title ?? "", /title/i);

  const long = parseCardDraft({ ...empty, title: "x".repeat(HALL_CARD_TITLE_MAX + 1), speaker: "y".repeat(HALL_CARD_NAME_MAX + 1), project: "ok" });
  assert.ok(!long.ok);
  assert.match(long.errors.title ?? "", new RegExp(String(HALL_CARD_TITLE_MAX)));
  assert.match(long.errors.speaker ?? "", new RegExp(String(HALL_CARD_NAME_MAX)));
  assert.equal(long.errors.project, undefined);

  // Code points, not UTF-16 units: 80 emoji are fine.
  assert.ok(parseCardDraft({ ...empty, title: "🎬".repeat(HALL_CARD_TITLE_MAX) }).ok);
});

test("links: https on the allowlist only, no http, no credentials or ports, at most four", () => {
  const bad = parseCardDraft({
    ...empty,
    title: "T",
    links: [
      { kind: "web", url: "http://z.cash/" },
      { kind: "web", url: "https://evil.example/phish" },
      { kind: "github", url: "https://user:pw@github.com/x" },
      { kind: "docs", url: "javascript:alert(1)" },
    ],
  });
  assert.ok(!bad.ok);
  assert.match(bad.errors.link0 ?? "", /https/);
  assert.match(bad.errors.link1 ?? "", /github\.com/);
  assert.ok(bad.errors.link2);
  assert.ok(bad.errors.link3);

  const five = parseCardDraft({ ...empty, title: "T", links: Array.from({ length: 5 }, (_, i) => ({ kind: "web" as const, url: `https://z.cash/${i}` })) });
  assert.ok(!five.ok);
  assert.match(five.errors.links ?? "", /4/);

  const unknownKind = parseCardDraft({ ...empty, title: "T", links: [{ kind: "video" as never, url: "https://z.cash/" }] });
  assert.ok(!unknownKind.ok);
  assert.ok(unknownKind.errors.link0);
});

test("hostile text stays text: markup is kept verbatim for textContent rendering, controls are stripped", () => {
  const result = parseCardDraft({ ...empty, title: '<img src=x onerror="alert(1)">', speaker: "\u0000Eve\u0007" });
  assert.ok(result.ok);
  assert.equal(result.card.title, '<img src=x onerror="alert(1)">');
  assert.equal(result.card.speaker, "Eve");
});

test("draftFromCard round-trips a card, and kinds are suggested from the URL", () => {
  const card = { title: "Demo", speaker: "Ada", links: [{ kind: "zechub" as const, url: "https://zechub.wiki/wallets" }], videoId: "vidAAAA0001" };
  const draft = draftFromCard(card);
  assert.deepEqual(draft, { title: "Demo", speaker: "Ada", project: "", links: [{ kind: "zechub", url: "https://zechub.wiki/wallets" }], videoId: "vidAAAA0001" });
  const again = parseCardDraft(draft);
  assert.ok(again.ok);
  assert.deepEqual(again.card, card);
  assert.deepEqual(draftFromCard(null), empty);

  assert.equal(suggestLinkKind("github.com/zcash/zcash"), "github");
  assert.equal(suggestLinkKind("https://www.zechub.wiki/x"), "zechub");
  assert.equal(suggestLinkKind("https://forum.zcashcommunity.com/t/1"), "forum");
  assert.equal(suggestLinkKind("https://zips.z.cash/zip-0317"), "docs");
  assert.equal(suggestLinkKind("https://z.cash/"), "web");
  assert.equal(suggestLinkKind("not a url at all"), "web");
  assert.equal(linkKindLabel("zechub"), "ZecHub");
});
