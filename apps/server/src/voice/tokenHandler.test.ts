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
// CORE-004 security revision ():
// the request shape is now { capability }, resolved server-side — never a
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

// TEST D/E (Director's review): the browser cannot override the
// playerId/nickname placed into the minted token — parseVoiceTokenRequest
// reads ONLY `.capability`; an attacker resurrecting the old request shape
// gets silently ignored, never merged into the result.
test("Test D/E: an extra playerId/nickname field in the request body is ignored, never extracted", () => {
  const result = parseVoiceTokenRequest({
    capability: "real-capability",
    playerId: "someone-elses-playerId",
    nickname: "Spoofed Name",
  });
  assert.deepEqual(result, { capability: "real-capability" }, "only capability may ever be read from the request");
});

// --- mintVoiceToken ---------------------------------------------------------
// CORE-004 §9/§10: identity is the multiplayer playerId (the security
// identity), nickname is display metadata only. No recording grant. Takes
// an already-server-resolved VoiceIdentity — never anything browser-supplied.

test("mintVoiceToken uses playerId as the LiveKit identity, not the nickname", async () => {
  const response = await mintVoiceToken(TEST_CONFIG, { playerId: "player-xyz", nickname: "Builder" });
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
  assert.equal(payload.video?.roomRecord, undefined, "no recording grant may ever be issued — CORE-004 §7");
  assert.equal(payload.video?.room, TEST_CONFIG.roomName);
});

// CORE-004 §33 Test 9: no wallet identifier is part of the voice participant/application mapping.
test("Test 9: no wallet-shaped field is ever accepted, minted, or present in a voice token", async () => {
  const response = await mintVoiceToken(TEST_CONFIG, { playerId: "p1", nickname: "Builder" });
  const payloadBase64 = response.token.split(".")[1]!;
  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
  const payloadKeys = Object.keys(payload).join(" ").toLowerCase();
  assert.ok(!payloadKeys.includes("wallet"), "minted token must carry no wallet-shaped claim");
  assert.ok(!payloadKeys.includes("zcash"), "minted token must carry no zcash-shaped claim");
  assert.ok(!payloadKeys.includes("address"), "minted token must carry no address-shaped claim");
});

test("mintVoiceToken issues a short-lived token (has an exp claim close to now)", async () => {
  const response = await mintVoiceToken(TEST_CONFIG, { playerId: "p1", nickname: "N1" });
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

const KNOWN_IDENTITY: VoiceIdentity = { playerId: "player-known", nickname: "Builder" };

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

// TEST A (Director's review): a valid current-session capability mints a token.
test("Test A: a valid capability returns 200 with a token for the resolved identity", async () => {
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

// TEST B (Director's review): an unknown/random capability is rejected.
test("Test B: an unknown capability is rejected with 403, not minted", async () => {
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

// TEST D/E (Director's review), HTTP layer: even with a spoofed
// playerId/nickname riding alongside a VALID capability, the minted token
// uses only the resolver's identity — never the request body's claims.
test("Test D/E: a spoofed playerId/nickname alongside a valid capability is ignored by the minted token", async () => {
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
