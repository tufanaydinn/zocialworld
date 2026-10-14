// Stage 2 verification server (TESTING ONLY). The game's bridge is loaded from the repository by
// absolute path (ZW_REPO); a second package directory PKG2_DIR is served at /pkg2/ (the Stage-1
// engine, for the same-page benchmark and for a real Stage-1 save).
// Serves a built WebZjs package + a test page with cross-origin isolation headers, and mounts the
// game's own grpc-web -> lightwalletd bridge (apps/server/src/zcash/lwdProxy.ts, loaded
// from this repository) at /zcash/lwd/.
//
// Regtest extras (only when ZEBRA_RPC is set):
//   POST /__ctl/mine?n=N            mine N blocks on the local zebrad (regtest `generate`)
//   POST /__ctl/lightd?branch=HEX&upgradeName=NAME&upgradeHeight=H | ?clear=1
//        make the bridge answer GetLightdInfo with a forged consensusBranchId / pending upgrade
//        (to exercise the wallet's consensus_branch_mismatch / consensus_upgrade_pending guard)
//   GET  /__ctl/config              the JSON file in CONFIG_FILE (regtest test keys/addresses)
//
// Usage: PORT=8841 LIGHTWALLETD_URL=http://127.0.0.1:9367 PKG_DIR=... PAGE=regtest.html \
//        ZEBRA_RPC=http://127.0.0.1:18632 CONFIG_FILE=... npx tsx server.mts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import http2 from "node:http2";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const REPO = process.env.ZW_REPO ?? new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const { createLightwalletdProxy, encodeTrailerFrame } = await import(`${REPO}/apps/server/src/zcash/lwdProxy.ts`);

const PORT = Number(process.env.PORT ?? 8841);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const UPSTREAM = process.env.LIGHTWALLETD_URL ?? "http://127.0.0.1:9367";
const PKG_DIR = process.env.PKG_DIR!;
const PKG2_DIR = process.env.PKG2_DIR ?? "";
const PAGE = process.env.PAGE ?? "regtest.html";
const ZEBRA_RPC = process.env.ZEBRA_RPC ?? "";
const CONFIG_FILE = process.env.CONFIG_FILE ?? "";
const PAGE_DIR = new URL(".", import.meta.url).pathname;
const EXTRA_ORIGINS = (process.env.EXTRA_ORIGINS ?? "").split(",").filter(Boolean);

const lwd = createLightwalletdProxy({ allowedOrigins: [ORIGIN, `http://localhost:${PORT}`, ...EXTRA_ORIGINS], upstream: UPSTREAM });
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

// ---- forged GetLightdInfo (regtest only) -------------------------------------------------------
let lightdOverride: { branch?: string; upgradeName?: string; upgradeHeight?: number } | null = null;

/**
 * Injected bridge failures, per gRPC method (TESTING ONLY).
 *  - `busy`: answered at once with grpc-status 8 "bridge busy" (what lwdProxy.ts says at its stream cap) — the call
 *    never reaches lightwalletd;
 *  - `lost`: forwarded to lightwalletd, which answers, but the browser gets grpc-status 14 instead (a response lost
 *    after the server accepted the call).
 * `skip` lets that many calls through first; `count` calls then fail.
 */
const faults = new Map<string, { mode: "busy" | "lost"; skip: number; count: number }>();
const SERVICE_PATH = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/";

function failHeaders(origin: string | undefined, status: number, message: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/grpc-web+proto", "grpc-status": String(status), "grpc-message": message };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Expose-Headers"] = "grpc-status, grpc-message";
  }
  return headers;
}

/** `lost`: the call reaches lightwalletd (its answer is read and dropped); the browser sees a transport failure. */
async function forwardAndLose(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const client = http2.connect(UPSTREAM);
  const upstream = client.request({ ":method": "POST", ":path": `${SERVICE_PATH}${method}`, "content-type": "application/grpc+proto", te: "trailers" });
  upstream.end(Buffer.concat(chunks));
  upstream.on("data", () => undefined);
  await new Promise((resolve) => {
    upstream.on("end", resolve);
    upstream.on("error", resolve);
  });
  client.close();
  res.writeHead(200, failHeaders(req.headers.origin, 14, "lightwalletd stream failed")).end();
  console.log(`[ctl] ${method}: forwarded, answer dropped (fault "lost")`);
}

function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n, shift = 0n;
  for (;;) {
    const b = buf[pos++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
}
function writeVarint(v: bigint): Buffer {
  const out: number[] = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; out.push(b); } while (v > 0n);
  return Buffer.from(out);
}
/** Rewrites LightdInfo fields 6 (consensusBranchId), 16 (upgradeName), 17 (upgradeHeight). */
function rewriteLightdInfo(msg: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  const repl = new Set<number>();
  if (lightdOverride?.branch) repl.add(6);
  if (lightdOverride?.upgradeName) { repl.add(16); repl.add(17); }
  while (pos < msg.length) {
    const start = pos;
    const [key, p1] = readVarint(msg, pos);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    pos = p1;
    if (wire === 0) { pos = readVarint(msg, pos)[1]; }
    else if (wire === 2) { const [len, p2] = readVarint(msg, pos); pos = p2 + Number(len); }
    else throw new Error(`unexpected wire type ${wire}`);
    if (!repl.has(field)) parts.push(msg.subarray(start, pos));
  }
  const str = (field: number, s: string) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([writeVarint(BigInt((field << 3) | 2)), writeVarint(BigInt(b.length)), b]); };
  const u64 = (field: number, v: number) => Buffer.concat([writeVarint(BigInt(field << 3)), writeVarint(BigInt(v))]);
  if (lightdOverride?.branch) parts.push(str(6, lightdOverride.branch));
  if (lightdOverride?.upgradeName) { parts.push(str(16, lightdOverride.upgradeName)); parts.push(u64(17, lightdOverride.upgradeHeight ?? 0)); }
  return Buffer.concat(parts);
}
async function forgedLightdInfo(res: ServerResponse, origin: string | undefined): Promise<void> {
  const client = http2.connect(UPSTREAM);
  const req = client.request({ ":method": "POST", ":path": "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo", "content-type": "application/grpc+proto", te: "trailers" });
  req.end(Buffer.from([0, 0, 0, 0, 0]));
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  await new Promise((r) => req.on("end", r));
  client.close();
  const body = Buffer.concat(chunks);
  const msg = rewriteLightdInfo(body.subarray(5, 5 + body.readUInt32BE(1)));
  const frame = Buffer.alloc(5); frame.writeUInt32BE(msg.length, 1);
  const headers: Record<string, string> = { "Content-Type": "application/grpc-web+proto" };
  if (origin) { headers["Access-Control-Allow-Origin"] = origin; headers["Access-Control-Expose-Headers"] = "grpc-status, grpc-message"; }
  res.writeHead(200, headers);
  res.end(Buffer.concat([frame, msg, encodeTrailerFrame({ "grpc-status": "0", "grpc-message": "" })]));
  console.log(`[ctl] answered GetLightdInfo with override ${JSON.stringify(lightdOverride)}`);
}

async function zebra(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(ZEBRA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function control(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const json = (code: number, v: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
  try {
    if (url.pathname === "/__ctl/mine" && req.method === "POST") {
      const n = Math.max(1, Math.min(200, Number(url.searchParams.get("n") ?? 1)));
      const hashes = await zebra("generate", [n]);
      // give lightwalletd time to ingest the new tip
      const target = await zebra("getblockcount", []);
      return json(200, { mined: hashes.length, height: target });
    }
    if (url.pathname === "/__ctl/lightd" && req.method === "POST") {
      if (url.searchParams.get("clear")) lightdOverride = null;
      else lightdOverride = {
        branch: url.searchParams.get("branch") ?? undefined,
        upgradeName: url.searchParams.get("upgradeName") ?? undefined,
        upgradeHeight: url.searchParams.get("upgradeHeight") ? Number(url.searchParams.get("upgradeHeight")) : undefined,
      };
      console.log(`[ctl] lightd override = ${JSON.stringify(lightdOverride)}`);
      return json(200, { override: lightdOverride });
    }
    if (url.pathname === "/__ctl/fault" && req.method === "POST") {
      const method = url.searchParams.get("method") ?? "";
      if (url.searchParams.get("clear")) {
        if (method) faults.delete(method);
        else faults.clear();
      } else {
        const mode = url.searchParams.get("mode") === "lost" ? "lost" : "busy";
        faults.set(method, { mode, skip: Number(url.searchParams.get("skip") ?? 0), count: Number(url.searchParams.get("count") ?? 1) });
      }
      console.log(`[ctl] faults = ${JSON.stringify([...faults])}`);
      return json(200, { faults: Object.fromEntries(faults) });
    }
    if (url.pathname === "/__ctl/mempool") {
      return json(200, { txids: await zebra("getrawmempool", []) });
    }
    if (url.pathname === "/__ctl/config") {
      return json(200, CONFIG_FILE ? JSON.parse(await readFile(CONFIG_FILE, "utf8")) : {});
    }
    return json(404, { error: "unknown control endpoint" });
  } catch (e) {
    return json(500, { error: String(e) });
  }
}

let calls = 0;
createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const url = new URL(req.url ?? "/", ORIGIN);
  if (ZEBRA_RPC && url.pathname.startsWith("/__ctl/")) return void control(req, res, url);
  if (url.pathname.startsWith("/zcash/lwd/")) {
    calls++;
    const method = url.pathname.split("/").pop();
    const fault = method ? faults.get(method) : undefined;
    if (ZEBRA_RPC && fault && req.method === "POST") {
      if (fault.skip > 0) fault.skip--;
      else if (fault.count > 0) {
        fault.count--;
        if (fault.count === 0) faults.delete(method!);
        if (fault.mode === "lost") return void forwardAndLose(req, res, method!);
        req.resume();
        res.writeHead(200, failHeaders(req.headers.origin, 8, "bridge busy")).end();
        console.log(`[ctl] ${method}: answered "bridge busy" (fault)`);
        return;
      }
    }
    if (ZEBRA_RPC && lightdOverride && method === "GetLightdInfo" && req.method === "POST") {
      req.resume();
      return void forgedLightdInfo(res, req.headers.origin);
    }
    const t0 = Date.now();
    res.on("finish", () => { if (method !== "GetLightdInfo") console.log(`[lwd] ${method} ${res.statusCode} ${Date.now() - t0}ms`); });
  }
  if (lwd(req, res)) return;
  let path = url.pathname === "/" ? `/${PAGE}` : url.pathname;
  const base = path.startsWith("/pkg/") ? PKG_DIR : PKG2_DIR && path.startsWith("/pkg2/") ? PKG2_DIR : PAGE_DIR;
  if (path.startsWith("/pkg/")) path = path.slice(4);
  else if (base === PKG2_DIR && path.startsWith("/pkg2/")) path = path.slice(5);
  // wasm-bindgen-rayon / wasm_thread worker helpers import the package by its directory
  // (`../../..`), which a bundler resolves to package.json "main"; emulate that here.
  if ((base === PKG_DIR || base === PKG2_DIR) && path.endsWith("/")) path = "/webzjs_wallet.js";
  const file = normalize(join(base, path));
  if (!file.startsWith(normalize(base))) { res.writeHead(403).end(); return; }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[harness] ${ORIGIN} -> lwd ${UPSTREAM}; pkg ${PKG_DIR}; pkg2 ${PKG2_DIR || "-"}; page ${PAGE}`));
process.on("SIGTERM", () => { console.log(`[harness] lwd calls: ${calls}`); process.exit(0); });
