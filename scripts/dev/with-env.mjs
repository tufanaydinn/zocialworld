#!/usr/bin/env node
/**
 * Runs a command with environment variables set — the same on Linux, macOS and Windows.
 *
 * npm runs package.json scripts with cmd.exe on Windows, where the POSIX form `VITE_ZCASH_NETWORK=main npm run dev`
 * fails ("'VITE_ZCASH_NETWORK' is not recognized…"). The root `npm run dev:main` uses this launcher instead:
 *
 *   node scripts/dev/with-env.mjs VITE_ZCASH_NETWORK=main -- npm run dev --workspace apps/web
 *
 * Every `NAME=value` before `--` is set for the command after it (on top of the current environment); the command's
 * exit code is passed on, and Ctrl+C / SIGTERM reach it. Node built-ins only.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `["A=1", "B=x=y", "--", "cmd", "arg"]` → `{ env: { A: "1", B: "x=y" }, command: ["cmd", "arg"] }`. Throws on bad input. */
export function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) throw new Error("usage: with-env.mjs NAME=value [NAME=value …] -- command [args…]");
  const env = {};
  for (const assignment of argv.slice(0, separator)) {
    const equals = assignment.indexOf("=");
    const name = equals > 0 ? assignment.slice(0, equals) : "";
    if (!NAME.test(name)) throw new Error(`not a NAME=value assignment: ${JSON.stringify(assignment)}`);
    env[name] = assignment.slice(equals + 1);
  }
  const command = argv.slice(separator + 1);
  if (command.length === 0) throw new Error("with-env.mjs: no command after --");
  return { env, command };
}

/** Starts `command` with `env` added; resolves with its exit code (128 + signal number style codes for signals). */
export function run({ env, command }, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: options.stdio ?? "inherit",
      env: { ...process.env, ...env },
      // Windows: `npm` is npm.cmd, which only a shell resolves.
      shell: process.platform === "win32",
    });
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("error", (error) => {
      console.error(`[with-env] could not start ${command[0]}: ${error.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  process.exit(await run(parsed));
}
