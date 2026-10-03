import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { loadEnvFile } from "./env.js";
import { WorldServer } from "./WorldServer.js";
import { createVerifyClient, isOriginAllowed, isProductionMisconfigured, resolveAllowedOrigins } from "./origin.js";
import { loadVoiceConfig } from "./voice/config.js";
import { createVoiceTokenHandler } from "./voice/tokenHandler.js";

loadEnvFile();

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const staleTimeoutMs = Number(process.env.STALE_TIMEOUT_MS ?? 15000);
const nodeEnv = process.env.NODE_ENV;

// Local dev origins (localhost/127.0.0.1:5173) are auto-allowed outside
// of NODE_ENV=production; in production the allowlist comes *only* from
// ALLOWED_ORIGINS — never hardcoded here. See .env.example and
// docs/protocols/multiplayer-protocol.md § Origin validation.
const allowedOrigins = resolveAllowedOrigins(nodeEnv, process.env.ALLOWED_ORIGINS);

// Fail closed: a production server configured with zero allowed Origins
// would reject every real browser forever, which is almost certainly a
// forgotten ALLOWED_ORIGINS rather than an intended empty allowlist.
if (isProductionMisconfigured(nodeEnv, allowedOrigins)) {
  console.error(
    "[server] refusing to start: NODE_ENV=production but ALLOWED_ORIGINS has no entries. " +
      "Set ALLOWED_ORIGINS to your deployed web client's origin(s) — see .env.example.",
  );
  process.exit(1);
}

// One shared HTTP server for both the gameplay WebSocket upgrade and
// (CORE-004) the voice-token endpoint — two structurally separate
// concerns on one port for local-dev simplicity. See
// apps/server/src/voice/tokenHandler.ts and ADR-007: this is a plain
// request/response endpoint, never merged into the gameplay WS protocol.
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer, verifyClient: createVerifyClient(allowedOrigins) });
const world = new WorldServer(wss, { staleTimeoutMs });

// Voice is optional (CORE-004 §28) — if LIVEKIT_* env vars are absent,
// voiceConfig is null and the endpoint responds 503 rather than existing
// in a half-configured state. Nothing else in this server depends on it.
//
// CORE-004 security revision: the token handler never reads a
// playerId/nickname from the request — it resolves an opaque
// capability through `world.resolveVoiceSession`, the one narrow
// interface the voice module is allowed into WorldServer's session
// state (see WorldServer.resolveVoiceSession's own docstring).
const voiceConfig = loadVoiceConfig();
const voiceTokenHandler = voiceConfig
  ? createVoiceTokenHandler(voiceConfig, allowedOrigins, (capability) => world.resolveVoiceSession(capability))
  : null;

httpServer.on("request", (req, res) => {
  if (req.url !== "/voice/token") {
    res.writeHead(404).end();
    return;
  }
  if (!voiceTokenHandler) {
    // Voice unconfigured: still answer the browser's CORS preflight
    // (OPTIONS) the same way createVoiceTokenHandler would, so a client
    // sees a clean 503 it can read via fetch() rather than a CORS
    // failure at the preflight stage (which otherwise throws a generic,
    // misleading "Failed to fetch" with no HTTP status at all) — see
    // VoiceSession.enableVoice()'s `!response.ok` handling, tested by
    // tests/e2e/voice.spec.ts's Test 8.
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, allowedOrigins)) {
      res.writeHead(403).end();
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204).end();
      return;
    }
    res.writeHead(503).end();
    return;
  }
  voiceTokenHandler(req, res);
});

httpServer.listen(port, host, () => {
  console.log(`[server] listening on ws://${host}:${port} (stale timeout ${staleTimeoutMs}ms)`);
  console.log(`[server] allowed origins: ${allowedOrigins.join(", ")}`);
  console.log(`[server] voice token endpoint: ${voiceConfig ? "enabled" : "disabled (LIVEKIT_* env vars not set)"}`);
});

httpServer.on("error", (error) => {
  console.error("[server] HTTP/WebSocketServer error:", error);
});

function shutdown(): void {
  console.log("[server] shutting down");
  world.dispose();
  httpServer.close(() => process.exit(0));
  // Force-exit if close() hangs (e.g. sockets not draining) — this server
  // holds no state worth flushing, so an immediate exit is safe.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
