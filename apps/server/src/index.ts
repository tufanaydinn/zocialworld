import { createServer } from "node:http";
import { loadEnvFile } from "./env.js";
import { WorldServer } from "./WorldServer.js";
import { HALL_DEFAULT_MAX_TURN_MS, hallHostKeyProblem } from "./watchHall.js";
import { isOriginAllowed, isProductionMisconfigured, resolveAllowedOrigins } from "./origin.js";
import { createGameSocketServer } from "./socketServer.js";
import { LOCAL_LIVEKIT_FLAG, loadVoiceConfig, localDevVoiceConfig } from "./voice/config.js";
import { createVoiceTokenHandler } from "./voice/tokenHandler.js";
import { createCommunityContentHandler } from "./content/communityContent.js";
import { loadWatchCatalog } from "./content/watchCatalogFile.js";
import { createLightwalletdProxy } from "./zcash/lwdProxy.js";
import { MINIMAL_PAGE_CSP, buildPageCsp, createStaticSiteHandler, cspConnectOrigins, cspImageOrigins } from "./staticSite.js";
import { createFaucetHandler, zcashdRpcFromEnv } from "./zcash/faucet.js";
import { describeNameService } from "./identity/nameService.js";
import { createWalletServices } from "./zcash/walletServices.js";
import { describeZcashServerConfig, publicZcashInfo } from "./zcash/network.js";
import { createVersionHandler, resolveBuildId } from "./buildInfo.js";
import { describeModeratorKeys, parseModeratorKeys } from "./moderation/moderatorKeys.js";
import { DEFAULT_MAX_NEW_CONNECTIONS_PER_MINUTE, parseMaxSessionsPerIp } from "./moderation/connectionLimits.js";
import { parseTrustProxy } from "./moderation/clientAddress.js";
import { LiveKitRoomAdmin } from "./voice/roomAdmin.js";

loadEnvFile();

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const staleTimeoutMs = Number(process.env.STALE_TIMEOUT_MS ?? 30000);
const nodeEnv = process.env.NODE_ENV;

// Local dev origins (localhost/127.0.0.1 on :5174 and :5173) are auto-allowed outside
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
// the voice-token endpoint — two structurally separate
// concerns on one port for local-dev simplicity. See
// apps/server/src/voice/tokenHandler.ts and ADR-007: this is a plain
// request/response endpoint, never merged into the gameplay WS protocol.
// ADR-018: ZCASH_NETWORK=test|main, the wallet bridge's upstream (LIGHTWALLETD_URL, default zec.rocks on
// main), the payment cap (PAYMENT_CAP_ZEC), owned names (ADR-016: NAME_REGISTRY=off|dev|zcashd|
// lightwalletd, NAME_REGISTRY_ADDRESS, NAME_REGISTRY_UFVK, NAME_FEE_ZEC, NAME_REGISTRY_FILE; the zcashd scanner reuses
// the faucet's ZCASHD_RPC_* client) and the transfer fee (ADR-018 § 6: PAYMENT_FEE_*). Fail closed on a bad value, on
// main with test-chain-only settings (faucet, zcashd/dev registry), on dev with NODE_ENV=production, on a fee/registry
// address that is not its viewing key's, and on an unreadable store (never start and overwrite it). Addresses, keys
// and txids are never logged.
const zcashdRpc = zcashdRpcFromEnv();
const walletServices = createWalletServices(process.env, { rpc: zcashdRpc });
if (!walletServices.ok) {
  console.error(`[server] ${walletServices.error}`);
  process.exit(1);
}
const { zcash, nameConfig, names, fees: transferFees, feeProblem, warnings: walletWarnings } = walletServices.services;
// Startup warnings, e.g. a mainnet registry/fee address without an Orchard-family receiver (never the address or key).
for (const warning of walletWarnings) console.warn(`[server] WARNING: ${warning}`);
// ADR-018 § 7: the served client's build id ("Update ready — reload"): BUILD_ID, else WEB_DIST/build-id.txt.
const buildId = resolveBuildId(process.env, process.env.WEB_DIST ?? null);

const httpServer = createServer();
// Messages over WS_MAX_PAYLOAD_BYTES (4 KiB) close the socket with 1009 before they are buffered.
const wss = createGameSocketServer(httpServer, allowedOrigins);
// Watch Hall: the host key is handed to the hall rules once and never logged.
// The max turn is a plain number of milliseconds, capped at 24 h: unset or empty (an empty value counts as unset)
// keeps the 60-minute default, 0 turns the cap off, and an unreadable value keeps the default with a warning.
const HALL_MAX_TURN_CAP_MS = 24 * 60 * 60 * 1000;
const hallMaxTurnRaw = process.env.WATCH_HALL_MAX_TURN_MS?.trim() ?? "";
const hallMaxTurnParsed = hallMaxTurnRaw === "" ? null : Number(hallMaxTurnRaw);
if (hallMaxTurnParsed !== null && !(Number.isFinite(hallMaxTurnParsed) && hallMaxTurnParsed >= 0)) {
  console.warn(`[server] WATCH_HALL_MAX_TURN_MS is not a number of milliseconds (≥ 0); keeping the ${HALL_DEFAULT_MAX_TURN_MS / 60_000}-minute default`);
}
const hallMaxTurnMs = hallMaxTurnParsed !== null && Number.isFinite(hallMaxTurnParsed) && hallMaxTurnParsed >= 0 ? Math.min(HALL_MAX_TURN_CAP_MS, hallMaxTurnParsed) : undefined;

// Voice is optional — see the token handler below. Read before the world: the moderation tools revoke
// LiveKit publishers through the same configuration (ADR-019 § 6).
const configuredVoice = loadVoiceConfig();
const localVoice = configuredVoice ? null : localDevVoiceConfig();
const voiceConfig = configuredVoice ?? localVoice;

// ADR-019: MODERATOR_KEYS (comma-separated, each like the host key; weak ones are dropped — never
// logged), MAX_SESSIONS_PER_IP (default 4; 0 = no per-IP limits, local testing only) with 10 new connections a minute
// per network, TRUST_PROXY (the reverse proxy whose X-Forwarded-For names the client), and the LiveKit RoomService
// (LIVEKIT_API_URL overrides where it is reached; default: LIVEKIT_URL's host over http/https).
const moderatorKeys = parseModeratorKeys(process.env.MODERATOR_KEYS);
const maxSessionsPerIp = parseMaxSessionsPerIp(process.env.MAX_SESSIONS_PER_IP);
if (maxSessionsPerIp.warning) console.warn(`[server] ${maxSessionsPerIp.warning}`);
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy.invalid > 0) console.warn(`[server] TRUST_PROXY: ${trustProxy.invalid} entr${trustProxy.invalid === 1 ? "y is" : "ies are"} not an IP address and ${trustProxy.invalid === 1 ? "is" : "are"} ignored`);
const roomAdmin = voiceConfig ? new LiveKitRoomAdmin(voiceConfig, process.env.LIVEKIT_API_URL?.trim() ? { apiUrl: process.env.LIVEKIT_API_URL.trim() } : {}) : null;

const world = new WorldServer(wss, {
  staleTimeoutMs,
  ...(process.env.WATCH_HALL_HOST_KEY ? { hallHostKey: process.env.WATCH_HALL_HOST_KEY } : {}),
  ...(hallMaxTurnMs !== undefined ? { hallMaxTurnMs } : {}),
  names,
  paymentCapZat: zcash.paymentCapZat,
  transferFees,
  buildId,
  moderatorKeys,
  connectionLimits: { maxSessionsPerIp: maxSessionsPerIp.value, maxNewPerMinute: DEFAULT_MAX_NEW_CONNECTIONS_PER_MINUTE },
  trustedProxies: trustProxy.proxies,
  publishers: roomAdmin,
});

// Voice is optional — if LIVEKIT_* env vars are absent,
// voiceConfig (read above) is null and the endpoint responds 503 rather than existing
// in a half-configured state. Only the moderation tools' publisher revoke also uses it (ADR-019 § 6).
//
// The token handler never reads a
// playerId/nickname from the request — it resolves an opaque
// capability through `world.resolveVoiceSession`, the one narrow
// interface the voice module is allowed into WorldServer's session
// state (see WorldServer.resolveVoiceSession's own docstring).
// The root `npm run dev` starts a local LiveKit (scripts/dev/livekit.mjs) and passes --local-livekit, so
// voice works out of the box in development — never in production, never over a complete LIVEKIT_* configuration,
// and not with SKIP_LOCAL_LIVEKIT=1.
if (process.argv.includes(LOCAL_LIVEKIT_FLAG) && nodeEnv === "production") console.warn("[server] --local-livekit is ignored with NODE_ENV=production");
const voiceTokenHandler = voiceConfig
  ? createVoiceTokenHandler(voiceConfig, allowedOrigins, (capability) => world.resolveVoiceSession(capability))
  : null;

// Read-only community content gateway (ZecHub bounties/wiki, forum,
// GitHub) — lets the client show third-party content in-game without the
// browser contacting those services. See content/communityContent.ts.
// The Watch Hall catalogue: WATCH_CATALOG_FILE, else a deployment-provided catalogue file next to src/ when present,
// else the sample. A broken file stops the start (content/watchCatalogFile.ts).
const watchCatalog = loadWatchCatalog(process.env.WATCH_CATALOG_FILE);
const communityContent = createCommunityContentHandler({
  allowedOrigins,
  watchCatalog: watchCatalog.catalog,
  ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
  // Watch Hall: optional, enables YouTube live status and view counts. Server-only; never logged.
  ...(process.env.YOUTUBE_API_KEY ? { youtubeApiKey: process.env.YOUTUBE_API_KEY } : {}),
});

// In-game wallet sync/broadcast bridge (grpc-web → lightwalletd gRPC) so the
// lightwalletd operator never sees players' IPs. testnet.zec.rocks by default, zec.rocks on
// ZCASH_NETWORK=main (zcash/network.ts); LIGHTWALLETD_URL=off disables it. See zcash/lwdProxy.ts.
// LIGHTWALLETD_URL may list mirrors ("a,b"): tried in order with health-based failover (zcash/upstreamPool.ts).
const lightwalletdUrls = zcash.lightwalletdUrls;
const lightwalletd = lightwalletdUrls.length === 0 ? null : createLightwalletdProxy({ allowedOrigins, upstream: lightwalletdUrls });

// Regtest test-coin faucet (zcashd z_sendmany; disabled unless ZCASHD_RPC_* are set). A claim must come
// from a live session: the owner-only capability from `welcome` is resolved like the voice token's — or, before
// join (a new player paying the name fee during onboarding, ADR-016), the connection's pending reservation id.
// GET /zcash/info also tells the client how names work here (mode and fee only).
// /zcash/info also says which network this server is on and the payment rules (fee and cap, never the
// fee address); on main there is no faucet (ADR-018 § 4).
const faucet = createFaucetHandler({
  allowedOrigins,
  ...(zcashdRpc ? { rpc: zcashdRpc } : {}),
  network: zcash.network,
  resolveSession: (capability) => world.resolveVoiceSession(capability)?.playerId ?? world.resolveNameReservationSession(capability),
  info: () => publicZcashInfo(zcash, world.nameInfo, transferFees?.feeZat ?? 0),
});
const version = createVersionHandler({ allowedOrigins, build: () => buildId });

// Single-service deployment: WEB_DIST=/path/to/apps/web/dist makes this server also serve the client
// (one origin for page, WebSocket, voice, content and wallet bridge).
// The full Content-Security-Policy, from this deployment's own origins (the page origins'
// WebSocket form and LiveKit); CSP_MODE=minimal keeps only frame-ancestors/object-src/base-uri (regression escape hatch).
const pageCsp =
  process.env.CSP_MODE?.trim() === "minimal"
    ? MINIMAL_PAGE_CSP
    : buildPageCsp({ connectOrigins: cspConnectOrigins(allowedOrigins, voiceConfig?.url ?? null), imageOrigins: cspImageOrigins(allowedOrigins) });
const staticSite = process.env.WEB_DIST ? createStaticSiteHandler(process.env.WEB_DIST, { csp: pageCsp }) : null;

httpServer.on("request", (req, res) => {
  if (communityContent(req, res)) return;
  if (lightwalletd?.(req, res)) return;
  if (faucet(req, res)) return;
  if (version(req, res)) return;
  if (req.url !== "/voice/token" && staticSite?.(req, res)) return;
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
    // A reason the client can tell apart from a proxy's 503 ("Voice isn't set up on this game server").
    res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "voice_unconfigured" }));
    return;
  }
  voiceTokenHandler(req, res);
});

httpServer.listen(port, host, () => {
  console.log(`[server] listening on ws://${host}:${port} (stale timeout ${staleTimeoutMs}ms)`);
  console.log(`[server] allowed origins: ${allowedOrigins.join(", ")}`);
  console.log(
    `[server] voice token endpoint: ${
      configuredVoice ? "enabled" : localVoice ? `enabled — local development LiveKit at ${localVoice.url} (--dev keys; started by npm run dev, scripts/dev/livekit.mjs)` : "disabled (LIVEKIT_* env vars not set)"
    }`,
  );
  console.log(`[server] watch hall host role: ${world.hallHostEnabled ? "enabled" : `disabled (${hallHostKeyProblem(process.env.WATCH_HALL_HOST_KEY) ?? "unknown"})`}`);
  console.log(`[server] moderators: ${describeModeratorKeys(moderatorKeys)}; reports, mutes and short bans in memory only${roomAdmin ? "; LiveKit publisher revoke on" : ""}`);
  console.log(
    `[server] connection limit: ${maxSessionsPerIp.value > 0 ? `${maxSessionsPerIp.value} sessions and ${DEFAULT_MAX_NEW_CONNECTIONS_PER_MINUTE} new connections a minute per network` : "OFF (MAX_SESSIONS_PER_IP=0 — local testing only)"}; client address: ${trustProxy.proxies.size > 0 ? `X-Forwarded-For from ${trustProxy.proxies.size} trusted prox${trustProxy.proxies.size === 1 ? "y" : "ies"} (TRUST_PROXY)` : "the socket's peer"}`,
  );
  const maxTurn = hallMaxTurnMs ?? HALL_DEFAULT_MAX_TURN_MS;
  console.log(`[server] watch hall max turn: ${maxTurn > 0 ? `${Math.round(maxTurn / 60_000)} min while others wait and no host is in the hall` : "off"}`);
  console.log("[server] community content gateway: GET /content/* (read-only, cached)");
  console.log(
    `[server] watch catalogue: ${watchCatalog.origin} (${watchCatalog.catalog.collections.length} collection${watchCatalog.catalog.collections.length === 1 ? "" : "s"}); YouTube live status ${process.env.YOUTUBE_API_KEY ? "enabled" : "off (YOUTUBE_API_KEY unset; Atom feeds + curated replays)"}`,
  );
  console.log(`[server] web client: ${staticSite ? `serving ${process.env.WEB_DIST}` : "not served here (dev: Vite)"}`);
  console.log(`[server] zcash network: ${describeZcashServerConfig(zcash)}`);
  console.log(`[server] wallet bridge: ${lightwalletd ? `POST /zcash/lwd/* → ${lightwalletdUrls.join(", ")}${lightwalletdUrls.length > 1 ? " (in failover order)" : ""}` : "disabled"}`);
  console.log(`[server] name registry: ${describeNameService(names, nameConfig)}`);
  console.log(`[server] transfer fee: ${transferFees ? `${transferFees.feeZat / 1e8} ZEC per player payment (ADR-018 § 6), verified with the fee account's viewing key` : `off (${feeProblem ?? "not configured"})`}`);
  console.log(`[server] client build: ${buildId ?? "unknown (no update prompt)"}`);
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
