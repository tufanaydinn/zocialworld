/**
 * Voice (CORE-004) server-side configuration — reads LiveKit connection
 * details from the environment. See ../../.env.example.
 *
 * Voice is an optional enhancement (CORE-004 §28): if these variables
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
  /** Single shared room for CORE-004's public-world prototype scope — see ADR-003. Not a private room system. */
  roomName: string;
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
