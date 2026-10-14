#!/usr/bin/env node
// Downloads the mainnet wallet engine's WebAssembly module (webzjs_wallet_bg.wasm, ~62 MB) into
// vendor/webzjs-wallet-main/ and checks it against that directory's SHA256SUMS before keeping it.
//
//   npm run engine:fetch                       download it unless a matching file is already there
//   npm run engine:fetch -- --force            download again even when the file on disk matches
//   npm run engine:fetch -- --check            only verify the file on disk (exit 1 if missing or different)
//   npm run engine:fetch -- --url <url>        download from another location (a mirror); checked the same way
//   npm run engine:fetch -- --dir <dir>        another package directory (default: vendor/webzjs-wallet-main)
//
// The module is a GitHub Release asset of this repository. The release tag is derived from the module's
// SHA-256 in SHA256SUMS: `engine-<first 12 hex digits>` (package.json carries upstream's version, which
// does not change between our builds). A rebuilt engine therefore needs a new Release, and the committed
// SHA256SUMS always selects the matching one. Nothing is kept unless its SHA-256 equals the committed
// value. Behind an HTTP proxy, run Node with NODE_USE_ENV_PROXY=1.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENGINE_DIR = join(REPO, "vendor", "webzjs-wallet-main");
export const ENGINE_FILE = "webzjs_wallet_bg.wasm";
export const RELEASE_REPOSITORY = "tufanaydinn/zocialworld";

/** Parses `sha256sum` output ("<hash>  ./name" or "<hash> *name") into a Map of name -> hash. */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (!m) throw new Error(`SHA256SUMS: unreadable line: ${line}`);
    sums.set(m[2].replace(/^\.\//, ""), m[1]);
  }
  return sums;
}

/** The release tag of an engine module with this SHA-256. */
export function engineReleaseTag(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw new Error(`not a SHA-256: ${sha256}`);
  return `engine-${sha256.slice(0, 12)}`;
}

/** The download URL of the engine module in the release `tag`. */
export function engineReleaseUrl(tag, repository = RELEASE_REPOSITORY) {
  return `https://github.com/${repository}/releases/download/${tag}/${ENGINE_FILE}`;
}

/** The expected SHA-256 of the engine module, from `dir`/SHA256SUMS. */
export function expectedEngineSha256(dir = ENGINE_DIR) {
  const sums = parseSha256Sums(readFileSync(join(dir, "SHA256SUMS"), "utf8"));
  const expected = sums.get(ENGINE_FILE);
  if (!expected) throw new Error(`${join(dir, "SHA256SUMS")} does not list ${ENGINE_FILE}`);
  return expected;
}

/** SHA-256 of a file (streamed), or null when it does not exist. */
export async function sha256File(file) {
  if (!existsSync(file)) return null;
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Whether `file` exists and has the SHA-256 `expected`. */
export async function verifyEngine(file, expected) {
  const actual = await sha256File(file);
  return { ok: actual === expected, actual };
}

/**
 * Makes sure `dir` holds the engine module named by its SHA256SUMS. Downloads it (to a `.part` file,
 * hashing while writing) unless a matching file is present and `force` is false; keeps the download only
 * when its SHA-256 matches, else deletes it and throws. A file already on disk is only replaced by a
 * verified download. Returns { status: "present" | "downloaded", sha256, url? }.
 */
export async function fetchEngine({ dir = ENGINE_DIR, url, force = false, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const expected = expectedEngineSha256(dir);
  const target = join(dir, ENGINE_FILE);
  if (!force && (await verifyEngine(target, expected)).ok) return { status: "present", sha256: expected };
  const source = url ?? engineReleaseUrl(engineReleaseTag(expected));
  log(`downloading ${source}`);
  const res = await fetchImpl(source, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${source}`);
  const part = `${target}.part`;
  const hash = createHash("sha256");
  const tee = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), tee, createWriteStream(part));
  } catch (e) {
    rmSync(part, { force: true });
    throw new Error(`download failed: ${e.message}`);
  }
  const actual = hash.digest("hex");
  if (actual !== expected) {
    rmSync(part, { force: true });
    throw new Error(`refused: the download from ${source} has sha256 ${actual}, but SHA256SUMS expects ${expected}`);
  }
  renameSync(part, target);
  return { status: "downloaded", sha256: expected, url: source };
}

async function main(argv) {
  const opts = { force: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") opts.force = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--dir") opts.dir = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  const dir = opts.dir ?? ENGINE_DIR;
  const expected = expectedEngineSha256(dir);
  if (opts.check) {
    const { ok, actual } = await verifyEngine(join(dir, ENGINE_FILE), expected);
    console.log(ok ? `${ENGINE_FILE}: OK (sha256 ${expected})` : `${ENGINE_FILE}: ${actual ? `sha256 ${actual} differs from ${expected}` : "missing"}`);
    return ok ? 0 : 1;
  }
  const r = await fetchEngine({ dir, url: opts.url, force: opts.force, log: (m) => console.log(m) });
  console.log(`${ENGINE_FILE}: ${r.status === "present" ? "already present" : "downloaded"}, sha256 ${r.sha256} matches SHA256SUMS`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`engine:fetch: ${e.message}`);
      process.exit(1);
    },
  );
}
