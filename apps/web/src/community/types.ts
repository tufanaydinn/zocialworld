/** Shapes returned by the server gateway (mirrors apps/server/src/content/communityContent.ts). */

export interface Bounty {
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

export interface WikiArticleMeta {
  /** Curated short id ("" for articles that are only in the full index). */
  readonly id: string;
  readonly title: string;
  readonly section: string;
  /** Sub-folder inside the section (e.g. a research series), "" if none. */
  readonly group: string;
  /** Path inside ZecHub/zechub — what `wikiPage()` opens. */
  readonly path: string;
  readonly url: string;
  readonly urlTr: string;
}

export interface WikiIndex extends Listing<WikiArticleMeta> {
  /** false: GitHub couldn't be reached, so only the curated articles are listed. */
  readonly complete?: boolean;
}

export interface WikiArticle extends WikiArticleMeta {
  readonly markdown: string;
  readonly license: string;
  readonly editUrl: string;
}

export interface ForumTopic {
  readonly id: number;
  readonly title: string;
  readonly excerpt: string;
  readonly postsCount: number;
  readonly views: number;
  readonly likes: number;
  readonly createdAt: string;
  readonly lastPostedAt: string;
  readonly pinned: boolean;
  readonly closed?: boolean;
  readonly categoryId?: number | null;
  readonly url: string;
}

export interface ForumPost {
  readonly id: number;
  readonly postNumber: number;
  readonly username: string;
  readonly createdAt: string;
  readonly html: string;
  readonly likes: number;
}

export interface ForumThread {
  readonly title: string;
  readonly url: string;
  readonly postsCount: number;
  readonly categoryId?: number | null;
  readonly posts: readonly ForumPost[];
  /** Offset of these posts in the thread; `nextOffset` loads the next chunk (null at the end). */
  readonly offset?: number;
  readonly nextOffset?: number | null;
  /** Offset of the chunk before these posts (after a jump to a post), null at the start. */
  readonly prevOffset?: number | null;
}

export interface ForumCategory {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** Six hex digits without '#', or "". */
  readonly color: string;
  readonly topicCount: number;
  readonly parentId: number | null;
  readonly url: string;
  readonly subcategories: readonly ForumCategory[];
}

export interface ForumCategories extends Listing<ForumCategory> {
  readonly grantsCategoryId?: number;
}

export interface ForumCategoryPage extends Listing<ForumTopic> {
  readonly category: ForumCategory & { readonly parent: { readonly id: number; readonly name: string } | null };
  readonly page: number;
  readonly hasMore: boolean;
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

export interface ForumSearch extends Listing<ForumSearchHit> {
  readonly query: string;
  readonly hasMore: boolean;
}

/** A z.cash/learn article — an index entry only (title, our own summary); it opens on z.cash. */
export interface ZcashLearnArticle {
  readonly slug: string;
  readonly title: string;
  readonly topic: string;
  readonly summary: string;
  readonly url: string;
}

export interface RepoSummary {
  readonly fullName: string;
  readonly blurb: string;
  readonly url: string;
}

export interface RepoDetail extends RepoSummary {
  readonly stats: {
    readonly description: string;
    readonly stars: number | null;
    readonly forks: number | null;
    readonly openIssues: number | null;
    readonly license: string;
    readonly pushedAt: string;
    readonly homepage: string;
    readonly topics: readonly string[];
  } | null;
  readonly latestRelease: { readonly name: string; readonly tag: string; readonly publishedAt: string; readonly url: string } | null;
  readonly contributors: readonly string[];
  readonly readme: string;
}

export interface Listing<T> {
  /** false when the gateway couldn't reach the upstream source (items is then empty). */
  readonly available?: boolean;
  readonly items: readonly T[];
  readonly source?: string;
  readonly sourceUrl?: string;
  readonly stale?: boolean;
  readonly license?: string;
}
