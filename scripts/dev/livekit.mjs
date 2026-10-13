#!/usr/bin/env node
/**
 * A local LiveKit voice server for `npm run dev`.
 *
 * Without a configured LiveKit the game server answers `/voice/token` with 503 and a local run has no voice. The root
 * `npm run dev` therefore runs this script next to the web client and the game server (which it starts with
 * `--local-livekit`, so the server uses this LiveKit with the `--dev` keys).
 *
 * What it does:
 *  1. Does nothing when voice is configured some other way — LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET set
 *     in the environment or in apps/server/.env (your own LiveKit) — or when SKIP_LOCAL_LIVEKIT=1, and never with
 *     NODE_ENV=production.
 *  2. Finds livekit-server v1.13.8 (the version the stage and voice were tested on):
 *     LIVEKIT_BINARY if set; else the copy cached under node_modules/.cache/livekit/; else it downloads the official
 *     release archive for this platform from github.com/livekit/livekit, checks its SHA-256 against the release's
 *     checksums.txt, extracts the binary and caches it; else (macOS has no release archive) `livekit-server` on PATH
 *     (`brew install livekit`).
 *  3. Starts it in --dev mode on this computer only: signalling on 127.0.0.1:7880 (LOCAL_LIVEKIT_PORT), WebRTC on TCP
 *     7881 and one UDP port 7882 (the next two). LIVEKIT_NODE_IP sets the advertised media address (tests use
 *     127.0.0.1). The --dev keys (devkey / secret) are placeholders for this computer — never use them on a server.
 *
 * Node built-ins only (no new dependency): fetch, crypto, zlib, child_process.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

export const LIVEKIT_VERSION = "1.13.8";
export const RELEASE_BASE = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}`;
export const DEFAULT_PORT = 7880;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TAG = "[livekit]";

/** The release archive for a Node platform/arch, or null when LiveKit publishes none (macOS: use Homebrew). */
export function releaseAsset(platform, arch) {
  const archName = { x64: "amd64", arm64: "arm64", arm: "armv7" }[arch];
  if (platform === "linux" && archName) return { name: `livekit_${LIVEKIT_VERSION}_linux_${archName}.tar.gz`, kind: "tar.gz", binary: "livekit-server" };
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return { name: `livekit_${LIVEKIT_VERSION}_windows_${archName}.zip`, kind: "zip", binary: "livekit-server.exe" };
  return null;
}

/** `checksums.txt` ("<sha256>  <file>" per line) → Map(file → sha256). */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** One regular file from a .tar.gz (ustar), matched by its base name; null if absent. */
export function extractFromTarGz(archive, baseName) {
  const tar = gunzipSync(archive);
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if ((type === "0" || type === "\0") && name.split("/").pop() === baseName) return Buffer.from(body);
    name = "";
  }
  return null;
}

/** One file from a .zip (stored or deflated), matched by its base name; null if absent. */
export function extractFromZip(archive, baseName) {
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65_557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = archive.readUInt16LE(end + 10);
  let entry = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count && entry + 46 <= archive.length; i++) {
    if (archive.readUInt32LE(entry) !== 0x02014b50) return null;
    const method = archive.readUInt16LE(entry + 10);
    const compressedSize = archive.readUInt32LE(entry + 20);
    const nameLength = archive.readUInt16LE(entry + 28);
    const extraLength = archive.readUInt16LE(entry + 30);
    const commentLength = archive.readUInt16LE(entry + 32);
    const localOffset = archive.readUInt32LE(entry + 42);
    const name = archive.subarray(entry + 46, entry + 46 + nameLength).toString("utf8");
    entry += 46 + nameLength + extraLength + commentLength;
    if (name.split("/").pop() !== baseName) continue;
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(start, start + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    return null;
  }
  return null;
}

/** The same `KEY=value` rules as apps/server/src/env.ts (comments, quotes); a missing file is {}. */
export function readEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[trimmed.slice(0, eq).trim()] = value;
  }
  return values;
}

/** Whether to run the local LiveKit: { run: true } or { run: false, reason }. The real environment wins over the .env file. */
export function decide(env, fileEnv = {}) {
  const get = (key) => (env[key] !== undefined ? env[key] : fileEnv[key]) ?? "";
  if (get("NODE_ENV") === "production") return { run: false, reason: "NODE_ENV=production: the local development LiveKit never runs in production." };
  if (/^(1|true|yes)$/i.test(get("SKIP_LOCAL_LIVEKIT"))) return { run: false, reason: "SKIP_LOCAL_LIVEKIT is set: not starting a local LiveKit (voice needs LIVEKIT_* in apps/server/.env)." };
  if (get("LIVEKIT_URL") && get("LIVEKIT_API_KEY") && get("LIVEKIT_API_SECRET")) return { run: false, reason: `LIVEKIT_URL is configured (${get("LIVEKIT_URL")}): using that LiveKit, not starting a local one.` };
  return { run: true };
}

/**
 * The port to listen on (LOCAL_LIVEKIT_PORT, default 7880; TCP and UDP media use the next two). Like the game server
 * (which reads it after loading apps/server/.env), the environment wins over the file — so a port set in either place
 * reaches both processes and they agree.
 */
export function localPort(env, fileEnv = {}) {
  const raw = env.LOCAL_LIVEKIT_PORT ?? fileEnv.LOCAL_LIVEKIT_PORT;
  const port = Number(raw ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65533) throw new Error(`LOCAL_LIVEKIT_PORT must be 1024–65533 (got ${raw})`);
  return port;
}

/** The config file this script writes: localhost signalling, one muxed UDP port, quiet logs, no TURN. */
export function devConfig(port) {
  return [
    "# Written by scripts/dev/livekit.mjs for local development only (npm run dev). Do not deploy.",
    `port: ${port}`,
    "rtc:",
    `  tcp_port: ${port + 1}`,
    `  udp_port: ${port + 2}`,
    "  use_external_ip: false",
    "logging:",
    "  level: info",
    "  pion_level: error",
    "",
  ].join("\n");
}

/** The pinned binary, downloaded and verified (or already cached). Returns its path, or null when none is published here. */
export async function ensureReleaseBinary({ platform = process.platform, arch = process.arch, cacheRoot = join(ROOT, "node_modules", ".cache", "livekit"), fetchImpl = fetch, log = console.log } = {}) {
  const asset = releaseAsset(platform, arch);
  if (!asset) return null;
  const dir = join(cacheRoot, LIVEKIT_VERSION, `${platform}-${arch}`);
  const binary = join(dir, asset.binary);
  const stamp = join(dir, "verified.json");
  if (existsSync(binary) && existsSync(stamp)) {
    const recorded = JSON.parse(readFileSync(stamp, "utf8"));
    if (recorded.binarySha256 === sha256(readFileSync(binary))) return binary;
    log(`${TAG} the cached binary changed since it was verified — downloading it again`);
  }
  log(`${TAG} downloading livekit-server ${LIVEKIT_VERSION} (${asset.name}) from the official GitHub release…`);
  const get = async (name) => {
    const response = await fetchImpl(`${RELEASE_BASE}/${name}`);
    if (!response.ok) throw new Error(`GET ${name}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = parseChecksums((await get("checksums.txt")).toString("utf8"));
  const expected = sums.get(asset.name);
  if (!expected) throw new Error(`checksums.txt of v${LIVEKIT_VERSION} lists no ${asset.name}`);
  const archive = await get(asset.name);
  const actual = sha256(archive);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset.name}: expected ${expected}, got ${actual} — not using it`);
  const extracted = asset.kind === "zip" ? extractFromZip(archive, asset.binary) : extractFromTarGz(archive, asset.binary);
  if (!extracted) throw new Error(`${asset.binary} not found in ${asset.name}`);
  mkdirSync(dir, { recursive: true });
  const partial = `${binary}.partial`;
  writeFileSync(partial, extracted);
  if (platform !== "win32") chmodSync(partial, 0o755);
  renameSync(partial, binary);
  writeFileSync(stamp, `${JSON.stringify({ version: LIVEKIT_VERSION, asset: asset.name, archiveSha256: actual, binarySha256: sha256(extracted) }, null, 2)}\n`);
  log(`${TAG} verified (sha256 ${actual.slice(0, 16)}…) and cached at ${binary}`);
  return binary;
}

/** `livekit-server` on PATH (macOS: brew install livekit), with its version; null if there is none. */
export function binaryOnPath(command = process.platform === "win32" ? "livekit-server.exe" : "livekit-server") {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const version = /(\d+\.\d+\.\d+)/.exec(`${result.stdout}${result.stderr}`)?.[1] ?? "unknown";
  return { path: command, version };
}

async function resolveBinary(env) {
  if (env.LIVEKIT_BINARY) {
    if (!existsSync(env.LIVEKIT_BINARY)) throw new Error(`LIVEKIT_BINARY=${env.LIVEKIT_BINARY} does not exist`);
    console.log(`${TAG} using LIVEKIT_BINARY=${env.LIVEKIT_BINARY}`);
    return env.LIVEKIT_BINARY;
  }
  try {
    const downloaded = await ensureReleaseBinary();
    if (downloaded) return downloaded;
  } catch (error) {
    console.warn(`${TAG} could not get the release binary: ${error instanceof Error ? error.message : error}`);
  }
  const onPath = binaryOnPath();
  if (onPath) {
    if (onPath.version !== LIVEKIT_VERSION) console.warn(`${TAG} using livekit-server ${onPath.version} from PATH (the tested version is ${LIVEKIT_VERSION})`);
    return onPath.path;
  }
  return null;
}

async function main() {
  const env = process.env;
  const fileEnv = readEnvFile(join(ROOT, "apps", "server", ".env"));
  const decision = decide(env, fileEnv);
  if (!decision.run) {
    console.log(`${TAG} ${decision.reason}`);
    return;
  }
  const port = localPort(env, fileEnv);
  const binary = await resolveBinary(env);
  if (!binary) {
    console.error(
      `${TAG} no livekit-server ${LIVEKIT_VERSION} for ${process.platform}/${process.arch}. ` +
        (process.platform === "darwin" ? "On macOS: brew install livekit (then run npm run dev again). " : "") +
        "Or set LIVEKIT_BINARY=/path/to/livekit-server, or LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET in apps/server/.env, or SKIP_LOCAL_LIVEKIT=1. Voice stays off until then; everything else works.",
    );
    process.exitCode = 1;
    return;
  }
  const dir = join(ROOT, "node_modules", ".cache", "livekit");
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, `dev-${port}.yaml`);
  writeFileSync(configPath, devConfig(port));
  const args = ["--dev", "--bind", "127.0.0.1", "--config", configPath, ...(env.LIVEKIT_NODE_IP ? ["--node-ip", env.LIVEKIT_NODE_IP] : [])];
  console.log(`${TAG} starting LiveKit ${LIVEKIT_VERSION} for local development: ws://127.0.0.1:${port} (media TCP ${port + 1}, UDP ${port + 2}; keys devkey / secret)`);
  // The game server's LIVEKIT_* stay unset: `npm run dev` starts it with --local-livekit (apps/server/src/voice/config.ts),
  // which expects the --dev placeholder keys — so keys or a config body inherited from the shell must not override them.
  const childEnv = { ...env };
  delete childEnv.LIVEKIT_KEYS;
  delete childEnv.LIVEKIT_CONFIG;
  const child = spawn(binary, args, { stdio: "inherit", env: childEnv });
  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal) console.log(`${TAG} stopped (${signal})`);
    process.exitCode = code ?? 0;
  });
  child.on("error", (error) => {
    console.error(`${TAG} could not start ${binary}: ${error.message}`);
    process.exitCode = 1;
  });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`${TAG} ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
