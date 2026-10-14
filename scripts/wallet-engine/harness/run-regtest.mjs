// Stage 2: the full regtest matrix of the Stage-2 engine (TESTING ONLY):
//   1. builds the page config (regtest test keys from zw-tx-decrypt 0.2, coinbase values from zebrad,
//      PROJECT's TEX and Orchard-only addresses),
//   2. starts the harness server (the game's own lwdProxy bridge -> local lightwalletd), serving the
//      Stage-2 regtest package at /pkg/ and the regtest twin of the SHIPPED Stage-1 engine at /pkg2/,
//   3. drives regtest.html in headless Chromium (every Stage-2 flow + the Stage-1 save -> restore flow),
//   4. fetches every produced transaction from zebrad and checks it with the NEW helper: shape (v6,
//      NU6.3 branch) and what each test key decrypts — the project's fee outputs in the Ironwood pool
//      (and in the Sapling pool for the Stage-1 registry address), the name fee, recipients, payers,
//   5. writes the run record (run JSON with page + helper checks, console, server log, decoded txs) and the
//      transaction fixtures.
// Usage: node run-regtest.mjs <stage2RegtestPkg> <stage1RegtestPkg> <outDir> [fixturesFile]
// Env: ZEBRA_RPC (default http://127.0.0.1:18932), LWD (default http://127.0.0.1:9667), PORT (8871),
//      HELPER (zw-tx-decrypt 0.2 zw_tx_decrypt.js), ZW_REPO (default: this repository, read only).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { texOf } from "./zaddr.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = process.env.ZW_REPO ?? new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const { chromium } = await import(`${REPO}/node_modules/playwright/index.mjs`);
const PKG = process.argv[2];
const PKG1 = process.argv[3];
const OUT = process.argv[4] ?? `${HERE}../work/harness/regtest`;
const FIXTURES = process.argv[5] ?? `${HERE}../fixtures/regtest-stage2-txs.json`;
const HELPER = process.env.HELPER ?? `${REPO}/vendor/zcash-tx-decrypt/zw_tx_decrypt.js`;
const PORT = Number(process.env.PORT ?? 8871);
const ZEBRA = process.env.ZEBRA_RPC ?? "http://127.0.0.1:18932";
const LWD = process.env.LWD ?? "http://127.0.0.1:9667";
// B's full UA as an earlier engine run (same seed) had it: the helper must derive the same address.
const PROJECT_ORCHARD_ONLY_UA = "uregtest1hmcjr5wyhtugazwwdv4udhgjpwywqrz8e3e4xdmemgleuurk7pf5p662f7n0mw02vjz5ww6crgy2nn8gjm6h9ep6d0tuf2h8nga55shw";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const B_UA_EXPECTED = "uregtest1798fnkml07gc8lvyd35wj6c0q9swz0phssqhv05wgy3x7mpxpz6uhwglckkzvmgv53d4ejmfgn7jea22pykuperc9nmtpj9gfs78hlcuz2xp9wjwfeuaa9mnass2el675t2wq7t2g23k4slnnk8k8tz2wwlqwej4naqaer3c7sxvp654d3nyqgd9js66hzxqstzpfj9carjpgq5zf4d";
const require = createRequire(import.meta.url);
const helper = require(HELPER);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

async function rpc(method, params = []) {
  const r = await fetch(ZEBRA, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ---- 1. config ----
const seeds = JSON.parse(readFileSync(`${REPO}/scripts/wallet-engine/fixtures/regtest-seeds.json`, "utf8")).seeds;
const keys = {};
for (const [k, s] of Object.entries(seeds)) keys[k] = helper.registryKeysFromSeed(s, "regtest", 0);
keys.D = helper.registryKeysFromSeed(seeds.C, "regtest", 3); // the Stage-1 player (seed C, account 3)
if (keys.B.unifiedAddress !== B_UA_EXPECTED) throw new Error("the helper's full UA for B differs from the engine's (earlier run)");
const addresses = JSON.parse(readFileSync(`${REPO}/scripts/wallet-engine/fixtures/test-addresses.json`, "utf8"));
let aTransparentCoinbaseZat = 0, bIronwoodCoinbaseZat = 0;
const tipAtStart = await rpc("getblockcount");
for (let h = 1; h <= tipAtStart; h++) {
  const b = await rpc("getblock", [String(h), 2]);
  const cb = b.tx[0];
  for (const o of cb.vout) if ((o.scriptPubKey.addresses ?? []).includes(keys.A.transparentAddress)) aTransparentCoinbaseZat += o.valueZat;
  if (cb.ironwood?.valueBalanceZat < 0) bIronwoodCoinbaseZat += -cb.ironwood.valueBalanceZat;
}
const cfg = {
  seeds, keys, addresses, bUnified: keys.B.unifiedAddress, aTransparentCoinbaseZat, bIronwoodCoinbaseZat, feeZat: 75000,
  projectTex: texOf(keys.PROJECT.transparentAddress, "texregtest"),
  // PROJECT's Orchard-only regtest UA (regtest test key), derived from the regtest PROJECT seed with
  // zw-tx-decrypt's examples/test_addresses.rs. (fixtures/test-addresses.json's regtest addresses are seed C's.)
  projectOrchardOnly: process.env.PROJECT_ORCHARD_ONLY ?? PROJECT_ORCHARD_ONLY_UA,
};
if (!same(helper.describeAddress(cfg.projectOrchardOnly).receivers, ["orchard"])) throw new Error("PROJECT_ORCHARD_ONLY is not an Orchard-only UA");
const cfgFile = `${HERE}.config.regtest.json`; // regtest test seeds only; deleted at the end
writeFileSync(cfgFile, JSON.stringify(cfg));
console.log(`[run] tip ${tipAtStart}; A transparent coinbase ${aTransparentCoinbaseZat} zat; B Ironwood coinbase ${bIronwoodCoinbaseZat} zat; helper ${helper.buildInfo()}`);

// ---- 2. server ----
const server = spawn("npx", ["tsx", `${HERE}server.mts`], {
  cwd: `${REPO}/apps/server`,
  env: { ...process.env, PORT: String(PORT), LIGHTWALLETD_URL: LWD, PKG_DIR: PKG, PKG2_DIR: PKG1, PAGE: "regtest.html", ZEBRA_RPC: ZEBRA, CONFIG_FILE: cfgFile, ZW_REPO: REPO },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));
const stopServer = () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} };
process.on("exit", stopServer);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/__ctl/config`)).ok) break; } catch {}
  await sleep(500);
}

const browser = await chromium.launch({ headless: true });
const consoleLines = [];
let run;
const t0 = Date.now();
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (consoleLines.length < 6000) consoleLines.push(`[${m.type()}] ${m.text().slice(0, 400)}`); });
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 600)}`));
  await page.goto(`http://127.0.0.1:${PORT}/regtest.html`);
  while (Date.now() - t0 < 75 * 60 * 1000) {
    run = await page.evaluate(() => window.__run).catch(() => undefined);
    if (run?.finished) break;
    await sleep(3000);
  }
} finally {
  await browser.close();
  stopServer();
}
const pageSeconds = Math.round((Date.now() - t0) / 1000);

// ---- 4. every produced transaction, from the chain, through the NEW helper ----
const ufvks = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.ufvk]));
const decodeSummary = (v) => ({
  version: v.version, versiongroupid: v.versiongroupid, height: v.height, expiryheight: v.expiryheight,
  vin: (v.vin ?? []).map((i) => (i.coinbase ? "coinbase" : `${i.txid?.slice(0, 16)}…:${i.vout}`)),
  vout: (v.vout ?? []).map((o) => ({ valueZat: o.valueZat, addresses: o.scriptPubKey?.addresses })),
  saplingSpends: (v.vShieldedSpend ?? []).length, saplingOutputs: (v.vShieldedOutput ?? []).length, valueBalanceZat: v.valueBalanceZat,
  orchard: v.orchard ? { actions: (v.orchard.actions ?? []).length, valueBalanceZat: v.orchard.valueBalanceZat } : null,
  ironwood: v.ironwood ? { actions: (v.ironwood.actions ?? []).length, valueBalanceZat: v.ironwood.valueBalanceZat } : null,
});
const tx = {};
const report = [];
for (const [name, txid] of Object.entries(run?.txs ?? {})) {
  if (!txid) continue;
  try {
    const hex = await rpc("getrawtransaction", [txid, 0]);
    const verbose = await rpc("getrawtransaction", [txid, 1]);
    const height = verbose.height ?? tipAtStart;
    const shape = helper.inspectTransaction(hex, height, "regtest");
    const decrypted = Object.fromEntries(Object.entries(ufvks).map(([k, u]) => [k, helper.decryptTransaction(hex, height, "regtest", u)]));
    tx[name] = { name, txid, height, rawTxHex: hex, shape, decrypted, zebrad: decodeSummary(verbose) };
    report.push({ name, txid, height, shape, zebrad: decodeSummary(verbose), decrypted });
  } catch (e) {
    report.push({ name, txid, error: String(e) });
  }
}
const helperChecks = [];
const hcheck = (name, cond, data) => { helperChecks.push({ name: `check:helper-${name}`, pass: !!cond, ...(data ?? {}) }); };
const pick = (o) => ({ pool: o.pool, valueZat: o.valueZat, memoText: o.memoText, incoming: o.incoming });
const dec = (name, who) => tx[name]?.decrypted?.[who] ?? null;
const feeNonce = run?.feeNonce;
try {
  hcheck("build-info-stage2", /Stage 2/.test(helper.buildInfo()) && /0a2c6d1ae6274e6af2291e312f7b7459516882f2/.test(helper.buildInfo()), { buildInfo: helper.buildInfo() });
  const all = Object.values(tx);
  hcheck("every-tx-v6-nu63-no-orchard", all.length >= 15 && all.every((t) => t.shape.version === "V6" && t.shape.consensusBranchId === "37a5165b" && !t.shape.hasOrchardBundle && !t.shape.hasSproutBundle && t.shape.txid === t.txid),
    { count: all.length, shapes: Object.fromEntries(all.map((t) => [t.name, `${t.shape.version} ${t.shape.consensusBranchId} t${t.shape.transparentInputs}/${t.shape.transparentOutputs} s${t.shape.saplingSpends}/${t.shape.saplingOutputs} iw${t.shape.ironwoodActions}`])) });
  hcheck("fee-output-is-ironwood-and-only-it-decrypts", same(dec("ironwoodPayment", "PROJECT")?.map(pick), [{ pool: "ironwood", valueZat: 75000, memoText: `zw-fee:v1:${feeNonce}`, incoming: true }])
    && dec("ironwoodPayment", "PROJECT")[0].transferType === "incoming", { project: dec("ironwoodPayment", "PROJECT")?.map(pick) });
  hcheck("recipient-output-invisible-to-project", same(dec("ironwoodPayment", "A")?.filter((o) => o.incoming).map(pick), [{ pool: "ironwood", valueZat: 100000, memoText: "zw-pay:v1:hello A, from B (regtest)", incoming: true }])
    && !dec("ironwoodPayment", "PROJECT").some((o) => o.valueZat === 100000), { a: dec("ironwoodPayment", "A")?.map(pick) });
  hcheck("payer-sees-outgoing-and-change", (() => { const b = dec("ironwoodPayment", "B") ?? []; return b.some((o) => o.transferType === "outgoing" && o.valueZat === 100000) && b.some((o) => o.transferType === "outgoing" && o.valueZat === 75000) && b.some((o) => o.transferType === "internal" && o.pool === "ironwood") && b.every((o) => !o.incoming); })());
  hcheck("stage1-registry-address-fee-output-is-sapling", same(dec("paymentSaplingFee", "PROJECT")?.map(pick), [{ pool: "sapling", valueZat: 75000, memoText: `zw-fee:v1:${feeNonce}-s`, incoming: true }]), { project: dec("paymentSaplingFee", "PROJECT")?.map(pick) });
  hcheck("name-fee-is-ironwood", same(dec("nameFee", "PROJECT")?.map(pick), [{ pool: "ironwood", valueZat: 75000, memoText: run?.nameMemo, incoming: true }]), { project: dec("nameFee", "PROJECT")?.map(pick) });
  hcheck("orchard-only-ua-payment-is-ironwood", same(dec("orchardOnlyUa", "PROJECT")?.map(pick), [{ pool: "ironwood", valueZat: 20000, memoText: "zw-pay:v1:orchard-only u1", incoming: true }]));
  const notProject = ["shield", "ironwoodToSapling", "saplingToIronwood", "withdrawalT", "texStep1", "texStep2", "legacyPayment", "toStage1Player", "restoredShield", "restoredPayment", "smallShield"];
  hcheck("project-key-sees-nothing-else", notProject.every((n) => tx[n] && same(dec(n, "PROJECT"), [])), { missing: notProject.filter((n) => !tx[n]) });
  hcheck("tex-pair", tx.texStep2?.shape.transparentInputs === 1 && tx.texStep2?.shape.transparentOutputs === 1 && !tx.texStep2?.shape.hasIronwoodBundle && tx.texStep2?.shape.saplingSpends === 0 && tx.texStep1?.shape.transparentOutputs === 1 && tx.texStep1?.height === tx.texStep2?.height);
  hcheck("shield-is-internal-ironwood", tx.shield?.shape.transparentInputs === 3 && (dec("shield", "A") ?? []).length > 0 && dec("shield", "A").every((o) => o.pool === "ironwood" && o.transferType === "internal"));
  hcheck("stage1-player-receives-sapling-with-memo", same(dec("toStage1Player", "D")?.map(pick), [{ pool: "sapling", valueZat: 300000, memoText: "zw-pay:v1:to a Stage-1 player", incoming: true }]) && tx.toStage1Player?.shape.transparentOutputs === 1,
    { d: dec("toStage1Player", "D")?.map(pick) });
  // The payer's own key sees only its internal change here: with Sapling-only inputs, upstream's select_ovk() encrypts
  // every output (the Ironwood one too) to the SAPLING outgoing key, which the Orchard-family trial decryption of the
  // Ironwood bundle does not try (zcash_keys UnifiedFullViewingKey::select_ovk at 0a2c6d1a).
  hcheck("restored-wallet-spent-its-stage1-sapling-note", tx.restoredPayment?.shape.saplingSpends >= 1 && same(dec("restoredPayment", "A")?.filter((o) => o.incoming).map(pick), [{ pool: "ironwood", valueZat: 200000, memoText: run?.restoredMemo, incoming: true }])
    && (dec("restoredPayment", "D") ?? []).length > 0 && dec("restoredPayment", "D").every((o) => o.transferType === "internal" && o.pool === "ironwood"), { shape: tx.restoredPayment?.shape, d: dec("restoredPayment", "D")?.map(pick) });
  const recv = (a) => [...helper.describeAddress(a).receivers].sort().join("+");
  const addrs = run?.addresses ?? {};
  hcheck("describe-engine-addresses", Object.keys(addrs).length === 4 && Object.values(addrs).every((a) => recv(a.unified) === "orchard+p2pkh+sapling" && recv(a.unifiedShielded) === "orchard+sapling" && recv(a.unifiedSaplingTransparent) === "p2pkh+sapling"
    && helper.describeAddress(a.unified).network === "regtest"), { A: addrs.A ? { unified: recv(addrs.A.unified), unifiedShielded: recv(addrs.A.unifiedShielded) } : null });
  const p = helper.addressesFromUfvk(keys.PROJECT.ufvk, "regtest");
  hcheck("project-ufvk-gives-the-engine-addresses", addrs.P && p.unifiedAddress === addrs.P.unified && p.unifiedShieldedAddress === addrs.P.unifiedShielded && p.unifiedSaplingTransparentAddress === addrs.P.unifiedSaplingTransparent && p.saplingAddress === addrs.P.sapling && p.transparentAddress === addrs.P.transparent);
} catch (e) {
  hcheck("runner", false, { error: String(e?.stack ?? e).slice(0, 600) });
}

// ---- 5. run record ----
const pageChecks = (run?.steps ?? []).filter((s) => s.name.startsWith("check:"));
const allChecks = [...pageChecks, ...helperChecks];
const passed = allChecks.filter((c) => c.pass).length;
const errorStep = (run?.steps ?? []).find((s) => s.name === "error");
const result = { at: new Date().toISOString(), pageSeconds, engine: PKG, stage1Engine: PKG1, helper: helper.buildInfo(), tipAtStart, passed, total: allChecks.length, pageFinished: !!run?.finished, pageError: errorStep ?? null, helperChecks, run };
writeFileSync(`${OUT}/regtest-run.json`, JSON.stringify(result, null, 1));
writeFileSync(`${OUT}/regtest-console.txt`, consoleLines.filter((l) => !/seed/i.test(l)).join("\n"));
writeFileSync(`${OUT}/regtest-server.log`, serverLog.join(""));
writeFileSync(`${OUT}/regtest-txs-decoded.json`, JSON.stringify(report, null, 1));
const fixtures = {
  note: "REGTEST ONLY. Real transactions produced by the Stage-2 engine (reproducible build, regtest twin) on a local zebrad 6.4.2 regtest chain (every upgrade through NU6.3 at height 1), fetched from zebrad. Keys are regtest test keys (D = seed C, account 3: the Stage-1 player).",
  network: "regtest", consensusBranchId: "37a5165b", ufvks, addresses: { ...(run?.addresses ?? {}), D: { unified: keys.D.unifiedAddress, unifiedShielded: keys.D.unifiedShieldedAddress, unifiedSaplingTransparent: keys.D.unifiedSaplingTransparentAddress, sapling: keys.D.saplingAddress, transparent: keys.D.transparentAddress } },
  feeNonce, nameMemo: run?.nameMemo, restoredMemo: run?.restoredMemo,
  txs: Object.values(tx).map((t) => ({ name: t.name, txid: t.txid, height: t.height, rawTxHex: t.rawTxHex, shape: t.shape, decrypted: t.decrypted })),
};
mkdirSync(new URL(".", `file://${FIXTURES}`).pathname, { recursive: true });
writeFileSync(FIXTURES, JSON.stringify(fixtures, null, 1));
try { (await import("node:fs")).rmSync(cfgFile, { force: true }); } catch {}
console.log(`[run] page finished=${run?.finished} in ${pageSeconds}s; ${passed}/${allChecks.length} checks (${pageChecks.filter((c) => c.pass).length}/${pageChecks.length} page + ${helperChecks.filter((c) => c.pass).length}/${helperChecks.length} helper)`);
for (const s of [...(run?.steps ?? []), ...helperChecks]) if (s.name.startsWith("check:") || s.name === "error") console.log(`  ${s.pass === false || s.name === "error" ? "FAIL" : "ok  "} ${s.name}${s.pass === false || s.name === "error" ? " " + JSON.stringify(s).slice(0, 500) : ""}`);
for (const t of report) {
  if (t.error) { console.log(`[tx] ${t.name} ${t.txid} ERROR ${t.error}`); continue; }
  const z = t.zebrad;
  console.log(`[tx] ${t.name} ${t.txid.slice(0, 16)}… h=${t.height} v${z.version} branch=${t.shape.consensusBranchId} vin=${z.vin.length} vout=${z.vout.length} sSp=${z.saplingSpends} sOut=${z.saplingOutputs} orch=${z.orchard?.actions ?? 0} iw=${z.ironwood?.actions ?? 0} project=${JSON.stringify(t.decrypted.PROJECT.map((o) => [o.pool, o.valueZat, o.memoText, o.transferType]))}`);
}
process.exit(passed === allChecks.length && run?.ok ? 0 : 1);
