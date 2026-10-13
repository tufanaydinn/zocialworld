/**
 * Where the game server lives. Every endpoint (WebSocket,
 * voice token, content gateway, wallet bridge) has its own VITE_* override;
 * without one, they derive from this:
 *
 *  - `VITE_SERVER_ORIGIN=same` — the server also serves this page (the
 *    single-service deployment): use the
 *    page's own origin, e.g. https://play.example.org;
 *  - `VITE_SERVER_ORIGIN=https://…` — a fixed origin;
 *  - unset — local development: the page's host on port 8787.
 */
export function gameServerOrigin(): string {
  const configured = import.meta.env?.VITE_SERVER_ORIGIN; // undefined in node unit tests
  if (configured === "same") return window.location.origin;
  if (configured) return configured.replace(/\/$/, "");
  return `${window.location.protocol}//${window.location.hostname}:8787`;
}
