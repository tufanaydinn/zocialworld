#!/usr/bin/env node
// Downloads the third-party model packs listed in assets/asset-registry.json (plus the packs that the production
// content lists in its own registry, src/content/production/asset-registry.json under apps/web, when that content is
// present) and checks every file against its recorded SHA-256 before writing it under apps/web/public/assets/.
//
//   npm run assets:fetch                      download every pack the sample world and the client systems can use
//   npm run assets:fetch -- --check           only verify what is already on disk (exit 1 if anything is missing)
//   npm run assets:fetch -- --pack <id>       one pack (repeatable); `--all` includes packs marked "fetch": false
//   npm run assets:fetch -- --mirror <dir>    read archives and repository files from a local copy instead of the network
//   npm run assets:fetch -- --root <dir>      write under another checkout (default: this repository)
//
// Kenney packs come from their pinned download archive (whose SHA-256 is checked first); KayKit packs come file by
// file from the pinned commit of their repository. Files marked `"process": "character"` are rebuilt from the
// original with scripts/assets/process-characters.mjs and checked against `fetchedSha256`. Nothing is written unless
// its hash matches. Behind an HTTP proxy, run Node with NODE_USE_ENV_PROXY=1.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listZip, readZipEntry } from "./zip.mjs";
import { processCharacter } from "./process-characters.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REGISTRY_PATH = join(REPO, "assets", "asset-registry.json");
/** Packs that only the production content uses, in the same format; absent in a tree without that content. */
export const CONTENT_REGISTRY_PATH = join("apps", "web", "src", "content", "production", "asset-registry.json");

/** The packs of `root`: the shared registry followed by the production content's registry when it exists. */
export function loadRegistry(root = REPO) {
  const shared = JSON.parse(readFileSync(join(root, "assets", "asset-registry.json"), "utf8"));
  const contentFile = join(root, CONTENT_REGISTRY_PATH);
  if (!existsSync(contentFile)) return shared;
  const content = JSON.parse(readFileSync(contentFile, "utf8"));
  if (!Array.isArray(shared) || !Array.isArray(content)) return shared;
  return [...shared, ...content];
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const PROCESSORS = { character: processCharacter };

/** The hashes a file on disk may have: the recorded file, or (for rebuilt files) the rebuild's result. */
export function acceptedHashes(file) {
  return [file.sha256, file.fetchedSha256].filter(Boolean);
}

/** Refuses registry paths that could write outside the pack folder. */
function safeJoin(base, relative) {
  if (relative.startsWith("/") || relative.split(/[\\/]/).includes("..")) throw new Error(`unsafe path in registry: ${relative}`);
  const target = resolve(base, relative);
  if (!target.startsWith(resolve(base) + sep)) throw new Error(`unsafe path in registry: ${relative}`);
  return target;
}

/** Checks the registry entries this script relies on and returns a list of problems (empty when usable). */
export function registryProblems(registry) {
  const problems = [];
  if (!Array.isArray(registry)) return ["the registry must be an array of packs"];
  const ids = new Set();
  for (const pack of registry) {
    const where = pack?.id ?? "(pack without id)";
    if (!pack?.id) problems.push("a pack has no id");
    else if (ids.has(pack.id)) problems.push(`duplicate pack id ${pack.id}`);
    ids.add(pack?.id);
    if (typeof pack?.location !== "string" || !pack.location.startsWith("apps/web/public/assets/")) problems.push(`${where}: location must be under apps/web/public/assets/`);
    const source = pack?.source;
    if (source?.kind === "zip") {
      if (!/^https:\/\//.test(source.url ?? "")) problems.push(`${where}: zip source needs an https url`);
      if (!/^[0-9a-f]{64}$/.test(source.sha256 ?? "")) problems.push(`${where}: zip source needs its sha256`);
    } else if (source?.kind === "git") {
      if (!/^https:\/\//.test(source.raw ?? "")) problems.push(`${where}: git source needs a raw file url prefix`);
      if (!/^[0-9a-f]{40}$/.test(source.commit ?? "")) problems.push(`${where}: git source needs a full commit id`);
      else if (!source.raw.includes(source.commit)) problems.push(`${where}: the raw url must pin the commit`);
    } else problems.push(`${where}: source.kind must be "zip" or "git"`);
    if (!Array.isArray(pack?.files) || pack.files.length === 0) {
      problems.push(`${where}: no files`);
      continue;
    }
    if (pack.fileCount !== undefined && pack.fileCount !== pack.files.length) problems.push(`${where}: fileCount ${pack.fileCount} != ${pack.files.length} files`);
    const paths = new Set();
    for (const file of pack.files) {
      if (typeof file?.path !== "string" || typeof file?.from !== "string") problems.push(`${where}: every file needs path and from`);
      else if (paths.has(file.path)) problems.push(`${where}: duplicate file ${file.path}`);
      paths.add(file?.path);
      if (!/^[0-9a-f]{64}$/.test(file?.sha256 ?? "")) problems.push(`${where}/${file?.path}: missing sha256`);
      if (file?.process !== undefined) {
        if (!PROCESSORS[file.process]) problems.push(`${where}/${file.path}: unknown process "${file.process}"`);
        if (!/^[0-9a-f]{64}$/.test(file.sourceSha256 ?? "")) problems.push(`${where}/${file.path}: a rebuilt file needs sourceSha256`);
        if (!/^[0-9a-f]{64}$/.test(file.fetchedSha256 ?? "")) problems.push(`${where}/${file.path}: a rebuilt file needs fetchedSha256`);
      }
    }
  }
  return problems;
}

/** Which files of `pack` are missing or differ under `root` (a repository checkout). */
export function checkPack(pack, root) {
  const dir = join(root, pack.location);
  const missing = [];
  const mismatched = [];
  for (const file of pack.files) {
    const target = safeJoin(dir, file.path);
    if (!existsSync(target)) missing.push(file.path);
    else if (!acceptedHashes(file).includes(sha256(readFileSync(target)))) mismatched.push(file.path);
  }
  return { missing, mismatched };
}

async function download(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`download failed: ${url} (${lastError?.message ?? lastError})`);
}

/** Reads the source bytes of a pack: the whole archive (zip) or a function that returns one repository file (git). */
function sourceReader(pack, mirror) {
  const source = pack.source;
  if (source.kind === "zip") {
    let archive;
    return async (from) => {
      if (!archive) {
        const bytes = mirror ? readFileSync(join(mirror, basename(new URL(source.url).pathname))) : await download(source.url);
        if (sha256(bytes) !== source.sha256) throw new Error(`${pack.id}: archive hash mismatch (expected ${source.sha256})`);
        const entries = new Map(listZip(bytes).map((e) => [e.name, e]));
        archive = { bytes, entries };
      }
      const entry = archive.entries.get(from);
      if (!entry) throw new Error(`${pack.id}: ${from} is not in the archive`);
      return readZipEntry(archive.bytes, entry);
    };
  }
  const repoName = source.repository ? basename(new URL(source.repository).pathname) : pack.id;
  return async (from) => {
    if (mirror) return readFileSync(safeJoin(join(mirror, repoName), from));
    return download(source.raw + from.split("/").map(encodeURIComponent).join("/"));
  };
}

/** Produces the verified bytes of one registered file. */
export async function produceFile(pack, file, read) {
  const original = await read(file.from);
  if (!file.process) {
    if (sha256(original) !== file.sha256) throw new Error(`${pack.id}/${file.path}: hash mismatch for ${file.from}`);
    return original;
  }
  if (sha256(original) !== file.sourceSha256) throw new Error(`${pack.id}/${file.path}: source hash mismatch for ${file.from}`);
  const rebuilt = PROCESSORS[file.process](original);
  if (sha256(rebuilt) !== file.fetchedSha256) throw new Error(`${pack.id}/${file.path}: rebuilt file hash mismatch (expected ${file.fetchedSha256}, got ${sha256(rebuilt)})`);
  return rebuilt;
}

function writeAtomic(target, bytes) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
}

/** Fetches the files of one pack that are missing or wrong under `root`; returns how many were written. */
export async function fetchPack(pack, { root = REPO, mirror, force = false, log = console.log } = {}) {
  const dir = join(root, pack.location);
  const { missing, mismatched } = force ? { missing: pack.files.map((f) => f.path), mismatched: [] } : checkPack(pack, root);
  const wanted = new Set([...missing, ...mismatched]);
  if (wanted.size === 0) {
    log(`${pack.id}: up to date (${pack.files.length} files)`);
    return 0;
  }
  const read = sourceReader(pack, mirror);
  let written = 0;
  for (const file of pack.files) {
    if (!wanted.has(file.path)) continue;
    writeAtomic(safeJoin(dir, file.path), await produceFile(pack, file, read));
    written++;
  }
  log(`${pack.id}: wrote ${written} of ${pack.files.length} files`);
  return written;
}

function parseArgs(argv) {
  const args = { packs: [], check: false, all: false, force: false, mirror: undefined, root: REPO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--all") args.all = true;
    else if (a === "--force") args.force = true;
    else if (a === "--pack") args.packs.push(argv[++i]);
    else if (a === "--mirror") args.mirror = resolve(argv[++i]);
    else if (a === "--root") args.root = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2), registry = loadRegistry()) {
  const args = parseArgs(argv);
  const problems = registryProblems(registry);
  if (problems.length > 0) {
    for (const p of problems) console.error(`registry: ${p}`);
    return 2;
  }
  const unknown = args.packs.filter((id) => !registry.some((p) => p.id === id));
  if (unknown.length > 0) {
    console.error(`unknown pack: ${unknown.join(", ")}`);
    return 2;
  }
  const selected = registry.filter((p) => (args.packs.length > 0 ? args.packs.includes(p.id) : args.all || p.fetch !== false));
  if (args.check) {
    let bad = 0;
    for (const pack of selected) {
      const { missing, mismatched } = checkPack(pack, args.root);
      bad += missing.length + mismatched.length;
      console.log(`${pack.id}: ${pack.files.length - missing.length - mismatched.length}/${pack.files.length} verified${missing.length ? `, ${missing.length} missing` : ""}${mismatched.length ? `, ${mismatched.length} differ: ${mismatched.join(", ")}` : ""}`);
    }
    return bad === 0 ? 0 : 1;
  }
  for (const pack of selected) await fetchPack(pack, { root: args.root, mirror: args.mirror, force: args.force });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
