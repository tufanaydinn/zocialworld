import { test } from "node:test";
import assert from "node:assert/strict";
import { routeLink, wikiSlug } from "./links.ts";

test("forum links route to in-game threads, posts, categories and search", () => {
  assert.deepEqual(routeLink("https://forum.zcashcommunity.com/t/zcash-turkiye-university-tour-2026/57848"), { kind: "thread", id: 57848, post: 0 });
  assert.deepEqual(routeLink("https://forum.zcashcommunity.com/t/some-topic/57848/12"), { kind: "thread", id: 57848, post: 12 });
  assert.deepEqual(routeLink("https://forum.zcashcommunity.com/t/57848/3?u=x"), { kind: "thread", id: 57848, post: 3 });
  assert.deepEqual(routeLink("https://forum.zcashcommunity.com/c/grants/applications/36"), { kind: "category", id: 36 });
  assert.deepEqual(routeLink("https://forum.zcashcommunity.com/search?q=zechub%20wiki"), { kind: "search", query: "zechub wiki" });
  assert.equal(routeLink("https://forum.zcashcommunity.com/u/someone"), null, "profiles stay on the forum");
});

test("ZecHub wiki and GitHub links route in-game; other sites do not", () => {
  assert.deepEqual(routeLink("https://zechub.wiki/using-zcash/wallets#top"), { kind: "wiki", slug: "using-zcash/wallets" });
  assert.deepEqual(routeLink("https://zechub.wiki/tr/using-zcash/wallets"), { kind: "wiki", slug: "using-zcash/wallets" });
  assert.deepEqual(routeLink("https://github.com/ZecHub/zechub/blob/main/site/Using_Zcash/Wallets.md"), { kind: "wikiPath", path: "site/Using_Zcash/Wallets.md" });
  assert.deepEqual(routeLink("https://github.com/ZcashFoundation/zebra"), { kind: "repo", fullName: "ZcashFoundation/zebra" });
  assert.equal(routeLink("https://zechub.wiki/content-images/x.webp"), null);
  assert.equal(routeLink("https://z.cash/learn/what-is-zcash/"), null);
  assert.equal(routeLink("http://forum.zcashcommunity.com/t/x/1"), null, "https only");
  assert.equal(routeLink("not a url"), null);
});

test("wikiSlug normalises repository paths and site URLs to the same key", () => {
  assert.equal(wikiSlug("/Using_Zcash/Wallets.md"), "using-zcash/wallets");
  assert.equal(wikiSlug("/site/Using_Zcash/Wallets.md"), "using-zcash/wallets");
  assert.equal(wikiSlug("/using-zcash/wallets/"), "using-zcash/wallets");
  assert.equal(wikiSlug("/research/zcash-foundations-series/article-1/article-1-finite-fields"), "research/zcash-foundations-series/article-1/article-1-finite-fields");
});
