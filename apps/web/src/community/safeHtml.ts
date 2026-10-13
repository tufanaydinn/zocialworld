import DOMPurify from "dompurify";
import { marked } from "marked";
import { getContentBaseUrl } from "./config.ts";

/**
 * Turns third-party Markdown/HTML (wiki articles, READMEs, forum posts,
 * bounty descriptions) into HTML that is safe to insert into the HUD:
 *
 *  - DOMPurify strips scripts, event handlers, iframes, forms, styles;
 *  - images from the gateway's allowlist (forum uploads and emoji, ZecHub
 *    wiki images, listed repositories) are shown THROUGH our server
 *    (`/content/media`), so the player's IP never reaches those hosts;
 *    every other image, and all video/audio/svg, becomes a short text
 *    note — a direct remote load would leak the IP (privacy baseline);
 *  - relative links and images are resolved against `base` (the page
 *    they came from) when given; links keep only absolute https URLs and
 *    open in a new tab with rel="noopener noreferrer" — the Community
 *    Hub then re-routes the ones it can show itself (links.ts).
 */

const FORBIDDEN = ["video", "audio", "svg", "picture", "source", "iframe", "object", "embed", "form", "input", "button", "style", "link", "meta", "math"];

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "IMG") {
      // Defence in depth: only images rewritten to our gateway survive.
      const src = node.getAttribute("src") ?? "";
      if (!src.startsWith(mediaPrefix())) node.removeAttribute("src");
      node.setAttribute("loading", "lazy");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (/^https:\/\//i.test(href)) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      } else {
        node.removeAttribute("href");
      }
    }
  });
}

const MEDIA = ["video", "audio", "picture"];

/**
 * Hosts + path prefixes the gateway relays — mirrors MEDIA_SOURCES in
 * apps/server/src/content/sources.ts (the server re-checks every URL, so
 * this list only decides what to try instead of showing a note). A string
 * is a path prefix; a RegExp must match the whole path (YouTube thumbnails,
 * the same strict pattern as the server's YOUTUBE_THUMB_PATH).
 */
const MEDIA_HOSTS: readonly [string, string | RegExp][] = [
  ["zechub.wiki", "/content-images/"],
  ["global.discourse-cdn.com", "/zcash/"],
  ["emoji.discourse-cdn.com", "/"],
  ["forum.zcashcommunity.com", "/uploads/"],
  ["forum.zcashcommunity.com", "/images/emoji/"],
  ["raw.githubusercontent.com", "/"],
  ["i.ytimg.com", /^\/vi\/[A-Za-z0-9_-]{11}\/(?:mqdefault|hqdefault)\.jpg$/],
];

const mediaPrefix = (): string => `${getContentBaseUrl()}/media?url=`;

/** Absolute https URL for `raw` (resolved against `base`), or null. */
function absolute(raw: string, base?: string): string | null {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Gateway URL for an image the gateway may relay, else null. */
export function proxiedImage(src: string, base?: string): string | null {
  const url = absolute(src, base);
  if (!url) return null;
  const { hostname, pathname, search } = new URL(url);
  if (/\/(user_avatar|letter_avatar)/.test(pathname)) return null;
  const allowed = MEDIA_HOSTS.some(([host, rule]) => hostname === host && (typeof rule === "string" ? pathname.startsWith(rule) : search === "" && rule.test(pathname)));
  return allowed ? `${mediaPrefix()}${encodeURIComponent(url)}` : null;
}

function note(doc: Document, text: string): HTMLElement {
  const span = doc.createElement("span");
  span.className = "zw-media-note";
  span.textContent = text;
  return span;
}

/** Inert pre-pass (DOMParser never runs scripts or loads media): proxy allowed images, replace other media with a note, resolve relative links. */
function prepare(html: string, base?: string, linkBase = base): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  // Discourse wraps uploaded images in lightbox links with size captions ("image 857×669 77.3 KB") — keep just the image.
  for (const wrapper of Array.from(doc.body.querySelectorAll(".lightbox-wrapper"))) {
    const image = wrapper.querySelector("img");
    if (image) wrapper.replaceWith(image);
    else wrapper.replaceWith(note(doc, "[image]"));
  }
  // Inline SVGs in posts are icons (link previews, quotes) — drop them; avatars are personal data, never shown.
  for (const icon of Array.from(doc.body.getElementsByTagName("svg"))) icon.remove();
  for (const image of Array.from(doc.body.getElementsByTagName("img"))) {
    if (/avatar/i.test(`${image.className} ${image.getAttribute("src") ?? ""}`)) {
      image.remove();
      continue;
    }
    const proxied = proxiedImage(image.getAttribute("src") ?? "", base);
    if (!proxied) {
      image.replaceWith(note(doc, image.classList.contains("emoji") ? image.getAttribute("alt") ?? "" : "[image]"));
      continue;
    }
    const clean = doc.createElement("img");
    clean.setAttribute("src", proxied);
    clean.setAttribute("alt", image.getAttribute("alt") ?? "");
    if (image.classList.contains("emoji")) clean.className = "emoji";
    for (const size of ["width", "height"]) {
      const value = image.getAttribute(size);
      if (value && /^\d{1,4}$/.test(value)) clean.setAttribute(size, value);
    }
    image.replaceWith(clean);
  }
  for (const tag of MEDIA) {
    for (const element of Array.from(doc.body.getElementsByTagName(tag))) element.replaceWith(note(doc, "[media]"));
  }
  if (linkBase) {
    for (const link of Array.from(doc.body.getElementsByTagName("a"))) {
      const href = link.getAttribute("href");
      if (href && !href.startsWith("#")) {
        const resolved = absolute(href, linkBase);
        if (resolved) link.setAttribute("href", resolved);
      }
    }
  }
  return doc.body.innerHTML;
}

/** `base`: URL of the page the HTML came from (resolves relative images, and links unless `linkBase` is given). */
export function sanitizeHtml(html: string, base?: string, linkBase?: string): string {
  ensureHooks();
  return DOMPurify.sanitize(prepare(html, base, linkBase ?? base), {
    FORBID_TAGS: FORBIDDEN,
    FORBID_ATTR: ["style", "srcset"],
    ADD_ATTR: ["loading", "referrerpolicy"],
    ALLOW_DATA_ATTR: false,
  });
}

export function renderMarkdown(markdown: string, base?: string, linkBase?: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true }) as string;
  return sanitizeHtml(html, base, linkBase);
}
