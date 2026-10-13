/**
 * In-game routing for links inside forum posts, wiki articles, READMEs
 * and bounty descriptions: anything the Community Hub can show itself
 * (forum threads/posts/categories/search, ZecHub wiki pages, listed
 * GitHub repositories) opens INSIDE the game instead of a new tab.
 * Everything else stays an explicit new-tab link.
 */

export type InGameTarget =
  | { readonly kind: "thread"; readonly id: number; readonly post: number }
  | { readonly kind: "category"; readonly id: number }
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "wiki"; readonly slug: string }
  | { readonly kind: "wikiPath"; readonly path: string }
  | { readonly kind: "repo"; readonly fullName: string };

const FORUM_HOST = "forum.zcashcommunity.com";

export function routeLink(href: string): InGameTarget | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === FORUM_HOST) {
    if (parts[0] === "t") {
      // /t/{slug}/{id}[/{post}] or /t/{id}[/{post}]
      const numbers = parts.slice(1).filter((part) => /^\d{1,10}$/.test(part)).map(Number);
      const hasSlug = parts[1] !== undefined && !/^\d+$/.test(parts[1]);
      const id = hasSlug ? numbers[0] : Number(parts[1]);
      const post = hasSlug ? numbers[1] : numbers[1];
      if (id && id > 0) return { kind: "thread", id, post: post && post > 1 ? post : 0 };
    }
    if (parts[0] === "c") {
      const id = Number(parts[parts.length - 1]);
      if (Number.isInteger(id) && id > 0) return { kind: "category", id };
    }
    if (parts[0] === "search") {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (query.length >= 2 && query.length <= 100) return { kind: "search", query };
    }
    return null;
  }

  if (host === "zechub.wiki" || host === "www.zechub.wiki") {
    if (parts.length === 0 || parts[0] === "api" || parts[0] === "content-images") return null;
    return { kind: "wiki", slug: wikiSlug(url.pathname) };
  }

  if (host === "github.com" && parts.length >= 2) {
    // github.com/ZecHub/zechub/blob/<branch>/site/....md → the article in-game
    if (parts[0]!.toLowerCase() === "zechub" && parts[1]!.toLowerCase() === "zechub" && (parts[2] === "blob" || parts[2] === "tree") && parts[4] === "site" && /\.md$/i.test(url.pathname)) {
      return { kind: "wikiPath", path: decodeURIComponent(parts.slice(4).join("/")) };
    }
    if (parts.length === 2) return { kind: "repo", fullName: `${parts[0]}/${parts[1]}` };
  }
  return null;
}

/**
 * zechub.wiki URL path → comparable slug: lowercase, no locale prefix,
 * no trailing slash or ".md", underscores as hyphens.
 * "/tr/Using_Zcash/Wallets.md" → "using-zcash/wallets".
 */
export function wikiSlug(pathname: string): string {
  let parts = pathname.split("/").filter(Boolean);
  if (parts.length > 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(parts[0]!)) parts = parts.slice(1);
  if (parts[0]?.toLowerCase() === "site") parts = parts.slice(1);
  return parts
    .map((part) => decodeURIComponentSafe(part).replace(/\.md$/i, "").replace(/_/g, "-").toLowerCase())
    .join("/");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
