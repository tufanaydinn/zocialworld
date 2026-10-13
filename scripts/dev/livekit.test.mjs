// scripts/dev/livekit.mjs — the local LiveKit `npm run dev` starts. Run: node --test scripts/dev/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { LIVEKIT_VERSION, decide, devConfig, ensureReleaseBinary, extractFromTarGz, extractFromZip, localPort, parseChecksums, readEnvFile, releaseAsset, sha256 } from "./livekit.mjs";

/** A one-file ustar archive, gzipped. */
function tarGz(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

/** A zip with one deflated entry and one stored entry. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, body, deflate } of entries) {
    const data = deflate ? deflateRawSync(body) : body;
    const nameBuffer = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, data);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

test("release assets: linux and windows archives from the official release; macOS has none (Homebrew)", () => {
  assert.deepEqual(releaseAsset("linux", "x64"), { name: `livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz`, kind: "tar.gz", binary: "livekit-server" });
  assert.equal(releaseAsset("linux", "arm64")?.name, `livekit_${LIVEKIT_VERSION}_linux_arm64.tar.gz`);
  assert.deepEqual(releaseAsset("win32", "x64"), { name: `livekit_${LIVEKIT_VERSION}_windows_amd64.zip`, kind: "zip", binary: "livekit-server.exe" });
  assert.equal(releaseAsset("win32", "arm64")?.name, `livekit_${LIVEKIT_VERSION}_windows_arm64.zip`);
  assert.equal(releaseAsset("darwin", "arm64"), null);
  assert.equal(releaseAsset("linux", "ia32"), null);
});

test("checksums.txt is parsed per file name", () => {
  const sums = parseChecksums(`059f6de65da11a57400e4646027da705d592ce42acb48c08570a397df446f869  livekit_1.13.8_linux_amd64.tar.gz\r\nnot a line\n1C9BC93ADF19528A86865DBDCE5FB3958E7310C43FF8B437287AEB72669F26BD *livekit_1.13.8_windows_amd64.zip\n`);
  assert.equal(sums.get("livekit_1.13.8_linux_amd64.tar.gz"), "059f6de65da11a57400e4646027da705d592ce42acb48c08570a397df446f869");
  assert.equal(sums.get("livekit_1.13.8_windows_amd64.zip"), "1c9bc93adf19528a86865dbdce5fb3958e7310c43ff8b437287aeb72669f26bd");
  assert.equal(sums.size, 2);
});

test("the binary comes out of a .tar.gz and a .zip (stored or deflated)", () => {
  const body = Buffer.from("#!/bin/sh\necho livekit\n".repeat(50));
  assert.deepEqual(extractFromTarGz(tarGz("livekit-server", body), "livekit-server"), body);
  assert.equal(extractFromTarGz(tarGz("README.md", body), "livekit-server"), null);
  const archive = zip([
    { name: "LICENSE", body: Buffer.from("license"), deflate: false },
    { name: "livekit-server.exe", body, deflate: true },
  ]);
  assert.deepEqual(extractFromZip(archive, "livekit-server.exe"), body);
  assert.deepEqual(extractFromZip(archive, "LICENSE"), Buffer.from("license"));
  assert.equal(extractFromZip(archive, "nope.exe"), null);
  assert.equal(extractFromZip(Buffer.from("not a zip"), "x"), null);
});

test("decide: runs unless voice is configured, opted out or production; the real environment wins over apps/server/.env", () => {
  assert.deepEqual(decide({}, {}), { run: true });
  assert.deepEqual(decide({}, { LIVEKIT_URL: "ws://localhost:7880", LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "" }), { run: true }, ".env.example's empty keys mean no LiveKit");
  assert.equal(decide({}, { LIVEKIT_URL: "wss://voice.example", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }).run, false);
  assert.equal(decide({ LIVEKIT_URL: "wss://voice.example", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }, {}).run, false);
  assert.equal(decide({ SKIP_LOCAL_LIVEKIT: "1" }, {}).run, false);
  assert.equal(decide({}, { SKIP_LOCAL_LIVEKIT: "true" }).run, false);
  assert.equal(decide({ SKIP_LOCAL_LIVEKIT: "0" }, { SKIP_LOCAL_LIVEKIT: "1" }).run, true, "the environment wins");
  assert.equal(decide({ NODE_ENV: "production" }, {}).run, false);
});

test("ports and the config file: signalling on the port, TCP and one UDP port next to it, quiet logs", () => {
  assert.equal(localPort({}), 7880);
  assert.equal(localPort({ LOCAL_LIVEKIT_PORT: "7900" }), 7900);
  assert.throws(() => localPort({ LOCAL_LIVEKIT_PORT: "80" }));
  // apps/server/.env counts too (the game server reads it there), and the environment wins — both processes agree.
  assert.equal(localPort({}, { LOCAL_LIVEKIT_PORT: "7980" }), 7980);
  assert.equal(localPort({ LOCAL_LIVEKIT_PORT: "7900" }, { LOCAL_LIVEKIT_PORT: "7980" }), 7900);
  assert.throws(() => localPort({}, { LOCAL_LIVEKIT_PORT: "abc" }), /LOCAL_LIVEKIT_PORT/);
  const yaml = devConfig(7900);
  assert.match(yaml, /^port: 7900$/m);
  assert.match(yaml, /^ {2}tcp_port: 7901$/m);
  assert.match(yaml, /^ {2}udp_port: 7902$/m);
  assert.match(yaml, /^ {2}level: info$/m);
});

test("readEnvFile follows apps/server/src/env.ts (comments, quotes); a missing file is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "zw-lk-env-"));
  try {
    assert.deepEqual(readEnvFile(join(dir, "missing")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("download: verified against checksums.txt and cached; a mismatch is refused; the cache is reused without a download", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "zw-lk-cache-"));
  const body = Buffer.from("\x7fELF fake livekit-server");
  const archive = tarGz("livekit_dir/livekit-server", body);
  const name = `livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz`;
  const fetches = [];
  const fakeFetch = (sum) => async (url) => {
    fetches.push(url);
    const file = url.split("/").pop();
    const payload = file === "checksums.txt" ? Buffer.from(`${sum}  ${name}\n`) : file === name ? archive : null;
    return payload ? { ok: true, status: 200, arrayBuffer: async () => payload } : { ok: false, status: 404 };
  };
  const quiet = () => undefined;
  try {
    await assert.rejects(ensureReleaseBinary({ platform: "linux", arch: "x64", cacheRoot, fetchImpl: fakeFetch("0".repeat(64)), log: quiet }), /checksum mismatch/);
    const binary = await ensureReleaseBinary({ platform: "linux", arch: "x64", cacheRoot, fetchImpl: fakeFetch(sha256(archive)), log: quiet });
    assert.deepEqual(readFileSync(binary), body);
    assert.ok(fetches.every((url) => url.startsWith(`https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/`)));
    const stamp = JSON.parse(readFileSync(join(cacheRoot, LIVEKIT_VERSION, "linux-x64", "verified.json"), "utf8"));
    assert.equal(stamp.archiveSha256, sha256(archive));
    fetches.length = 0;
    assert.equal(await ensureReleaseBinary({ platform: "linux", arch: "x64", cacheRoot, fetchImpl: fakeFetch("bad"), log: quiet }), binary);
    assert.equal(fetches.length, 0, "a verified cache needs no network");
    assert.equal(await ensureReleaseBinary({ platform: "darwin", arch: "arm64", cacheRoot, log: quiet }), null, "macOS: no release archive");
    assert.ok(existsSync(binary));
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
