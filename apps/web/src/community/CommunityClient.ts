import { getContentBaseUrl } from "./config.ts";
import type {
  Bounty,
  ForumCategories,
  ForumCategoryPage,
  ForumSearch,
  ForumThread,
  ForumTopic,
  Listing,
  RepoDetail,
  RepoSummary,
  WikiArticle,
  WikiIndex,
  ZcashLearnArticle,
} from "./types.ts";

/** Zcash Community Forum "Community Grants" category (the gateway also reports it as `grantsCategoryId`). */
export const GRANTS_CATEGORY_ID = 33;

/**
 * Thin typed client for the server's community content gateway, with a
 * per-session memo so reopening a panel never refetches.
 */
export class CommunityClient {
  private readonly base = getContentBaseUrl();
  private readonly memo = new Map<string, Promise<unknown>>();

  private get<T>(path: string): Promise<T> {
    let pending = this.memo.get(path) as Promise<T> | undefined;
    if (!pending) {
      pending = fetch(`${this.base}${path}`, { headers: { Accept: "application/json" } }).then(async (response) => {
        if (!response.ok) throw new Error(`content ${path} → ${response.status}`);
        const body = (await response.json()) as T & { available?: boolean };
        if (body.available === false) throw new Error(`content ${path} unavailable upstream`);
        return body;
      });
      // Failed loads are not memoized, so "Retry" really retries.
      pending.catch(() => this.memo.delete(path));
      this.memo.set(path, pending);
    }
    return pending;
  }

  bounties(): Promise<Listing<Bounty>> {
    return this.get("/bounties");
  }
  /** Every English ZecHub wiki article (curated list only while GitHub is unreachable). */
  wikiIndex(): Promise<WikiIndex> {
    return this.get("/wiki");
  }
  /** A curated article by short id (used by lessons). */
  wikiArticle(id: string): Promise<WikiArticle> {
    return this.get(`/wiki/${encodeURIComponent(id)}`);
  }
  /** Any article of the index, by its repository path. */
  wikiPage(path: string): Promise<WikiArticle> {
    return this.get(`/wiki/page?path=${encodeURIComponent(path)}`);
  }
  forumTopics(): Promise<Listing<ForumTopic>> {
    return this.get("/forum/zcash-apps");
  }
  forumCategories(): Promise<ForumCategories> {
    return this.get("/forum/categories");
  }
  forumCategory(id: number, page = 0): Promise<ForumCategoryPage> {
    return this.get(`/forum/category/${Math.trunc(id)}${page > 0 ? `?page=${Math.trunc(page)}` : ""}`);
  }
  /** A thread from the start, from a chunk offset, or around a post number (`post`). */
  forumThread(id: number, at: { offset?: number; post?: number } = {}): Promise<ForumThread> {
    const query = at.post && at.post > 1 ? `?post=${Math.trunc(at.post)}` : at.offset && at.offset > 0 ? `?offset=${Math.trunc(at.offset)}` : "";
    return this.get(`/forum/topics/${Math.trunc(id)}${query}`);
  }
  forumSearch(query: string): Promise<ForumSearch> {
    return this.get(`/forum/search?q=${encodeURIComponent(query.replace(/\s+/g, " ").trim().toLowerCase())}`);
  }
  zcashLearn(): Promise<Listing<ZcashLearnArticle>> {
    return this.get("/zcash-learn");
  }
  repos(): Promise<Listing<RepoSummary>> {
    return this.get("/github");
  }
  repo(fullName: string): Promise<RepoDetail> {
    const [owner, name] = fullName.split("/");
    return this.get(`/github/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`);
  }
}
