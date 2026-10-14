// Stage 2: the GAME SERVER's own fee and name checks, end to end on the local NU6.3 regtest chain
// (TESTING ONLY), against real payments made by the Stage-2 (Ironwood) engine's regtest twin. Same flow as the Stage 1
// check:
//   * the game server runs READ-ONLY from the repository (apps/server/src/index.ts, through tsx, as `npm start` does)
//     with NAME_REGISTRY=lightwalletd and the transfer fee (PAYMENT_FEE_ZEC), reading reported transactions from the
//     local lightwalletd and decrypting them with the regtest PROJECT viewing key through its vendored helper
//     (vendor/zcash-tx-decrypt, zw-tx-decrypt 0.2);
//   * two players (Alice, Bob) speak the game protocol over WebSocket; their wallets (server-checks.html, headless
//     Chromium) pay through the game's bridge. Checks: name_reserve -> name_quote -> pay -> name_payment_sent ->
//     confirmed + nickname_updated; pay_request -> pay_accept WITH a fee quote -> ONE transaction (recipient + fee
//     output) -> pay_sent -> mined -> the next request is relayed; a control payment WITHOUT the fee output -> fee_unpaid.
// MODE (argv[3]):
//   sapling-registry     the registry/fee address is PROJECT's zs1: the Ironwood-funded wallet pays SAPLING fee outputs
//                        (from Ironwood notes).
//   full-ua-registry     the registry/fee address is PROJECT's FULL unified address (what scripts/tools/
//                        registry-keys.mjs prints): the wallet pays IRONWOOD fee outputs, which the server
//                        counts (shieldedPayments.ts projectNotes accepts pool "ironwood").
// Needs: the local chain (chain/reset.sh) with funded A (run run-regtest.mjs first) and a built Stage-2 regtest package.
// Usage: node run-server-checks.mjs <regtestPkgDir> <mode> [outFile]
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = process.env.ZW_REPO ?? new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const { chromium } = await import(`${REPO}/node_modules/playwright/index.mjs`);
const PKG = process.argv[2];
const MODE = process.argv[3] ?? "sapling-registry";
const OUT_FILE = process.argv[4] ?? `${HERE}../work/harness/server-checks-${MODE}.json`;
const HELPER = process.env.HELPER ?? `${REPO}/vendor/zcash-tx-decrypt/zw_tx_decrypt.js`;
const ZEBRA = process.env.ZEBRA_RPC ?? "http://127.0.0.1:18932";
const LWD = process.env.LIGHTWALLETD_URL ?? "http://127.0.0.1:9667";
const GAME_PORT = Number(process.env.GAME_PORT ?? 8872), PAGE_PORT = Number(process.env.PAGE_PORT ?? 8874);
const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;
const require = createRequire(import.meta.url);
const WebSocket = require(`${REPO}/node_modules/ws`);
const helper = require(HELPER);
const killGroup = (child) => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!PKG || !["sapling-registry", "full-ua-registry"].includes(MODE)) {
  console.error("usage: node run-server-checks.mjs <regtestPkgDir> <sapling-registry|full-ua-registry> [outFile]");
  process.exit(2);
}
const ACCEPTS_IRONWOOD = true; // the server counts Sapling AND Ironwood fee outputs
const EXPECT_POOL = MODE === "sapling-registry" ? "sapling" : "ironwood";

// Shared memo builders — the same code the client uses (packages/shared).
const shared = await import(`${REPO}/packages/shared/src/multiplayer-protocol.ts`).catch(() => null);
const buildPayFeeMemo = shared?.buildPayFeeMemo ?? ((nonce) => `zw-fee:v1:${nonce}`);

async function rpc(method, params = []) {
  const r = await fetch(ZEBRA, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function generate(n) { for (let i = 0; i < 60; i++) { try { return await rpc("generate", [n]); } catch { await sleep(1000); } } throw new Error("generate failed"); }

const report = { at: new Date().toISOString(), mode: MODE, helper: helper.buildInfo(), checks: [], steps: [] };
const check = (name, pass, data) => { report.checks.push({ name: `${MODE}: ${name}`, pass: !!pass, ...(data ?? {}) }); console.log(`${pass ? "PASS" : "FAIL"} ${MODE}: ${name} ${data ? JSON.stringify(data).slice(0, 260) : ""}`); };
const step = (name, data) => report.steps.push({ name, t: new Date().toISOString(), ...(data ?? {}) });

// ---- keys (regtest test keys only) ----
const seeds = JSON.parse(readFileSync(`${REPO}/scripts/wallet-engine/fixtures/regtest-seeds.json`, "utf8")).seeds;
const keys = Object.fromEntries(Object.entries(seeds).map(([k, s]) => [k, helper.registryKeysFromSeed(s, "regtest", 0)]));
const REGISTRY = MODE === "sapling-registry" ? keys.PROJECT.saplingAddress : keys.PROJECT.unifiedAddress;
report.registryAddress = { kind: MODE === "sapling-registry" ? "PROJECT saplingAddress (zs)" : "PROJECT unifiedAddress (full UA)", receivers: helper.describeAddress(REGISTRY).receivers };
const scratch = `${HERE}.server-checks-${MODE}`;
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const cfgFile = `${scratch}/config.json`; // regtest test seeds only; deleted at the end
writeFileSync(cfgFile, JSON.stringify({ seeds: { A: seeds.A, B: seeds.B } }));

// ---- servers ----
const logs = { game: [], harness: [] };
const nodeArgs = ["--import", "tsx", "src/index.ts"];
const game = spawn(process.execPath, nodeArgs, {
  cwd: `${REPO}/apps/server`,
  env: {
    ...process.env,
    PORT: String(GAME_PORT), HOST: "127.0.0.1", ZCASH_NETWORK: "test", LIGHTWALLETD_URL: LWD, ALLOWED_ORIGINS: PAGE_ORIGIN, ZCASHD_RPC_URL: "",
    NAME_REGISTRY: "lightwalletd", NAME_REGISTRY_ADDRESS: REGISTRY, NAME_REGISTRY_UFVK: keys.PROJECT.ufvk, NAME_FEE_ZEC: "0.00075", NAME_MIN_CONF: "1",
    NAME_REGISTRY_FILE: `${scratch}/names.json`,
    PAYMENT_FEE_ZEC: "0.00075", PAYMENT_MIN_CONF: "1",
  },
  stdio: ["ignore", "pipe", "pipe"], detached: true,
});
game.stdout.on("data", (d) => logs.game.push(String(d)));
game.stderr.on("data", (d) => logs.game.push(String(d)));
const harness = spawn("npx", ["tsx", `${HERE}server.mts`], {
  cwd: `${REPO}/apps/server`,
  env: { ...process.env, PORT: String(PAGE_PORT), PKG_DIR: PKG, PAGE: "server-checks.html", LIGHTWALLETD_URL: LWD, ZEBRA_RPC: ZEBRA, CONFIG_FILE: cfgFile, ZW_REPO: REPO },
  stdio: ["ignore", "pipe", "pipe"], detached: true,
});
harness.stdout.on("data", (d) => logs.harness.push(String(d)));
harness.stderr.on("data", (d) => logs.harness.push(String(d)));
const up = async (url) => { for (let i = 0; i < 120; i++) { try { await fetch(url); return true; } catch {} await sleep(500); } return false; };

/** A game client over WebSocket: join as a wallet holder, collect every message. */
function player(nickname) {
  const ws = new WebSocket(`ws://127.0.0.1:${GAME_PORT}`, { headers: { origin: PAGE_ORIGIN } });
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    inbox.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  const next = (match, timeoutMs = 120_000, label = "message") => {
    const found = inbox.find(match);
    if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (m) => { clearTimeout(timer); inbox.splice(inbox.indexOf(m), 1); resolve(m); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out waiting for ${label}`)); }, timeoutMs);
      waiters.push(w);
    });
  };
  const opened = new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  opened.catch(() => undefined);
  ws.on("error", () => undefined);
  const beat = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "heartbeat" })); }, 5_000);
  ws.on("close", () => clearInterval(beat));
  return {
    ws, inbox, next,
    async join() {
      await opened;
      ws.send(JSON.stringify({ type: "join", nickname, wallet: true }));
      const welcome = await next((m) => m.type === "welcome", 30_000, "welcome");
      this.id = welcome.playerId;
      return welcome;
    },
    send(msg) { ws.send(JSON.stringify(msg)); },
    close() { clearInterval(beat); try { ws.close(); } catch {} },
  };
}

let browser;
let alice = null;
let bob = null;
try {
  check("game server up (repository source, read-only, vendored zw-tx-decrypt 0.2)", await up(`http://127.0.0.1:${GAME_PORT}/zcash/info`));
  check("harness up", await up(`${PAGE_ORIGIN}/`));
  const info = await (await fetch(`http://127.0.0.1:${GAME_PORT}/zcash/info`)).json();
  const startup = logs.game.join("");
  check("startup: fee-confirmed names (lightwalletd backend) and the transfer fee are on",
    info.names?.mode === "fee" && info.names?.feeZat === 75_000 && info.payments?.feeZat === 75_000 && info.network === "test" && /name registry: lightwalletd/.test(startup) && /transfer fee: 0\.00075/.test(startup),
    { names: info.names, payments: info.payments, lines: startup.split("\n").filter((l) => /name registry|transfer fee|preload/.test(l)).map((l) => l.trim().replace(/\/tmp\/\S+/g, "<path>")) });
  alice = player("Alice");
  bob = player("Bob");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on("console", (m) => { if (consoleLines.length < 500) consoleLines.push(m.text().slice(0, 200)); });
  await page.goto(`${PAGE_ORIGIN}/`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
  const call = async (fn, ...args) => {
    const r = await page.evaluate(([f, a]) => window.zw[f](...a), [fn, args]);
    step(`zw.${fn}`, { ms: r.ms, error: r.error ?? null });
    if (r.error) throw Object.assign(new Error(`${fn}: ${r.error.code ?? ""} ${r.error.message}`), { code: r.error.code });
    return r.result;
  };
  await call("init");
  await call("open", "A", 2);
  await call("open", "B", 2);
  await call("sync", "A");
  await call("sync", "B");
  const balA0 = await call("balances", "A");
  const addrB = await call("addresses", "B");
  check("Alice's Stage-2 wallet has shielded (Ironwood) funds to pay with", balA0.shieldedSpendableZat > 400_000 && balA0.ironwoodSpendableZat > 400_000, { ironwoodSpendableZat: balA0.ironwoodSpendableZat, saplingSpendableZat: balA0.saplingSpendableZat });
  const status = await call("status", "A");
  check("sending allowed on the local NU6.3 chain", status.allowed === true && status.chainBranch === "37a5165b");
  const mineAndWait = async (n) => {
    const hashes = await generate(n);
    const tip = await rpc("getblockcount");
    await sleep(4000); // lightwalletd ingests the block
    return { tip, hashes: hashes.length };
  };
  const decryptFor = async (txid) => helper.decryptTransaction(await rpc("getrawtransaction", [txid, 0]), (await rpc("getrawtransaction", [txid, 1])).height ?? (await rpc("getblockcount")) + 1, "regtest", keys.PROJECT.ufvk);

  await alice.join();
  await bob.join();
  check("both players joined as wallet holders", Boolean(alice.id && bob.id));

  // ---------------------------------------------------------------- 1. the name fee (ADR-018 § 5)
  const name = `Iw${randomBytes(3).toString("hex")}`;
  const keyHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  alice.send({ type: "name_reserve", nickname: name, keyHash });
  const quote = await alice.next((m) => m.type === "name_quote" || (m.type === "name_status" && !m.reservationId), 30_000, "name_quote");
  check("name_reserve -> name_quote: the configured registry address, the advertised fee, the memo bound to the key", quote.type === "name_quote" && quote.amountZat === 75_000 && quote.address === REGISTRY && quote.memo.endsWith(keyHash.slice(0, 16)), { type: quote.type, amountZat: quote.amountZat, memo: quote.memo });
  const nameTx = await call("send", "A", [{ to: quote.address, amountZat: quote.amountZat, memo: quote.memo }]);
  const nameTxid = nameTx.txids[0];
  check(`the Stage-2 wallet paid the quote in one transaction, as a ${EXPECT_POOL.toUpperCase()} output`, typeof nameTxid === "string" && nameTx.txids.length === 1 && nameTx.outputs?.[0]?.pool === EXPECT_POOL, { feeZat: nameTx.feeZat, outputs: nameTx.outputs });
  alice.send({ type: "name_payment_sent", reservationId: quote.reservationId, txid: nameTxid });
  step("mined", await mineAndWait(1));
  const nameSeen = await decryptFor(nameTxid);
  check(`zw-tx-decrypt 0.2 reads the name fee as ${EXPECT_POOL} (75,000 zat, the quoted memo)`, nameSeen.length === 1 && nameSeen[0].pool === EXPECT_POOL && nameSeen[0].valueZat === 75_000 && nameSeen[0].memoText === quote.memo && nameSeen[0].incoming, { project: nameSeen.map((o) => ({ pool: o.pool, valueZat: o.valueZat, memoText: o.memoText })) });
  if (ACCEPTS_IRONWOOD) {
    const confirmed = await alice.next((m) => m.type === "name_status" && m.reservationId === quote.reservationId && (m.status === "confirmed" || m.status === "expired"), 120_000, "name_status confirmed");
    check("name_payment_sent -> the server fetched, decrypted and confirmed the name fee (1 confirmation)", confirmed.status === "confirmed", { status: confirmed.status, nickname: confirmed.nickname });
    const renamed = await bob.next((m) => m.type === "nickname_updated" && m.playerId === alice.id, 30_000, "nickname_updated");
    check("everyone sees the owned name (nickname_updated)", renamed.nickname === name, { nickname: renamed.nickname });
  } else {
    // Today's server: projectNotes() keeps Sapling notes only, so the Ironwood name fee is never counted.
    const outcome = await alice.next((m) => m.type === "name_status" && m.reservationId === quote.reservationId && (m.status === "confirmed" || m.status === "seen"), 45_000, "name_status").then((m) => m.status).catch(() => "none");
    check("unchanged server (Stage-1 policy: Sapling notes only): the Ironwood name fee is NOT counted — no seen/confirmed within 45 s (> 4 polls)", outcome === "none", { outcome });
  }

  // ---------------------------------------------------------------- 2. a payment with its fee output (ADR-018 § 6)
  const KEY = randomBytes(65).toString("base64");
  const pay = async (requestId, withFee) => {
    alice.send({ type: "pay_request", to: bob.id, requestId, senderKey: KEY });
    await bob.next((m) => m.type === "pay_request" && m.requestId === requestId, 30_000, "pay_request relay");
    bob.send({ type: "pay_accept", requestId, recipientKey: KEY, sealed: randomBytes(200).toString("base64"), iv: randomBytes(12).toString("base64") });
    const accepted = await alice.next((m) => m.type === "pay_accept" && m.requestId === requestId, 30_000, "pay_accept relay");
    // The recipient seals its shielded unified address (Orchard-family + Sapling): an Ironwood output.
    const outputs = [{ to: addrB.unifiedShielded, amountZat: 100_000, memo: "zw-pay:v1:server check (Stage 2)" }];
    if (withFee) outputs.push({ to: accepted.fee.address, amountZat: accepted.fee.zat, memo: buildPayFeeMemo(accepted.fee.nonce) });
    const tx = await call("send", "A", outputs);
    alice.send({ type: "pay_sent", requestId, txid: tx.txids[0] });
    return { accepted, tx };
  };
  const p1 = await pay("req-srv-0001", true);
  check("the acceptance reached Alice WITH the server's fee quote (the registry address, 0.00075, a nonce)", p1.accepted.fee?.zat === 75_000 && p1.accepted.fee?.address === REGISTRY && /^[0-9a-f]{32}$/.test(p1.accepted.fee?.nonce ?? ""), { fee: p1.accepted.fee ? { zat: p1.accepted.fee.zat, nonce: p1.accepted.fee.nonce } : null });
  check(`ONE transaction paid Bob (Ironwood) and the project (${EXPECT_POOL})`, p1.tx.txids.length === 1 && p1.tx.outputs.length === 2 && p1.tx.outputs[0].pool === "ironwood" && p1.tx.outputs[1].pool === EXPECT_POOL, { outputs: p1.tx.outputs, feeZat: p1.tx.feeZat });
  const feeSeen = await decryptFor(p1.tx.txids[0]);
  check(`the project key decrypts the fee output (and only it) as ${EXPECT_POOL}`, feeSeen.length === 1 && feeSeen[0].pool === EXPECT_POOL && feeSeen[0].valueZat === 75_000 && feeSeen[0].memoText === buildPayFeeMemo(p1.accepted.fee.nonce) && feeSeen[0].incoming, { project: feeSeen.map((o) => ({ pool: o.pool, valueZat: o.valueZat, memoText: o.memoText })) });
  step("mined", await mineAndWait(1));
  await sleep(40_000); // > 2 fee-check polls (15 s)
  alice.send({ type: "pay_request", to: bob.id, requestId: "req-srv-0002", senderKey: KEY });
  const after = await Promise.race([
    bob.next((m) => m.type === "pay_request" && m.requestId === "req-srv-0002", 20_000, "relay").then((m) => ({ relayed: true, m })),
    alice.next((m) => m.type === "pay_error" && m.requestId === "req-srv-0002", 20_000, "pay_error").then((m) => ({ relayed: false, reason: m.reason })),
  ]);
  if (ACCEPTS_IRONWOOD) {
    check(`fee verified on chain (${EXPECT_POOL} fee output): Alice's next request is relayed (no fee_unpaid)`, after.relayed === true, { result: after.relayed ? "relayed" : after.reason });
    alice.send({ type: "pay_cancel", requestId: "req-srv-0002" });
    // ---------------------------------------------------------------- 3. control: a payment WITHOUT the fee output
    const p3 = await pay("req-srv-0003", false);
    check("control: the transaction paid Bob only (no fee output)", p3.tx.outputs.length === 1, { outputs: p3.tx.outputs });
    step("mined", await mineAndWait(1));
    await sleep(40_000);
    alice.send({ type: "pay_request", to: bob.id, requestId: "req-srv-0004", senderKey: KEY });
    const refused = await Promise.race([
      alice.next((m) => m.type === "pay_error" && m.requestId === "req-srv-0004", 20_000, "pay_error").then((m) => ({ refused: true, reason: m.reason })),
      bob.next((m) => m.type === "pay_request" && m.requestId === "req-srv-0004", 20_000, "relay").then(() => ({ refused: false })),
    ]);
    check("control: mined without the fee output -> the server refuses the next request with fee_unpaid", refused.refused === true && refused.reason === "fee_unpaid", refused);
  } else {
    check("unchanged server (Stage-1 policy): the Ironwood fee output is NOT counted — the next request is refused with fee_unpaid (the server must accept pool \"ironwood\")", after.relayed === false && after.reason === "fee_unpaid", { result: after.relayed ? "relayed" : after.reason });
  }
  report.console = consoleLines.filter((l) => /error|panic/i.test(l)).slice(0, 20);
} catch (e) {
  check("runner", false, { error: String(e?.stack ?? e).slice(0, 800) });
} finally {
  alice?.close();
  bob?.close();
  await browser?.close();
  killGroup(game);
  killGroup(harness);
  rmSync(scratch, { recursive: true, force: true });
  report.serverLog = logs.game.join("").split("\n").filter((l) => /\[server\]|error|fee|name|preload/i.test(l)).map((l) => l.replace(/(u|z)regtest[0-9a-z]{20,}/g, "<regtest address>").replace(/uview[0-9a-z]{20,}/g, "<viewing key>").replace(/\/tmp\/\S+/g, "<path>")).slice(0, 40);
  report.passed = report.checks.filter((c) => c.pass).length;
  report.total = report.checks.length;
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`${report.passed}/${report.total} checks passed (${MODE}) -> ${OUT_FILE}`);
  process.exit(report.passed === report.total ? 0 : 1);
}
