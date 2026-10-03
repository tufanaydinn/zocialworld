import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import {
  isOriginAllowed,
  parseAllowedOrigins,
  createVerifyClient,
  resolveAllowedOrigins,
  isProductionEnv,
  isProductionMisconfigured,
  DEFAULT_DEV_ORIGINS,
} from "./origin.js";

// --- Pure function tests -----------------------------------------------

test("isOriginAllowed: an allowlisted Origin is allowed", () => {
  assert.equal(isOriginAllowed("http://localhost:5173", ["http://localhost:5173"]), true);
});

test("isOriginAllowed: a non-allowlisted Origin is rejected", () => {
  assert.equal(isOriginAllowed("http://evil.example", ["http://localhost:5173"]), false);
});

test("isOriginAllowed: a missing Origin (undefined) is allowed regardless of the allowlist", () => {
  assert.equal(isOriginAllowed(undefined, ["http://localhost:5173"]), true);
  assert.equal(isOriginAllowed(undefined, []), true);
});

test("isOriginAllowed: an empty-string Origin is treated the same as missing", () => {
  assert.equal(isOriginAllowed("", ["http://localhost:5173"]), true);
});

test("parseAllowedOrigins: splits, trims, and drops empty entries", () => {
  assert.deepEqual(parseAllowedOrigins("https://a.example, https://b.example ,, "), [
    "https://a.example",
    "https://b.example",
  ]);
});

test("parseAllowedOrigins: undefined/empty input yields an empty list", () => {
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(""), []);
});

// --- Environment-sensitive allowlist resolution -------------------------

test("isProductionEnv: only the literal string 'production' counts as production", () => {
  assert.equal(isProductionEnv("production"), true);
  assert.equal(isProductionEnv("development"), false);
  assert.equal(isProductionEnv("test"), false);
  assert.equal(isProductionEnv(undefined), false);
  assert.equal(isProductionEnv("Production"), false);
});

test("resolveAllowedOrigins: dev mode (NODE_ENV unset) includes the default Vite origins", () => {
  const resolved = resolveAllowedOrigins(undefined, undefined);
  assert.deepEqual(resolved, DEFAULT_DEV_ORIGINS);
});

test("resolveAllowedOrigins: dev mode adds configured origins on top of the defaults", () => {
  const resolved = resolveAllowedOrigins("development", "https://staging.example");
  assert.deepEqual(resolved, [...DEFAULT_DEV_ORIGINS, "https://staging.example"]);
});

test("resolveAllowedOrigins: production mode does NOT implicitly include localhost", () => {
  const resolved = resolveAllowedOrigins("production", undefined);
  assert.deepEqual(resolved, []);
  assert.equal(resolved.includes("http://localhost:5173"), false);
});

test("resolveAllowedOrigins: production mode accepts an explicitly configured production origin", () => {
  const resolved = resolveAllowedOrigins("production", "https://app.example");
  assert.deepEqual(resolved, ["https://app.example"]);
});

test("isProductionMisconfigured: true only when production AND the allowlist is empty", () => {
  assert.equal(isProductionMisconfigured("production", []), true);
  assert.equal(isProductionMisconfigured("production", ["https://app.example"]), false);
  assert.equal(isProductionMisconfigured("development", []), false);
  assert.equal(isProductionMisconfigured(undefined, []), false);
});

// --- Real WebSocket handshake tests -------------------------------------
//
// The standard (browser-spec) global `WebSocket` does not let JavaScript
// set a custom Origin header — the runtime sets it from the page's real
// origin and page code cannot override it, which is the entire point of
// the check. To actually exercise the server's handshake-time rejection
// here, we use the `ws` package's own client, which (being a Node library
// with no browser sandboxing) allows setting an arbitrary `origin` --
// exactly the capability a motivated non-browser attacker would also
// have, which is why `isOriginAllowed` never treats a *present* Origin
// as a stronger signal than "a well-behaved browser sent this".

async function startServerWithOrigins(allowedOrigins: readonly string[]): Promise<{ port: number; stop: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, verifyClient: createVerifyClient(allowedOrigins) });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, stop: () => new Promise<void>((resolve) => wss.close(() => resolve())) };
}

function attemptConnection(url: string, origin?: string): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const client = new WsClient(url, origin !== undefined ? { origin } : {});
    client.once("open", () => {
      client.close();
      resolve("open");
    });
    client.once("error", () => resolve("rejected"));
  });
}

test("Approved Origin is accepted", async () => {
  const { port, stop } = await startServerWithOrigins(["http://allowed.example"]);
  try {
    const result = await attemptConnection(`ws://127.0.0.1:${port}`, "http://allowed.example");
    assert.equal(result, "open");
  } finally {
    await stop();
  }
});

test("Unapproved Origin is rejected", async () => {
  const { port, stop } = await startServerWithOrigins(["http://allowed.example"]);
  try {
    const result = await attemptConnection(`ws://127.0.0.1:${port}`, "http://evil.example");
    assert.equal(result, "rejected");
  } finally {
    await stop();
  }
});

test("Missing Origin is accepted (documented non-browser/test-client policy)", async () => {
  const { port, stop } = await startServerWithOrigins(["http://allowed.example"]);
  try {
    // ws's client sends no Origin header at all when none is configured —
    // the same shape a non-browser client (or this very test suite, via
    // the global WebSocket used elsewhere) produces.
    const result = await attemptConnection(`ws://127.0.0.1:${port}`);
    assert.equal(result, "open");
  } finally {
    await stop();
  }
});

test("Default dev origins (Vite's localhost/127.0.0.1:5173) are accepted by createVerifyClient", async () => {
  const { port, stop } = await startServerWithOrigins(DEFAULT_DEV_ORIGINS);
  try {
    const result = await attemptConnection(`ws://127.0.0.1:${port}`, "http://localhost:5173");
    assert.equal(result, "open");
  } finally {
    await stop();
  }
});

test("A server resolved for dev mode accepts the default Vite origin at handshake time", async () => {
  const { port, stop } = await startServerWithOrigins(resolveAllowedOrigins(undefined, undefined));
  try {
    const result = await attemptConnection(`ws://127.0.0.1:${port}`, "http://localhost:5173");
    assert.equal(result, "open");
  } finally {
    await stop();
  }
});

test("A server resolved for production mode rejects localhost at handshake time even though no ALLOWED_ORIGINS was set", async () => {
  const { port, stop } = await startServerWithOrigins(resolveAllowedOrigins("production", undefined));
  try {
    const result = await attemptConnection(`ws://127.0.0.1:${port}`, "http://localhost:5173");
    assert.equal(result, "rejected");
  } finally {
    await stop();
  }
});

test("A server resolved for production mode accepts its explicitly configured origin at handshake time", async () => {
  const { port, stop } = await startServerWithOrigins(resolveAllowedOrigins("production", "https://app.example"));
  try {
    const result = await attemptConnection(`ws://127.0.0.1:${port}`, "https://app.example");
    assert.equal(result, "open");
  } finally {
    await stop();
  }
});
