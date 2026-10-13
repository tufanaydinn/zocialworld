/**
 * Allowlisted upstream sources for the community content gateway.
 *
 * The gateway is NOT a general proxy: it only ever fetches the fixed
 * URLs built from these constants and from the operator's watch
 * catalogue, so a client can never make this server request an
 * arbitrary host or path.
 */

export const BOUNTIES_API = "https://zechub.zone/api/bounties";
/** Public bounty detail page on the ZecHub bounty board. */
export const bountyPageUrl = (id: string): string => `https://bounties.zechub.wiki/bounty/${encodeURIComponent(id)}`;

export const FORUM_ORIGIN = "https://forum.zcashcommunity.com";
export const FORUM_CATEGORY = { slug: "zcash-apps", id: 16, title: "Zcash Apps" } as const;
/** "Community Grants" (ZCG) — applications, RFPs, retroactive and minor grants, ZOMG updates live in its subcategories. */
export const FORUM_GRANTS_CATEGORY_ID = 33;
/** Deepest category page the gateway will relay (30 topics per page). */
export const FORUM_MAX_PAGE = 50;

export const GITHUB_API = "https://api.github.com";
export const GITHUB_RAW = "https://raw.githubusercontent.com";

/** Ecosystem repositories that can be opened in-game (the open-source project board). */
export const GITHUB_REPOS: readonly { readonly fullName: string; readonly blurb: string }[] = [
  { fullName: "ZecHub/zechub", blurb: "ZecHub — the community-run Zcash education wiki." },
  { fullName: "ZcashFoundation/zebra", blurb: "Zebra — a Zcash full node written in Rust." },
  { fullName: "zcash/librustzcash", blurb: "Rust crates that implement the Zcash protocol." },
  { fullName: "zingolabs/zingolib", blurb: "Zingo — wallet library and CLI for Zcash." },
  { fullName: "Electric-Coin-Company/zashi-android", blurb: "Zashi — mobile Zcash wallet (Android)." },
  { fullName: "ChainSafe/WebZjs", blurb: "WebZjs — Zcash wallet tooling for the browser." },
  { fullName: "zcash/zcash-devtool", blurb: "Developer tool for exploring Zcash wallets and transactions." },
];

/**
 * Images the gateway may relay (`/content/media`), so pictures in forum
 * posts, wiki articles and READMEs show in-game without the browser
 * contacting these hosts. Host + path prefix; raster formats only (the
 * bytes are sniffed — no SVG); avatars are never relayed.
 */
export const MEDIA_SOURCES: readonly { readonly host: string; readonly pathPrefix: string }[] = [
  { host: "zechub.wiki", pathPrefix: "/content-images/" },
  { host: "global.discourse-cdn.com", pathPrefix: "/zcash/" },
  { host: "emoji.discourse-cdn.com", pathPrefix: "/" },
  { host: "forum.zcashcommunity.com", pathPrefix: "/uploads/" },
  { host: "forum.zcashcommunity.com", pathPrefix: "/images/emoji/" },
  ...GITHUB_REPOS.map((repo) => ({ host: "raw.githubusercontent.com", pathPrefix: `/${repo.fullName}/` })),
];
export const MEDIA_MAX_BYTES = 3_000_000;
/**
 * Watch Hall thumbnails: only `https://i.ytimg.com/vi/<11-character id>/mqdefault.jpg`
 * or `hqdefault.jpg` — no query, no other path. The gateway builds these URLs itself from validated
 * video ids; the client wraps them in `/content/media` (apps/web/src/community/safeHtml.ts mirrors this).
 */
export const YOUTUBE_THUMB_HOST = "i.ytimg.com";
export const YOUTUBE_THUMB_PATH = /^\/vi\/[A-Za-z0-9_-]{11}\/(?:mqdefault|hqdefault)\.jpg$/;

/** Normalized https URL if `raw` is an image location the gateway may relay, else null. */
export function allowedMediaUrl(raw: string): string | null {
  if (raw.length > 800) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (path.includes("..") || /\/(user_avatar|letter_avatar(_proxy)?)\//.test(path)) return null;
  const host = url.hostname.toLowerCase();
  // YouTube thumbnails: an exact path pattern, never a prefix, and no dot segments even before normalisation.
  if (host === YOUTUBE_THUMB_HOST) {
    return !/\.\.|%2e/i.test(raw) && url.search === "" && url.hash === "" && YOUTUBE_THUMB_PATH.test(url.pathname) ? url.href : null;
  }
  const allowed = MEDIA_SOURCES.some((source) => source.host === host && url.pathname.toLowerCase().startsWith(source.pathPrefix.toLowerCase()));
  return allowed ? url.href : null;
}

/** ZecHub wiki — content lives as Markdown in ZecHub/zechub (license CC BY-SA 4.0). */
export const WIKI_REPO = "ZecHub/zechub";
export const WIKI_LICENSE = "CC BY-SA 4.0 — ZecHub contributors";

export interface WikiArticleSource {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  /** Path inside ZecHub/zechub. */
  readonly path: string;
}

export const WIKI_ARTICLES: readonly WikiArticleSource[] = [
  { id: "what-is-zec", title: "What is ZEC and Zcash?", section: "Start Here", path: "site/Start_Here/What_is_ZEC_and_Zcash.md" },
  { id: "new-user-guide", title: "New User Guide", section: "Start Here", path: "site/Start_Here/New_User_Guide.md" },
  { id: "who-can-see", title: "Who Can See Your Zcash Payment?", section: "Start Here", path: "site/Start_Here/Who_Can_See_Your_Zcash_Payment.md" },
  { id: "what-is-zechub", title: "What is ZecHub?", section: "Start Here", path: "site/Start_Here/What_is_ZecHub.md" },
  { id: "developer-resources", title: "Developer Resources", section: "Start Here", path: "site/Start_Here/Developer_Resources.md" },
  { id: "dev-fund", title: "Development Fund", section: "Start Here", path: "site/Start_Here/Development_Fund.md" },
  { id: "wallets", title: "Wallets", section: "Using Zcash", path: "site/Using_Zcash/Wallets.md" },
  { id: "shielded-pools", title: "Shielded Pools", section: "Using Zcash", path: "site/Using_Zcash/Shielded_Pools.md" },
  { id: "memos", title: "Memos", section: "Using Zcash", path: "site/Using_Zcash/Memos.md" },
  { id: "transactions", title: "Transactions", section: "Using Zcash", path: "site/Using_Zcash/Transactions.md" },
  { id: "payment-uris", title: "Payment Request URIs", section: "Using Zcash", path: "site/Using_Zcash/Payment_Request_URIs.md" },
  { id: "community-projects", title: "Community Projects", section: "Community", path: "site/Zcash_Community/Community_Projects.md" },
  { id: "governance", title: "Zcash Governance", section: "Community", path: "site/Zcash_Community/Zcash_Governance.md" },
  { id: "ambassadors", title: "Zcash Global Ambassadors", section: "Community", path: "site/Zcash_Community/Zcash_Global_Ambassadors.md" },
  { id: "secure-messengers", title: "Secure Messengers", section: "Privacy Tools", path: "site/Privacy_Tools/Secure_Messengers.md" },
  { id: "tor-i2p", title: "Tor and I2P", section: "Privacy Tools", path: "site/Privacy_Tools/Tor_and_I2P.md" },
  { id: "faq", title: "FAQ", section: "Glossary & FAQs", path: "site/Glossary_and_FAQs/FAQ.md" },
];

/**
 * The full wiki index is built from the repository tree (GitHub API, two
 * requests, cached for hours). Only English articles under `site/` are
 * listed: `zechubglobal/` holds translations, `archive/` retired pages.
 */
export const WIKI_EXCLUDED_DIRS: readonly string[] = ["zechubglobal", "archive"];
/** Display names (and order) of the wiki's top-level sections; unknown folders are appended with a prettified name. */
export const WIKI_SECTIONS: readonly { readonly dir: string; readonly name: string }[] = [
  { dir: "Start_Here", name: "Start Here" },
  { dir: "Using_Zcash", name: "Using Zcash" },
  { dir: "guides", name: "Guides" },
  { dir: "tutorials", name: "Tutorials" },
  { dir: "Zcash_Tech", name: "Zcash Tech" },
  { dir: "Research", name: "Research" },
  { dir: "Privacy_Tools", name: "Privacy Tools" },
  { dir: "Zcash_Use_Cases", name: "Use Cases" },
  { dir: "Zcash_Community", name: "Community" },
  { dir: "Zcash_Organizations", name: "Organizations" },
  { dir: "Zcash_Social_Media", name: "Social Media" },
  { dir: "ZFAV_Club", name: "ZFAV Club" },
  { dir: "Glossary_and_FAQs", name: "Glossary & FAQs" },
  { dir: "contribute", name: "Contribute" },
];

/**
 * z.cash/learn — Electric Coin Co.'s article library.
 *
 * NOT fetched by the gateway: the site sits behind bot protection (every
 * non-browser request, including its RSS feed and WordPress API, is
 * redirected to a captcha) and publishes no content license. Getting
 * around that would mean impersonating a browser, so the game ships a
 * curated index instead — titles, our OWN one-line summaries and a topic
 * — and every article opens on z.cash in a new tab. If ECC provides a
 * feed or permission, this list can be replaced by live data.
 */
export const ZCASH_LEARN_ORIGIN = "https://z.cash/learn/";
export interface ZcashLearnSource {
  readonly slug: string;
  readonly title: string;
  readonly topic: string;
  readonly summary: string;
}
export const ZCASH_LEARN_ARTICLES: readonly ZcashLearnSource[] = [
  { slug: "what-is-zcash", title: "What is Zcash?", topic: "Basics", summary: "The digital currency with optional, strong privacy — the starting point." },
  { slug: "whats-the-point-of-zcash", title: "What's the point of Zcash?", topic: "Basics", summary: "Why money that keeps your payments private matters." },
  { slug: "what-is-the-difference-between-zcash-and-zec", title: "Zcash vs ZEC", topic: "Basics", summary: "Zcash is the network and protocol; ZEC is the coin you hold and send." },
  { slug: "how-is-zcash-different-than-bitcoin", title: "How is Zcash different than Bitcoin?", topic: "Basics", summary: "Shared roots, but Zcash adds shielded payments built on zero-knowledge proofs." },
  { slug: "who-created-zcash", title: "Who created Zcash?", topic: "Basics", summary: "The scientists and engineers behind Zcash and how it launched in 2016." },
  { slug: "why-is-privacy-so-important", title: "Why is privacy so important?", topic: "Privacy", summary: "Financial privacy as safety, dignity and freedom — not something to hide." },
  { slug: "is-bitcoin-private", title: "Is Bitcoin private?", topic: "Privacy", summary: "Why a public ledger lets anyone follow transparent payments." },
  { slug: "is-zcash-traceable", title: "Is Zcash traceable?", topic: "Privacy", summary: "What shielded transactions hide, and what transparent ones still show." },
  { slug: "what-is-the-difference-between-shielded-and-transparent-zcash", title: "Shielded vs transparent Zcash", topic: "Privacy", summary: "The two kinds of Zcash addresses and transactions, side by side." },
  { slug: "comparing-on-chain-privacy-technologies", title: "Comparing on-chain privacy technologies", topic: "Privacy", summary: "How Zcash's approach compares with other privacy techniques." },
  { slug: "how-to-use-zcash", title: "How to use Zcash", topic: "Using Zcash", summary: "Get a wallet, receive ZEC and make your first private payment." },
  { slug: "how-to-buy-and-use-zcash-orchard", title: "How to buy and use Zcash (Orchard)", topic: "Using Zcash", summary: "Buying ZEC and moving it into the Orchard shielded pool." },
  { slug: "whats-the-best-zcash-wallet", title: "What's the best Zcash wallet?", topic: "Using Zcash", summary: "Choosing a wallet that supports shielded payments." },
  { slug: "whats-the-best-zcash-exchange", title: "What's the best Zcash exchange?", topic: "Using Zcash", summary: "Where ZEC can be bought and what to look for." },
  { slug: "how-to-spend-your-zcash-on-everyday-items", title: "Spending Zcash on everyday items", topic: "Using Zcash", summary: "Ways to pay for real things with ZEC." },
  { slug: "useful-tips-when-using-zcash", title: "Useful tips when using Zcash", topic: "Using Zcash", summary: "Habits that keep your payments private and your funds safe." },
  { slug: "what-are-zcash-unified-addresses", title: "What are Unified Addresses?", topic: "Using Zcash", summary: "One address (u1…) that bundles several receiver types." },
  { slug: "what-are-zero-knowledge-proofs", title: "What are zero-knowledge proofs?", topic: "Technology", summary: "Proving a statement is true without revealing why it is true." },
  { slug: "what-are-zk-snarks", title: "What are zk-SNARKs?", topic: "Technology", summary: "The short, fast-to-verify proofs that make shielded payments possible." },
  { slug: "what-is-halo-for-zcash", title: "What is Halo?", topic: "Technology", summary: "The proving system behind Orchard that needs no trusted setup." },
  { slug: "does-zcash-contain-a-backdoor", title: "Does Zcash contain a backdoor?", topic: "Technology", summary: "Trusted setups, Halo and why the question comes up." },
  { slug: "mastering-zcash", title: "Mastering Zcash", topic: "Technology", summary: "A deeper technical tour of how Zcash works." },
  { slug: "run-a-zcash-full-node", title: "Run a Zcash full node", topic: "Technology", summary: "Help the network by running and verifying the chain yourself." },
  { slug: "download-zebra", title: "Download Zebra", topic: "Technology", summary: "Zebra, the Zcash Foundation's full node written in Rust." },
  { slug: "what-are-the-economics-of-zcash", title: "What are the economics of Zcash?", topic: "Economics", summary: "Issuance, halvings and how the network is funded." },
  { slug: "does-zcash-have-a-max-supply", title: "Does Zcash have a max supply?", topic: "Economics", summary: "The 21 million ZEC cap and how new coins are issued." },
  { slug: "can-i-make-money-mining-zcash", title: "Can I make money mining Zcash?", topic: "Economics", summary: "How Zcash mining works and what it takes." },
];

/**
 * Watch Hall upstreams (ADR-014 § 8). The channels, playlists, replays, recurring events and calendars come from the
 * server's watch catalogue (`watchCatalogTypes.ts`).
 *
 * YouTube Data API v3: only with a server-side YOUTUBE_API_KEY, and only playlistItems.list and
 * videos.list (1 quota unit each) — never search.list. The key travels in the query string, so
 * upstream URLs are never logged and never part of a cache key.
 */
export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
/** Public Atom feeds (no key, ~15 newest entries, no live flag). Failures are remembered for 5 minutes. */
export const YOUTUBE_FEEDS = "https://www.youtube.com/feeds/videos.xml";

/** site/Start_Here/What_is_ZEC_and_Zcash.md → https://zechub.wiki/start-here/what-is-zec-and-zcash */
export function wikiPageUrl(path: string, locale?: string): string {
  const slug = path
    .replace(/^site\//, "")
    .replace(/\.md$/, "")
    .split("/")
    .map((part) => part.toLowerCase().replace(/_/g, "-"))
    .join("/");
  return `https://zechub.wiki/${locale ? `${locale}/` : ""}${slug}`;
}
