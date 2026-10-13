import http2, { type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { isOriginAllowed } from "../origin.js";
import { UpstreamPool } from "./upstreamPool.js";

/**
 * grpc-web → gRPC bridge for the in-game wallet.
 *
 * The browser wallet (WebZjs) talks grpc-web to `/zcash/lwd/…`; this
 * server forwards each call to a lightwalletd over HTTP/2 gRPC and turns
 * the HTTP/2 trailers back into a grpc-web trailer frame.
 *
 * Why here instead of letting the browser call a public grpc-web proxy:
 * the lightwalletd operator would then see every player's IP address next
 * to their wallet traffic (block sync timing, transaction broadcasts). Via
 * this bridge it only ever sees this server — the same rule the content
 * gateway follows (docs/privacy/PRIVACY_MODEL.md).
 *
 * Narrow by design: only `cash.z.wallet.sdk.rpc.CompactTxStreamer`
 * methods, binary grpc-web only, origin allowlist, body cap, concurrent
 * stream cap. Request and response bodies are never logged.
 *
 * `upstream` may be an ordered list (LIGHTWALLETD_URL="a,b"). A call
 * that fails before the first byte reached the browser — cannot connect, the
 * stream is reset, or a trailers-only gRPC UNAVAILABLE — is replayed on the
 * next upstream (the request body is buffered), and the failed upstream cools
 * down (zcash/upstreamPool.ts). A stream that already sent data is never
 * replayed (the wallet retries the call itself).
 */

export const LWD_PATH_PREFIX = "/zcash/lwd/";
const SERVICE = "cash.z.wallet.sdk.rpc.CompactTxStreamer";
const METHOD_PATH = new RegExp(`^${LWD_PATH_PREFIX.replace(/\//g, "\\/")}(${SERVICE.replace(/\./g, "\\.")}\\/[A-Za-z]{1,64})$`);
const MAX_REQUEST_BYTES = 4 * 1024 * 1024; // a large shielded transaction is well under this
const DEFAULT_MAX_STREAMS = 64;
/** How long a proxy CONNECT or the TLS handshake may take. */
const CONNECT_TIMEOUT_MS = 15_000;
const USER_AGENT = "zocial-world-lwd-bridge/1.0";
const PASS_HEADERS = ["grpc-timeout", "grpc-accept-encoding"];

export interface LwdProxyOptions {
  readonly allowedOrigins: readonly string[];
  /** lightwalletd gRPC endpoint, e.g. https://testnet.zec.rocks:443 — or an ordered list, primary first. */
  readonly upstream: string | readonly string[];
  readonly maxConcurrentStreams?: number;
  /** Test seam: opens the HTTP/2 session to an upstream. */
  readonly connect?: (upstream: URL) => Promise<ClientHttp2Session>;
  /** How long a failed upstream is skipped (default 60 s). */
  readonly upstreamCooldownMs?: number;
}

/** grpc-web trailer frame: flag 0x80, 4-byte big-endian length, then "key: value\r\n" lines. */
export function encodeTrailerFrame(trailers: Record<string, string>): Buffer {
  const text = Object.entries(trailers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("");
  const body = Buffer.from(text, "utf8");
  const frame = Buffer.alloc(5 + body.length);
  frame.writeUInt8(0x80, 0);
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}

function grpcTrailers(headers: IncomingHttpHeaders): Record<string, string> | null {
  const status = headers["grpc-status"];
  if (status === undefined) return null;
  const message = headers["grpc-message"];
  return { "grpc-status": String(status), "grpc-message": typeof message === "string" ? message : "" };
}

/**
 * Opens a TLS + HTTP/2 session, through an HTTP CONNECT proxy when HTTPS_PROXY is set (e.g. in sandboxes/CI). Also used
 * by the server's own unary calls (lightwalletdClient.ts: the fee checks of ADR-018 § 5/§ 6).
 */
export async function connectLightwalletd(upstream: URL, options: { readonly timeoutMs?: number } = {}): Promise<ClientHttp2Session> {
  // The CONNECT answer and the TLS handshake are bounded, so a proxy that accepts TCP and never answers
  // fails the connection instead of hanging every later call.
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const port = Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80));
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const bypass = noProxy.some((entry) => upstream.hostname === entry || (entry.startsWith(".") && upstream.hostname.endsWith(entry)));
  if (upstream.protocol !== "https:") return http2.connect(upstream.origin);
  if (!proxy || bypass) return http2.connect(upstream.origin);

  const proxyUrl = new URL(proxy);
  const tunnel = await new Promise<import("node:net").Socket>((resolve, reject) => {
    const req = httpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || 80),
      method: "CONNECT",
      path: `${upstream.hostname}:${port}`,
      headers: { host: `${upstream.hostname}:${port}` },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("proxy CONNECT timed out")));
    req.once("connect", (res, socket) => {
      req.setTimeout(0);
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${res.statusCode}`));
      }
    });
    req.once("error", reject);
    req.end();
  });
  const tls: TLSSocket = tlsConnect({ socket: tunnel, servername: upstream.hostname, ALPNProtocols: ["h2"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => tls.destroy(new Error("TLS handshake with lightwalletd timed out")), timeoutMs);
    tls.once("secureConnect", () => {
      clearTimeout(timer);
      resolve();
    });
    tls.once("error", (error) => {
      clearTimeout(timer);
      tunnel.destroy();
      reject(error);
    });
  });
  return http2.connect(upstream.origin, { createConnection: () => tls });
}

export function createLightwalletdProxy(options: LwdProxyOptions): (req: IncomingMessage, res: ServerResponse) => boolean {
  const pool = new UpstreamPool(typeof options.upstream === "string" ? [options.upstream] : options.upstream, { ...(options.upstreamCooldownMs !== undefined ? { cooldownMs: options.upstreamCooldownMs } : {}) });
  const maxStreams = options.maxConcurrentStreams ?? DEFAULT_MAX_STREAMS;
  const open = options.connect ?? ((upstream: URL) => connectLightwalletd(upstream));
  const sessions: (Promise<ClientHttp2Session> | null)[] = pool.urls.map(() => null);
  let active = 0;

  const getSession = (index: number): Promise<ClientHttp2Session> => {
    const current = sessions[index];
    if (current) return current;
    const pending = open(pool.urls[index]!).then((s) => {
      const reset = (): void => {
        if (sessions[index] === pending) sessions[index] = null;
      };
      s.on("close", reset);
      s.on("error", reset);
      s.on("goaway", reset);
      return s;
    });
    pending.catch(() => {
      if (sessions[index] === pending) sessions[index] = null;
    });
    sessions[index] = pending;
    return pending;
  };

  return (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!path.startsWith(LWD_PATH_PREFIX)) return false;

    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, options.allowedOrigins)) {
      res.writeHead(403).end();
      return true;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "grpc-status, grpc-message");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-grpc-web, x-user-agent, grpc-timeout, grpc-accept-encoding, accept");
      res.setHeader("Access-Control-Max-Age", "600");
      res.writeHead(204).end();
      return true;
    }
    const match = METHOD_PATH.exec(path);
    if (req.method !== "POST" || !match) {
      res.writeHead(req.method !== "POST" ? 405 : 404).end();
      return true;
    }
    const contentType = String(req.headers["content-type"] ?? "");
    if (!/^application\/grpc-web(\+proto)?$/i.test(contentType.split(";")[0]!.trim())) {
      res.writeHead(415).end(); // grpc-web-text (base64) is not supported
      return true;
    }
    if (active >= maxStreams) {
      res.writeHead(200, { "Content-Type": "application/grpc-web+proto", "grpc-status": "8", "grpc-message": "bridge busy" }).end();
      return true;
    }

    active++;
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      active--;
    };
    res.once("close", done);

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        req.destroy();
        if (!res.headersSent) res.writeHead(413).end();
        done();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_REQUEST_BYTES) return;
      void forward(Buffer.concat(chunks), match[1]!);
    });

    async function forward(body: Buffer, methodPath: string): Promise<void> {
      const failEarly = (status: number, message: string): void => {
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/grpc-web+proto", "grpc-status": String(status), "grpc-message": message }).end();
        else res.end(encodeTrailerFrame({ "grpc-status": String(status), "grpc-message": message }));
        done();
      };
      const order = pool.order();
      for (let attempt = 0; attempt < order.length; attempt++) {
        const index = order[attempt]!;
        const last = attempt === order.length - 1;
        const outcome = await forwardTo(index, body, methodPath, last);
        if (outcome === "done") return;
        pool.markFailed(index);
        if (res.writableEnded || res.destroyed) return done();
        if (!last) console.warn(`[lwd] upstream ${pool.urls[index]!.origin} failed; trying ${pool.urls[order[attempt + 1]!]!.origin}`);
        else failEarly(14, "lightwalletd unavailable");
      }
    }

    /**
     * One upstream. "retry": it failed before anything reached the browser (the caller tries the next one, or answers
     * UNAVAILABLE after the last). "done": the response was written (success, a gRPC error from lightwalletd, or a
     * failure after data had been sent).
     */
    function forwardTo(index: number, body: Buffer, methodPath: string, last: boolean): Promise<"done" | "retry"> {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (outcome: "done" | "retry"): void => {
          if (settled) return;
          settled = true;
          if (outcome === "done") {
            pool.markOk(index);
            done();
          }
          resolve(outcome);
        };
        getSession(index).then(
          (h2) => {
            const headers: Record<string, string> = {
              ":method": "POST",
              ":path": `/${methodPath}`,
              "content-type": "application/grpc+proto",
              te: "trailers",
              "user-agent": USER_AGENT,
            };
            for (const name of PASS_HEADERS) {
              const value = req.headers[name];
              if (typeof value === "string" && value.length < 64) headers[name] = value;
            }
            let stream: http2.ClientHttp2Stream;
            try {
              stream = h2.request(headers);
            } catch (error) {
              console.warn("[lwd] stream open failed:", error instanceof Error ? error.message : error);
              settle("retry");
              return;
            }
            let trailersOnly: Record<string, string> | null = null;
            let httpStatus = 200;
            let wroteTrailers = false;
            let sentData = false;
            const onClientClose = (): void => {
              if (!stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
            };
            res.once("close", onClientClose);
            const startResponse = (): void => {
              if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/grpc-web+proto", "Cache-Control": "no-store" });
            };
            stream.on("response", (responseHeaders) => {
              trailersOnly = grpcTrailers(responseHeaders);
              httpStatus = Number(responseHeaders[":status"] ?? 200);
              // A normal response starts at once (a long server stream, e.g. the mempool stream, must not wait for its
              // first message); only a trailers-only or gateway error waits, in case another upstream can answer.
              if (trailersOnly === null && httpStatus < 400) startResponse();
            });
            stream.on("data", (chunk: Buffer) => {
              startResponse();
              sentData = true;
              res.write(chunk);
            });
            stream.on("trailers", (trailers) => {
              const frame = grpcTrailers(trailers);
              if (frame) {
                startResponse();
                res.write(encodeTrailerFrame(frame));
                wroteTrailers = true;
              }
            });
            stream.on("end", () => {
              // Nothing reached the browser and this upstream is down (a gateway error, or gRPC UNAVAILABLE with no
              // data): another upstream may answer.
              const unavailable = !sentData && !wroteTrailers && (httpStatus >= 500 || (trailersOnly?.["grpc-status"] === "14" && trailersOnly !== null));
              if (unavailable && !last) {
                res.removeListener("close", onClientClose);
                return settle("retry");
              }
              startResponse();
              if (!wroteTrailers) res.write(encodeTrailerFrame(trailersOnly ?? { "grpc-status": httpStatus >= 400 ? "14" : "0", "grpc-message": httpStatus >= 400 ? "lightwalletd unavailable" : "" }));
              res.end();
              settle("done");
            });
            stream.on("error", (error) => {
              console.warn("[lwd] stream error:", error.message);
              if (settled) return;
              if (!sentData && !wroteTrailers && !res.headersSent) {
                res.removeListener("close", onClientClose);
                return settle("retry");
              }
              if (!res.writableEnded) res.end(encodeTrailerFrame({ "grpc-status": "14", "grpc-message": "lightwalletd stream failed" }));
              settle("done");
            });
            stream.end(body);
          },
          (error: unknown) => {
            console.warn("[lwd] upstream connect failed:", error instanceof Error ? error.message : error);
            settle("retry");
          },
        );
      });
    }
    return true;
  };
}
