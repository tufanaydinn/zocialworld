// Tests for scripts/tools/registry-keys.mjs, the operator's fee/registry key tool.
// Run: node --test scripts/tools/ (part of `npm run test:scripts`).
//
// Uses only the PUBLIC BIP-39 test vector "abandon ×11 about" (anyone can spend from it — never send ZEC there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(HERE, "registry-keys.mjs");
const PUBLIC_TEST_VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// The tool prints the FULL unified address (Orchard + Sapling + transparent receivers).
const PUBLIC_TEST_VECTOR_ADDRESS =
  "u1vu0zkreyef83369fn3dr94zkg2djqlcgtghxf2jmdcdmxp2z4l70dlh6yfdf5v33cteezva2c528syqtmu7uxgzss6fumh3tzjumnqh45z3yewkqplrfdz4f68aahg8x35yknyf7vjh4wy5sn4cc8edkxlef2p4q8ez6e0xuzrmr4rzff54m5t5whyzdgfg2cujtjdjlx2zqu46h7ty";

function runTool(args, { script = SCRIPT, input, nodeArgs = [] } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, script, ...args], { encoding: "utf8", input, timeout: 60_000 });
}

test("--seed-stdin: prints the mainnet registry address and viewing key, never the seed", () => {
  const result = runTool(["--network", "main", "--seed-stdin"], { input: `${PUBLIC_TEST_VECTOR}\r\n` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^NAME_REGISTRY_ADDRESS=${PUBLIC_TEST_VECTOR_ADDRESS}$`, "m"));
  assert.match(result.stdout, /^NAME_REGISTRY_UFVK=uview1[0-9a-z]+$/m);
  // The other accepted forms are listed as comments (the shielded-only u1… and the zs1…).
  assert.match(result.stdout, /^# shielded unified address \(Orchard \+ Sapling, no transparent receiver\): u1[0-9a-z]+$/m);
  assert.match(result.stdout, /^# Sapling-only form of the same receiver .*: zs1[0-9a-z]+$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /abandon/);
});

test("a fresh seed is shown once as 24 numbered words; --out gets the settings without it", () => {
  const dir = mkdtempSync(join(tmpdir(), "zw-registry-keys-"));
  try {
    const out = join(dir, "registry.env");
    const result = runTool(["--network", "main", "--out", out]);
    assert.equal(result.status, 0, result.stderr);
    const words = [...result.stdout.matchAll(/\b\d{1,2}\. ([a-z]+)/g)].map((match) => match[1]);
    assert.equal(words.length, 24);
    const written = readFileSync(out, "utf8");
    assert.match(written, /^NAME_REGISTRY_ADDRESS=u1[0-9a-z]+$/m);
    assert.match(written, /^NAME_REGISTRY_UFVK=uview1[0-9a-z]+$/m);
    assert.ok(!written.includes(words.join(" ")), "the seed is never written");
    for (const line of written.trimEnd().split("\n")) assert.match(line, /^(# |NAME_REGISTRY_(ADDRESS|UFVK)=)/, "only comments and the two settings");
    if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(runTool(["--network", "main", "--out", out]).status, 1, "an existing --out file is never overwritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The helper used to be located with `new URL(…).pathname`: "/C:/…" on Windows (require() cannot load it) and a
// "%20"-encoded path wherever a folder name has a space. The same check for the space case, on any system: the
// repository seen through a folder with a space in its name.
test("works from a folder whose path contains a space (and so from a Windows drive path)", { skip: process.platform === "win32" && "symlinks need extra rights on Windows" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "zw registry keys "));
  try {
    const repo = join(dir, "zocial world");
    mkdirSync(repo);
    for (const name of ["scripts", "vendor", "node_modules"]) symlinkSync(join(ROOT, name), join(repo, name), "dir");
    const result = runTool(["--network", "main", "--seed-stdin"], {
      script: join(repo, "scripts", "tools", "registry-keys.mjs"),
      input: PUBLIC_TEST_VECTOR,
      // Keep the path with the space (Node would otherwise resolve the symlinks to the real repository path).
      nodeArgs: ["--preserve-symlinks", "--preserve-symlinks-main"],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^NAME_REGISTRY_ADDRESS=${PUBLIC_TEST_VECTOR_ADDRESS}$`, "m"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
