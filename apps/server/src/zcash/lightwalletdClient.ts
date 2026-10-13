import http2, { type ClientHttp2Session } from "node:http2";
import { connectLightwalletd } from "./lwdProxy.js";
import { UpstreamPool } from "./upstreamPool.js";

/**
 * The game server's own unary calls to lightwalletd (ADR-018 § 5/§ 6): the chain tip and one transaction
 * by id, for the name-fee and transfer-fee checks. Minimal gRPC over node:http2 (no new dependency): a hand-written
 * protobuf encoder/decoder for the three messages involved, the same upstream and CONNECT-proxy handling as the
 * wallet bridge (lwdProxy.ts). Nothing here logs a transaction id, an address or an amount.
 *
 *   GetLatestBlock(ChainSpec {}) → BlockID { height = 1 (uint64), hash = 2 (bytes) }
 *   GetTransaction(TxFilter { hash = 3 (bytes, txid in INTERNAL byte order) }) → RawTransaction { data = 1, height = 2 }
 *
 * lightwalletd answers a transaction still in the mempool with height 0 (zaino-based servers with 2^64 − 1); both are
 * reported as `height: null` (unmined).
 *
 * `upstream` may be an ordered list. A call that fails at the connection level (cannot connect, timed out, a
 * reset stream, gRPC UNAVAILABLE) is retried on the next upstream and the failed one cools down (upstreamPool.ts); a
 * definitive gRPC answer (NOT_FOUND for an unknown transaction, …) is returned as it is.
 */

const SERVICE = "cash.z.wallet.sdk.rpc.CompactTxStreamer";
const CALL_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const USER_AGENT = "zocial-world-fee-check/1.0";

export interface RawTransaction {
  /** The serialized transaction, hex. */
  readonly hex: string;
  /** The block height it was mined at, or null while it is unmined (mempool). */
  readonly height: number | null;
}

/** Where the fee checks read the chain from (a fake in tests). */
export interface ChainSource {
  tipHeight(): Promise<number>;
  /** null when lightwalletd does not know the transaction (not yet propagated, expired, or never broadcast). */
  getTransaction(txid: string): Promise<RawTransaction | null>;
}

export class GrpcStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`lightwalletd status ${status}: ${message.replace(/[0-9a-f]{64}/gi, "<txid>").slice(0, 200)}`);
    this.status = status;
  }
}

// ------------------------------------------------------------------ protobuf (just enough)

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = start;
  for (;;) {
    if (pos >= buf.length || shift > 63n) throw new Error("bad protobuf varint");
    const byte = buf[pos++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
}

/** Every field of a protobuf message: varints as bigint, length-delimited fields as bytes (other wire types skipped). */
export function decodeFields(buf: Uint8Array): Map<number, (bigint | Uint8Array)[]> {
  const fields = new Map<number, (bigint | Uint8Array)[]>();
  let pos = 0;
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    pos = afterKey;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value: bigint | Uint8Array;
    if (wire === 0) {
      [value, pos] = readVarint(buf, pos);
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buf, pos);
      const end = afterLength + Number(length);
      if (end > buf.length) throw new Error("truncated protobuf field");
      value = buf.subarray(afterLength, end);
      pos = end;
    } else if (wire === 1) {
      pos += 8;
      continue;
    } else if (wire === 5) {
      pos += 4;
      continue;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    const list = fields.get(field) ?? [];
    list.push(value);
    fields.set(field, list);
  }
  return fields;
}

/** TxFilter { hash = 3 }: the txid's 32 bytes in internal order (reversed from the explorer form). */
export function encodeTxFilter(txidHex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(txidHex)) throw new Error("bad txid");
  const internal = Buffer.from(txidHex, "hex").reverse();
  return Uint8Array.from([0x1a, internal.length, ...internal]);
}

const UNMINED_SENTINEL = (1n << 63n);

/** RawTransaction { data = 1, height = 2 } → hex and height (null when unmined). */
export function decodeRawTransaction(message: Uint8Array): RawTransaction {
  const fields = decodeFields(message);
  const data = fields.get(1)?.[0];
  const height = fields.get(2)?.[0];
  if (!(data instanceof Uint8Array) || data.length === 0) throw new Error("RawTransaction without data");
  const h = typeof height === "bigint" ? height : 0n;
  return { hex: Buffer.from(data).toString("hex"), height: h === 0n || h >= UNMINED_SENTINEL ? null : Number(h) };
}

/** BlockID { height = 1 } → height. */
export function decodeBlockHeight(message: Uint8Array): number {
  const height = decodeFields(message).get(1)?.[0];
  if (typeof height !== "bigint" || height <= 0n) throw new Error("BlockID without height");
  return Number(height);
}

/** One gRPC length-prefixed message (uncompressed). */
export function grpcFrame(message: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(message.length, 1);
  Buffer.from(message).copy(frame, 5);
  return frame;
}

/** The first message of a gRPC response body (compressed frames are refused: we never ask for compression). */
export function firstGrpcMessage(body: Buffer): Uint8Array | null {
  if (body.length < 5) return null;
  if (body.readUInt8(0) !== 0) throw new Error("compressed gRPC response");
  const length = body.readUInt32BE(1);
  if (5 + length > body.length) throw new Error("truncated gRPC response");
  return body.subarray(5, 5 + length);
}

/**
 * A gRPC `grpc-message` header (percent-encoded per the gRPC spec) as text, at most 500 characters. Never throws: an
 * invalid encoding from a misbehaving upstream or proxy (a raw "%", say) is kept as it came.
 */
export function decodeGrpcMessage(text: unknown): string {
  if (typeof text !== "string") return "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    decoded = text;
  }
  return decoded.slice(0, 500);
}

// ------------------------------------------------------------------ the client

export interface LightwalletdClientOptions {
  /** One upstream, or an ordered list: the primary first. */
  readonly upstream: string | readonly string[];
  /** Test seam: opens the HTTP/2 session to an upstream. */
  readonly connect?: (upstream: URL) => Promise<ClientHttp2Session>;
  readonly timeoutMs?: number;
  /** How long a failed upstream is skipped (default 60 s). */
  readonly upstreamCooldownMs?: number;
}

/** NOT_FOUND-like answers lightwalletd/zcashd/zebrad give for an unknown transaction id. */
const NOT_FOUND = /not found|no information|no such|unknown transaction|-5\b/i;

/** gRPC answers that mean "this upstream can't serve now" rather than an answer about the request. */
function isConnectionLevel(error: unknown): boolean {
  if (error instanceof GrpcStatusError) return error.status === 14 || error.status === 4; // UNAVAILABLE, DEADLINE_EXCEEDED
  return true; // connect / TLS / timeout / reset / malformed transport errors
}

export class LightwalletdClient implements ChainSource {
  private readonly pool: UpstreamPool;
  private readonly open: (upstream: URL) => Promise<ClientHttp2Session>;
  private readonly timeoutMs: number;
  private readonly sessions: (Promise<ClientHttp2Session> | null)[];

  constructor(options: LightwalletdClientOptions) {
    this.pool = new UpstreamPool(typeof options.upstream === "string" ? [options.upstream] : options.upstream, {
      ...(options.upstreamCooldownMs !== undefined ? { cooldownMs: options.upstreamCooldownMs } : {}),
    });
    this.timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    this.open = options.connect ?? ((upstream: URL) => connectLightwalletd(upstream, { timeoutMs: this.timeoutMs }));
    this.sessions = this.pool.urls.map(() => null);
  }

  async tipHeight(): Promise<number> {
    const reply = await this.call("GetLatestBlock", new Uint8Array(0));
    return decodeBlockHeight(reply);
  }

  async getTransaction(txid: string): Promise<RawTransaction | null> {
    try {
      return decodeRawTransaction(await this.call("GetTransaction", encodeTxFilter(txid)));
    } catch (error) {
      if (error instanceof GrpcStatusError && (error.status === 5 || NOT_FOUND.test(error.message))) return null;
      throw error;
    }
  }

  close(): void {
    for (let index = 0; index < this.sessions.length; index++) {
      void this.sessions[index]?.then((s) => s.close()).catch(() => undefined);
      this.sessions[index] = null;
    }
  }

  private getSession(index: number): Promise<ClientHttp2Session> {
    const current = this.sessions[index];
    if (current) return current;
    const pending = this.open(this.pool.urls[index]!).then((s) => {
      const reset = (): void => {
        if (this.sessions[index] === pending) this.sessions[index] = null;
      };
      s.on("close", reset);
      s.on("error", reset);
      s.on("goaway", reset);
      return s;
    });
    pending.catch(() => {
      if (this.sessions[index] === pending) this.sessions[index] = null;
    });
    this.sessions[index] = pending;
    return pending;
  }

  /** Drops the cached session if it is still `session` (a half-open or late one is replaced by the next call). */
  private dropSession(index: number, pending: Promise<ClientHttp2Session>): void {
    if (this.sessions[index] !== pending) return;
    this.sessions[index] = null;
    void pending.then((s) => s.close(), () => undefined);
  }

  /**
   * Opening the session (CONNECT through a proxy, TLS) is bounded by the call timeout too. A session that
   * never opens is dropped, so the next call tries a new one instead of awaiting the same promise forever.
   */
  private async sessionWithin(index: number, method: string): Promise<ClientHttp2Session> {
    const pending = this.getSession(index);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.dropSession(index, pending);
            reject(new Error(`lightwalletd ${method}: connecting timed out`));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The upstreams in failover order; a connection-level failure moves on to the next one. */
  private async call(method: string, message: Uint8Array): Promise<Uint8Array> {
    let lastError: unknown = null;
    for (const index of this.pool.order()) {
      try {
        const reply = await this.callOn(index, method, message);
        this.pool.markOk(index);
        return reply;
      } catch (error) {
        if (!isConnectionLevel(error)) {
          this.pool.markOk(index); // a definitive answer: this upstream works
          throw error;
        }
        this.pool.markFailed(index);
        lastError = error;
      }
    }
    throw lastError ?? new Error(`lightwalletd ${method}: no upstream`);
  }

  private async callOn(index: number, method: string, message: Uint8Array): Promise<Uint8Array> {
    const pendingSession = this.getSession(index);
    const session = await this.sessionWithin(index, method);
    return new Promise<Uint8Array>((resolve, reject) => {
      let stream: http2.ClientHttp2Stream;
      try {
        stream = session.request({
          ":method": "POST",
          ":path": `/${SERVICE}/${method}`,
          "content-type": "application/grpc+proto",
          te: "trailers",
          "user-agent": USER_AGENT,
          "grpc-timeout": `${Math.ceil(this.timeoutMs / 1000)}S`,
        });
      } catch (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let status: number | null = null;
      let statusMessage = "";
      const timer = setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        // A call that hangs on an open session points at a half-open connection: replace it.
        this.dropSession(index, pendingSession);
        reject(new Error(`lightwalletd ${method} timed out`));
      }, this.timeoutMs);
      // Runs inside http2 event listeners, where a throw would escape every caller and crash the server
      // (e.g. a raw "%" in grpc-message). Never throws: a malformed status ends the call with an error instead.
      const takeStatus = (headers: http2.IncomingHttpHeaders): void => {
        try {
          if (headers["grpc-status"] === undefined) return;
          const code = Number(headers["grpc-status"]);
          status = Number.isInteger(code) && code >= 0 ? code : 2;
          statusMessage = decodeGrpcMessage(headers["grpc-message"]);
        } catch {
          status = 2;
          statusMessage = "malformed status";
        }
      };
      stream.on("response", takeStatus);
      stream.on("trailers", takeStatus);
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          stream.close(http2.constants.NGHTTP2_CANCEL);
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      stream.on("end", () => {
        clearTimeout(timer);
        if (size > MAX_RESPONSE_BYTES) return reject(new Error(`lightwalletd ${method} answer too large`));
        if (status !== null && status !== 0) return reject(new GrpcStatusError(status, statusMessage));
        try {
          const reply = firstGrpcMessage(Buffer.concat(chunks));
          if (reply === null) return reject(new GrpcStatusError(status ?? 2, "empty answer"));
          resolve(reply);
        } catch (error) {
          reject(error);
        }
      });
      stream.end(grpcFrame(message));
    });
  }
}
