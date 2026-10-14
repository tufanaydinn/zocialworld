// Tests for the engine fetch-and-verify script: checksum parsing, the release tag, and that only a
// download with the committed SHA-256 is ever kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_DIR,
  ENGINE_FILE,
  engineReleaseTag,
  engineReleaseUrl,
  expectedEngineSha256,
  fetchEngine,
  parseSha256Sums,
  verifyEngine,
} from "./fetch-engine.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const GOOD = Buffer.from("the published engine module");
const BAD = Buffer.from("something else");

/** A package directory whose SHA256SUMS names GOOD as the engine module. */
function pkgDir() {
  const dir = mkdtempSync(join(tmpdir(), "zw-engine-fetch-"));
  writeFileSync(join(dir, "SHA256SUMS"), `${sha256("x")}  ./package.json\n${sha256(GOOD)}  ./${ENGINE_FILE}\n`);
  return dir;
}

/** A fetch stand-in that serves `bytes` and records the URLs asked for. */
function fakeFetch(bytes, status = 200) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return new Response(status === 200 ? bytes : "not found", { status });
  };
  return { impl, calls };
}

test("parseSha256Sums reads sha256sum output in both modes", () => {
  const a = sha256("a"), b = sha256("b");
  const sums = parseSha256Sums(`${a}  ./webzjs_wallet_bg.wasm\n${b} *snippets/x.js\n\n`);
  assert.equal(sums.get("webzjs_wallet_bg.wasm"), a);
  assert.equal(sums.get("snippets/x.js"), b);
  assert.throws(() => parseSha256Sums("not a checksum line"), /unreadable line/);
});

test("the release tag is derived from the module's SHA-256", () => {
  const h = "772d260643a874e261e5067324243b255194b90d2c91d0513e4b6ac0a25e3854";
  assert.equal(engineReleaseTag(h), "engine-772d260643a8");
  assert.equal(
    engineReleaseUrl("engine-772d260643a8"),
    "https://github.com/tufanaydinn/zocialworld/releases/download/engine-772d260643a8/webzjs_wallet_bg.wasm",
  );
  assert.throws(() => engineReleaseTag("772d"), /not a SHA-256/);
});

test("the vendored SHA256SUMS names the engine module", () => {
  const expected = expectedEngineSha256(ENGINE_DIR);
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.match(readFileSync(join(ENGINE_DIR, "BUILD-INFO.txt"), "utf8"), new RegExp(`engine main: wasm \\d+ bytes, sha256 ${expected}`));
});

test("a download with the committed SHA-256 is kept", async () => {
  const dir = pkgDir();
  try {
    const f = fakeFetch(GOOD);
    const r = await fetchEngine({ dir, fetchImpl: f.impl });
    assert.equal(r.status, "downloaded");
    assert.deepEqual(f.calls, [engineReleaseUrl(engineReleaseTag(sha256(GOOD)))]);
    assert.deepEqual(readFileSync(join(dir, ENGINE_FILE)), GOOD);
    assert.equal((await verifyEngine(join(dir, ENGINE_FILE), sha256(GOOD))).ok, true);
    // Present and matching: nothing is downloaded again unless forced.
    const again = fakeFetch(GOOD);
    assert.equal((await fetchEngine({ dir, fetchImpl: again.impl })).status, "present");
    assert.equal(again.calls.length, 0);
    assert.equal((await fetchEngine({ dir, fetchImpl: again.impl, force: true })).status, "downloaded");
    assert.equal(again.calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a download with any other SHA-256 is refused and leaves nothing behind", async () => {
  const dir = pkgDir();
  try {
    await assert.rejects(fetchEngine({ dir, fetchImpl: fakeFetch(BAD).impl }), /refused: .* expects/);
    assert.equal(existsSync(join(dir, ENGINE_FILE)), false);
    assert.deepEqual(readdirSync(dir), ["SHA256SUMS"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong file on disk is only replaced by a verified download", async () => {
  const dir = pkgDir();
  try {
    writeFileSync(join(dir, ENGINE_FILE), BAD);
    assert.deepEqual(await verifyEngine(join(dir, ENGINE_FILE), sha256(GOOD)), { ok: false, actual: sha256(BAD) });
    await assert.rejects(fetchEngine({ dir, fetchImpl: fakeFetch(Buffer.from("tampered")).impl }), /refused/);
    assert.deepEqual(readFileSync(join(dir, ENGINE_FILE)), BAD);
    const r = await fetchEngine({ dir, fetchImpl: fakeFetch(GOOD).impl, url: "https://mirror.example/engine.wasm" });
    assert.equal(r.url, "https://mirror.example/engine.wasm");
    assert.deepEqual(readFileSync(join(dir, ENGINE_FILE)), GOOD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an HTTP error is reported and writes nothing", async () => {
  const dir = pkgDir();
  try {
    await assert.rejects(fetchEngine({ dir, fetchImpl: fakeFetch(GOOD, 404).impl }), /HTTP 404/);
    assert.deepEqual(readdirSync(dir), ["SHA256SUMS"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
