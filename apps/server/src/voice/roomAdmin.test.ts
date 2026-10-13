import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { LiveKitRoomAdmin, roomServiceUrl } from "./roomAdmin.js";
import type { VoiceConfig } from "./config.js";

/**
 * ADR-019 § 6: the RoomService Twirp calls with a fake fetch — the request shape, the short-lived admin
 * token signed with LIVEKIT_API_SECRET, one retry, a nameless failure line, and 404 meaning "nothing to revoke". The
 * real-LiveKit check (a kicked or benched publisher really stops) is tests/e2e/moderation-livekit-real.spec.ts.
 */

const CONFIG: VoiceConfig = { apiKey: "APIkey123", apiSecret: "secret-for-tests-only-1234567890", url: "wss://voice.example.org", roomName: "public-world" };

interface Call {
  url: string;
  body: Record<string, unknown>;
  auth: string;
}

function fakeFetch(statuses: number[], json: unknown = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: headers.Authorization ?? "" });
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function decodeJwt(header: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signatureOk: boolean } {
  const token = header.replace(/^Bearer /, "");
  const [h, p, s] = token.split(".") as [string, string, string];
  const expected = createHmac("sha256", CONFIG.apiSecret).update(`${h}.${p}`).digest("base64url");
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(p, "base64url").toString()), signatureOk: expected === s };
}

test("the RoomService URL is LIVEKIT_URL's host over http(s)", () => {
  assert.equal(roomServiceUrl("wss://voice.example.org"), "https://voice.example.org");
  assert.equal(roomServiceUrl("ws://127.0.0.1:7880/"), "http://127.0.0.1:7880");
  assert.equal(roomServiceUrl("http://livekit:7880"), "http://livekit:7880");
});

test("revoke: UpdateParticipant to subscribe-only, with a 60-second roomAdmin token for the one room", async () => {
  const { calls, fetchImpl } = fakeFetch([200]);
  const admin = new LiveKitRoomAdmin(CONFIG, { fetch: fetchImpl, apiUrl: "http://livekit:7880" });
  assert.equal(await admin.updatePermission("player-1"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://livekit:7880/twirp/livekit.RoomService/UpdateParticipant");
  assert.deepEqual(calls[0]!.body, {
    room: "public-world",
    identity: "player-1",
    permission: { canSubscribe: true, canPublish: false, canPublishData: false, canPublishSources: [], canUpdateMetadata: false },
  });
  const jwt = decodeJwt(calls[0]!.auth);
  assert.equal(jwt.signatureOk, true, "signed with LIVEKIT_API_SECRET (HS256)");
  assert.equal(jwt.header.alg, "HS256");
  assert.equal(jwt.claims.iss, CONFIG.apiKey);
  assert.deepEqual(jwt.claims.video, { roomAdmin: true, room: "public-world" });
  assert.equal(Number(jwt.claims.exp) - Number(jwt.claims.nbf ?? jwt.claims.iat ?? Number(jwt.claims.exp) - 60) <= 60, true, "short-lived");
});

test("remove: RemoveParticipant; a 404 (not in the room) is not a failure and is not retried", async () => {
  const { calls, fetchImpl } = fakeFetch([404]);
  const warnings: string[] = [];
  const admin = new LiveKitRoomAdmin(CONFIG, { fetch: fetchImpl, warn: (line) => warnings.push(line), retryDelayMs: 1 });
  assert.equal(await admin.remove("player-2"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://voice.example.org/twirp/livekit.RoomService/RemoveParticipant");
  assert.deepEqual(calls[0]!.body, { room: "public-world", identity: "player-2" });
  assert.deepEqual(warnings, []);
});

test("a failure is retried once, then only a nameless line is logged", async () => {
  const flaky = fakeFetch([503, 200]);
  const warnings: string[] = [];
  const admin = new LiveKitRoomAdmin(CONFIG, { fetch: flaky.fetchImpl, warn: (line) => warnings.push(line), retryDelayMs: 1 });
  assert.equal(await admin.updatePermission("player-3"), true);
  assert.equal(flaky.calls.length, 2);
  assert.deepEqual(warnings, []);

  const down = fakeFetch([500, 502]);
  const admin2 = new LiveKitRoomAdmin(CONFIG, { fetch: down.fetchImpl, warn: (line) => warnings.push(line), retryDelayMs: 1 });
  assert.equal(await admin2.remove("player-secret-id"), false);
  assert.equal(down.calls.length, 2, "one retry");
  assert.deepEqual(warnings, ["[moderation] livekit revoke failed"]);

  const unreachable = new LiveKitRoomAdmin(CONFIG, { fetch: (async () => Promise.reject(new Error("ECONNREFUSED player-secret-id"))) as typeof fetch, warn: (line) => warnings.push(line), retryDelayMs: 1 });
  assert.equal(await unreachable.updatePermission("player-secret-id"), false);
  assert.equal(warnings.join("\n").includes("player-secret-id"), false, "never an identity in the log");
});

test("listParticipants reads identities, canPublish and track sources", async () => {
  const { fetchImpl } = fakeFetch([200], { participants: [{ identity: "a", permission: { canPublish: false }, tracks: [] }, { identity: "b", permission: { canPublish: true }, tracks: [{ source: "SCREEN_SHARE" }] }] });
  const admin = new LiveKitRoomAdmin(CONFIG, { fetch: fetchImpl });
  assert.deepEqual(await admin.listParticipants(), [
    { identity: "a", canPublish: false, tracks: [] },
    { identity: "b", canPublish: true, tracks: [{ source: "SCREEN_SHARE", muted: false }] },
  ]);
});
