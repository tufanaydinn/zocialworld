import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { VoiceConfig } from "./config.js";
import { parseVoiceTokenRequest, mintVoiceToken, createVoiceTokenHandler, type VoiceIdentity } from "./tokenHandler.js";

const TEST_CONFIG: VoiceConfig = {
  apiKey: "test-key",
  apiSecret: "test-secret-at-least-32-characters-long",
  url: "ws://127.0.0.1:7880",
  roomName: "public-world",
};

// --- parseVoiceTokenRequest --------------------------------------------------
// The request shape is { capability }, resolved server-side — never a
// client-supplied playerId/nickname. See WorldServer.resolveVoiceSession().

test("parseVoiceTokenRequest accepts a well-formed body", () => {
  const result = parseVoiceTokenRequest({ capability: "abc-123" });
  assert.deepEqual(result, { capability: "abc-123" });
});

test("parseVoiceTokenRequest rejects missing or wrong-typed fields", () => {
  assert.equal(parseVoiceTokenRequest(null), null);
  assert.equal(parseVoiceTokenRequest({}), null);
  assert.equal(parseVoiceTokenRequest({ capability: 123 }), null);
  assert.equal(parseVoiceTokenRequest({ capability: "" }), null);
});

test("parseVoiceTokenRequest rejects a capability containing control characters", () => {
  assert.equal(parseVoiceTokenRequest({ capability: "abc\u0000" }), null);
});

test("parseVoiceTokenRequest rejects an over-length capability", () => {
  assert.equal(parseVoiceTokenRequest({ capability: "a".repeat(129) }), null);
});

// The browser cannot override the
// playerId/nickname placed into the minted token — parseVoiceTokenRequest
// reads ONLY `.capability`; an attacker sending a { playerId, nickname }
// body gets silently ignored, never merged into the result.
test("an extra playerId/nickname field in the request body is ignored, never extracted", () => {
  const result = parseVoiceTokenRequest({
    capability: "real-capability",
    playerId: "someone-elses-playerId",
    nickname: "Spoofed Name",
  });
  assert.deepEqual(result, { capability: "real-capability" }, "only capability may ever be read from the request");
});

// --- mintVoiceToken ---------------------------------------------------------
// Identity is the multiplayer playerId (the security
// identity), nickname is display metadata only. No recording grant. Takes
// an already-server-resolved VoiceIdentity — never anything browser-supplied.

test("mintVoiceToken uses playerId as the LiveKit identity, not the nickname", async () => {
  const response = await mintVoiceToken(TEST_CONFIG, { playerId: "player-xyz", nickname: "Builder", canReceive: true, canTalk: true });
  assert.equal(typeof response.token, "string");
  assert.ok(response.token.length > 0);
  assert.equal(response.url, TEST_CONFIG.url);
  assert.equal(response.roomName, TEST_CONFIG.roomName);

  // Decode the JWT payload (base64url, no verification needed for this
  // structural assertion) to confirm identity/name mapping and the
  // absence of a recording grant.
  const payloadBase64 = response.token.split(".")[1]!;
  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
  assert.equal(payload.sub, "player-xyz", "JWT subject (identity) must be the playerId");
  assert.equal(payload.name, "Builder", "JWT name must be the nickname (display only)");
  assert.equal(payload.video?.roomRecord, undefined, "no recording grant may ever be issued");
  assert.equal(payload.video?.room, TEST_CONFIG.roomName);
});

test("voice tokens may publish microphone and screen share only (never a webcam)", async () => {
  const response = await mintVoiceToken(TEST_CONFIG, { playerId: "p1", nickname: "Builder", canReceive: true, canTalk: true });
  const payload = JSON.parse(Buffer.from(response.token.split(".")[1]!, "base64url").toString("utf8"));
  const sources = (payload.video?.canPublishSources ?? []) as string[];
  assert.ok(sources.length > 0, "publish sources must be restricted explicitly");
  assert.ok(sources.some((source) => /microphone/i.test(source)));
  assert.ok(!sources.some((source) => /camera/i.test(source)), `no camera source allowed, got ${sources.join(",")}`);
  assert.equal(payload.video?.canUpdateOwnMetadata, true, "needed for the voice-range attribute");
});

// ADR-014 § 5: watch mode. The request may only narrow the grant.
const decodeVideoGrant = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")).video as Record<string, unknown>;

test("parseVoiceTokenRequest reads an optional listenOnly flag (true only) and rejects a non-boolean", () => {
  assert.deepEqual(parseVoiceTokenRequest({ capability: "abc", listenOnly: true }), { capability: "abc", listenOnly: true });
  assert.deepEqual(parseVoiceTokenRequest({ capability: "abc", listenOnly: false }), { capability: "abc" });
  assert.equal(parseVoiceTokenRequest({ capability: "abc", listenOnly: "yes" }), null);
  assert.equal(parseVoiceTokenRequest({ capability: "abc", listenOnly: 1 }), null);
});

test("the normal grant may publish microphone, screen share and tab audio (SCREEN_SHARE_AUDIO)", async () => {
  const grant = decodeVideoGrant((await mintVoiceToken(TEST_CONFIG, { playerId: "p1", nickname: "Builder", canReceive: true, canTalk: true })).token);
  assert.equal(grant.canPublish, true);
  assert.deepEqual(grant.canPublishSources, ["microphone", "screen_share", "screen_share_audio"]);
  assert.equal(grant.canSubscribe, true);
  assert.equal(grant.canUpdateOwnMetadata, true);
});

test("the listen-only grant can subscribe but publishes nothing and cannot set attributes", async () => {
  const grant = decodeVideoGrant((await mintVoiceToken(TEST_CONFIG, { playerId: "p1", nickname: "Builder", canReceive: true, canTalk: true }, { listenOnly: true })).token);
  assert.equal(grant.canPublish, false);
  assert.deepEqual(grant.canPublishSources, []);
  assert.equal(grant.canPublishData, false);
  assert.equal(grant.canSubscribe, true);
  assert.equal(grant.canUpdateOwnMetadata, false);
  assert.equal(grant.roomRecord, undefined, "still no recording grant");
  assert.equal(grant.room, TEST_CONFIG.roomName);
});

// No wallet identifier is part of the voice participant/application mapping.
test("no wallet-shaped field is ever accepted, minted, or present in a voice token", async () => {
  const response = await mintVoiceToken(TEST_CONFIG, { playerId: "p1", nickname: "Builder", canReceive: true, canTalk: true });
  const payloadBase64 = response.token.split(".")[1]!;
  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
  const payloadKeys = Object.keys(payload).join(" ").toLowerCase();
  assert.ok(!payloadKeys.includes("wallet"), "minted token must carry no wallet-shaped claim");
  assert.ok(!payloadKeys.includes("zcash"), "minted token must carry no zcash-shaped claim");
  assert.ok(!payloadKeys.includes("address"), "minted token must carry no address-shaped claim");
});

test("mintVoiceToken issues a short-lived token (has an exp claim close to now)", async () => {
  const response = await mintVoiceToken(TEST_CONFIG, { playerId: "p1", nickname: "N1", canReceive: true, canTalk: true });
  const payloadBase64 = response.token.split(".")[1]!;
  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
  const nowSeconds = Date.now() / 1000;
  assert.ok(payload.exp > nowSeconds, "token must not already be expired");
  assert.ok(payload.exp < nowSeconds + 900, "token must be short-lived (well under 15 minutes)");
});

// --- createVoiceTokenHandler (HTTP integration) ----------------------------
// A stub `resolveCapability` stands in for WorldServer.resolveVoiceSession
// here — the real wiring is exercised in WorldServer.test.ts's capability
// tests (A/B/C/F/G/H/I), since this file tests the HTTP handler in
// isolation, not the real session registry.

const KNOWN_IDENTITY: VoiceIdentity = { playerId: "player-known", nickname: "Builder", canReceive: true, canTalk: true };

function stubResolveCapability(capability: string): VoiceIdentity | null {
  return capability === "valid-capability" ? KNOWN_IDENTITY : null;
}

async function startTestServer(handler: ReturnType<typeof createVoiceTokenHandler>): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

// A valid current-session capability mints a token.
test("a valid capability returns 200 with a token for the resolved identity", async () => {
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], stubResolveCapability);
  const { port, stop } = await startTestServer(handler);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ capability: "valid-capability" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string };
    const payloadBase64 = body.token.split(".")[1]!;
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
    assert.equal(payload.sub, KNOWN_IDENTITY.playerId);
    assert.equal(payload.name, KNOWN_IDENTITY.nickname);
  } finally {
    await stop();
  }
});

// An unknown/random capability is rejected.
test("an unknown capability is rejected with 403, not minted", async () => {
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], stubResolveCapability);
  const { port, stop } = await startTestServer(handler);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ capability: "some-random-guess" }),
    });
    assert.equal(response.status, 403);
  } finally {
    await stop();
  }
});

// HTTP layer: even with a spoofed
// playerId/nickname riding alongside a VALID capability, the minted token
// uses only the resolver's identity — never the request body's claims.
test("a spoofed playerId/nickname alongside a valid capability is ignored by the minted token", async () => {
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], stubResolveCapability);
  const { port, stop } = await startTestServer(handler);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ capability: "valid-capability", playerId: "attacker-chosen-id", nickname: "Attacker" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string };
    const payloadBase64 = body.token.split(".")[1]!;
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
    assert.equal(payload.sub, KNOWN_IDENTITY.playerId, "minted identity must be the resolver's, never the request body's");
    assert.notEqual(payload.sub, "attacker-chosen-id");
    assert.equal(payload.name, KNOWN_IDENTITY.nickname);
    assert.notEqual(payload.name, "Attacker");
  } finally {
    await stop();
  }
});

test("POST {capability, listenOnly:true} mints the subscribe-only grant for the resolved identity", async () => {
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], stubResolveCapability);
  const { port, stop } = await startTestServer(handler);
  try {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify(body),
      });
    const listen = await post({ capability: "valid-capability", listenOnly: true });
    assert.equal(listen.status, 200);
    const listenToken = ((await listen.json()) as { token: string }).token;
    assert.equal(decodeVideoGrant(listenToken).canPublish, false);
    assert.equal(JSON.parse(Buffer.from(listenToken.split(".")[1]!, "base64url").toString("utf8")).sub, KNOWN_IDENTITY.playerId);

    const normal = await post({ capability: "valid-capability" });
    assert.equal(decodeVideoGrant(((await normal.json()) as { token: string }).token).canPublish, true);

    assert.equal((await post({ capability: "valid-capability", listenOnly: "no" })).status, 400);
    assert.equal((await post({ capability: "some-random-guess", listenOnly: true })).status, 403, "listen-only still needs a live session");
  } finally {
    await stop();
  }
});

test("the normal grant cannot publish data messages either (canPublishData: false)", async () => {
  const grant = decodeVideoGrant((await mintVoiceToken(TEST_CONFIG, { playerId: "p1", nickname: "Builder", canReceive: true, canTalk: true })).token);
  assert.equal(grant.canPublishData, false);
});

// ADR-015 § 5: guests may listen, never talk (no publishing grant).
test("ADR-015: a guest (canReceive false) gets 403 wallet_required for the full grant; listen-only still works", async () => {
  const GUEST: VoiceIdentity = { playerId: "player-guest", nickname: "Guest-1234", canReceive: false, canTalk: false };
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], (capability) =>
    capability === "guest-capability" ? GUEST : capability === "valid-capability" ? KNOWN_IDENTITY : null,
  );
  const { port, stop } = await startTestServer(handler);
  try {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify(body),
      });
    const full = await post({ capability: "guest-capability" });
    assert.equal(full.status, 403);
    assert.deepEqual(await full.json(), { error: "wallet_required" });
    assert.equal(full.headers.get("access-control-allow-origin"), "http://localhost:5173", "the browser can read the reason");

    const listen = await post({ capability: "guest-capability", listenOnly: true });
    assert.equal(listen.status, 200);
    const token = ((await listen.json()) as { token: string }).token;
    assert.equal(decodeVideoGrant(token).canPublish, false);
    assert.equal(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")).sub, GUEST.playerId);

    const holder = await post({ capability: "valid-capability" });
    assert.equal(holder.status, 200, "a wallet holder still gets the full grant");
    assert.equal(decodeVideoGrant(((await holder.json()) as { token: string }).token).canPublish, true);
  } finally {
    await stop();
  }
});

test("a holder without a server-verified identity (no owned name while a registry runs) gets 403 name_required; listen-only still works", async () => {
  const UNNAMED: VoiceIdentity = { playerId: "player-unnamed", nickname: "Guest-4321", canReceive: true, canTalk: false };
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], (capability) => (capability === "unnamed-capability" ? UNNAMED : null));
  const { port, stop } = await startTestServer(handler);
  try {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify(body),
      });
    const full = await post({ capability: "unnamed-capability" });
    assert.equal(full.status, 403);
    assert.deepEqual(await full.json(), { error: "name_required" });
    const listen = await post({ capability: "unnamed-capability", listenOnly: true });
    assert.equal(listen.status, 200);
    assert.equal(decodeVideoGrant(((await listen.json()) as { token: string }).token).canPublish, false);
  } finally {
    await stop();
  }
});

test("an unapproved Origin is rejected with 403", async () => {
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], stubResolveCapability);
  const { port, stop } = await startTestServer(handler);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ capability: "valid-capability" }),
    });
    assert.equal(response.status, 403);
  } finally {
    await stop();
  }
});

test("a malformed body returns 400, not a crash", async () => {
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], stubResolveCapability);
  const { port, stop } = await startTestServer(handler);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: "not json",
    });
    assert.equal(response.status, 400);
  } finally {
    await stop();
  }
});

test("a non-POST method is rejected with 405", async () => {
  const handler = createVoiceTokenHandler(TEST_CONFIG, ["http://localhost:5173"], stubResolveCapability);
  const { port, stop } = await startTestServer(handler);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
    assert.equal(response.status, 405);
  } finally {
    await stop();
  }
});
