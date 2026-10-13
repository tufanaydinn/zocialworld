/**
 * Voice server-side configuration — reads LiveKit connection
 * details from the environment. See ../../.env.example.
 *
 * Voice is an optional enhancement: if these variables
 * aren't set, `loadVoiceConfig()` returns `null` and the HTTP server
 * simply never wires up the voice-token endpoint — the rest of the
 * application (multiplayer, nickname, social) is completely unaffected.
 * This is a deliberate "absent config disables the feature" pattern,
 * not an error condition.
 */
export interface VoiceConfig {
  /** LiveKit API key — server-side only, never sent to a browser. */
  apiKey: string;
  /** LiveKit API secret — server-side only, used only to sign tokens, never transmitted anywhere. */
  apiSecret: string;
  /** The ws(s):// URL browsers should use to connect to the LiveKit server. Safe to expose to clients — it's just an endpoint, not a credential. */
  url: string;
  /** Single shared room for the public world — see ADR-007. Not a private room system. */
  roomName: string;
}

/**
 * `npm run dev` (the repository root) starts a local LiveKit server through
 * `scripts/dev/livekit.mjs` and runs this server with this flag, so voice works out of the box.
 */
export const LOCAL_LIVEKIT_FLAG = "--local-livekit";
/** The API key and secret `livekit-server --dev` uses when it is given none (placeholders, never for production). */
export const LIVEKIT_DEV_KEY = "devkey";
export const LIVEKIT_DEV_SECRET = "secret";
/** The local LiveKit's signalling port (`LOCAL_LIVEKIT_PORT`); its RTC ports are the next two. Shared with scripts/dev/livekit.mjs. */
export const LOCAL_LIVEKIT_DEFAULT_PORT = 7880;

/**
 * The local development LiveKit, or null. Only when the server was started with
 * `--local-livekit` (the root `npm run dev`), never with `NODE_ENV=production`, and not when
 * `SKIP_LOCAL_LIVEKIT=1`. A complete `LIVEKIT_*` configuration always wins (callers try
 * `loadVoiceConfig()` first), so pointing at your own LiveKit keeps working.
 */
export function localDevVoiceConfig(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): VoiceConfig | null {
  if (!argv.includes(LOCAL_LIVEKIT_FLAG)) return null;
  if (env.NODE_ENV === "production") return null;
  if (/^(1|true|yes)$/i.test(env.SKIP_LOCAL_LIVEKIT ?? "")) return null;
  const port = Number(env.LOCAL_LIVEKIT_PORT ?? LOCAL_LIVEKIT_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65533) return null;
  return {
    apiKey: LIVEKIT_DEV_KEY,
    apiSecret: LIVEKIT_DEV_SECRET,
    url: `ws://127.0.0.1:${port}`,
    roomName: env.LIVEKIT_ROOM_NAME || "public-world",
  };
}

export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const url = env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !url) return null;

  return {
    apiKey,
    apiSecret,
    url,
    roomName: env.LIVEKIT_ROOM_NAME || "public-world",
  };
}
