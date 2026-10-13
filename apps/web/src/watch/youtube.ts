/**
 * YouTube helpers for the Watch Hall (docs/architecture/WATCH_HALL.md).
 * Pure functions — nothing here contacts YouTube. The only code that does is the opt-in
 * personal player (PersonalPlayer.ts), and only after the viewer's consent.
 */

/** A YouTube video id: exactly 11 characters of [A-Za-z0-9_-] (same as HALL_VIDEO_ID_PATTERN). */
export const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * The video id in a bare id, a youtube.com link (`/watch?v=`, `/live/`, `/embed/`, `/shorts/`)
 * or a youtu.be link; null for anything else (other hosts, http, malformed ids).
 */
export function parseVideoId(input: string): string | null {
  const value = input.trim();
  if (YOUTUBE_ID_PATTERN.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1] ?? null;
  } else if (WATCH_HOSTS.has(host)) {
    if (url.pathname === "/watch") candidate = url.searchParams.get("v");
    else {
      const match = /^\/(?:live|embed|shorts)\/([^/]+)\/?$/.exec(url.pathname);
      candidate = match?.[1] ?? null;
    }
  }
  return candidate !== null && YOUTUBE_ID_PATTERN.test(candidate) ? candidate : null;
}

function assertId(id: string): void {
  if (!YOUTUBE_ID_PATTERN.test(id)) throw new TypeError("not a YouTube video id");
}

/** The privacy-enhanced embed the personal player loads (autoplay, no unrelated suggestions). */
export function embedUrl(id: string): string {
  assertId(id);
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
}

/** The public watch page (opened only in a new tab on an explicit click). */
export function watchUrl(id: string): string {
  assertId(id);
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Whether this browser supports `<iframe credentialless>` (Chromium). Only then can a cross-origin
 * player live inside our cross-origin-isolated page (COEP require-corp) without cookies.
 */
export function supportsCredentialless(): boolean {
  return typeof HTMLIFrameElement !== "undefined" && "credentialless" in HTMLIFrameElement.prototype;
}
