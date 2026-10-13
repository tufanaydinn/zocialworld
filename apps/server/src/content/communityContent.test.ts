import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  cleanText,
  createCommunityContentHandler,
  isWikiArticlePath,
  mapBounties,
  mapForumCategories,
  mapForumSearch,
  mapForumThread,
  mapForumTopics,
  mapWikiTree,
  prettifyWikiName,
  sniffImageType,
  type Fetcher,
} from "./communityContent.js";
import { allowedMediaUrl } from "./sources.js";

const ORIGIN = "http://127.0.0.1:5173";

function fakeFetcher(routes: Record<string, unknown>, calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return { ok: false, status: 404, text: async () => "" };
    const body = routes[key];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
}

async function serve(handler: ReturnType<typeof createCommunityContentHandler>): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const BOUNTY = {
  id: "b1",
  title: "Write a guide",
  description: "Details",
  bountyAmount: 0.25,
  status: "TO_DO",
  categoryId: "Writing and Research",
  difficulty: "EASY",
  dateCreated: "2026-10-01T00:00:00Z",
  timeToComplete: "2026-10-20T00:00:00Z",
  isPrivate: false,
  createdByUser: { name: "Real Name", nickname: "nick", avatar: "https://avatars.example/1" },
  assigneeUser: { name: "Another Name" },
};

test("mapBounties keeps public fields only and drops closed/private bounties", () => {
  const items = mapBounties({
    data: [BOUNTY, { ...BOUNTY, id: "b2", status: "COMPLETED" }, { ...BOUNTY, id: "b3", isPrivate: true }],
  });
  assert.equal(items.length, 1);
  const json = JSON.stringify(items);
  assert.ok(!json.includes("Real Name") && !json.includes("Another Name") && !json.includes("avatars.example"), "personal data leaked");
  assert.equal(items[0]!.url, "https://bounties.zechub.wiki/bounty/b1");
  assert.equal(items[0]!.amountZec, 0.25);
});

test("cleanText strips control characters and caps length", () => {
  assert.equal(cleanText("a\u0000b\u0007c", 10), "abc");
  assert.equal(cleanText("x".repeat(20), 5), "xxxx…");
  assert.equal(cleanText(42, 5), "");
});

test("forum mapping builds canonical topic URLs and sanitizes slugs", () => {
  const topics = mapForumTopics({ topic_list: { topics: [{ id: 7, title: "Hello", slug: "hel<lo>", posts_count: 2, excerpt: "<b>hi</b>" }] } });
  assert.equal(topics[0]!.url, "https://forum.zcashcommunity.com/t/hello/7");
  assert.equal(topics[0]!.excerpt, "hi");
  const thread = mapForumThread({ id: 7, slug: "hello", title: "Hello", posts_count: 1, post_stream: { posts: [{ id: 1, post_number: 1, username: "u", cooked: "<p>x</p>" }] } });
  assert.equal(thread?.posts[0]?.username, "u");
});

test("gateway serves bounties, caches them and falls back to stale data when upstream fails", async () => {
  let clock = 0;
  const calls: string[] = [];
  const routes: Record<string, unknown> = { "https://zechub.zone/api/bounties": { data: [BOUNTY] } };
  const handler = createCommunityContentHandler({ allowedOrigins: [ORIGIN], fetcher: fakeFetcher(routes, calls), ttlMs: 1000, now: () => clock });
  const { server, base } = await serve(handler);
  try {
    const first = await (await fetch(`${base}/content/bounties`, { headers: { Origin: ORIGIN } })).json();
    assert.equal(first.items.length, 1);
    const upstreamCalls = calls.length;
    await fetch(`${base}/content/bounties`);
    assert.equal(calls.length, upstreamCalls, "second request within TTL must hit the cache");

    clock = 5000;
    routes["https://zechub.zone/api/bounties"] = new Error("down");
    const stale = await (await fetch(`${base}/content/bounties`)).json();
    assert.equal(stale.stale, true);
    assert.equal(stale.items.length, 1);
  } finally {
    server.close();
  }
});

test("listing endpoints degrade to available:false (HTTP 200) when the upstream is unreachable", async () => {
  const handler = createCommunityContentHandler({ allowedOrigins: [ORIGIN], fetcher: fakeFetcher({ "https://": new Error("offline") }) });
  const { server, base } = await serve(handler);
  try {
    const response = await fetch(`${base}/content/bounties`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { available: false, items: [] });
    assert.equal((await fetch(`${base}/content/forum/topics/123`)).status, 502, "detail endpoints still report the failure");
  } finally {
    server.close();
  }
});

test("gateway only fetches allowlisted repos and wiki articles", async () => {
  const calls: string[] = [];
  const handler = createCommunityContentHandler({ allowedOrigins: [ORIGIN], fetcher: fakeFetcher({}, calls) });
  const { server, base } = await serve(handler);
  try {
    assert.equal((await fetch(`${base}/content/github/evil/repo`)).status, 404);
    assert.equal((await fetch(`${base}/content/wiki/not-a-real-article`)).status, 404);
    assert.equal((await fetch(`${base}/content/wiki/..%2F..%2Fetc`)).status, 404);
    assert.equal(calls.length, 0, "no upstream request for non-allowlisted targets");
  } finally {
    server.close();
  }
});

test("gateway rejects disallowed origins and non-GET methods, ignores other paths", async () => {
  const handler = createCommunityContentHandler({ allowedOrigins: [ORIGIN], fetcher: fakeFetcher({}) });
  const { server, base } = await serve(handler);
  try {
    assert.equal((await fetch(`${base}/content/wiki`, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${base}/content/wiki`, { method: "POST" })).status, 405);
    const wiki = await fetch(`${base}/content/wiki`, { headers: { Origin: ORIGIN } });
    assert.equal(wiki.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal((await fetch(`${base}/voice/token`)).status, 418, "non-content paths fall through");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- forum categories, grants, threads, search

const FORUM = "https://forum.zcashcommunity.com";
const CATEGORIES = {
  category_list: {
    categories: [
      {
        id: 33,
        slug: "grants",
        name: "Community Grants",
        color: "F4B76C",
        topic_count: 292,
        description_text: "<b>Grants</b> for the Zcash community",
        subcategory_list: [
          { id: 36, slug: "applications", name: "Applications", color: "zzz<script>", topic_count: 467 },
          { id: 99, slug: "secret", name: "Secret", read_restricted: true },
        ],
      },
      { id: 16, slug: "zcash-apps", name: "Zcash Apps", color: "b36319", topic_count: 456, subcategory_list: [] },
      { id: 70, slug: "staff", name: "Staff", read_restricted: true },
    ],
  },
};
const TOPICS_PAGE = { topic_list: { more_topics_url: "/c/grants/applications/36?page=1", topics: [{ id: 5, title: "Grant: in-game wiki", slug: "grant-wiki", posts_count: 3, category_id: 36, closed: true }] } };

test("forum categories keep public categories only, with validated colours and subcategory URLs", () => {
  const categories = mapForumCategories(CATEGORIES);
  assert.deepEqual(
    categories.map((category) => category.id),
    [33, 16],
  );
  const grants = categories[0]!;
  assert.equal(grants.color, "f4b76c");
  assert.equal(grants.description, "Grants for the Zcash community");
  assert.deepEqual(
    grants.subcategories.map((sub) => [sub.id, sub.url, sub.color, sub.parentId]),
    [[36, `${FORUM}/c/grants/applications/36`, "", 33]],
  );
});

test("forum search drops display names/avatars and links to the matching post", () => {
  const { hits, hasMore } = mapForumSearch({
    posts: [{ id: 1, name: "Real Name", username: "zecfan", avatar_template: "/a/{size}.png", topic_id: 5, post_number: 4, blurb: "a <b>grant</b> idea", like_count: 2 }],
    topics: [{ id: 5, title: "Grant: in-game wiki", slug: "grant-wiki", category_id: 36 }],
    grouped_search_result: { more_full_page_results: true },
  });
  assert.equal(hasMore, true);
  assert.equal(hits[0]!.url, `${FORUM}/t/grant-wiki/5/4`);
  assert.equal(hits[0]!.blurb, "a grant idea");
  const json = JSON.stringify(hits);
  assert.ok(!json.includes("Real Name") && !json.includes("avatar"), "personal data leaked");
});

test("gateway: categories, grants alias, subcategory pages with pagination, unknown category 404", async () => {
  const calls: string[] = [];
  const handler = createCommunityContentHandler({
    allowedOrigins: [ORIGIN],
    fetcher: fakeFetcher({ [`${FORUM}/categories.json`]: CATEGORIES, [`${FORUM}/c/`]: TOPICS_PAGE }, calls),
  });
  const { server, base } = await serve(handler);
  try {
    const categories = await (await fetch(`${base}/content/forum/categories`)).json();
    assert.equal(categories.grantsCategoryId, 33);
    assert.equal(categories.items[0].name, "Community Grants");

    const sub = await (await fetch(`${base}/content/forum/category/36?page=2`)).json();
    assert.ok(calls.includes(`${FORUM}/c/grants/applications/36.json?page=2`), "subcategory URL uses the parent slug");
    assert.equal(sub.page, 2);
    assert.equal(sub.hasMore, true);
    assert.equal(sub.category.parent.name, "Community Grants");
    assert.equal(sub.items[0].closed, true);

    await fetch(`${base}/content/forum/grants?page=999`);
    assert.ok(calls.includes(`${FORUM}/c/grants/33.json?page=50`), "page is clamped");

    const before = calls.length;
    assert.equal((await fetch(`${base}/content/forum/category/99`)).status, 404, "restricted category");
    assert.equal((await fetch(`${base}/content/forum/category/12345`)).status, 404, "unknown category");
    assert.equal(calls.length, before, "no upstream request for categories outside the list");
  } finally {
    server.close();
  }
});

test("gateway pages through long threads by post id", async () => {
  const stream = Array.from({ length: 45 }, (_, i) => 100 + i);
  const post = (id: number) => ({ id, post_number: id - 99, username: `u${id}`, cooked: `<p>${id}</p>`, name: "Real Name" });
  const calls: string[] = [];
  const handler = createCommunityContentHandler({
    allowedOrigins: [ORIGIN],
    fetcher: fakeFetcher(
      {
        [`${FORUM}/t/5.json`]: { id: 5, slug: "grant-wiki", title: "Grant", posts_count: 45, post_stream: { stream, posts: stream.slice(0, 20).map(post) } },
        [`${FORUM}/t/5/posts.json`]: { post_stream: { posts: stream.slice(20, 40).reverse().map(post) } },
      },
      calls,
    ),
  });
  const { server, base } = await serve(handler);
  try {
    const first = await (await fetch(`${base}/content/forum/topics/5`)).json();
    assert.equal(first.posts.length, 20);
    assert.equal(first.nextOffset, 20);
    assert.equal(first.stream, undefined, "post id stream stays server-side");
    assert.ok(!JSON.stringify(first).includes("Real Name"));

    const second = await (await fetch(`${base}/content/forum/topics/5?offset=20`)).json();
    assert.equal(calls.at(-1), `${FORUM}/t/5/posts.json?${stream.slice(20, 40).map((id) => `post_ids[]=${id}`).join("&")}`);
    assert.deepEqual(second.posts.map((p: { postNumber: number }) => p.postNumber).slice(0, 2), [21, 22], "sorted by post number");
    assert.equal(second.nextOffset, 40);
    assert.equal((await fetch(`${base}/content/forum/topics/5?offset=45`)).status, 404);
  } finally {
    server.close();
  }
});

test("gateway validates and rate-limits forum search", async () => {
  let clock = 0;
  const calls: string[] = [];
  const handler = createCommunityContentHandler({ allowedOrigins: [ORIGIN], fetcher: fakeFetcher({ [`${FORUM}/search.json`]: { posts: [], topics: [] } }, calls), now: () => clock });
  const { server, base } = await serve(handler);
  try {
    assert.equal((await fetch(`${base}/content/forum/search?q=a`)).status, 400);
    assert.equal((await fetch(`${base}/content/forum/search?q=${"x".repeat(101)}`)).status, 400);
    const ok = await (await fetch(`${base}/content/forum/search?q=${encodeURIComponent("zechub  grants")}`)).json();
    assert.equal(ok.query, "zechub grants");
    assert.equal(calls.at(-1), `${FORUM}/search.json?q=zechub%20grants`);

    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await fetch(`${base}/content/forum/search?q=term${i}`)).status);
    assert.ok(statuses.includes(429), "uncached searches are capped per minute");
    assert.equal((await fetch(`${base}/content/forum/search?q=zechub%20grants`)).status, 200, "cached searches still answer");
    clock = 61_000;
    assert.equal((await fetch(`${base}/content/forum/search?q=fresh`)).status, 200, "budget refills");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- wiki index + z.cash learn

const TREE = [
  { path: "Start_Here", type: "tree" },
  { path: "Start_Here/What_is_ZEC_and_Zcash.md", type: "blob" },
  { path: "guides/visualizing-zcash-addresses.md", type: "blob" },
  { path: "Research/zcash-foundations-series/article-1/article-1-finite-fields.md", type: "blob" },
  { path: "zechubglobal/tr/Start_Here/Zcash_Nedir.md", type: "blob" },
  { path: "archive/Old.md", type: "blob" },
  { path: "footer.md", type: "blob" },
  { path: "guides/image.png", type: "blob" },
  ...Array.from({ length: 20 }, (_, i) => ({ path: `Zcash_Tech/Topic_${i}.md`, type: "blob" })),
];

test("wiki tree → English articles only, curated titles kept, readable titles otherwise", () => {
  const items = mapWikiTree(TREE);
  const paths = items.map((item) => item.path);
  assert.ok(paths.includes("site/guides/visualizing-zcash-addresses.md"));
  assert.ok(!paths.some((path) => /zechubglobal|archive|footer|\.png/.test(path)));
  assert.equal(items[0]!.title, "What is ZEC and Zcash?", "curated title, Start Here first");
  assert.equal(items[0]!.id, "what-is-zec");
  const research = items.find((item) => item.path.includes("finite-fields"))!;
  assert.equal(research.title, "1. Finite Fields");
  assert.equal(research.group, "Zcash Foundations Series");
  assert.equal(research.url, "https://zechub.wiki/research/zcash-foundations-series/article-1/article-1-finite-fields");
  assert.equal(prettifyWikiName("Is_Zcash_Post_Quantum"), "Is Zcash Post Quantum");
  assert.equal(prettifyWikiName("zcash-and-the-law"), "Zcash and the Law");
  for (const bad of ["site/../package.json", "site/zechubglobal/tr/x.md", "site/x.md", "README.md", "site/a//b.md", "site/guides/x.md?raw"]) {
    assert.equal(isWikiArticlePath(bad), false, bad);
  }
});

test("gateway serves the full wiki index and only fetches pages that are in it", async () => {
  const sha = "a".repeat(40);
  const calls: string[] = [];
  const handler = createCommunityContentHandler({
    allowedOrigins: [ORIGIN],
    fetcher: fakeFetcher(
      {
        "https://api.github.com/repos/ZecHub/zechub/git/trees/HEAD": { tree: [{ path: "site", type: "tree", sha }] },
        [`https://api.github.com/repos/ZecHub/zechub/git/trees/${sha}`]: { tree: TREE },
        "https://raw.githubusercontent.com/ZecHub/zechub/HEAD/site/guides/": "# Visualizing",
      },
      calls,
    ),
  });
  const { server, base } = await serve(handler);
  try {
    const index = await (await fetch(`${base}/content/wiki`)).json();
    assert.equal(index.complete, true);
    assert.equal(index.items.length, 23);

    const page = await (await fetch(`${base}/content/wiki/page?path=${encodeURIComponent("site/guides/visualizing-zcash-addresses.md")}`)).json();
    assert.equal(page.markdown, "# Visualizing");
    assert.equal(page.editUrl, "https://github.com/ZecHub/zechub/edit/main/site/guides/visualizing-zcash-addresses.md");

    const before = calls.length;
    for (const path of ["site/guides/not-listed.md", "site/../LICENSE", "site/zechubglobal/tr/Start_Here/Zcash_Nedir.md"]) {
      assert.equal((await fetch(`${base}/content/wiki/page?path=${encodeURIComponent(path)}`)).status, 404, path);
    }
    assert.equal(calls.length, before, "no upstream request for paths outside the index");
  } finally {
    server.close();
  }
});

test("wiki index falls back to the curated list when GitHub is unreachable", async () => {
  const handler = createCommunityContentHandler({ allowedOrigins: [ORIGIN], fetcher: fakeFetcher({ "https://api.github.com": new Error("rate limited") }) });
  const { server, base } = await serve(handler);
  try {
    const index = await (await fetch(`${base}/content/wiki`)).json();
    assert.equal(index.complete, false);
    assert.equal(index.items.length, 17);
  } finally {
    server.close();
  }
});

test("z.cash Learn is an index of links to z.cash (no upstream fetch)", async () => {
  const calls: string[] = [];
  const handler = createCommunityContentHandler({ allowedOrigins: [ORIGIN], fetcher: fakeFetcher({}, calls) });
  const { server, base } = await serve(handler);
  try {
    const learn = await (await fetch(`${base}/content/zcash-learn`)).json();
    assert.equal(learn.mode, "index");
    assert.ok(learn.items.length >= 20);
    assert.ok(learn.items.every((item: { url: string }) => /^https:\/\/z\.cash\/learn\/[a-z0-9-]+\/$/.test(item.url)));
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- images + jump to post

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function binaryFetcher(bodies: Record<string, Uint8Array | Error>, calls: { url: string; redirect?: string }[] = []): Fetcher {
  return async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    const body = bodies[url];
    if (!body) return { ok: false, status: 404, text: async () => "" };
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => body.slice().buffer };
  };
}

test("media allowlist: forum/wiki/listed-repo images only, never avatars, traversal or other hosts", () => {
  assert.ok(allowedMediaUrl("https://global.discourse-cdn.com/zcash/original/3X/6/1/abc.jpeg"));
  assert.ok(allowedMediaUrl("https://zechub.wiki/content-images/logo.webp"));
  assert.ok(allowedMediaUrl("https://emoji.discourse-cdn.com/twitter/heart.png?v=12"));
  assert.ok(allowedMediaUrl("https://raw.githubusercontent.com/ZecHub/zechub/HEAD/assets/x.png"));
  for (const bad of [
    "http://zechub.wiki/content-images/x.png",
    "https://zechub.wiki/api/secret",
    "https://global.discourse-cdn.com/other-forum/x.png",
    "https://global.discourse-cdn.com/zcash/user_avatar/forum.zcashcommunity.com/u/96/1.png",
    "https://zechub.wiki/content-images/../api/x",
    "https://zechub.wiki/content-images/%2e%2e/api",
    "https://raw.githubusercontent.com/evil/repo/HEAD/x.png",
    "https://user:pw@zechub.wiki/content-images/x.png",
    "https://zechub.wiki:8443/content-images/x.png",
    "https://zechub.wiki.evil.example/content-images/x.png",
    "javascript:alert(1)",
  ]) {
    assert.equal(allowedMediaUrl(bad), null, bad);
  }
});

test("image sniffing accepts PNG/JPEG/GIF/WebP and rejects SVG/HTML", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageType(new TextEncoder().encode("<svg xmlns=")), null);
  assert.equal(sniffImageType(new TextEncoder().encode("<html>")), null);
});

test("gateway relays allowlisted images (cached, no redirects) and refuses everything else", async () => {
  const good = "https://zechub.wiki/content-images/logo.png";
  const svg = "https://zechub.wiki/content-images/logo.svg";
  const calls: { url: string; redirect?: string }[] = [];
  const handler = createCommunityContentHandler({
    allowedOrigins: [ORIGIN],
    fetcher: binaryFetcher({ [good]: PNG, [svg]: new TextEncoder().encode('<svg onload="x()">') }, calls),
  });
  const { server, base } = await serve(handler);
  try {
    const media = (url: string) => fetch(`${base}/content/media?url=${encodeURIComponent(url)}`);
    const ok = await media(good);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), PNG);
    await media(good);
    assert.equal(calls.length, 1, "second load comes from the cache");
    assert.equal(calls[0]!.redirect, "error", "redirects are never followed");

    assert.equal((await media(svg)).status, 415, "SVG is not relayed");
    const before = calls.length;
    assert.equal((await media("https://tracker.example/p.gif")).status, 404);
    assert.equal((await fetch(`${base}/content/media`)).status, 404);
    assert.equal(calls.length, before, "no upstream request for non-allowlisted URLs");
  } finally {
    server.close();
  }
});

test("gateway jumps to a post inside a long thread and reports earlier/later chunks", async () => {
  const stream = Array.from({ length: 59 }, (_, i) => 500 + i);
  const post = (id: number) => ({ id, post_number: id - 499, username: `u${id}`, cooked: "<p>x</p>" });
  const calls: string[] = [];
  const handler = createCommunityContentHandler({
    allowedOrigins: [ORIGIN],
    fetcher: fakeFetcher(
      {
        [`${FORUM}/t/9.json`]: { id: 9, slug: "long", title: "Long", posts_count: 59, post_stream: { stream, posts: stream.slice(0, 20).map(post) } },
        [`${FORUM}/t/9/30.json`]: { id: 9, post_stream: { stream, posts: stream.slice(24, 44).map(post) } },
      },
      calls,
    ),
  });
  const { server, base } = await serve(handler);
  try {
    const around = await (await fetch(`${base}/content/forum/topics/9?post=30`)).json();
    assert.ok(calls.includes(`${FORUM}/t/9/30.json`));
    assert.equal(around.posts[0].postNumber, 25);
    assert.equal(around.offset, 24);
    assert.equal(around.prevOffset, 4);
    assert.equal(around.nextOffset, 44);
    assert.equal(around.title, "Long");
  } finally {
    server.close();
  }
});
