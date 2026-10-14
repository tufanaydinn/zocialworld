// Stage 2 mainnet smoke test, NO FUNDS:
//   * runs the GAME SERVER (apps/server/src/index.ts from the repository, read-only: no name registry, no .env) for
//     its wallet bridge -> https://zec.rocks:443 (LIGHTWALLETD_URL to override),
//   * serves the Stage-2 mainnet package + mainnet.html from the harness server,
//   * drives the page in headless Chromium (fresh throwaway seeds, never printed): create + sync 2,000 and 30,000
//     blocks (timed), engine info, addresses, the upgrade guard, coded refusals, restore,
//   * decodes the produced addresses with zw-tx-decrypt 0.2 (describeAddress) and runs registryKeysFromSeed on a
//     throwaway mainnet seed.
// Usage: node run-mainnet.mjs <mainPkgDir> [outFile] [blocks e.g. 2000,30000]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = process.env.ZW_REPO ?? new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const { chromium } = await import(`${REPO}/node_modules/playwright/index.mjs`);
const PKG = process.argv[2];
const OUT_FILE = process.argv[3] ?? `${HERE}../work/harness/mainnet-smoke.json`;
const BLOCKS = process.argv[4] ?? "2000,30000";
const HELPER = process.env.HELPER ?? `${REPO}/vendor/zcash-tx-decrypt/zw_tx_decrypt.js`;
const UPSTREAM = process.env.LIGHTWALLETD_URL ?? "https://zec.rocks:443";
const GAME_PORT = Number(process.env.GAME_PORT ?? 8875), PAGE_PORT = Number(process.env.PAGE_PORT ?? 8876);
const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;
const require = createRequire(import.meta.url);
const h = require(HELPER);
const killGroup = (child) => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
const addresses = JSON.parse(readFileSync(`${REPO}/scripts/wallet-engine/fixtures/test-addresses.json`, "utf8"));

const logs = { game: [], harness: [] };
const game = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: `${REPO}/apps/server`,
  env: { ...process.env, PORT: String(GAME_PORT), HOST: "127.0.0.1", LIGHTWALLETD_URL: UPSTREAM, ALLOWED_ORIGINS: PAGE_ORIGIN, NAME_REGISTRY: "off" },
  stdio: ["ignore", "pipe", "pipe"], detached: true,
});
game.stdout.on("data", (d) => logs.game.push(String(d)));
game.stderr.on("data", (d) => logs.game.push(String(d)));
const harness = spawn("npx", ["tsx", `${HERE}server.mts`], {
  cwd: `${REPO}/apps/server`,
  env: { ...process.env, PORT: String(PAGE_PORT), PKG_DIR: PKG, PAGE: "mainnet.html", LIGHTWALLETD_URL: UPSTREAM, ZW_REPO: REPO },
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
  page.on("console", (m) => { if (consoleLines.length < 4000) consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 500)}`));
  const lwd = `http://127.0.0.1:${GAME_PORT}/zcash/lwd`;
  const q = new URLSearchParams({ lwd, orchardOnly: addresses.main.orchardOnlyUa, testnetUa: addresses.test.orchardSaplingUa, tex: addresses.main.tex, blocks: BLOCKS });
  await page.goto(`${PAGE_ORIGIN}/?${q}`);
  while (Date.now() - t0 < 80 * 60 * 1000) {
    run = await page.evaluate(() => window.__run).catch(() => undefined);
    if (run?.finished) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await browser.close();
} finally {
  killGroup(game);
  killGroup(harness);
}

// Decode the wallet's addresses with the Stage-2 helper; registryKeysFromSeed on a throwaway mainnet seed.
const checks = (run?.steps ?? []).filter((s) => s.name.startsWith("check:")).map((s) => ({ ...s }));
const add = (name, pass, data) => checks.push({ name: `check:${name}`, pass: !!pass, ...(data ?? {}) });
const recv = (a) => [...h.describeAddress(a).receivers].sort().join("+");
const a = run?.addresses;
let decoded = null;
try {
  decoded = a ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, h.describeAddress(v)])) : null;
  add("describe-full-ua-orchard+sapling+p2pkh", a && decoded.unified.network === "main" && decoded.unified.kind === "unified" && recv(a.unified) === "orchard+p2pkh+sapling" && decoded.unified.hasOrchard && decoded.unified.hasSapling && decoded.unified.hasTransparent, { receivers: decoded?.unified.receivers });
  add("describe-shielded-ua-orchard+sapling", a && decoded.unifiedShielded.network === "main" && recv(a.unifiedShielded) === "orchard+sapling" && !decoded.unifiedShielded.hasTransparent, { receivers: decoded?.unifiedShielded.receivers });
  add("describe-stage1-ua-sapling+p2pkh", a && recv(a.unifiedSaplingTransparent) === "p2pkh+sapling" && !decoded.unifiedSaplingTransparent.hasOrchard, { receivers: decoded?.unifiedSaplingTransparent.receivers });
  add("describe-zs1-and-t1", a && decoded.sapling.kind === "sapling" && decoded.transparent.kind === "transparent-p2pkh" && decoded.sapling.network === "main");
  const { generateMnemonic } = await import(`${REPO}/node_modules/@scure/bip39/index.js`);
  const { wordlist } = await import(`${REPO}/node_modules/@scure/bip39/wordlists/english.js`);
  let seed = generateMnemonic(wordlist, 256);
  const rk = h.registryKeysFromSeed(seed, "main", 0);
  seed = null;
  const { ufvk, ...addrs } = rk;
  add("registry-keys-mainnet", rk.ufvk.startsWith("uview1") && recv(rk.unifiedAddress) === "orchard+p2pkh+sapling" && recv(rk.unifiedShieldedAddress) === "orchard+sapling" && recv(rk.unifiedSaplingTransparentAddress) === "p2pkh+sapling"
    && rk.saplingAddress.startsWith("zs1") && rk.transparentAddress.startsWith("t1") && JSON.stringify(h.addressesFromUfvk(ufvk, "main")) === JSON.stringify(addrs), { unifiedAddress: rk.unifiedAddress.slice(0, 12) });
} catch (e) {
  add("runner", false, { error: String(e?.stack ?? e).slice(0, 600) });
}
const passed = checks.filter((c) => c.pass).length;
const bridgeLine = logs.game.join("").split("\n").find((line) => line.includes("wallet bridge")) ?? null;
const calls = {};
for (const l of logs.game.join("").split("\n")) { const m = /\[lwd\] (\w+) (\d+)/.exec(l); if (m) { const k = `${m[1]} ${m[2]}`; calls[k] = (calls[k] ?? 0) + 1; } }
const result = { at: new Date().toISOString(), elapsedSec: Math.round((Date.now() - t0) / 1000), engine: PKG, helper: h.buildInfo(), bridge: `game server apps/server/src/index.ts on :${GAME_PORT} -> ${UPSTREAM}`, bridgeLog: bridgeLine?.trim() ?? null, lwdCalls: calls, passed, total: checks.length, sync: run?.sync ?? null, checks, decoded, steps: run?.steps ?? null, pageErrors: consoleLines.filter((l) => l.startsWith("[pageerror]")).slice(0, 20) };
mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(result, null, 1));
writeFileSync(OUT_FILE.replace(/\.json$/, "-console.txt"), consoleLines.filter((l) => !/seed/i.test(l)).join("\n"));
console.log(JSON.stringify({ passed, total: checks.length, sync: run?.sync, elapsedSec: result.elapsedSec }, null, 1));
for (const c of checks) console.log(`  ${c.pass ? "ok  " : "FAIL"} ${c.name}${c.pass ? "" : " " + JSON.stringify(c).slice(0, 400)}`);
const err = (run?.steps ?? []).find((s) => s.name === "error"); if (err) console.log("ERROR", JSON.stringify(err).slice(0, 600));
process.exit(passed === checks.length && run?.ok ? 0 : 1);
