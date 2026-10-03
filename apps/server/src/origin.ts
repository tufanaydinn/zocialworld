/**
 * WebSocket `Origin` allowlist.
 *
 * Browsers send an `Origin` header on every WebSocket handshake and
 * cannot be told by page JavaScript to send a different one — it's set
 * by the browser itself from the page's real origin. That makes it a
 * (browser-cooperation) check against a hostile *website* trying to get
 * its visitors' browsers to open a WebSocket to this server, e.g. to
 * ride the visitor's position in some other exploit. It is NOT an
 * authentication mechanism: a non-browser client (curl, a bot, a
 * modified client) can send any `Origin` it likes, or none at all —
 * see `isOriginAllowed`'s handling of a missing header below.
 */

export const DEFAULT_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/** Parses the comma-separated `ALLOWED_ORIGINS` env var into a list, trimming whitespace and dropping empty entries. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Decides whether a WebSocket upgrade should be accepted based on its
 * `Origin` header.
 *
 * Deliberate policy: a **missing** Origin is allowed. Only a **present**
 * Origin that isn't on the allowlist is rejected. Reasoning: Origin is
 * reliably sent only by real browsers; non-browser clients (this
 * project's own test suite included — see `origin.test.ts`, and
 * anything server-to-server in the future) legitimately send no Origin
 * at all. Rejecting "no Origin" would block those without meaningfully
 * stopping a motivated attacker, who doesn't need a browser (and
 * therefore doesn't need to send a real Origin) to reach this server in
 * the first place. What this check actually stops is a browser, on some
 * other website, whose Origin header the browser itself attaches and
 * the page's JavaScript cannot override.
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

/** Builds a `ws` `verifyClient` callback enforcing `isOriginAllowed` against the given allowlist. */
export function createVerifyClient(allowedOrigins: readonly string[]): (info: { origin: string }) => boolean {
  return (info) => isOriginAllowed(info.origin || undefined, allowedOrigins);
}

/**
 * Whether the server should treat itself as running in production for
 * Origin-policy purposes. Only the literal string `"production"` counts
 * — anything else (`undefined`, `"development"`, `"test"`, a typo) is
 * treated as non-production, which is the permissive-but-local direction
 * (auto-allowing `localhost`/`127.0.0.1:5173`), not the
 * exposed-to-the-internet direction. A deployment must opt *in* to the
 * stricter production policy by setting `NODE_ENV=production`
 * explicitly, rather than accidentally falling out of it via a typo.
 */
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === "production";
}

/**
 * Resolves the full allowed-Origins list for a given environment.
 *
 * - Non-production (`nodeEnv` anything but `"production"`): the local
 *   dev defaults (`DEFAULT_DEV_ORIGINS`) are always included, in
 *   addition to whatever `ALLOWED_ORIGINS` configures. This is what
 *   makes `npm run dev` work out of the box.
 * - Production: `DEFAULT_DEV_ORIGINS` are **not** included. The
 *   allowlist is exactly whatever `ALLOWED_ORIGINS` configures — a
 *   production deployment that still trusted `localhost:5173` forever
 *   would be a standing hole, not a convenience.
 */
export function resolveAllowedOrigins(nodeEnv: string | undefined, allowedOriginsEnv: string | undefined): string[] {
  const explicit = parseAllowedOrigins(allowedOriginsEnv);
  if (isProductionEnv(nodeEnv)) return explicit;
  return [...DEFAULT_DEV_ORIGINS, ...explicit];
}

/**
 * Fail-closed startup guard: a production server with zero allowed
 * Origins would silently reject every real browser connection forever
 * (while still accepting any non-browser client, per the missing-Origin
 * policy above) — that's almost certainly a forgotten `ALLOWED_ORIGINS`,
 * not an intentional choice, so the policy here is to refuse to start
 * rather than run in that state. See `apps/server/src/index.ts`.
 */
export function isProductionMisconfigured(nodeEnv: string | undefined, allowedOrigins: readonly string[]): boolean {
  return isProductionEnv(nodeEnv) && allowedOrigins.length === 0;
}
