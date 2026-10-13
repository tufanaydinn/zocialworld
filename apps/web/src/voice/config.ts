/**
 * Resolves the voice-token HTTP endpoint. No hardcoded production
 * hostname (same reasoning as `networking/config.ts`'s
 * `getWebSocketUrl()`) — `VITE_VOICE_TOKEN_URL` (see `.env.example`) is
 * the real configuration point; the fallback is a local-dev convenience
 * derived from the page's own host, sharing the same default port as
 * the gameplay WebSocket server (both run in one process — see
 * `apps/server/src/index.ts`).
 */
import { gameServerOrigin } from "../core/serverOrigin.ts";

export function getVoiceTokenUrl(): string {
  const configured = import.meta.env.VITE_VOICE_TOKEN_URL;
  if (configured) return configured;

  return `${gameServerOrigin()}/voice/token`;
}
