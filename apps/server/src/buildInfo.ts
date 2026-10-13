import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isOriginAllowed } from "./origin.js";

/**
 * The build id of the web client this server serves (ADR-018 § 7: "Update ready — reload").
 *
 *  - BUILD_ID, if set (a client hosted elsewhere: set it to that build's id);
 *  - else the `build-id.txt` the web build writes into its dist folder (WEB_DIST, the single-service deployment);
 *  - else null (development: Vite serves the client, nobody is prompted).
 *
 * Announced in `welcome.build` and by `GET /version` ({ build }). A client running another build offers to reload
 * between actions. The id is not secret: it is a timestamp and a random suffix (or what the operator chose).
 */

const BUILD_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function resolveBuildId(env: Record<string, string | undefined>, webDist: string | null): string | null {
  const configured = env.BUILD_ID?.trim();
  if (configured) return BUILD_ID.test(configured) ? configured : null;
  if (!webDist) return null;
  try {
    const text = readFileSync(join(webDist, "build-id.txt"), "utf8").trim();
    return BUILD_ID.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** `GET /version` → `{ "build": "<id>" | null }`, for the client's periodic check (CORS as the other /zcash endpoints). */
export function createVersionHandler(options: { readonly allowedOrigins: readonly string[]; readonly build: () => string | null }): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    if ((req.url ?? "").split("?")[0] !== "/version") return false;
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
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.writeHead(204).end();
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(req.method === "HEAD" ? undefined : JSON.stringify({ build: options.build() }));
    return true;
  };
}
