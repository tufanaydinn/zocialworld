/**
 * Resolves the multiplayer WebSocket endpoint. No hardcoded production
 * hostname (CORE-002 §23) — `VITE_WS_URL` (see `.env.example`) is the
 * real configuration point; the fallback below is a local-dev
 * convenience only, derived from the page's own host rather than a
 * hardcoded "localhost" so it also works when testing from another
 * device on the same LAN as the dev server.
 */
export function getWebSocketUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (configured) return configured;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:8787`;
}
