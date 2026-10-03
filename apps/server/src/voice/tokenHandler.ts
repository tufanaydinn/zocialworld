import { AccessToken } from "livekit-server-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isOriginAllowed } from "../origin.js";
import type { VoiceConfig } from "./config.js";

/**
 * Voice token minting (CORE-004 §10/§39; capability-auth model added in
 * the CORE-004 security revision — 
 * on PR #4).
 *
 * Deliberately NOT a WebSocket message on the gameplay protocol — this
 * is a one-shot request/response (ask for a token, get a token), kept
 * on its own small HTTP endpoint so the voice module stays structurally
 * separate from `WorldServer`'s presence-relay responsibilities (see
 * ADR-007). `apps/server/src/index.ts` wires this handler onto the same
 * underlying `http.Server` the WebSocket upgrade already uses, on a
 * distinct path.
 *
 * Security posture: the LiveKit API secret never leaves this process —
 * it is used here only to sign a short-lived JWT, which is the only
 * thing sent to the browser. See docs/privacy/VOICE_THREAT_MODEL.md.
 *
 * Trust model (REVISED): the browser supplies only an opaque capability
 * (see `apps/server/src/voice/capability.ts`), never a `playerId` or
 * nickname — those are resolved server-side, from the capability, via
 * `resolveCapability` (in practice, `WorldServer.resolveVoiceSession`).
 * This closes a real vulnerability in the original design: every
 * connected client already learns every other player's `playerId`
 * through the ordinary multiplayer protocol
 * (`player_snapshot`/`player_joined`), so trusting a client-supplied
 * `playerId` directly would let any client request a voice token *as*
 * another visible player (LiveKit participant identity is a
 * routing/security identity, not cosmetic). A `playerId`/nickname field
 * in the request body, if present, is now simply never read — there is
 * no code path from an attacker-supplied value to the minted token.
 */

const MAX_BODY_BYTES = 1024;
const MAX_CAPABILITY_LENGTH = 128; // base64url of 32 random bytes is 43 chars; generous headroom without inviting a large-body attempt
const TOKEN_TTL_SECONDS = 600; // short-lived — CORE-004 §10

const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

export interface VoiceTokenRequest {
  capability: string;
}

export interface VoiceTokenResponse {
  token: string;
  url: string;
  roomName: string;
}

/** The authoritative identity a capability resolves to — see `WorldServer.resolveVoiceSession()`. Never constructed from anything the browser supplied. */
export interface VoiceIdentity {
  playerId: string;
  nickname: string;
}

function isValidCapability(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CAPABILITY_LENGTH &&
    !CONTROL_CHAR_PATTERN.test(value)
  );
}

/**
 * Exported for unit testing without an HTTP round-trip. Deliberately
 * reads ONLY `body.capability` — an extra `playerId`/`nickname` field
 * in the request body (e.g. an attacker trying to resurrect the old
 * trust model) is silently ignored, never merged into the result. See
 * `tokenHandler.test.ts`'s impersonation-attempt tests.
 */
export function parseVoiceTokenRequest(raw: unknown): VoiceTokenRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (!isValidCapability(body.capability)) return null;
  return { capability: body.capability };
}

/** Mints a scoped, short-lived LiveKit token for the given (already server-resolved) identity. No recording grant is ever issued — see CORE-004 §7. */
export async function mintVoiceToken(config: VoiceConfig, identity: VoiceIdentity): Promise<VoiceTokenResponse> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: identity.playerId, // the opaque multiplayer session id — the voice security identity
    name: identity.nickname, // display metadata only, mirrors the social nickname — never the security identity
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    room: config.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // roomRecord intentionally omitted — this grant has no recording
    // capability of any kind, enforced at the token layer, not just by
    // this application never calling a recording API.
  });

  return { token: await token.toJwt(), url: config.url, roomName: config.roomName };
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

/**
 * Builds the request handler for the voice-token endpoint. Returns
 * `null` if `config` is `null` — callers (see index.ts) should respond
 * 503 themselves rather than call a handler that can't exist, keeping
 * "voice is unconfigured" visibly distinct from "voice request failed."
 *
 * `resolveCapability` is the one narrow interface into `WorldServer`
 * this module is allowed to use (in practice,
 * `WorldServer.resolveVoiceSession`, injected from `index.ts`) — it
 * turns an opaque capability into the authoritative `{ playerId,
 * nickname }` to mint a token for, or `null` for an unknown/revoked/
 * superseded one. This handler never reads a `playerId` or `nickname`
 * from the request body itself.
 */
export function createVoiceTokenHandler(
  config: VoiceConfig,
  allowedOrigins: readonly string[],
  resolveCapability: (capability: string) => VoiceIdentity | null,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
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

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    readJsonBody(req, MAX_BODY_BYTES)
      .then((raw) => {
        const parsed = parseVoiceTokenRequest(raw);
        if (!parsed) {
          res.writeHead(400).end();
          return;
        }
        // Never logged — see docs/privacy/VOICE_THREAT_MODEL.md §
        // Logging: a capability is temporary credential material, same
        // discipline as a LiveKit token or API secret.
        const identity = resolveCapability(parsed.capability);
        if (!identity) {
          res.writeHead(403).end(); // unknown, revoked, or superseded capability — never treated as "fall back to anything browser-supplied"
          return;
        }
        return mintVoiceToken(config, identity).then((response) => {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200).end(JSON.stringify(response));
        });
      })
      .catch(() => {
        // Malformed JSON, oversized body, or a token-signing failure —
        // never leak internals (no stack trace, no SDP/ICE/secret data,
        // see CORE-004 §31) to the client.
        if (!res.headersSent) res.writeHead(400).end();
      });
  };
}
