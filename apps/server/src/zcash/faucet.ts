import type { IncomingMessage, ServerResponse } from "node:http";
import { isOriginAllowed } from "../origin.js";

/**
 * Test-coin faucet for the project's own regtest chain.
 *
 * The chain's zcashd node holds the mined coinbase; a
 * claim sends a small amount straight to the player's SHIELDED address via
 * `z_sendmany`. Configured by env (absent → faucet disabled):
 *   ZCASHD_RPC_URL, ZCASHD_RPC_USER, ZCASHD_RPC_PASS, FAUCET_ZEC (default 1)
 *
 * Abuse limits: a claim needs a live game session (the owner-only session
 * capability from `welcome` — or, before join, the connection's pending name
 * reservation id, ADR-016), one claim per session per 10 minutes, one per
 * address per 24 hours, at most 20 claims per minute overall. Addresses are
 * kept only as an in-memory cooldown key and are never logged.
 */

export interface FaucetOptions {
  readonly allowedOrigins: readonly string[];
  /** Resolves the session capability to its playerId (null = not a live session). */
  readonly resolveSession: (capability: string) => string | null;
  readonly rpc?: RpcFn;
  readonly now?: () => number;
  readonly amountZec?: number;
  /** Extra non-secret fields for GET /zcash/info (ADR-016: the name registry's mode and fee — never its address). */
  readonly info?: () => Record<string, unknown>;
  /** ADR-018 § 4: on main there is no faucet — /zcash/info says so and a claim is refused. */
  readonly network?: "main" | "test";
}

export type RpcFn = <T>(method: string, params: unknown[]) => Promise<T>;

const SESSION_COOLDOWN_MS = 10 * 60 * 1000;
const ADDRESS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const GLOBAL_PER_MINUTE = 20;
const ADDRESS = /^(u(regtest|test)?1[0-9a-z]{40,}|z(regtest|test)?sapling1[0-9a-z]{40,})$/;

export function zcashdRpcFromEnv(): RpcFn | null {
  const url = process.env.ZCASHD_RPC_URL;
  if (!url || !process.env.ZCASHD_RPC_USER) return null;
  const auth = Buffer.from(`${process.env.ZCASHD_RPC_USER}:${process.env.ZCASHD_RPC_PASS ?? ""}`).toString("base64");
  let id = 0;
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
        body: JSON.stringify({ jsonrpc: "1.0", id: ++id, method, params }),
        signal: controller.signal,
      });
      const body = (await res.json()) as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(`zcashd ${method}: ${body.error.message ?? "error"}`);
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createFaucetHandler(options: FaucetOptions): (req: IncomingMessage, res: ServerResponse) => boolean {
  const mainnet = options.network === "main";
  const rpc = mainnet ? null : (options.rpc ?? zcashdRpcFromEnv());
  const now = options.now ?? Date.now;
  const amount = options.amountZec ?? Number(process.env.FAUCET_ZEC ?? 1);
  const bySession = new Map<string, number>();
  const byAddress = new Map<string, number>();
  let windowStart = 0;
  let inWindow = 0;
  let minerAddress: string | null = null;

  const findMinerAddress = async (call: RpcFn): Promise<string> => {
    if (minerAddress) return minerAddress;
    const addresses = await call<string[]>("z_listaddresses", []);
    let best: string | null = null;
    let bestBalance = -1;
    for (const address of addresses) {
      const balance = Number(await call<number | string>("z_getbalance", [address, 1]));
      if (balance > bestBalance) {
        bestBalance = balance;
        best = address;
      }
    }
    if (!best) throw new Error("no funded shielded address on the node");
    minerAddress = best;
    return best;
  };

  const send = async (call: RpcFn, to: string): Promise<string> => {
    const from = await findMinerAddress(call);
    // Sapling coinbase → Orchard receiver crosses pools: the amount is revealed at the turnstile,
    // irrelevant on a private test chain.
    const opid = await call<string>("z_sendmany", [from, [{ address: to, amount: Number(amount.toFixed(8)) }], 1, null, "AllowRevealedAmounts"]);
    const deadline = now() + 30_000;
    while (now() < deadline) {
      const [status] = await call<{ status: string }[]>("z_getoperationstatus", [[opid]]);
      if (status && (status.status === "success" || status.status === "failed")) {
        const [result] = await call<{ status: string; result?: { txid: string }; error?: { message?: string } }[]>("z_getoperationresult", [[opid]]);
        if (result?.status === "success" && result.result) return result.result.txid;
        throw new Error(result?.error?.message ?? "z_sendmany failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    throw new Error("z_sendmany timed out");
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  };

  return (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/zcash/info" && path !== "/zcash/faucet") return false;
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, options.allowedOrigins)) {
      res.writeHead(403).end();
      return true;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204).end();
      return true;
    }
    if (path === "/zcash/info") {
      json(res, 200, { ...(options.info?.() ?? {}), faucet: rpc !== null, amount: rpc ? amount : 0 });
      return true;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return true;
    }
    if (!rpc) {
      json(res, mainnet ? 403 : 503, { error: "faucet_disabled" });
      return true;
    }
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 2048) req.destroy();
    });
    req.on("end", () => {
      void (async () => {
        let body: { capability?: unknown; address?: unknown };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return json(res, 400, { error: "bad_request" });
        }
        const playerId = typeof body.capability === "string" ? options.resolveSession(body.capability) : null;
        if (!playerId) return json(res, 403, { error: "no_session" });
        const address = typeof body.address === "string" ? body.address.trim() : "";
        if (!ADDRESS.test(address)) return json(res, 400, { error: "bad_address" });
        const t = now();
        if ((bySession.get(playerId) ?? 0) > t || (byAddress.get(address) ?? 0) > t) return json(res, 429, { error: "cooldown" });
        if (t - windowStart >= 60_000) {
          windowStart = t;
          inWindow = 0;
        }
        if (++inWindow > GLOBAL_PER_MINUTE) return json(res, 429, { error: "busy" });
        bySession.set(playerId, t + SESSION_COOLDOWN_MS);
        byAddress.set(address, t + ADDRESS_COOLDOWN_MS);
        try {
          const txid = await send(rpc, address);
          json(res, 200, { ok: true, amount, txid });
        } catch (error) {
          bySession.delete(playerId);
          byAddress.delete(address);
          // zcashd errors can echo the recipient — keep addresses out of the log.
          const reason = (error instanceof Error ? error.message : String(error)).replace(/\b[uz][0-9a-z]{30,}\b/gi, "<address>");
          console.warn("[faucet] send failed:", reason);
          json(res, 502, { error: "send_failed" });
        }
      })();
    });
    return true;
  };
}
