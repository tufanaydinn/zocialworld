// scripts/dev/with-env.mjs — `npm run dev:main` on Linux, macOS and Windows. Run: node --test scripts/dev/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, run } from "./with-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

test("parseArgs: assignments before --, the command after it (values may contain '=')", () => {
  assert.deepEqual(parseArgs(["VITE_ZCASH_NETWORK=main", "X=a=b", "--", "npm", "run", "dev"]), { env: { VITE_ZCASH_NETWORK: "main", X: "a=b" }, command: ["npm", "run", "dev"] });
  assert.deepEqual(parseArgs(["EMPTY=", "--", "node"]), { env: { EMPTY: "" }, command: ["node"] });
  assert.throws(() => parseArgs(["A=1", "npm"]), /usage/);
  assert.throws(() => parseArgs(["A=1", "--"]), /no command/);
  assert.throws(() => parseArgs(["=1", "--", "x"]), /NAME=value/);
  assert.throws(() => parseArgs(["1A=1", "--", "x"]), /NAME=value/);
});

test("run: the variables reach the command, and its exit code comes back", async () => {
  const ok = await run({ env: { ZW_WITH_ENV_TEST: "main" }, command: [process.execPath, "-e", "process.exit(process.env.ZW_WITH_ENV_TEST === 'main' ? 0 : 3)"] }, { stdio: "ignore" });
  assert.equal(ok, 0);
  assert.equal(await run({ env: {}, command: [process.execPath, "-e", "process.exit(7)"] }, { stdio: "ignore" }), 7);
  assert.equal(await run({ env: {}, command: ["zw-no-such-command-xyz"] }, { stdio: "ignore" }), process.platform === "win32" ? 1 : 127);
});

test("as a script: bad arguments exit 2; a command's exit code is passed on", () => {
  const script = join(HERE, "with-env.mjs");
  assert.equal(spawnSync(process.execPath, [script, "A=1"], { encoding: "utf8" }).status, 2);
  const passed = spawnSync(process.execPath, [script, "ZW_T=x", "--", process.execPath, "-e", "process.exit(process.env.ZW_T === 'x' ? 5 : 9)"], { encoding: "utf8" });
  assert.equal(passed.status, 5);
});

test("package.json: dev:main uses the launcher (no POSIX-only VAR=value prefix)", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  for (const name of ["dev:main:web", "dev:main:server"]) {
    assert.match(scripts[name], /^node scripts\/dev\/with-env\.mjs [A-Z_]+=main -- npm run /, name);
  }
});
