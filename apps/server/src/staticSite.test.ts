import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MINIMAL_PAGE_CSP, PAGE_CSP, buildPageCsp, createStaticSiteHandler, cspConnectOrigins, cspImageOrigins } from "./staticSite.js";

test("the CSP is built from the deployment's origins (page ws(s) + LiveKit https/wss); junk is dropped", () => {
  const origins = cspConnectOrigins(["https://play.example.org", "http://localhost:5173", "not a url"], "wss://voice.example.org");
  assert.deepEqual(origins, ["http://localhost:5173", "https://play.example.org", "https://voice.example.org", "ws://localhost:5173", "wss://play.example.org", "wss://voice.example.org"]);
  const csp = buildPageCsp({ connectOrigins: [...origins, "https://evil.example/path", "javascript:alert(1)"] });
  assert.match(csp, /connect-src 'self' blob: data: http:\/\/localhost:5173 https:\/\/play\.example\.org https:\/\/voice\.example\.org ws:\/\/localhost:5173 wss:\/\/play\.example\.org wss:\/\/voice\.example\.org;/);
  assert.equal(csp.includes("evil.example"), false, "only bare origins");
  assert.equal(csp.includes("javascript:"), false);
  assert.match(csp, /worker-src 'self' blob:;/);
  assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/www\.youtube\.com;/);
  assert.equal(cspConnectOrigins([], null).length, 0);
  assert.equal(MINIMAL_PAGE_CSP, "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
});

test("integration: img-src adds the http(s) page origins (a VITE_CONTENT_URL gateway's /content/media), never LiveKit or ws", () => {
  const images = cspImageOrigins(["https://play.example.org", "https://content.example.org", "not a url"]);
  assert.deepEqual(images, ["https://content.example.org", "https://play.example.org"]);
  const csp = buildPageCsp({ connectOrigins: cspConnectOrigins(["https://play.example.org"], "wss://voice.example.org"), imageOrigins: [...images, "wss://x.example", "https://evil.example/p"] });
  assert.match(csp, /img-src 'self' data: blob: https:\/\/content\.example\.org https:\/\/play\.example\.org;/);
  assert.match(csp, /media-src 'self' data: blob:;/);
  assert.equal(/img-src[^;]*voice\.example\.org/.test(csp), false);
  assert.match(PAGE_CSP, /img-src 'self' data: blob:;/, "without deployment origins the policy is unchanged");
});

test("a handler serves the policy it was given (CSP_MODE=minimal)", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Zocial World</title>");
  const handler = createStaticSiteHandler(dist, { csp: MINIMAL_PAGE_CSP });
  const server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const page = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    assert.equal(page.headers.get("content-security-policy"), MINIMAL_PAGE_CSP);
  } finally {
    server.close();
  }
});

test("serves the built client with cross-origin isolation, wasm MIME, SPA fallback and no traversal", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Zocial World</title>");
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "assets", "app-abc.js"), "export {}");
  mkdirSync(join(dist, "webzjs"));
  writeFileSync(join(dist, "webzjs", "engine_bg.wasm"), Buffer.from([0, 97, 115, 109]));
  writeFileSync(join(tmpdir(), "secret.txt"), "nope");
  const handler = createStaticSiteHandler(dist);
  const server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(418).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(page.headers.get("cross-origin-embedder-policy"), "require-corp");
    // The full policy — no inline/third-party script, connections only to this origin.
    assert.equal(page.headers.get("content-security-policy"), PAGE_CSP);
    assert.match(PAGE_CSP, /script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval';/);
    assert.match(PAGE_CSP, /connect-src 'self' blob: data:;/, "blob:/data: are local: the GLTF loader fetches embedded textures through them");
    assert.match(PAGE_CSP, /frame-ancestors 'none'; object-src 'none'; base-uri 'self'$/);
    assert.equal((await fetch(`${base}/webzjs/engine_bg.wasm`)).headers.get("content-security-policy"), PAGE_CSP, "the engine's workers get the same policy");
    assert.match(await page.text(), /Zocial World/);
    const asset = await fetch(`${base}/assets/app-abc.js`);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.equal((await fetch(`${base}/webzjs/engine_bg.wasm`)).headers.get("content-type"), "application/wasm");
    assert.match(await (await fetch(`${base}/some/route`)).text(), /Zocial World/, "SPA fallback");
    assert.equal((await fetch(`${base}/missing.js`)).status, 404, "missing assets are not masked by index.html");
    assert.notEqual((await fetch(`${base}/..%2fsecret.txt`)).status, 200, "no traversal out of dist");
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 418, "non-GET falls through");
  } finally {
    server.close();
  }
});

test("the wallet engine under /webzjs/ carries a strong content ETag and revalidates with 304", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Zocial World</title>");
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "assets", "app-abc.js"), "export {}");
  mkdirSync(join(dist, "webzjs", "snippets"), { recursive: true });
  const wasm = join(dist, "webzjs", "webzjs_wallet_bg.wasm");
  const engineBytes = 4 + (3 << 20); // spans several 1 MiB hash chunks
  writeFileSync(wasm, Buffer.concat([Buffer.from([0, 97, 115, 109]), Buffer.alloc(3 << 20, 7)]));
  writeFileSync(join(dist, "webzjs", "snippets", "workerHelpers.js"), "export {}");
  const serve = async (): Promise<{ base: string; close: () => void }> => {
    const handler = createStaticSiteHandler(dist);
    const server = createServer((req, res) => {
      if (!handler(req, res)) res.writeHead(418).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  };
  const site = await serve();
  const url = `${site.base}/webzjs/webzjs_wallet_bg.wasm`;
  try {
    const first = await fetch(url);
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag") ?? "";
    assert.match(etag, /^"[A-Za-z0-9_-]{43}"$/, "strong (no W/): the base64url SHA-256 of the content");
    assert.equal(first.headers.get("cache-control"), "no-cache", "always revalidated, so a new engine is picked up at once");
    assert.equal((await first.arrayBuffer()).byteLength, engineBytes);

    const revalidated = await fetch(url, { headers: { "If-None-Match": etag } });
    assert.equal(revalidated.status, 304);
    assert.equal((await revalidated.arrayBuffer()).byteLength, 0, "no body on 304");
    assert.equal(revalidated.headers.get("etag"), etag);
    assert.equal(revalidated.headers.get("cache-control"), "no-cache");
    assert.equal(revalidated.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(revalidated.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(revalidated.headers.get("cross-origin-resource-policy"), "same-origin");

    assert.equal((await fetch(url, { headers: { "If-None-Match": `W/${etag}` } })).status, 304, "If-None-Match compares weakly");
    assert.equal((await fetch(url, { headers: { "If-None-Match": `"stale", ${etag}` } })).status, 304, "a list matches any member");
    assert.equal((await fetch(url, { method: "HEAD", headers: { "If-None-Match": etag } })).status, 304);
    const mismatch = await fetch(url, { headers: { "If-None-Match": '"stale"' } });
    assert.equal(mismatch.status, 200);
    assert.equal((await mismatch.arrayBuffer()).byteLength, engineBytes);

    const snippet = await fetch(`${site.base}/webzjs/snippets/workerHelpers.js`);
    assert.match(snippet.headers.get("etag") ?? "", /^"[A-Za-z0-9_-]{43}"$/, "nested engine files are tagged too");
    assert.notEqual(snippet.headers.get("etag"), etag);
    await snippet.arrayBuffer();
    const asset = await fetch(`${site.base}/assets/app-abc.js`);
    assert.equal(asset.headers.get("etag"), null, "hashed assets keep the immutable cache and no ETag");
    await asset.arrayBuffer();
    const page = await fetch(`${site.base}/`);
    assert.equal(page.headers.get("etag"), null);
    await page.arrayBuffer();

    // A new handler (a server restart) derives the same tag from the same bytes.
    const restarted = await serve();
    try {
      const again = await fetch(`${restarted.base}/webzjs/webzjs_wallet_bg.wasm`, { headers: { "If-None-Match": etag } });
      assert.equal(again.status, 304, "the tag survives a restart");
    } finally {
      restarted.close();
    }

    // A replaced engine gets a new tag, and the old one no longer matches.
    writeFileSync(wasm, Buffer.from([0, 97, 115, 109, 1]));
    const replaced = await fetch(url, { headers: { "If-None-Match": etag } });
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.headers.get("etag"), etag);
    assert.equal((await replaced.arrayBuffer()).byteLength, 5);
  } finally {
    site.close();
  }
});
