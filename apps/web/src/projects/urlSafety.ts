/**
 * CORE-005 § 15: external link safety. The ONLY function anything in
 * this module ever uses to decide whether a project's `websiteUrl`/
 * `repositoryUrl`/`socialUrl` may be rendered as a clickable link — see
 * `ProjectDetailPanel.ts`. Never render an unvalidated registry string
 * directly as an `href`.
 */

const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * True only for a well-formed `http:`/`https:` URL. Rejects
 * `javascript:`, `data:`, `vbscript:`, any other scheme, and anything
 * that fails to parse as a URL at all (a bare domain with no protocol,
 * whitespace, empty string, etc.) — `new URL()` throws for all of
 * those, which this treats as "unsafe", not an error to propagate.
 */
export function isSafeExternalUrl(value: string | undefined | null): value is string {
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return SAFE_PROTOCOLS.has(parsed.protocol);
}

/**
 * Builds a safe `<a>` element for an already-`isSafeExternalUrl()`-checked
 * URL — never called with an unchecked value (callers must check first;
 * this throws rather than silently rendering an unsafe link if misused).
 * `rel="noopener noreferrer"` on every `target="_blank"` link, per CORE-005
 * § 15.
 */
export function createSafeExternalLink(url: string, label: string): HTMLAnchorElement {
  if (!isSafeExternalUrl(url)) throw new Error(`createSafeExternalLink: refusing to render unsafe URL "${url}"`);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = label; // text node only — never innerHTML, see CORE-005 § 39
  return anchor;
}
