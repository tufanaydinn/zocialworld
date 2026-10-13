import { injectUiStyles } from "../ui/styles.ts";
import { GRANTS_CATEGORY_ID, type CommunityClient } from "./CommunityClient.ts";
import { routeLink, wikiSlug, type InGameTarget } from "./links.ts";
import { renderMarkdown, sanitizeHtml } from "./safeHtml.ts";
import type { Bounty, ForumCategory, ForumPost, ForumTopic, RepoSummary, WikiArticleMeta, ZcashLearnArticle } from "./types.ts";

/**
 * In-game Community Hub overlay: ZecHub bounties ("open work"), the whole
 * ZecHub wiki (searchable), the Zcash Community Forum (Community Grants
 * first, every public category, full threads, search), an index of
 * z.cash/learn articles and ecosystem GitHub repositories — browsed and
 * READ without leaving the game (z.cash articles open on z.cash). Every external action ("apply", "reply on forum", "open repo")
 * is an explicit new-tab link, never an embedded third-party page.
 *
 * All text comes from our server's content gateway and is rendered
 * through `safeHtml.ts` (DOMPurify, media stripped, https-only links).
 */

export type CommunityView = "bounties" | "wiki" | "forum" | "learn" | "github";

const FORUM_ORIGIN = "https://forum.zcashcommunity.com";

const TABS: { id: CommunityView; label: string }[] = [
  { id: "bounties", label: "Bounties" },
  { id: "wiki", label: "Wiki" },
  { id: "forum", label: "Forum & Grants" },
  { id: "learn", label: "Z.cash Learn" },
  { id: "github", label: "Open Source" },
];

export class CommunityPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  private readonly tabButtons = new Map<CommunityView, HTMLButtonElement>();
  private view: CommunityView = "bounties";
  private renderToken = 0;
  /** Wiki filter text, kept while reading an article so "Back" returns to the same results. */
  private wikiFilter = "";

  private readonly client: CommunityClient;

  constructor(container: HTMLElement, client: CommunityClient) {
    this.client = client;
    injectUiStyles();
    injectCommunityStyles();
    this.backdrop = el("div", "zw-ui zw-community-backdrop");
    const panel = el("div", "zw-panel zw-community");
    const header = el("div", "zw-community-header");
    const title = el("div", "zw-community-title");
    title.textContent = "Community Hub";
    const tabs = el("div", "zw-community-tabs");
    for (const tab of TABS) {
      const button = el("button", "zw-community-tab");
      button.textContent = tab.label;
      button.addEventListener("click", () => this.show(tab.id));
      this.tabButtons.set(tab.id, button);
      tabs.appendChild(button);
    }
    const close = el("button", "zw-button zw-community-close");
    close.textContent = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    header.append(title, tabs, close);
    this.body = el("div", "zw-community-body");
    this.footer = el("div", "zw-community-footer");
    panel.append(header, this.body, this.footer);
    this.backdrop.appendChild(panel);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });
    container.appendChild(this.backdrop);
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  open(view: CommunityView = this.view): void {
    document.exitPointerLock();
    this.backdrop.classList.add("visible");
    this.show(view);
  }

  close(): void {
    this.backdrop.classList.remove("visible");
  }

  /** Opens one ZecHub wiki article by repository path (e.g. from the wallet's faucet guide link). */
  openWikiArticle(path: string): void {
    this.open("wiki");
    void this.openTarget({ kind: "wikiPath", path }, () => void this.renderWikiIndex(), `https://github.com/ZecHub/zechub/blob/main/${path}`);
  }

  /**
   * Opens an https link in the Hub when it can show it itself (forum thread / category / search,
   * ZecHub wiki page, listed GitHub repository — community/links.ts), e.g. a Watch Hall speaker
   * card's forum link. Returns false when it can't: the caller then opens a new tab.
   */
  openLink(href: string): boolean {
    const target = routeLink(href);
    if (!target) return false;
    const view: CommunityView = target.kind === "repo" ? "github" : target.kind === "wiki" || target.kind === "wikiPath" ? "wiki" : "forum";
    this.open(view);
    void this.openTarget(target, () => this.show(view), href);
    return true;
  }

  dispose(): void {
    this.backdrop.remove();
  }

  private show(view: CommunityView): void {
    this.activateTab(view);
    if (view === "bounties") void this.renderBounties();
    else if (view === "wiki") void this.renderWikiIndex();
    else if (view === "forum") void this.renderForum();
    else if (view === "learn") void this.renderLearn();
    else void this.renderRepos();
  }

  private activateTab(view: CommunityView): void {
    this.view = view;
    for (const [id, button] of this.tabButtons) button.classList.toggle("active", id === view);
  }

  /**
   * After third-party HTML is inserted: links the Hub can show itself open
   * in-game (with `back` returning here); images that fail to load turn
   * back into a text note.
   */
  private wire(container: HTMLElement, back: () => void): void {
    for (const link of Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const target = routeLink(link.href);
      if (!target) continue;
      link.removeAttribute("target");
      link.classList.add("zw-ingame-link");
      link.title = "Opens here in the game";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void this.openTarget(target, back, link.href);
      });
    }
    for (const image of Array.from(container.querySelectorAll("img"))) {
      image.addEventListener("error", () => {
        const note = el("span", "zw-media-note");
        note.textContent = image.classList.contains("emoji") ? image.alt : "[image]";
        image.replaceWith(note);
      });
    }
  }

  private async openTarget(target: InGameTarget, back: () => void, href: string): Promise<void> {
    const external = (): void => void window.open(href, "_blank", "noopener,noreferrer");
    switch (target.kind) {
      case "thread":
        this.activateTab("forum");
        return this.renderThread(target.id, back, target.post);
      case "category":
        this.activateTab("forum");
        return this.renderForumCategory(target.id, 0, back);
      case "search":
        this.activateTab("forum");
        return this.renderForumSearch(target.query);
      case "repo": {
        const repos = await this.client.repos().catch(() => null);
        const repo = repos?.items.find((item) => item.fullName.toLowerCase() === target.fullName.toLowerCase());
        if (!repo) return external();
        this.activateTab("github");
        return this.renderRepo(repo.fullName, back);
      }
      case "wiki":
      case "wikiPath": {
        const index = await this.client.wikiIndex().catch(() => null);
        const article = index?.items.find((item) => (target.kind === "wiki" ? wikiSlug(new URL(item.url).pathname) === target.slug : item.path === target.path));
        if (!article) return external();
        this.activateTab("wiki");
        return this.renderWikiArticle(article, back);
      }
    }
  }

  /** Runs a render step, ignoring results that arrive after the user navigated elsewhere. */
  private async step<T>(load: () => Promise<T>, render: (data: T) => void, retry: () => void): Promise<void> {
    const token = ++this.renderToken;
    this.body.replaceChildren(statusLine("Loading…"));
    try {
      const data = await load();
      if (token !== this.renderToken) return;
      this.body.replaceChildren();
      this.body.scrollTop = 0;
      render(data);
    } catch (error) {
      if (token !== this.renderToken) return;
      console.warn("[community] load failed:", error);
      const failure = statusLine("Couldn't reach the community gateway. It may be offline, or the source is temporarily unavailable.");
      const button = el("button", "zw-button");
      button.textContent = "Retry";
      button.addEventListener("click", retry);
      this.body.replaceChildren(failure, button);
    }
  }

  private setFooter(text: string, link?: { label: string; url: string }): void {
    this.footer.replaceChildren();
    const note = el("span", "");
    note.textContent = text;
    this.footer.appendChild(note);
    if (link) this.footer.appendChild(externalLink(link.label, link.url));
  }

  // ---------------------------------------------------------------- bounties

  private renderBounties(): Promise<void> {
    return this.step(
      () => this.client.bounties(),
      (listing) => {
        this.setFooter(`Live from ZecHub Bounties${listing.stale ? " (cached)" : ""} · ${listing.items.length} open`, {
          label: "Bounty board ↗",
          url: listing.sourceUrl ?? "https://bounties.zechub.wiki/home",
        });
        const intro = el("p", "zw-community-intro");
        intro.textContent = "Open work from the ZecHub community — guides, design, video and web tasks paid in ZEC.";
        this.body.appendChild(intro);
        const list = el("div", "zw-community-list");
        for (const bounty of listing.items) list.appendChild(this.bountyRow(bounty));
        this.body.appendChild(list);
      },
      () => void this.renderBounties(),
    );
  }

  private bountyRow(bounty: Bounty): HTMLElement {
    const row = el("button", "zw-community-row");
    const amount = el("div", "zw-zec-badge");
    amount.textContent = bounty.amountZec !== null ? `${trimAmount(bounty.amountZec)} ZEC` : "ZEC";
    const text = el("div", "zw-community-row-text");
    const title = el("div", "zw-community-row-title");
    title.textContent = bounty.title;
    const meta = el("div", "zw-community-row-meta");
    meta.textContent = [bounty.category, prettyEnum(bounty.difficulty), prettyEnum(bounty.status), bounty.dueAt ? `due ${shortDate(bounty.dueAt)}` : ""]
      .filter(Boolean)
      .join(" · ");
    text.append(title, meta);
    row.append(amount, text);
    row.addEventListener("click", () => this.renderBountyDetail(bounty));
    return row;
  }

  private renderBountyDetail(bounty: Bounty): void {
    ++this.renderToken;
    this.body.replaceChildren(backButton(() => void this.renderBounties()));
    const head = el("div", "zw-community-detail-head");
    const amount = el("div", "zw-zec-badge zw-zec-badge-large");
    amount.textContent = bounty.amountZec !== null ? `${trimAmount(bounty.amountZec)} ZEC` : "ZEC";
    const title = el("h3", "");
    title.textContent = bounty.title;
    head.append(amount, title);
    const chips = el("div", "zw-community-chips");
    for (const value of [bounty.category, prettyEnum(bounty.difficulty), prettyEnum(bounty.status), bounty.dueAt ? `Due ${shortDate(bounty.dueAt)}` : ""]) {
      if (!value) continue;
      const chip = el("span", "zw-community-chip");
      chip.textContent = value;
      chips.appendChild(chip);
    }
    const description = el("div", "zw-community-prose");
    description.innerHTML = renderMarkdown(bounty.description);
    this.wire(description, () => this.renderBountyDetail(bounty));
    const actions = el("div", "zw-community-actions");
    actions.appendChild(externalLink("View & apply on ZecHub ↗", bounty.url, true));
    this.body.append(head, chips, description, actions);
    this.body.scrollTop = 0;
  }

  // ---------------------------------------------------------------- wiki

  private renderWikiIndex(): Promise<void> {
    return this.step(
      () => this.client.wikiIndex(),
      (listing) => {
        this.setFooter(`ZecHub Wiki · ${listing.items.length} articles · ${listing.license ?? "CC BY-SA 4.0"}${listing.stale ? " (cached)" : ""}`, {
          label: "zechub.wiki ↗",
          url: "https://zechub.wiki",
        });
        const intro = el("p", "zw-community-intro");
        intro.textContent =
          listing.complete === false
            ? "The full ZecHub index is temporarily unavailable — showing the essential articles."
            : "The whole ZecHub wiki, read in-game. Articles come live from the ZecHub repository.";
        const search = el("input", "zw-input zw-community-search") as HTMLInputElement;
        search.type = "search";
        search.placeholder = `Filter ${listing.items.length} articles — e.g. wallet, memo, Orchard, FROST`;
        search.value = this.wikiFilter;
        search.setAttribute("aria-label", "Filter wiki articles");
        const counter = el("div", "zw-community-row-meta");
        const results = el("div", "");
        const draw = (): void => {
          this.wikiFilter = search.value;
          const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
          const matches = listing.items.filter((article) => {
            const haystack = `${article.title} ${article.section} ${article.group}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
          });
          counter.textContent = terms.length ? `${matches.length} of ${listing.items.length} articles` : "";
          results.replaceChildren();
          const sections = new Map<string, WikiArticleMeta[]>();
          for (const article of matches) sections.set(article.section, [...(sections.get(article.section) ?? []), article]);
          for (const [section, articles] of sections) {
            const heading = el("div", "zw-community-section");
            heading.textContent = `${section} · ${articles.length}`;
            const grid = el("div", "zw-community-grid");
            let group = "";
            for (const article of articles) {
              if (article.group && article.group !== group) {
                const sub = el("div", "zw-community-subsection");
                sub.textContent = article.group;
                grid.appendChild(sub);
              }
              group = article.group;
              const card = el("button", "zw-community-card");
              card.textContent = article.title;
              card.addEventListener("click", () => void this.renderWikiArticle(article));
              grid.appendChild(card);
            }
            results.append(heading, grid);
          }
          if (matches.length === 0) results.appendChild(statusLine("No article matches — try another word."));
        };
        search.addEventListener("input", draw);
        search.addEventListener("keydown", (event) => blurOnEscape(event, search));
        this.body.append(intro, search, counter, results);
        draw();
      },
      () => void this.renderWikiIndex(),
    );
  }

  private renderWikiArticle(meta: WikiArticleMeta, back: () => void = () => void this.renderWikiIndex()): Promise<void> {
    return this.step(
      () => (meta.path ? this.client.wikiPage(meta.path) : this.client.wikiArticle(meta.id)),
      (article) => {
        this.body.appendChild(backButton(back));
        const crumb = el("div", "zw-community-row-meta");
        crumb.textContent = [article.section, article.group].filter(Boolean).join(" › ");
        const prose = el("div", "zw-community-prose zw-community-article");
        // Wiki pages link each other as "/using-zcash/wallets" and show images from zechub.wiki — resolve against the page URL.
        prose.innerHTML = renderMarkdown(article.markdown, article.url);
        this.wire(prose, () => void this.renderWikiArticle(meta, back));
        const actions = el("div", "zw-community-actions");
        actions.append(
          externalLink("Read on zechub.wiki ↗", article.url),
          externalLink("Türkçe ↗", article.urlTr),
          externalLink("Improve this page on GitHub ↗", article.editUrl),
        );
        this.body.append(crumb, prose, actions);
        this.setFooter(`ZecHub Wiki — ${article.title} · ${article.license}`);
      },
      () => void this.renderWikiArticle(meta, back),
    );
  }

  // ---------------------------------------------------------------- forum

  /** Forum home: search, Community Grants (subcategories + latest threads), then every public category. */
  private renderForum(): Promise<void> {
    return this.step(
      () => Promise.all([this.client.forumCategories(), this.client.forumCategory(GRANTS_CATEGORY_ID).catch(() => null)]),
      ([categories, grants]) => {
        this.setFooter(`Zcash Community Forum${categories.stale ? " (cached)" : ""} · read-only`, {
          label: "Open forum ↗",
          url: categories.sourceUrl ?? "https://forum.zcashcommunity.com",
        });
        this.body.appendChild(this.forumSearchBox(""));
        const grantsId = categories.grantsCategoryId ?? GRANTS_CATEGORY_ID;
        const grantsCategory = categories.items.find((category) => category.id === grantsId);
        if (grantsCategory) {
          const hero = el("div", "zw-grants-hero");
          const title = el("div", "zw-grants-title");
          title.textContent = "Community Grants";
          const blurb = el("p", "zw-community-intro");
          blurb.textContent =
            grantsCategory.description ||
            "Zcash Community Grants (ZCG) — proposals, requests for proposals, retroactive and minor grants, and updates.";
          const chips = el("div", "zw-community-chips");
          chips.appendChild(this.categoryChip(grantsCategory, "All grants"));
          for (const sub of grantsCategory.subcategories) chips.appendChild(this.categoryChip(sub));
          hero.append(title, blurb, chips);
          if (grants && grants.items.length) {
            const heading = el("div", "zw-community-section");
            heading.textContent = "Latest grant threads";
            const list = el("div", "zw-community-list");
            for (const topic of grants.items.filter((item) => !item.pinned).slice(0, 6)) list.appendChild(this.topicRow(topic, () => void this.renderForum()));
            const more = el("button", "zw-button");
            more.textContent = "All grant threads →";
            more.addEventListener("click", () => void this.renderForumCategory(grantsId, 0));
            hero.append(heading, list, more);
          }
          this.body.appendChild(hero);
        }
        const heading = el("div", "zw-community-section");
        heading.textContent = "All categories";
        const grid = el("div", "zw-community-grid zw-community-grid-wide");
        for (const category of categories.items) {
          if (category.id === grantsId) continue;
          grid.appendChild(this.categoryCard(category));
        }
        this.body.append(heading, grid);
      },
      () => void this.renderForum(),
    );
  }

  private categoryChip(category: ForumCategory, label = category.name): HTMLElement {
    const chip = el("button", "zw-community-chip zw-chip-button");
    chip.textContent = `${label} · ${category.topicCount}`;
    if (category.color) chip.style.borderColor = `#${category.color}`;
    chip.addEventListener("click", () => void this.renderForumCategory(category.id, 0));
    return chip;
  }

  private categoryCard(category: ForumCategory): HTMLElement {
    const card = el("div", "zw-community-card zw-category-card");
    if (category.color) card.style.borderLeftColor = `#${category.color}`;
    const name = el("button", "zw-category-name");
    name.textContent = category.name;
    name.addEventListener("click", () => void this.renderForumCategory(category.id, 0));
    const meta = el("div", "zw-community-row-meta");
    meta.textContent = `${category.topicCount} topics${category.description ? ` · ${category.description}` : ""}`;
    card.append(name, meta);
    if (category.subcategories.length) {
      const chips = el("div", "zw-community-chips");
      for (const sub of category.subcategories) chips.appendChild(this.categoryChip(sub));
      card.appendChild(chips);
    }
    return card;
  }

  private forumSearchBox(initial: string): HTMLElement {
    const form = el("form", "zw-forum-search");
    const input = el("input", "zw-input zw-community-search") as HTMLInputElement;
    input.type = "search";
    input.placeholder = "Search the forum — e.g. ZecHub grant, Zashi, Orchard";
    input.value = initial;
    input.minLength = 2;
    input.maxLength = 100;
    input.setAttribute("aria-label", "Search the Zcash Community Forum");
    input.addEventListener("keydown", (event) => blurOnEscape(event, input));
    const go = el("button", "zw-button zw-button-primary");
    go.type = "submit";
    go.textContent = "Search";
    form.append(input, go);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = input.value.replace(/\s+/g, " ").trim();
      if (query.length >= 2) void this.renderForumSearch(query);
    });
    return form;
  }

  private renderForumCategory(id: number, page: number, back?: () => void): Promise<void> {
    return this.step(
      () => this.client.forumCategory(id, page),
      (listing) => {
        const category = listing.category;
        this.body.appendChild(
          backButton(back ?? (() => (category.parent && page === 0 ? void this.renderForumCategory(category.parent.id, 0) : void this.renderForum()))),
        );
        const crumb = el("div", "zw-community-row-meta");
        crumb.textContent = ["Forum", category.parent?.name, category.name].filter(Boolean).join(" › ");
        const title = el("h3", "zw-thread-title");
        title.textContent = category.name;
        if (category.color) title.style.borderLeft = `4px solid #${category.color}`;
        const description = el("p", "zw-community-intro");
        description.textContent = category.description;
        this.body.append(crumb, title, description);
        if (category.subcategories.length) {
          const chips = el("div", "zw-community-chips");
          for (const sub of category.subcategories) chips.appendChild(this.categoryChip(sub));
          this.body.appendChild(chips);
        }
        const list = el("div", "zw-community-list");
        for (const topic of listing.items) list.appendChild(this.topicRow(topic, () => void this.renderForumCategory(id, page, back)));
        if (listing.items.length === 0) list.appendChild(statusLine("No topics on this page."));
        this.body.appendChild(list);
        const pager = el("div", "zw-community-actions zw-pager");
        if (page > 0) {
          const newer = el("button", "zw-button");
          newer.textContent = "← Newer";
          newer.addEventListener("click", () => void this.renderForumCategory(id, page - 1, back));
          pager.appendChild(newer);
        }
        const where = el("span", "zw-community-row-meta");
        where.textContent = `Page ${page + 1}`;
        pager.appendChild(where);
        if (listing.hasMore) {
          const older = el("button", "zw-button");
          older.textContent = "Older →";
          older.addEventListener("click", () => void this.renderForumCategory(id, page + 1, back));
          pager.appendChild(older);
        }
        this.body.appendChild(pager);
        this.setFooter(`Zcash Community Forum — ${category.name}${listing.stale ? " (cached)" : ""} · ${category.topicCount} topics`, {
          label: "Open category ↗",
          url: category.url,
        });
      },
      () => void this.renderForumCategory(id, page, back),
    );
  }

  private renderForumSearch(query: string): Promise<void> {
    return this.step(
      () => this.client.forumSearch(query),
      (result) => {
        this.body.append(backButton(() => void this.renderForum()), this.forumSearchBox(query));
        const summary = el("p", "zw-community-intro");
        summary.textContent = result.items.length ? `${result.items.length} matching posts for “${result.query}”` : `Nothing found for “${result.query}”.`;
        this.body.appendChild(summary);
        const list = el("div", "zw-community-list");
        for (const hit of result.items) {
          const row = el("button", "zw-community-row");
          const text = el("div", "zw-community-row-text");
          const title = el("div", "zw-community-row-title");
          title.textContent = hit.topicTitle;
          const meta = el("div", "zw-community-row-meta");
          meta.textContent = `@${hit.username} · ${shortDate(hit.createdAt)}${hit.postNumber > 1 ? ` · reply #${hit.postNumber}` : ""}${hit.likes ? ` · ♥ ${hit.likes}` : ""}`;
          const blurb = el("div", "zw-search-blurb");
          blurb.textContent = hit.blurb;
          text.append(title, meta, blurb);
          row.appendChild(text);
          row.addEventListener("click", () => void this.renderThread(hit.topicId, () => void this.renderForumSearch(query), hit.postNumber));
          list.appendChild(row);
        }
        this.body.appendChild(list);
        if (result.hasMore) {
          const actions = el("div", "zw-community-actions");
          actions.appendChild(externalLink("More results on the forum ↗", result.sourceUrl ?? "https://forum.zcashcommunity.com/search"));
          this.body.appendChild(actions);
        }
        this.setFooter(`Zcash Community Forum search${result.stale ? " (cached)" : ""}`);
      },
      () => void this.renderForumSearch(query),
    );
  }

  private topicRow(topic: ForumTopic, back: () => void): HTMLElement {
    const row = el("button", "zw-community-row");
    const count = el("div", "zw-forum-count");
    count.innerHTML = `<b>${topic.postsCount}</b><span>posts</span>`;
    const text = el("div", "zw-community-row-text");
    const title = el("div", "zw-community-row-title");
    title.textContent = `${topic.pinned ? "📌 " : ""}${topic.closed ? "🔒 " : ""}${topic.title}`;
    const meta = el("div", "zw-community-row-meta");
    meta.textContent = `${topic.views} views · ${topic.likes} likes · active ${shortDate(topic.lastPostedAt || topic.createdAt)}`;
    text.append(title, meta);
    if (topic.excerpt) {
      const excerpt = el("div", "zw-search-blurb");
      excerpt.textContent = topic.excerpt;
      text.appendChild(excerpt);
    }
    row.append(count, text);
    row.addEventListener("click", () => void this.renderThread(topic.id, back));
    return row;
  }

  private postCard(post: ForumPost, threadUrl: string, back: () => void): HTMLElement {
    const card = el("div", "zw-forum-post");
    card.dataset.post = String(post.postNumber);
    const head = el("div", "zw-forum-post-head");
    head.textContent = `#${post.postNumber} · @${post.username} · ${shortDate(post.createdAt)}${post.likes ? ` · ♥ ${post.likes}` : ""}`;
    const content = el("div", "zw-community-prose");
    content.innerHTML = sanitizeHtml(post.html, threadUrl.startsWith(FORUM_ORIGIN) ? threadUrl : FORUM_ORIGIN);
    this.wire(content, back);
    card.append(head, content);
    return card;
  }

  /** A thread from its first post, or around post number `post` (links to a post, search hits). */
  private renderThread(id: number, back: () => void = () => void this.renderForum(), post = 0): Promise<void> {
    return this.step(
      () => this.client.forumThread(id, { post }),
      (thread) => {
        const here = (): void => void this.renderThread(id, back, post);
        this.body.appendChild(backButton(back));
        const title = el("h3", "zw-thread-title");
        title.textContent = thread.title;
        const posts = el("div", "");
        const shownIds = new Set<number>();
        const add = (list: readonly ForumPost[], where: "start" | "end"): void => {
          const fresh = list.filter((item) => !shownIds.has(item.id));
          for (const item of fresh) shownIds.add(item.id);
          const cards = fresh.map((item) => this.postCard(item, thread.url, here));
          if (where === "start") posts.prepend(...cards);
          else posts.append(...cards);
        };
        add(thread.posts, "end");

        // Long threads load in chunks of 20 posts, in place — later posts below, earlier ones (after a jump) above.
        let nextOffset = thread.nextOffset ?? null;
        let prevOffset = thread.prevOffset ?? null;
        const loader = (label: () => string, offset: () => number | null, apply: (chunk: Awaited<ReturnType<CommunityClient["forumThread"]>>) => void): HTMLButtonElement => {
          const button = el("button", "zw-button zw-load-more");
          const update = (): void => {
            button.textContent = label();
            button.style.display = offset() === null ? "none" : "";
          };
          button.addEventListener("click", () => {
            const at = offset();
            if (at === null) return;
            const token = this.renderToken;
            button.disabled = true;
            button.textContent = "Loading…";
            this.client
              .forumThread(id, { offset: at })
              .then((chunk) => {
                if (token === this.renderToken) apply(chunk);
              })
              .catch((error: unknown) => console.warn("[community] more posts failed:", error))
              .finally(() => {
                button.disabled = false;
                update();
              });
          });
          update();
          return button;
        };
        const earlier = loader(
          () => "↑ Load earlier posts",
          () => prevOffset,
          (chunk) => {
            add(chunk.posts, "start");
            prevOffset = chunk.offset && chunk.offset > 0 ? Math.max(0, chunk.offset - 20) : null;
          },
        );
        const later = loader(
          () => `Load more posts (${shownIds.size} of ${thread.postsCount})`,
          () => nextOffset,
          (chunk) => {
            add(chunk.posts, "end");
            nextOffset = chunk.nextOffset ?? null;
          },
        );
        this.body.append(title, earlier, posts, later);
        if (post > 1) {
          const target = posts.querySelector<HTMLElement>(`[data-post="${post}"]`);
          if (target) {
            target.classList.add("zw-forum-post-target");
            requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
          }
        }
        // Replying in-game needs per-user forum authorization (a Discourse User API key), which is not available yet: replies are written on the forum.
        const composer = el("div", "zw-forum-composer");
        const box = el("textarea", "zw-input zw-forum-textarea") as HTMLTextAreaElement;
        box.placeholder = "Write a reply…";
        box.disabled = true;
        const note = el("div", "zw-community-intro");
        note.textContent =
          "Reading needs no account. Replying from inside the game needs a forum sign-in for this app (proposed, not available yet) — until then, replies are written on the forum.";
        const actions = el("div", "zw-community-actions");
        actions.appendChild(externalLink("Reply on the forum ↗", post > 1 ? `${thread.url}/${post}` : thread.url, true));
        composer.append(box, note, actions);
        this.body.appendChild(composer);
        this.setFooter(`Zcash Community Forum · ${thread.postsCount} posts`, { label: "Open thread ↗", url: thread.url });
      },
      () => void this.renderThread(id, back, post),
    );
  }

  // ---------------------------------------------------------------- z.cash learn

  private renderLearn(): Promise<void> {
    return this.step(
      () => this.client.zcashLearn(),
      (listing) => {
        this.setFooter("Zcash Learn by Electric Coin Co. · articles open on z.cash", { label: "z.cash/learn ↗", url: listing.sourceUrl ?? "https://z.cash/learn/" });
        const intro = el("p", "zw-community-intro");
        intro.textContent =
          "Electric Coin Co.'s Zcash Learn library. z.cash doesn't allow automated access to its articles, so they open on z.cash in a new tab; the short summaries here are our own. For in-game reading, the Wiki tab has the whole ZecHub wiki.";
        this.body.appendChild(intro);
        const topics = new Map<string, ZcashLearnArticle[]>();
        for (const article of listing.items) topics.set(article.topic, [...(topics.get(article.topic) ?? []), article]);
        for (const [topic, articles] of topics) {
          const heading = el("div", "zw-community-section");
          heading.textContent = topic;
          const grid = el("div", "zw-community-grid zw-community-grid-wide");
          for (const article of articles) {
            const card = externalCard(article.title, article.summary, article.url);
            grid.appendChild(card);
          }
          this.body.append(heading, grid);
        }
        const actions = el("div", "zw-community-actions");
        actions.appendChild(externalLink("Browse every article on z.cash/learn ↗", listing.sourceUrl ?? "https://z.cash/learn/", true));
        this.body.appendChild(actions);
      },
      () => void this.renderLearn(),
    );
  }

  // ---------------------------------------------------------------- github

  private renderRepos(): Promise<void> {
    return this.step(
      () => this.client.repos(),
      (listing) => {
        this.setFooter("Open-source Zcash ecosystem repositories");
        const grid = el("div", "zw-community-grid zw-community-grid-wide");
        for (const repo of listing.items) grid.appendChild(this.repoCard(repo));
        this.body.appendChild(grid);
      },
      () => void this.renderRepos(),
    );
  }

  private repoCard(repo: RepoSummary): HTMLElement {
    const card = el("button", "zw-community-card zw-repo-card");
    const name = el("div", "zw-community-row-title");
    name.textContent = repo.fullName;
    const blurb = el("div", "zw-community-row-meta");
    blurb.textContent = repo.blurb;
    card.append(name, blurb);
    card.addEventListener("click", () => void this.renderRepo(repo.fullName));
    return card;
  }

  private renderRepo(fullName: string, back: () => void = () => void this.renderRepos()): Promise<void> {
    return this.step(
      () => this.client.repo(fullName),
      (repo) => {
        this.body.appendChild(backButton(back));
        const title = el("h3", "");
        title.textContent = repo.fullName;
        const description = el("p", "zw-community-intro");
        description.textContent = repo.stats?.description || repo.blurb;
        const chips = el("div", "zw-community-chips");
        const addChip = (text: string): void => {
          const chip = el("span", "zw-community-chip");
          chip.textContent = text;
          chips.appendChild(chip);
        };
        if (repo.stats) {
          if (repo.stats.stars !== null) addChip(`★ ${repo.stats.stars}`);
          if (repo.stats.forks !== null) addChip(`⑂ ${repo.stats.forks} forks`);
          if (repo.stats.openIssues !== null) addChip(`${repo.stats.openIssues} open issues`);
          if (repo.stats.license) addChip(repo.stats.license);
          if (repo.stats.pushedAt) addChip(`updated ${shortDate(repo.stats.pushedAt)}`);
        } else {
          addChip("Live stats unavailable right now");
        }
        if (repo.latestRelease) addChip(`Release ${repo.latestRelease.tag}`);
        const people = el("p", "zw-community-intro");
        if (repo.contributors.length > 0) people.textContent = `Top contributors: ${repo.contributors.map((login) => `@${login}`).join(", ")}`;
        const actions = el("div", "zw-community-actions");
        actions.append(
          externalLink("Open on GitHub ↗", repo.url, true),
          externalLink("Issues ↗", `${repo.url}/issues`),
          externalLink("Releases ↗", `${repo.url}/releases`),
        );
        const readme = el("div", "zw-community-prose zw-community-article");
        // Relative README images come from the repository's raw files; relative links go to GitHub's file view.
        readme.innerHTML = repo.readme
          ? renderMarkdown(repo.readme, `https://raw.githubusercontent.com/${repo.fullName}/HEAD/`, `https://github.com/${repo.fullName}/blob/HEAD/`)
          : "<p>No README found.</p>";
        this.wire(readme, () => void this.renderRepo(fullName, back));
        this.body.append(title, description, chips, people, actions, readme);
        this.setFooter(`GitHub — ${repo.fullName}`, { label: "Repository ↗", url: repo.url });
      },
      () => void this.renderRepo(fullName, back),
    );
  }
}

// ---------------------------------------------------------------- helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function statusLine(text: string): HTMLElement {
  const line = el("p", "zw-community-intro");
  line.textContent = text;
  return line;
}

function backButton(onBack: () => void): HTMLElement {
  const button = el("button", "zw-button zw-community-back");
  button.textContent = "← Back";
  button.addEventListener("click", onBack);
  return button;
}

/** Explicit "leave the game" link: https only, new tab, no referrer. */
function externalLink(label: string, url: string, primary = false): HTMLElement {
  const link = el("a", `zw-button${primary ? " zw-button-primary" : ""}`);
  link.textContent = label;
  if (/^https:\/\//.test(url)) {
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return link;
}

/** Typed keys never reach the game (the InputManager text-field guard); Esc leaves the field, so the next Esc closes the panel. */
function blurOnEscape(event: KeyboardEvent, input: HTMLInputElement): void {
  event.stopPropagation();
  if (event.key === "Escape") input.blur();
}

/** A card that IS an explicit new-tab link (https only, no referrer). */
function externalCard(title: string, summary: string, url: string): HTMLElement {
  const card = el("a", "zw-community-card zw-external-card");
  if (/^https:\/\//.test(url)) {
    card.href = url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
  }
  const name = el("div", "zw-community-row-title");
  name.textContent = `${title} ↗`;
  const blurb = el("div", "zw-community-row-meta");
  blurb.textContent = summary;
  card.append(name, blurb);
  return card;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function prettyEnum(value: string): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function trimAmount(amount: number): string {
  return amount >= 1 ? amount.toFixed(2).replace(/\.?0+$/, "") : amount.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

let stylesInjected = false;
function injectCommunityStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.zw-community-backdrop { position: absolute; inset: 0; z-index: 20; display: none; align-items: center; justify-content: center; background: rgba(8,6,16,0.6); }
.zw-community-backdrop.visible { display: flex; }
.zw-community { width: min(920px, 94vw); height: min(760px, 90vh); display: flex; flex-direction: column; padding: 0; overflow: hidden;
  background: linear-gradient(180deg, rgba(40,28,20,0.97), rgba(22,16,14,0.97)); border: 2px solid rgba(160,108,56,0.85); }
.zw-community-header { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-bottom: 1px solid rgba(201,138,60,0.35); flex-wrap: wrap; }
.zw-community-title { font: 700 22px Georgia, "Times New Roman", serif; color: #f4e3c1; }
.zw-community-tabs { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.zw-community-tab { background: rgba(255,255,255,0.06); color: #d9cdb8; border: 1px solid transparent; border-radius: 8px; padding: 6px 14px; font: 600 13px "Segoe UI", system-ui, sans-serif; cursor: pointer; }
.zw-community-tab.active { background: rgba(227,154,45,0.25); border-color: rgba(227,154,45,0.6); color: #fff3dc; }
.zw-community-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.zw-community-footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 18px; border-top: 1px solid rgba(201,138,60,0.25); font-size: 12px; color: #bfae96; }
.zw-community-intro { color: #cdbda5; font-size: 13px; line-height: 1.5; margin: 0 0 12px; }
.zw-community-list { display: flex; flex-direction: column; gap: 8px; }
.zw-community-row { display: flex; gap: 12px; align-items: center; text-align: left; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(201,138,60,0.18);
  background: rgba(10,8,6,0.45); color: #f1e9dd; cursor: pointer; font: inherit; }
.zw-community-row:hover { border-color: rgba(227,154,45,0.6); background: rgba(40,26,14,0.7); }
.zw-community-row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.zw-community-row-title { font-weight: 700; font-size: 14px; }
.zw-community-row-meta { font-size: 12px; color: #bfae96; }
.zw-zec-badge { flex: none; min-width: 78px; text-align: center; padding: 6px 8px; border-radius: 8px; background: #e39a2d; color: #24170b; font: 800 13px "Segoe UI", system-ui, sans-serif; }
.zw-zec-badge-large { font-size: 16px; padding: 8px 12px; }
.zw-forum-count { flex: none; width: 58px; display: flex; flex-direction: column; align-items: center; color: #e8c58a; }
.zw-forum-count b { font-size: 18px; } .zw-forum-count span { font-size: 10px; color: #a8987f; }
.zw-community-section { margin: 14px 0 8px; font: 700 13px "Segoe UI", system-ui, sans-serif; color: #e8c58a; text-transform: uppercase; letter-spacing: 0.06em; }
.zw-community-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.zw-community-grid-wide { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.zw-community-card { text-align: left; padding: 12px; border-radius: 10px; border: 1px solid rgba(201,138,60,0.2); background: rgba(10,8,6,0.45); color: #f1e9dd; cursor: pointer; font: 600 13px "Segoe UI", system-ui, sans-serif; display: flex; flex-direction: column; gap: 4px; }
.zw-community-card:hover { border-color: rgba(227,154,45,0.6); }
.zw-community-detail-head { display: flex; align-items: center; gap: 12px; margin: 10px 0; }
.zw-community-detail-head h3, .zw-thread-title { margin: 0; font: 700 19px Georgia, serif; color: #f4e3c1; }
.zw-community-chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 12px; }
.zw-community-chip { padding: 3px 10px; border-radius: 999px; background: rgba(255,255,255,0.07); border: 1px solid rgba(201,138,60,0.3); font-size: 12px; color: #e6d8c0; }
.zw-community-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.zw-community-actions .zw-button, .zw-community-footer .zw-button { text-decoration: none; display: inline-block; }
.zw-community-back { margin-bottom: 8px; }
.zw-community-prose { font-size: 14px; line-height: 1.6; color: #eadfcd; overflow-wrap: anywhere; }
.zw-community-prose h1, .zw-community-prose h2, .zw-community-prose h3 { font-family: Georgia, serif; color: #f4e3c1; margin: 16px 0 8px; }
.zw-community-prose a { color: #f2b440; }
.zw-community-prose code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; }
.zw-community-prose pre { background: rgba(0,0,0,0.4); padding: 10px; border-radius: 8px; overflow-x: auto; }
.zw-community-prose table { border-collapse: collapse; } .zw-community-prose td, .zw-community-prose th { border: 1px solid rgba(201,138,60,0.25); padding: 4px 8px; }
.zw-community-prose blockquote { border-left: 3px solid rgba(227,154,45,0.6); margin: 8px 0; padding-left: 12px; color: #cdbda5; }
.zw-media-note { color: #9d8f7a; font-style: italic; font-size: 12px; }
.zw-forum-post { padding: 10px 12px; margin: 8px 0; border-radius: 10px; background: rgba(10,8,6,0.45); border: 1px solid rgba(201,138,60,0.15); }
.zw-forum-post-head { font: 700 12px "Segoe UI", system-ui, sans-serif; color: #e8c58a; margin-bottom: 6px; }
.zw-forum-composer { margin-top: 14px; padding: 12px; border-radius: 10px; border: 1px dashed rgba(201,138,60,0.4); }
.zw-forum-textarea { width: 100%; min-height: 70px; resize: vertical; margin-bottom: 8px; }
.zw-community-search { width: 100%; box-sizing: border-box; margin: 0 0 8px; }
.zw-forum-search { display: flex; gap: 8px; margin-bottom: 12px; } .zw-forum-search .zw-community-search { margin: 0; flex: 1; }
.zw-community-subsection { grid-column: 1 / -1; font: 600 12px "Segoe UI", system-ui, sans-serif; color: #cdb48a; margin-top: 4px; }
.zw-grants-hero { padding: 14px 16px; margin-bottom: 8px; border-radius: 12px; border: 1px solid rgba(244,183,108,0.55);
  background: linear-gradient(135deg, rgba(244,183,108,0.16), rgba(10,8,6,0.4)); }
.zw-grants-title { font: 700 20px Georgia, serif; color: #f9d9a3; margin-bottom: 4px; }
.zw-chip-button { cursor: pointer; font: inherit; font-size: 12px; } .zw-chip-button:hover { background: rgba(227,154,45,0.25); color: #fff3dc; }
.zw-category-card { cursor: default; border-left: 4px solid rgba(201,138,60,0.5); }
.zw-category-name { all: unset; cursor: pointer; font: 700 15px "Segoe UI", system-ui, sans-serif; color: #f4e3c1; } .zw-category-name:hover { color: #f2b440; }
.zw-category-card .zw-community-chips { margin: 4px 0 0; }
.zw-search-blurb { font-size: 12px; color: #d4c6b0; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.zw-pager { align-items: center; justify-content: center; }
.zw-load-more { display: block; margin: 10px auto; }
.zw-community-prose img { max-width: min(100%, 560px); max-height: 340px; width: auto; height: auto; object-fit: contain; border-radius: 6px; vertical-align: middle;
  background: rgba(243,236,224,0.92); padding: 3px; }
.zw-community-prose img.emoji { width: 20px; height: 20px; border-radius: 0; background: none; padding: 0; }
.zw-community-prose a[target="_blank"]::after { content: " ↗"; font-size: 0.85em; opacity: 0.7; }
.zw-community-prose a.zw-ingame-link { color: #8fe3b0; text-decoration: underline dotted; }
.zw-forum-post-target { border-color: rgba(143,227,176,0.7); box-shadow: 0 0 0 1px rgba(143,227,176,0.35); }
.zw-external-card { text-decoration: none; } .zw-external-card .zw-community-row-meta { font-weight: 400; }
`;
  document.head.appendChild(style);
}
