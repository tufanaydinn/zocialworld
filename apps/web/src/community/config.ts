import { gameServerOrigin } from "../core/serverOrigin.ts";

/**
 * Base URL of the server's read-only community content gateway
 * (`apps/server/src/content/`). Same convention as the voice endpoint:
 * `VITE_CONTENT_URL` is the real configuration point; the fallback is a
 * local-dev convenience on the gameplay server's port. The browser only
 * ever talks to OUR server — never to ZecHub, the forum or GitHub
 * directly (privacy baseline: no player IP to third parties).
 */
export function getContentBaseUrl(): string {
  const configured = import.meta.env.VITE_CONTENT_URL;
  if (configured) return configured.replace(/\/$/, "");
  return `${gameServerOrigin()}/content`;
}
