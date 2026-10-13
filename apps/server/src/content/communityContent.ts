import type { IncomingMessage, ServerResponse } from "node:http";
import { isOriginAllowed } from "../origin.js";
import {
  BOUNTIES_API,
  bountyPageUrl,
  FORUM_CATEGORY,
  FORUM_GRANTS_CATEGORY_ID,
  FORUM_MAX_PAGE,
  FORUM_ORIGIN,
  GITHUB_API,
  GITHUB_RAW,
  GITHUB_REPOS,
  MEDIA_MAX_BYTES,
  allowedMediaUrl,
  WIKI_ARTICLES,
  WIKI_EXCLUDED_DIRS,
  WIKI_LICENSE,
  WIKI_REPO,
  WIKI_SECTIONS,
  wikiPageUrl,
  ZCASH_LEARN_ARTICLES,
  ZCASH_LEARN_ORIGIN,
} from "./sources.js";
import { createWatchSource, unavailableListing, watchPageParam } from "./watch.js";
import { SAMPLE_WATCH_CATALOG } from "./watchCatalog.sample.js";
import type { WatchCatalog } from "./watchCatalogTypes.js";

/**
 * Read-only community content gateway: `GET /content/*`.
 *
 * Lets the world show ZecHub bounties, the whole ZecHub wiki, every
 * public Zcash Community Forum category (Community Grants first) with
 * full threads and search, and GitHub repositories INSIDE the game
 * without the browser ever contacting those third parties. None of it
 * needs an API key — all are public, read-only endpoints:
 *
 *  - privacy: upstream services see this server, never a player's IP or
 *    browser fingerprint (docs/privacy/PRIVACY_MODEL.md — minimize network
 *    metadata exposure);
 *  - safety: only allowlisted upstream URLs are fetched (see sources.ts),
 *    responses are reshaped into small typed JSON with length caps, and
 *    personal fields (real names, avatars, emails, wallet addresses) are
 *    dropped — public forum handles are the only identity kept;
 *  - load: every upstream response is cached (default 10 min; category
 *    list and wiki index for hours) and concurrent requests share one
 *    in-flight fetch; if an upstream fails, the last good copy is served
 *    (marked `stale: true`). Forum search — the only route a client can
 *    steer with free text — is additionally capped per minute;
 *  - images: `/content/media?url=` relays pictures from a short host +
 *    path allowlist (sources.ts MEDIA_SOURCES) so posts and articles show
 *    them in-game; raster only (bytes sniffed, no SVG), no redirects,
 *    size-capped, byte-budgeted cache, uncached fetches capped per minute;
 *  - watch: `/content/watch*` serves the Watch Hall schedule, live status
 *    and replay catalogue (watch.ts; YouTube API only with a server key).
 *
 * Posting (forum replies, likes) is deliberately NOT implemented here: it
 * needs per-player forum authorization (Discourse User API keys) relayed
 * through this server — a write path that would need its own design and
 * threat model first.
 */

export interface UpstreamResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  /** Binary body — only needed for `/content/media`. */
  arrayBuffer?(): Promise<ArrayBuffer>;
}
export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect?: "follow" | "error" },
) => Promise<UpstreamResponse>;

export interface CommunityContentOptions {
  readonly allowedOrigins: readonly string[];
  readonly fetcher?: Fetcher;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Optional GitHub token for higher API rate limits (server-side env only; never sent to clients). */
  readonly githubToken?: string;
  /** Optional YouTube Data API key for Watch Hall live status (server-side env only; never logged, cached by, or sent to clients). */
  readonly youtubeApiKey?: string;
  /** What `/content/watch*` may list (default: the sample catalogue). */
  readonly watchCatalog?: WatchCatalog;
}

const USER_AGENT = "zocial-world-content-gateway/1.0 (+read-only community board)";
/** Uncached forum searches allowed per minute, across all players (cached repeats are free). */
const SEARCH_PER_MINUTE = 20;
const FORUM_POSTS_CHUNK = 20;
/** Uncached image fetches per minute, and the in-memory image cache budget. */
const MEDIA_PER_MINUTE = 150;
const MEDIA_CACHE_BYTES = 48_000_000;
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

/** Raster image type from the first bytes (PNG, JPEG, GIF, WebP) — never trusts the upstream Content-Type; SVG is rejected. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]): boolean => sig.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}
const TIMEOUT_MS = 8000;
const MAX_UPSTREAM_BYTES = 2_000_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/** Strips control characters and caps length — every string that leaves this gateway passes through here. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function cleanNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const CLOSED_BOUNTY_STATES = new Set(["DONE", "COMPLETED", "CANCELLED", "CANCELED", "CLOSED", "REJECTED"]);

export interface BountyItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly amountZec: number | null;
  readonly status: string;
  readonly category: string;
  readonly difficulty: string;
  readonly createdAt: string;
  readonly dueAt: string;
  readonly url: string;
}

export function mapBounties(payload: unknown): BountyItem[] {
  const list = (payload as { data?: unknown })?.data;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object" && !(item as { isPrivate?: boolean }).isPrivate)
    .map((raw) => {
      const item = raw as Record<string, unknown>;
      const id = cleanText(item.id, 64);
      return {
        id,
        title: cleanText(item.title, 160),
        description: cleanText(item.description, 6000),
        amountZec: cleanNumber(item.bountyAmount),
        status: cleanText(item.status, 32),
        category: cleanText(item.categoryId, 64),
        difficulty: cleanText(item.difficulty, 32),
        createdAt: cleanText(item.dateCreated, 40),
        dueAt: cleanText(item.timeToComplete, 40),
        url: bountyPageUrl(id),
      };
    })
    .filter((item) => item.id && item.title && !CLOSED_BOUNTY_STATES.has(item.status.toUpperCase()));
}

export interface ForumTopicItem {
  readonly id: number;
  readonly title: string;
  readonly excerpt: string;
  readonly postsCount: number;
  readonly views: number;
  readonly likes: number;
  readonly createdAt: string;
  readonly lastPostedAt: string;
  readonly pinned: boolean;
  readonly closed: boolean;
  readonly categoryId: number | null;
  readonly url: string;
}

export function mapForumTopics(payload: unknown): ForumTopicItem[] {
  const topics = (payload as { topic_list?: { topics?: unknown } })?.topic_list?.topics;
  if (!Array.isArray(topics)) return [];
  return topics
    .map((raw) => {
      const topic = raw as Record<string, unknown>;
      const id = cleanNumber(topic.id) ?? 0;
      const slug = cleanText(topic.slug, 200).replace(/[^a-z0-9-]/gi, "");
      return {
        id,
        title: cleanText(topic.title, 200),
        excerpt: stripTags(cleanText(topic.excerpt, 600)),
        postsCount: cleanNumber(topic.posts_count) ?? 0,
        views: cleanNumber(topic.views) ?? 0,
        likes: cleanNumber(topic.like_count) ?? 0,
        createdAt: cleanText(topic.created_at, 40),
        lastPostedAt: cleanText(topic.last_posted_at, 40),
        pinned: topic.pinned === true,
        closed: topic.closed === true,
        categoryId: cleanNumber(topic.category_id),
        url: topicUrl(slug, id),
      };
    })
    .filter((topic) => topic.id > 0 && topic.title);
}

export interface ForumPostItem {
  readonly id: number;
  readonly postNumber: number;
  readonly username: string;
  readonly createdAt: string;
  /** Discourse "cooked" HTML — the client sanitizes it (DOMPurify) and strips media before rendering. */
  readonly html: string;
  readonly likes: number;
}

export interface ForumThreadItem {
  readonly title: string;
  readonly url: string;
  readonly postsCount: number;
  readonly categoryId: number | null;
  readonly posts: ForumPostItem[];
  /** Every post id in reading order (Discourse `post_stream.stream`) — used to page through long threads; not sent to clients. */
  readonly stream: number[];
}

const topicUrl = (slug: string, id: number): string => `${FORUM_ORIGIN}/t/${slug || "topic"}/${id}`;
const cleanSlug = (value: unknown): string => cleanText(value, 200).replace(/[^a-z0-9-]/gi, "");

/** Maps Discourse posts (from `/t/{id}.json` or `/t/{id}/posts.json`), in post order, keeping only public fields. */
export function mapForumPosts(payload: unknown): ForumPostItem[] {
  const posts = (payload as { post_stream?: { posts?: unknown } } | null)?.post_stream?.posts;
  return (Array.isArray(posts) ? posts : [])
    .slice(0, 50)
    .map((raw) => {
      const post = raw as Record<string, unknown>;
      const likes = Array.isArray(post.actions_summary)
        ? (post.actions_summary as { id?: number; count?: number }[]).find((action) => action.id === 2)?.count ?? 0
        : 0;
      return {
        id: cleanNumber(post.id) ?? 0,
        postNumber: cleanNumber(post.post_number) ?? 0,
        username: cleanText(post.username, 60),
        createdAt: cleanText(post.created_at, 40),
        html: cleanText(post.cooked, 40000),
        likes,
      };
    })
    .filter((post) => post.id > 0)
    .sort((a, b) => a.postNumber - b.postNumber);
}

export function mapForumThread(payload: unknown): ForumThreadItem | null {
  const thread = payload as Record<string, unknown> | null;
  if (!thread || typeof thread !== "object") return null;
  const id = cleanNumber(thread.id) ?? 0;
  const rawStream = (thread.post_stream as { stream?: unknown })?.stream;
  const posts = mapForumPosts(thread);
  return {
    title: cleanText(thread.title, 200),
    url: topicUrl(cleanSlug(thread.slug), id),
    postsCount: cleanNumber(thread.posts_count) ?? 0,
    categoryId: cleanNumber(thread.category_id),
    posts,
    stream: Array.isArray(rawStream) ? rawStream.filter((value): value is number => Number.isInteger(value) && value > 0).slice(0, 20000) : posts.map((post) => post.id),
  };
}

export interface ForumCategoryItem {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** Six hex digits (no #), or "" if the forum sent something else. */
  readonly color: string;
  readonly topicCount: number;
  readonly parentId: number | null;
  readonly url: string;
  readonly subcategories: ForumCategoryItem[];
}

/** `/categories.json?include_subcategories=true` → public categories with their subcategories (restricted ones dropped). */
export function mapForumCategories(payload: unknown): ForumCategoryItem[] {
  const list = (payload as { category_list?: { categories?: unknown } } | null)?.category_list?.categories;
  if (!Array.isArray(list)) return [];
  const map = (raw: unknown, parent: { id: number; slug: string } | null): ForumCategoryItem | null => {
    const category = raw as Record<string, unknown> | null;
    if (!category || typeof category !== "object" || category.read_restricted === true) return null;
    const id = cleanNumber(category.id) ?? 0;
    const slug = cleanSlug(category.slug).toLowerCase();
    const name = cleanText(category.name, 80);
    if (id <= 0 || !slug || !name) return null;
    const color = typeof category.color === "string" && /^[0-9a-f]{6}$/i.test(category.color) ? category.color.toLowerCase() : "";
    const self = { id, slug };
    const children = parent ? [] : (Array.isArray(category.subcategory_list) ? category.subcategory_list : []).map((child) => map(child, self));
    return {
      id,
      slug,
      name,
      description: cleanText(typeof category.description_text === "string" ? stripTags(category.description_text) : "", 300),
      color,
      topicCount: cleanNumber(category.topic_count) ?? 0,
      parentId: parent?.id ?? null,
      url: parent ? `${FORUM_ORIGIN}/c/${parent.slug}/${slug}/${id}` : `${FORUM_ORIGIN}/c/${slug}/${id}`,
      subcategories: children.filter((child): child is ForumCategoryItem => child !== null),
    };
  };
  return list.map((raw) => map(raw, null)).filter((category): category is ForumCategoryItem => category !== null);
}

export interface ForumSearchHit {
  readonly topicId: number;
  readonly topicTitle: string;
  readonly categoryId: number | null;
  readonly postNumber: number;
  readonly username: string;
  readonly createdAt: string;
  readonly blurb: string;
  readonly likes: number;
  readonly url: string;
}

/** `/search.json` → matching posts with their topic. Display names and avatars are dropped; public handles stay. */
export function mapForumSearch(payload: unknown): { hits: ForumSearchHit[]; hasMore: boolean } {
  const result = payload as { posts?: unknown; topics?: unknown; grouped_search_result?: { more_full_page_results?: unknown } } | null;
  const topics = new Map<number, { title: string; slug: string; categoryId: number | null }>();
  for (const raw of Array.isArray(result?.topics) ? result.topics : []) {
    const topic = raw as Record<string, unknown>;
    const id = cleanNumber(topic.id);
    if (id) topics.set(id, { title: cleanText(topic.title, 200), slug: cleanSlug(topic.slug), categoryId: cleanNumber(topic.category_id) });
  }
  const hits = (Array.isArray(result?.posts) ? result.posts : [])
    .slice(0, 50)
    .map((raw) => {
      const post = raw as Record<string, unknown>;
      const topicId = cleanNumber(post.topic_id) ?? 0;
      const topic = topics.get(topicId);
      const postNumber = cleanNumber(post.post_number) ?? 1;
      return {
        topicId,
        topicTitle: topic?.title ?? "",
        categoryId: topic?.categoryId ?? null,
        postNumber,
        username: cleanText(post.username, 60),
        createdAt: cleanText(post.created_at, 40),
        blurb: cleanText(stripTags(typeof post.blurb === "string" ? post.blurb : ""), 400),
        likes: cleanNumber(post.like_count) ?? 0,
        url: `${topicUrl(topic?.slug ?? "", topicId)}${postNumber > 1 ? `/${postNumber}` : ""}`,
      };
    })
    .filter((hit) => hit.topicId > 0 && hit.topicTitle);
  return { hits, hasMore: result?.grouped_search_result?.more_full_page_results === true };
}

export interface WikiIndexItem {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  /** Sub-folder inside the section (e.g. a research series), if any. */
  readonly group: string;
  /** Path inside ZecHub/zechub. */
  readonly path: string;
  readonly url: string;
  readonly urlTr: string;
}

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"]);

/** "article-1-finite-fields" → "1. Finite Fields"; "Is_Zcash_Post_Quantum" → "Is Zcash Post Quantum". */
export function prettifyWikiName(name: string): string {
  const numbered = /^article-(\d+)-(.*)$/i.exec(name);
  const words = (numbered ? numbered[2]! : name).split(/[_\s-]+/).filter(Boolean);
  const title = words
    .map((word, index) => (word === word.toLowerCase() && (index === 0 || !SMALL_WORDS.has(word)) ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
  return numbered ? `${numbered[1]}. ${title}` : title;
}

const WIKI_PATH = /^site\/[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,200}\.md$/;

/** Is this a plausible English wiki article path (no traversal, no translations/archive)? */
export function isWikiArticlePath(path: string): boolean {
  if (!WIKI_PATH.test(path) || path.includes("..") || path.includes("//")) return false;
  const parts = path.split("/");
  return parts.length >= 3 && !WIKI_EXCLUDED_DIRS.includes(parts[1]!);
}

/** Builds the article index from the recursive git tree of `site/` (paths relative to site/), merged with the curated list. */
export function mapWikiTree(entries: unknown): WikiIndexItem[] {
  const curated = new Map(WIKI_ARTICLES.map((article) => [article.path, article]));
  const sectionOrder = new Map(WIKI_SECTIONS.map((section, index) => [section.dir, index]));
  const items: WikiIndexItem[] = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = raw as { path?: unknown; type?: unknown };
    if (entry.type !== "blob" || typeof entry.path !== "string") continue;
    const path = `site/${entry.path}`;
    if (!isWikiArticlePath(path)) continue;
    const parts = entry.path.split("/");
    const dir = parts[0]!;
    const known = curated.get(path);
    items.push({
      id: known?.id ?? "",
      title: cleanText(known?.title ?? prettifyWikiName(parts[parts.length - 1]!.replace(/\.md$/i, "")), 160),
      section: WIKI_SECTIONS.find((section) => section.dir === dir)?.name ?? prettifyWikiName(dir),
      group: parts.length > 2 ? prettifyWikiName(parts.slice(1, -1).filter((part) => !/^article-\d+$/i.test(part)).join(" ")) : "",
      path,
      url: wikiPageUrl(path),
      urlTr: wikiPageUrl(path, "tr"),
    });
    if (items.length >= 2000) break;
  }
  const rank = (item: WikiIndexItem): number => sectionOrder.get(item.path.split("/")[1]!) ?? WIKI_SECTIONS.length;
  return items.sort((a, b) => rank(a) - rank(b) || a.section.localeCompare(b.section) || a.group.localeCompare(b.group) || a.path.localeCompare(b.path));
}

const curatedWikiIndex = (): WikiIndexItem[] =>
  WIKI_ARTICLES.map((article) => ({ ...article, group: "", url: wikiPageUrl(article.path), urlTr: wikiPageUrl(article.path, "tr") }));

export interface RepoInfo {
  readonly fullName: string;
  readonly blurb: string;
  readonly url: string;
  readonly stats: {
    readonly description: string;
    readonly stars: number | null;
    readonly forks: number | null;
    readonly openIssues: number | null;
    readonly license: string;
    readonly pushedAt: string;
    readonly homepage: string;
    readonly topics: string[];
  } | null;
  readonly latestRelease: { readonly name: string; readonly tag: string; readonly publishedAt: string; readonly url: string } | null;
  readonly contributors: string[];
  readonly readme: string;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function createCommunityContentHandler(options: CommunityContentOptions): (req: IncomingMessage, res: ServerResponse) => boolean {
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<unknown>>();

  async function upstreamText(url: string, accept: string, extraHeaders: Record<string, string> = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(url, { headers: { "User-Agent": USER_AGENT, Accept: accept, ...extraHeaders }, signal: controller.signal });
      if (!response.ok) throw new Error(`upstream ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_UPSTREAM_BYTES) throw new Error("upstream response too large");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  const upstreamJson = async (url: string, extraHeaders?: Record<string, string>): Promise<unknown> =>
    JSON.parse(await upstreamText(url, "application/json", extraHeaders));

  /** Cached + de-duplicated loader; serves the last good value (stale) if a refresh fails. */
  async function cached<T>(key: string, load: () => Promise<T>, ttl = ttlMs): Promise<{ value: T; stale: boolean }> {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > now()) return { value: entry.value as T, stale: false };
    let pending = inFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    try {
      const value = await pending;
      cache.set(key, { value, expiresAt: now() + ttl });
      if (cache.size > 2000) cache.delete(cache.keys().next().value!);
      return { value, stale: false };
    } catch (error) {
      if (entry) return { value: entry.value as T, stale: true };
      throw error;
    }
  }

  const githubHeaders = (): Record<string, string> => (options.githubToken ? { Authorization: `Bearer ${options.githubToken}` } : {});

  // ---- images (`/content/media`): byte-budgeted LRU cache, de-duplicated, rate-capped uncached fetches.
  const mediaCache = new Map<string, { bytes: Buffer; type: string; expiresAt: number }>();
  const mediaInFlight = new Map<string, Promise<{ bytes: Buffer; type: string }>>();
  let mediaBytes = 0;
  let mediaWindowStart = 0;
  let mediaInWindow = 0;

  async function loadMedia(url: string): Promise<{ bytes: Buffer; type: string }> {
    const hit = mediaCache.get(url);
    if (hit && hit.expiresAt > now()) {
      mediaCache.delete(url);
      mediaCache.set(url, hit); // most recently used last
      return hit;
    }
    let pending = mediaInFlight.get(url);
    if (!pending) {
      if (now() - mediaWindowStart >= 60_000) {
        mediaWindowStart = now();
        mediaInWindow = 0;
      }
      if (++mediaInWindow > MEDIA_PER_MINUTE) throw new TooManyRequests();
      pending = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          // No redirects: a redirect could point outside the allowlist.
          const response = await fetcher(url, { headers: { "User-Agent": USER_AGENT, Accept: "image/webp,image/png,image/jpeg,image/gif" }, signal: controller.signal, redirect: "error" });
          if (!response.ok || !response.arrayBuffer) throw new Error(`media upstream ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > MEDIA_MAX_BYTES) throw new TooLarge();
          const type = sniffImageType(bytes);
          if (!type) throw new UnsupportedMedia();
          return { bytes, type };
        } finally {
          clearTimeout(timer);
        }
      })().finally(() => mediaInFlight.delete(url));
      mediaInFlight.set(url, pending);
    }
    const value = await pending;
    if (hit) {
      mediaBytes -= hit.bytes.length;
      mediaCache.delete(url);
    }
    if (!mediaCache.has(url)) {
      mediaCache.set(url, { ...value, expiresAt: now() + MEDIA_TTL_MS });
      mediaBytes += value.bytes.length;
      for (const [key, entry] of mediaCache) {
        if (mediaBytes <= MEDIA_CACHE_BYTES) break;
        mediaCache.delete(key);
        mediaBytes -= entry.bytes.length;
      }
    }
    return value;
  }

  async function loadRepo(fullName: string, blurb: string): Promise<RepoInfo> {
    const settle = async <T>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
    const [repo, release, contributors, readme] = await Promise.all([
      settle(upstreamJson(`${GITHUB_API}/repos/${fullName}`, githubHeaders())),
      settle(upstreamJson(`${GITHUB_API}/repos/${fullName}/releases/latest`, githubHeaders())),
      settle(upstreamJson(`${GITHUB_API}/repos/${fullName}/contributors?per_page=6`, githubHeaders())),
      settle(upstreamText(`${GITHUB_RAW}/${fullName}/HEAD/README.md`, "text/plain")),
    ]);
    if (repo === null && readme === null) throw new Error(`github unavailable for ${fullName}`);
    const r = repo as Record<string, unknown> | null;
    const rel = release as Record<string, unknown> | null;
    return {
      fullName,
      blurb,
      url: `https://github.com/${fullName}`,
      stats: r
        ? {
            description: cleanText(r.description, 400),
            stars: cleanNumber(r.stargazers_count),
            forks: cleanNumber(r.forks_count),
            openIssues: cleanNumber(r.open_issues_count),
            license: cleanText((r.license as { spdx_id?: string } | null)?.spdx_id, 40),
            pushedAt: cleanText(r.pushed_at, 40),
            homepage: /^https:\/\//.test(String(r.homepage ?? "")) ? cleanText(r.homepage, 300) : "",
            topics: Array.isArray(r.topics) ? (r.topics as unknown[]).slice(0, 8).map((topic) => cleanText(topic, 40)) : [],
          }
        : null,
      latestRelease: rel
        ? {
            name: cleanText(rel.name, 120),
            tag: cleanText(rel.tag_name, 60),
            publishedAt: cleanText(rel.published_at, 40),
            url: `https://github.com/${fullName}/releases/tag/${encodeURIComponent(cleanText(rel.tag_name, 60))}`,
          }
        : null,
      contributors: Array.isArray(contributors)
        ? (contributors as { login?: unknown; type?: unknown }[])
            .filter((c) => c.type !== "Bot")
            .slice(0, 6)
            .map((c) => cleanText(c.login, 40))
        : [],
      readme: cleanText(readme ?? "", 60000),
    };
  }

  /** Category list and wiki index change rarely — cached 6× longer (1 h by default). */
  const longTtl = ttlMs * 6;

  const loadCategories = (): Promise<{ value: ForumCategoryItem[]; stale: boolean }> =>
    cached(
      "forum:categories",
      async () => {
        const categories = mapForumCategories(await upstreamJson(`${FORUM_ORIGIN}/categories.json?include_subcategories=true`));
        if (categories.length === 0) throw new Error("no forum categories");
        return categories;
      },
      longTtl,
    );

  async function forumCategoryPage(id: number, page: number): Promise<Record<string, unknown>> {
    const { value: categories } = await loadCategories();
    const parent = categories.find((category) => category.id === id || category.subcategories.some((sub) => sub.id === id));
    if (!parent) throw new NotFound();
    const category = parent.id === id ? parent : parent.subcategories.find((sub) => sub.id === id)!;
    const path = category.parentId === null ? `/c/${category.slug}/${id}` : `/c/${parent.slug}/${category.slug}/${id}`;
    const result = await cached(`forum:category:${id}:${page}`, async () => {
      const payload = await upstreamJson(`${FORUM_ORIGIN}${path}.json${page > 0 ? `?page=${page}` : ""}`);
      const moreUrl = (payload as { topic_list?: { more_topics_url?: unknown } } | null)?.topic_list?.more_topics_url;
      return { items: mapForumTopics(payload), hasMore: typeof moreUrl === "string" && moreUrl.length > 0 && page < FORUM_MAX_PAGE };
    });
    return {
      source: `Zcash Community Forum — ${category.name}`,
      sourceUrl: category.url,
      category: { ...category, subcategories: category.subcategories, parent: category.parentId === null ? null : { id: parent.id, name: parent.name } },
      page,
      hasMore: result.value.hasMore,
      stale: result.stale,
      items: result.value.items,
    };
  }

  // Forum search is the one route a client steers with free text, so uncached upstream searches are capped per minute.
  let searchWindowStart = 0;
  let searchesInWindow = 0;
  const takeSearchBudget = (): boolean => {
    if (now() - searchWindowStart >= 60_000) {
      searchWindowStart = now();
      searchesInWindow = 0;
    }
    return ++searchesInWindow <= SEARCH_PER_MINUTE;
  };

  /** Full wiki index from the repository tree; the curated list if GitHub can't be reached (and nothing is cached). */
  async function loadWikiIndex(): Promise<{ items: WikiIndexItem[]; complete: boolean; stale: boolean }> {
    try {
      const result = await cached(
        "wiki:index",
        async () => {
          const root = (await upstreamJson(`${GITHUB_API}/repos/${WIKI_REPO}/git/trees/HEAD`, githubHeaders())) as { tree?: { path?: unknown; type?: unknown; sha?: unknown }[] };
          const site = Array.isArray(root?.tree) ? root.tree.find((entry) => entry.path === "site" && entry.type === "tree") : undefined;
          if (typeof site?.sha !== "string" || !/^[0-9a-f]{40}$/.test(site.sha)) throw new Error("wiki tree: no site folder");
          const tree = (await upstreamJson(`${GITHUB_API}/repos/${WIKI_REPO}/git/trees/${site.sha}?recursive=1`, githubHeaders())) as { tree?: unknown };
          const items = mapWikiTree(tree?.tree);
          if (items.length < WIKI_ARTICLES.length) throw new Error("wiki tree: suspiciously small");
          return items;
        },
        longTtl,
      );
      return { items: result.value, complete: true, stale: result.stale };
    } catch (error) {
      console.warn("[content] wiki index falls back to the curated list:", error instanceof Error ? error.message : error);
      return { items: curatedWikiIndex(), complete: false, stale: false };
    }
  }

  type Route = (match: RegExpExecArray, query: URLSearchParams) => Promise<unknown>;

  /**
   * Listing endpoints back the in-world boards, which load on startup. An
   * unreachable upstream must not surface as an HTTP error in every
   * player's console, so listings degrade to `{ available: false, items: [] }`.
   */
  const listing = (load: () => Promise<Record<string, unknown>>): Route => async () => {
    try {
      return { available: true, ...(await load()) };
    } catch (error) {
      console.warn("[content] listing unavailable:", error instanceof Error ? error.message : error);
      return { available: false, items: [] };
    }
  };

  // Watch Hall listings: schedule, live status and replays from the server's catalogue — see watch.ts.
  const watch = createWatchSource({ catalog: options.watchCatalog ?? SAMPLE_WATCH_CATALOG, cached, upstreamText, now, ttlMs, ...(options.youtubeApiKey ? { youtubeApiKey: options.youtubeApiKey } : {}) });

  /** [pattern, handler, Cache-Control max-age in seconds (default 120)]. */
  const routes: [RegExp, Route, number?][] = [
    [
      /^\/content\/watch$/,
      async () => {
        try {
          return await watch.listing();
        } catch (error) {
          console.warn("[content] watch listing unavailable:", error instanceof Error ? error.name : "error");
          return unavailableListing(now());
        }
      },
      30, // live data
    ],
    [
      /^\/content\/watch\/collection\/([a-z0-9-]{1,48})$/,
      async (match, query) => {
        // Only listed collections — never an arbitrary playlist or channel.
        const page = await watch.collection(match[1]!, watchPageParam(query.get("page")));
        if (!page) throw new NotFound();
        return page;
      },
    ],
    [
      /^\/content\/bounties$/,
      listing(async () => {
        const result = await cached("bounties", async () => {
          const pages = await Promise.all([1, 2, 3].map((page) => upstreamJson(`${BOUNTIES_API}?page=${page}&limit=50`).catch(() => null)));
          // Pages can shift while new bounties are posted — de-duplicate by id.
          const seen = new Set<string>();
          const items = pages.flatMap((page) => mapBounties(page)).filter((item) => !seen.has(item.id) && seen.add(item.id));
          if (items.length === 0 && pages.every((page) => page === null)) throw new Error("bounties unavailable");
          return items;
        });
        return { source: "ZecHub Bounties", sourceUrl: "https://bounties.zechub.wiki/home", stale: result.stale, items: result.value };
      }),
    ],
    [
      /^\/content\/wiki$/,
      async () => {
        const index = await loadWikiIndex();
        return { source: "ZecHub Wiki", sourceUrl: "https://zechub.wiki", license: WIKI_LICENSE, complete: index.complete, stale: index.stale, items: index.items };
      },
    ],
    [
      /^\/content\/wiki\/page$/,
      async (_match, query) => {
        const path = query.get("path") ?? "";
        // Only paths that are in the index can be fetched — never an arbitrary file of the repository.
        if (!isWikiArticlePath(path)) throw new NotFound();
        const article = (await loadWikiIndex()).items.find((item) => item.path === path);
        if (!article) throw new NotFound();
        const result = await cached(`wiki:path:${path}`, () => upstreamText(`${GITHUB_RAW}/${WIKI_REPO}/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`, "text/plain"));
        return {
          ...article,
          license: WIKI_LICENSE,
          editUrl: `https://github.com/${WIKI_REPO}/edit/main/${path}`,
          stale: result.stale,
          markdown: cleanText(result.value, 80000),
        };
      },
    ],
    [
      /^\/content\/wiki\/([a-z0-9-]{1,64})$/,
      async (match) => {
        const article = WIKI_ARTICLES.find((candidate) => candidate.id === match[1]);
        if (!article) throw new NotFound();
        const result = await cached(`wiki:${article.id}`, () => upstreamText(`${GITHUB_RAW}/${WIKI_REPO}/HEAD/${article.path}`, "text/plain"));
        return {
          ...article,
          group: "",
          license: WIKI_LICENSE,
          url: wikiPageUrl(article.path),
          urlTr: wikiPageUrl(article.path, "tr"),
          editUrl: `https://github.com/${WIKI_REPO}/edit/main/${article.path}`,
          stale: result.stale,
          markdown: cleanText(result.value, 80000),
        };
      },
    ],
    [
      /^\/content\/forum\/zcash-apps$/,
      listing(async () => {
        const result = await cached("forum:category", async () =>
          mapForumTopics(await upstreamJson(`${FORUM_ORIGIN}/c/${FORUM_CATEGORY.slug}/${FORUM_CATEGORY.id}.json`)),
        );
        return {
          source: `Zcash Community Forum — ${FORUM_CATEGORY.title}`,
          sourceUrl: `${FORUM_ORIGIN}/c/${FORUM_CATEGORY.slug}/${FORUM_CATEGORY.id}`,
          stale: result.stale,
          items: result.value,
        };
      }),
    ],
    [
      /^\/content\/forum\/categories$/,
      listing(async () => {
        const result = await loadCategories();
        return {
          source: "Zcash Community Forum",
          sourceUrl: FORUM_ORIGIN,
          grantsCategoryId: FORUM_GRANTS_CATEGORY_ID,
          stale: result.stale,
          items: result.value,
        };
      }),
    ],
    [
      /^\/content\/forum\/category\/(\d{1,6})$/,
      async (match, query) => forumCategoryPage(Number(match[1]), pageParam(query.get("page"))),
    ],
    [/^\/content\/forum\/grants$/, async (_match, query) => forumCategoryPage(FORUM_GRANTS_CATEGORY_ID, pageParam(query.get("page")))],
    [
      /^\/content\/forum\/search$/,
      async (_match, query) => {
        const q = (query.get("q") ?? "").replace(/\s+/g, " ").trim();
        if (q.length < 2 || q.length > 100) throw new BadRequest();
        const key = `forum:search:${q.toLowerCase()}`;
        const fresh = cache.get(key);
        if (!(fresh && fresh.expiresAt > now()) && !inFlight.has(key) && !takeSearchBudget()) throw new TooManyRequests();
        const result = await cached(key, async () => mapForumSearch(await upstreamJson(`${FORUM_ORIGIN}/search.json?q=${encodeURIComponent(q)}`)));
        return { source: "Zcash Community Forum search", sourceUrl: `${FORUM_ORIGIN}/search?q=${encodeURIComponent(q)}`, query: q, stale: result.stale, hasMore: result.value.hasMore, items: result.value.hits };
      },
    ],
    [
      /^\/content\/forum\/topics\/(\d{1,10})$/,
      async (match, query) => {
        const id = match[1]!;
        const result = await cached(`forum:topic:${id}`, async () => {
          const thread = mapForumThread(await upstreamJson(`${FORUM_ORIGIN}/t/${id}.json`));
          if (!thread) throw new Error("topic unavailable");
          return thread;
        });
        const { stream, ...thread } = result.value;
        const postNumber = Number.parseInt(query.get("post") ?? "0", 10) || 0;
        if (postNumber > 1 && postNumber <= 100_000) {
          // Jump to a post (links like /t/slug/123/45, search hits): Discourse returns the posts around it.
          const around = await cached(`forum:topic:${id}:post:${postNumber}`, async () => mapForumPosts(await upstreamJson(`${FORUM_ORIGIN}/t/${id}/${postNumber}.json`)));
          const first = around.value[0] ? stream.indexOf(around.value[0].id) : -1;
          const start = first < 0 ? 0 : first;
          const next = start + around.value.length;
          return {
            ...thread,
            posts: around.value,
            offset: start,
            prevOffset: start > 0 ? Math.max(0, start - FORUM_POSTS_CHUNK) : null,
            nextOffset: next < stream.length ? next : null,
            stale: result.stale || around.stale,
          };
        }
        const offset = Math.min(Number.parseInt(query.get("offset") ?? "0", 10) || 0, 100_000);
        if (offset <= 0) {
          const next = thread.posts.length;
          return { ...thread, offset: 0, prevOffset: null, nextOffset: next > 0 && next < stream.length ? next : null, stale: result.stale };
        }
        if (offset >= stream.length) throw new NotFound();
        // Later posts: Discourse serves them by id, in chunks.
        const ids = stream.slice(offset, offset + FORUM_POSTS_CHUNK);
        const chunk = await cached(`forum:topic:${id}:${offset}`, async () =>
          mapForumPosts(await upstreamJson(`${FORUM_ORIGIN}/t/${id}/posts.json?${ids.map((postId) => `post_ids[]=${postId}`).join("&")}`)),
        );
        const next = offset + ids.length;
        return {
          ...thread,
          posts: chunk.value,
          offset,
          prevOffset: offset > 0 ? Math.max(0, offset - FORUM_POSTS_CHUNK) : null,
          nextOffset: next < stream.length ? next : null,
          stale: result.stale || chunk.stale,
        };
      },
    ],
    [
      /^\/content\/zcash-learn$/,
      async () => ({
        source: "Zcash Learn (z.cash)",
        sourceUrl: ZCASH_LEARN_ORIGIN,
        // See sources.ts: z.cash blocks automated access and publishes no content license, so only an index ships.
        mode: "index",
        items: ZCASH_LEARN_ARTICLES.map((article) => ({ ...article, url: `${ZCASH_LEARN_ORIGIN}${article.slug}/` })),
      }),
    ],
    [/^\/content\/github$/, async () => ({ items: GITHUB_REPOS.map((repo) => ({ ...repo, url: `https://github.com/${repo.fullName}` })) })],
    [
      /^\/content\/github\/([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_.-]{1,100})$/,
      async (match) => {
        const fullName = `${match[1]}/${match[2]}`;
        const entry = GITHUB_REPOS.find((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase());
        if (!entry) throw new NotFound();
        const result = await cached(`github:${entry.fullName}`, () => loadRepo(entry.fullName, entry.blurb));
        return { ...result.value, stale: result.stale };
      },
    ],
  ];

  return (req, res) => {
    const [path = "", search = ""] = (req.url ?? "").split("?", 2);
    if (!path.startsWith("/content")) return false;

    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, options.allowedOrigins)) {
      res.writeHead(403).end();
      return true;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.writeHead(204).end();
      return true;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET, OPTIONS" }).end();
      return true;
    }

    if (path === "/content/media") {
      const url = allowedMediaUrl(new URLSearchParams(search).get("url") ?? "");
      if (!url) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "not_found" }));
        return true;
      }
      loadMedia(url)
        .then(({ bytes, type }) => {
          res.writeHead(200, {
            "Content-Type": type,
            "Content-Length": String(bytes.length),
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "cross-origin",
          });
          res.end(bytes);
        })
        .catch((error: unknown) => {
          const [status, code] =
            error instanceof TooManyRequests ? [429, "rate_limited"] : error instanceof TooLarge ? [413, "too_large"] : error instanceof UnsupportedMedia ? [415, "unsupported_media"] : [502, "upstream_unavailable"];
          if (status === 502) console.warn("[content] media failed:", error instanceof Error ? error.message : error);
          res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: code }));
        });
      return true;
    }

    for (const [pattern, route, maxAge = 120] of routes) {
      const match = pattern.exec(path);
      if (!match) continue;
      route(match, new URLSearchParams(search))
        .then((body) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` });
          res.end(JSON.stringify(body));
        })
        .catch((error: unknown) => {
          const [status, code] =
            error instanceof NotFound ? [404, "not_found"] : error instanceof BadRequest ? [400, "bad_request"] : error instanceof TooManyRequests ? [429, "rate_limited"] : [502, "upstream_unavailable"];
          if (status === 502) console.warn(`[content] ${path} failed:`, error instanceof Error ? error.message : error);
          res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(status === 429 ? { "Retry-After": "60" } : {}) });
          res.end(JSON.stringify({ error: code }));
        });
      return true;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "not_found" }));
    return true;
  };
}

class NotFound extends Error {}
class BadRequest extends Error {}
class TooManyRequests extends Error {}
class TooLarge extends Error {}
class UnsupportedMedia extends Error {}

/** `?page=` for forum category listings: an integer 0..FORUM_MAX_PAGE (anything else → 0). */
function pageParam(value: string | null): number {
  const page = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(page) ? Math.max(0, Math.min(FORUM_MAX_PAGE, page)) : 0;
}
