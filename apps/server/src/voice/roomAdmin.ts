import { AccessToken } from "livekit-server-sdk";
import type { VoiceConfig } from "./config.js";

/**
 * LiveKit publisher revoke (ADR-019 § 6): the game server tells LiveKit's RoomService, over its HTTP
 * (Twirp) API, to stop a participant from publishing (`canPublish: false` — a stage turn ended by a host, a vote or a
 * cooldown, or the identity was lost) or to remove it from the room (a kick or a ban). This closes the gap where a token
 * minted before the identity was lost kept publishing until it reconnected.
 *
 * Each call carries its own short-lived admin token (`roomAdmin` for the one room, 60 s), signed with the existing
 * LIVEKIT_API_SECRET by livekit-server-sdk's AccessToken — no new dependency. A failure (network, a 5xx) is retried
 * once and then only noted in the server log as "livekit revoke failed" — never with an identity or a name. A
 * participant LiveKit doesn't know (404 `not_found`: never connected voice, or already gone) is not a failure.
 * Honest viewers never subscribe to a non-holder's share anyway (ADR-014 § 5); this is the server-side second layer.
 */

/** What WorldServer needs: fire-and-forget revoke and remove (the moderation tests use a fake). */
export interface PublisherControl {
  revokePublishing(identity: string): void;
  removeParticipant(identity: string): void;
}

/** One participant as RoomService ListParticipants reports it (the fields the tests and operators read). */
export interface RoomParticipantInfo {
  readonly identity: string;
  readonly canPublish: boolean;
  readonly tracks: readonly { readonly source: string; readonly muted: boolean }[];
}

export interface RoomAdminOptions {
  /** The RoomService base URL (http/https). Default: LIVEKIT_URL with ws→http (LIVEKIT_API_URL overrides it). */
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  /** Delay before the one retry (default 500 ms). */
  readonly retryDelayMs?: number;
  /** Per-request timeout (default 5 s). */
  readonly timeoutMs?: number;
  /** Where the nameless failure line goes (default console.warn). */
  readonly warn?: (line: string) => void;
}

const ADMIN_TOKEN_TTL_SECONDS = 60;
const SERVICE = "/twirp/livekit.RoomService/";

/** `ws(s)://host[:port][/path]` → `http(s)://host[:port]` (RoomService lives on the signalling port). */
export function roomServiceUrl(url: string): string {
  const parsed = new URL(url.replace(/^ws(s?):\/\//i, "http$1://"));
  return `${parsed.protocol}//${parsed.host}`;
}

type CallResult = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly notFound: boolean };

export class LiveKitRoomAdmin implements PublisherControl {
  private readonly config: VoiceConfig;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly warn: (line: string) => void;

  constructor(config: VoiceConfig, options: RoomAdminOptions = {}) {
    this.config = config;
    this.baseUrl = (options.apiUrl ? roomServiceUrl(options.apiUrl) : roomServiceUrl(config.url)).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.warn = options.warn ?? ((line) => console.warn(line));
  }

  revokePublishing(identity: string): void {
    void this.updatePermission(identity);
  }

  removeParticipant(identity: string): void {
    void this.remove(identity);
  }

  /** Sets the participant's permission to subscribe-only. Resolves true on success (or when it isn't in the room). */
  async updatePermission(identity: string): Promise<boolean> {
    return this.withRetry("UpdateParticipant", {
      room: this.config.roomName,
      identity,
      // Replaces the whole permission: subscribe only — no microphone, no screen, no data, no attribute updates.
      permission: { canSubscribe: true, canPublish: false, canPublishData: false, canPublishSources: [], canUpdateMetadata: false },
    });
  }

  /** Removes the participant from the room. Resolves true on success (or when it isn't in the room). */
  async remove(identity: string): Promise<boolean> {
    return this.withRetry("RemoveParticipant", { room: this.config.roomName, identity });
  }

  /** RoomService ListParticipants for the room (tests and operators; never logged). */
  async listParticipants(): Promise<RoomParticipantInfo[]> {
    const result = await this.call("ListParticipants", { room: this.config.roomName });
    if (!result.ok) {
      if (result.notFound) return []; // no room yet: nobody connected
      throw new Error("ListParticipants failed");
    }
    const participants = (result.body as { participants?: unknown[] } | null)?.participants ?? [];
    return participants.map((raw) => {
      const p = raw as { identity?: unknown; permission?: { canPublish?: unknown; can_publish?: unknown }; tracks?: { source?: unknown; muted?: unknown }[] };
      const permission = p.permission ?? {};
      return {
        identity: typeof p.identity === "string" ? p.identity : "",
        canPublish: permission.canPublish === true || permission.can_publish === true,
        tracks: (p.tracks ?? []).map((track) => ({ source: String(track.source ?? "UNKNOWN"), muted: track.muted === true })),
      };
    });
  }

  private async withRetry(method: string, body: Record<string, unknown>): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.call(method, body);
      if (result.ok || result.notFound) return true;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
    this.warn("[moderation] livekit revoke failed");
    return false;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<CallResult> {
    try {
      const token = new AccessToken(this.config.apiKey, this.config.apiSecret, { ttl: ADMIN_TOKEN_TTL_SECONDS });
      token.addGrant({ roomAdmin: true, room: this.config.roomName });
      const response = await this.fetchImpl(`${this.baseUrl}${SERVICE}${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token.toJwt()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.ok) return { ok: true, body: await response.json().catch(() => null) };
      // Twirp: `not_found` is HTTP 404 (the participant or the room doesn't exist).
      if (response.status === 404) return { ok: false, notFound: true };
      return { ok: false, notFound: false };
    } catch {
      return { ok: false, notFound: false };
    }
  }
}
