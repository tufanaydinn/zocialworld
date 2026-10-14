// Stage 2: the Stage-2 MAINNET engine package's NU7 safety net on a REAL NU7 chain — the public Testnet (NU7 active
// since 4,465,026), NO FUNDS (as Stage 1's run-testnet-guard.mjs):
//   * runs the GAME SERVER (apps/server, read-only, no name registry) with LIGHTWALLETD_URL=https://testnet.zec.rocks:443,
//   * serves the engine package + testnet.html from the harness server,
//   * drives the page: new WebWallet("test", …), sending_status(), sync, refused sends, restore.
// Usage: node run-testnet.mjs <mainPkgDir> [outFile]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = process.env.ZW_REPO ?? new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const { chromium } = await import(`${REPO}/node_modules/playwright/index.mjs`);
const PKG = process.argv[2];
const OUT_FILE = process.argv[3] ?? `${HERE}../work/harness/testnet-nu7-guard.json`;
const UPSTREAM = process.env.LIGHTWALLETD_URL ?? "https://testnet.zec.rocks:443";
const GAME_PORT = Number(process.env.GAME_PORT ?? 8877), PAGE_PORT = Number(process.env.PAGE_PORT ?? 8878);
const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;
const killGroup = (child) => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };

const logs = { game: [], harness: [] };
const game = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: `${REPO}/apps/server`,
  env: { ...process.env, PORT: String(GAME_PORT), HOST: "127.0.0.1", ZCASH_NETWORK: "test", LIGHTWALLETD_URL: UPSTREAM, ALLOWED_ORIGINS: PAGE_ORIGIN, NAME_REGISTRY: "off", ZCASHD_RPC_URL: "" },
  stdio: ["ignore", "pipe", "pipe"], detached: true,
});
game.stdout.on("data", (d) => logs.game.push(String(d)));
game.stderr.on("data", (d) => logs.game.push(String(d)));
const harness = spawn("npx", ["tsx", `${HERE}server.mts`], {
  cwd: `${REPO}/apps/server`,
  env: { ...process.env, PORT: String(PAGE_PORT), PKG_DIR: PKG, PAGE: "testnet.html", LIGHTWALLETD_URL: UPSTREAM, ZW_REPO: REPO },
  stdio: ["ignore", "pipe", "pipe"], detached: true,
});
harness.stdout.on("data", (d) => logs.harness.push(String(d)));
harness.stderr.on("data", (d) => logs.harness.push(String(d)));
const up = async (url) => { for (let i = 0; i < 120; i++) { try { await fetch(url); return true; } catch {} await new Promise((r) => setTimeout(r, 500)); } return false; };

let run;
const t0 = Date.now();
const consoleLines = [];
try {
  await up(`http://127.0.0.1:${GAME_PORT}/`);
  await up(`${PAGE_ORIGIN}/`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => { if (consoleLines.length < 2000) consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 500)}`));
  const lwd = `http://127.0.0.1:${GAME_PORT}/zcash/lwd`;
  await page.goto(`${PAGE_ORIGIN}/?lwd=${encodeURIComponent(lwd)}&blocks=${Number(process.env.BLOCKS ?? 5000)}`);
  while (Date.now() - t0 < 25 * 60 * 1000) {
    run = await page.evaluate(() => window.__run).catch(() => undefined);
    if (run?.finished) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await browser.close();
} finally {
  killGroup(game);
  killGroup(harness);
}
const checks = (run?.steps ?? []).filter((s) => s.name.startsWith("check:"));
const bridgeLine = logs.game.join("").split("\n").find((line) => line.includes("wallet bridge")) ?? null;
const result = {
  at: new Date().toISOString(), elapsedSec: Math.round((Date.now() - t0) / 1000), engine: PKG,
  bridge: `game server apps/server/src/index.ts on :${GAME_PORT} (ZCASH_NETWORK=test) -> ${UPSTREAM}`, bridgeLog: bridgeLine?.trim() ?? null,
  ok: run?.ok === true, passed: checks.filter((c) => c.pass).length, total: checks.length,
  checks: Object.fromEntries(checks.map((s) => [s.name.slice(6), s.pass])), steps: run?.steps ?? null,
  pageErrors: consoleLines.filter((line) => line.startsWith("[pageerror]")).slice(0, 20),
};
mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ ok: result.ok, passed: result.passed, total: result.total, checks: result.checks, elapsedSec: result.elapsedSec }, null, 1));
const err = (run?.steps ?? []).find((s) => s.name === "error"); if (err) console.log("ERROR", JSON.stringify(err).slice(0, 600));
process.exit(result.ok && result.passed === result.total ? 0 : 1);
