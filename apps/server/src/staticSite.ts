import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readdirSync, readSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serves the built web client (apps/web/dist) from the game server itself
 * — a single-service deployment, so a player needs one HTTPS address for
 * the page, WebSocket, voice token, content gateway and wallet bridge.
 *
 * Every page response carries cross-origin isolation (COOP + COEP), which
 * the in-game wallet needs for SharedArrayBuffer. Hashed /assets/ files are
 * cached for a year; everything else revalidates. Unknown paths fall back
 * to index.html. Paths are normalised and confined to the dist folder.
 *
 * The wallet engine under /webzjs/ (~58 MB of wasm, copied unhashed by the
 * web build) gets a strong ETag: the SHA-256 of its content, computed once
 * when the handler is created. A browser revalidating with If-None-Match gets
 * a 304 instead of downloading the engine again every session. The tag is
 * recomputed if a file's size or mtime changes while the server runs.
 *
 * ADR-018 Consequences: every response carries a full Content-Security-Policy,
 * built at startup from the deployment's own origins (`buildPageCsp`):
 *  - `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'` — no inline or third-party script. The wallet engine needs
 *    WebAssembly and `eval`: wasm_thread calls `js_sys::eval("self")` on every sync/send/shield (in the page and in
 *    its workers, which get this same header);
 *  - `worker-src 'self' blob:` — the engine's module workers, and wasm-bindgen's Atomics.waitAsync fallback (blob:);
 *  - `connect-src 'self' blob: data:` + the page's own ws(s) origin + the deployment's LiveKit (https and wss) — the
 *    directive that stops an injected script from sending a seed, passphrase or address anywhere else (blob:/data: are
 *    local: the 3D loaders fetch embedded textures through them);
 *  - `img-src`/`media-src 'self' data: blob:` (the media proxy is same-origin; img-src also lists the http(s) page
 *    origins, for a content gateway built in with `VITE_CONTENT_URL` on another listed origin), `style-src 'self' 'unsafe-inline'` (UI
 *    modules inject <style>), `frame-src` YouTube (the personal player, ADR-014), `form-action 'self'`;
 *  - `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'` as before.
 * `CSP_MODE=minimal` (index.ts) falls back to three directives if a deployment hits a regression.
 */

/** The minimal fallback policy (CSP_MODE=minimal): three directives only. */
export const MINIMAL_PAGE_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/** The ws(s)/http(s) origins a page may connect to besides 'self': the page origins' WebSocket form and LiveKit. */
export function cspConnectOrigins(pageOrigins: readonly string[], livekitUrl: string | null): string[] {
  const out = new Set<string>();
  const add = (raw: string, pair: Record<string, string>): void => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    const other = pair[url.protocol];
    if (!other) return;
    out.add(`${url.protocol}//${url.host}`);
    out.add(`${other}//${url.host}`);
  };
  for (const origin of pageOrigins) add(origin, { "https:": "wss:", "http:": "ws:" });
  if (livekitUrl) add(livekitUrl, { "wss:": "https:", "ws:": "http:", "https:": "wss:", "http:": "ws:" });
  return [...out].sort();
}

/**
 * The http(s) page origins an image may come from besides 'self' (the CSP together with the content
 * gateway): a client built with `VITE_CONTENT_URL` on another listed origin loads its `/content/media` thumbnails
 * (Watch panel, Community hub) from there. LiveKit is not an image source.
 */
export function cspImageOrigins(pageOrigins: readonly string[]): string[] {
  return cspConnectOrigins(pageOrigins, null).filter((origin) => /^https?:/.test(origin));
}

/**
 * The page's Content-Security-Policy. `connectOrigins`: see `cspConnectOrigins`; `imageOrigins`: see
 * `cspImageOrigins`. Only bare http(s)/ws(s) origins are kept.
 */
export function buildPageCsp(options: { readonly connectOrigins?: readonly string[]; readonly imageOrigins?: readonly string[] } = {}): string {
  // blob:/data: are local (they reach no server): three.js's GLTFLoader fetch()es a model's embedded textures as blob:
  // URLs — without them the production build loses its textures (found by loading it under this policy).
  const connect = ["'self'", "blob:", "data:", ...(options.connectOrigins ?? []).filter((o) => /^(https?|wss?):\/\/[a-z0-9.[\]:-]+$/i.test(o))];
  const images = ["'self'", "data:", "blob:", ...(options.imageOrigins ?? []).filter((o) => /^https?:\/\/[a-z0-9.[\]:-]+$/i.test(o))];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    `img-src ${images.join(" ")}`,
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/** The policy without deployment origins (tests, and a server that knows none). */
export const PAGE_CSP = buildPageCsp();

const ENGINE_PREFIX = "/webzjs/";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

export function createStaticSiteHandler(distDir: string, options: { readonly csp?: string } = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const csp = options.csp ?? PAGE_CSP;
  const root = resolve(distDir);
  const indexFile = join(root, "index.html");
  const engineTags = new Map<string, EntityTag>();
  for (const file of listFiles(join(root, "webzjs"))) {
    try {
      const { size, mtimeMs } = statSync(file);
      currentTag(engineTags, file, size, mtimeMs);
    } catch {
      // vanished since the listing: nothing to tag
    }
  }

  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
    } catch {
      res.writeHead(400).end();
      return true;
    }
    if (pathname.includes("\0")) {
      res.writeHead(400).end();
      return true;
    }
    const candidate = normalize(join(root, pathname));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      res.writeHead(403).end();
      return true;
    }
    let file = candidate;
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = statSync(file);
      if (stat.isDirectory()) throw new Error("directory");
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      // SPA fallback — but never for things that look like missing assets.
      if (extname(pathname)) {
        res.writeHead(404, isolationHeaders()).end();
        return true;
      }
      file = indexFile;
      try {
        size = statSync(file).size;
      } catch {
        res.writeHead(404).end();
        return true;
      }
    }
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const immutable = pathname.startsWith("/assets/");
    const headers: Record<string, string> = {
      ...isolationHeaders(),
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": csp,
    };
    const etag = file === candidate && pathname.startsWith(ENGINE_PREFIX) ? currentTag(engineTags, file, size, mtimeMs) : null;
    if (etag) {
      headers.ETag = etag;
      if (ifNoneMatch(req.headers["if-none-match"], etag)) {
        res.writeHead(304, headers).end();
        return true;
      }
    }
    res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": String(size) });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  };
}

interface EntityTag {
  readonly size: number;
  readonly mtimeMs: number;
  readonly value: string;
}

/** Every regular file below `dir`, recursively; nothing if `dir` is missing. */
function listFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

/** SHA-256 of the file as a strong ETag, read in 1 MiB chunks so the engine is never held in memory whole. */
function hashTag(file: string): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(file, "r");
  try {
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return `"${hash.digest("base64url")}"`;
}

/**
 * The file's ETag for this size and mtime: cached, and hashed again only if the
 * file changed on disk since. Null if it cannot be read (then no ETag is sent).
 */
function currentTag(tags: Map<string, EntityTag>, file: string, size: number, mtimeMs: number): string | null {
  const cached = tags.get(file);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.value;
  try {
    const value = hashTag(file);
    tags.set(file, { size, mtimeMs, value });
    return value;
  } catch {
    tags.delete(file);
    return null;
  }
}

/** RFC 9110 § 13.1.2: If-None-Match uses the weak comparison, and `*` matches any current representation. */
function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || (tag.startsWith("W/") ? tag.slice(2) : tag) === etag;
  });
}

function isolationHeaders(): Record<string, string> {
  return {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}
