import type { BrowserContext } from "@playwright/test";
import { WebSocket as WsClient } from "ws";

/**
 * ADR-019 §§ 4–5 e2e helper: give one browser context its own client address on the game socket.
 *
 * Chromium does not send a context's `extraHTTPHeaders` on WebSocket upgrades, so every browser's game socket reaches
 * the e2e server from 127.0.0.1 — one "network" for the per-IP cap and for a guest's kick, ban or mute (a guest has no
 * other key). This relays the context's game sockets through the test runner, which opens each one to the real server
 * with `X-Forwarded-For: address` (the e2e server trusts 127.0.0.1 — TRUST_PROXY in playwright.config.ts). Each context
 * then counts as its own network, and a guest ban in one spec never locks out the rest of the suite.
 *
 * Messages and close codes (4001 kicked, 4002 banned, 4003 too many connections) pass through unchanged.
 */
export async function useClientAddress(context: BrowserContext, gameServerWs: string, address: string, origin?: string): Promise<void> {
  const server = new URL(gameServerWs);
  const upstreams = new Set<WsClient>();
  context.on("close", () => {
    for (const upstream of upstreams) upstream.terminate();
  });
  await context.routeWebSocket(
    (url) => url.port === server.port && (url.hostname === server.hostname || url.hostname === "localhost"),
    (route) => {
      const path = new URL(route.url());
      const upstream = new WsClient(`${server.protocol}//${server.host}${path.pathname}${path.search}`, {
        headers: { "X-Forwarded-For": address },
        ...(origin ? { origin } : {}),
      });
      upstreams.add(upstream);
      const pending: string[] = [];
      upstream.on("open", () => {
        for (const message of pending.splice(0)) upstream.send(message);
      });
      upstream.on("message", (data, isBinary) => route.send(isBinary ? Buffer.from(data as Buffer) : data.toString()));
      upstream.on("close", (code, reason) => {
        upstreams.delete(upstream);
        // A browser may only be handed 1000 or 3000–4999; anything else (1005, 1006) reads as a plain close.
        route.close(code === 1000 || (code >= 3000 && code <= 4999) ? { code, reason: reason.toString() } : {});
      });
      upstream.on("error", () => undefined); // a refused or broken upstream ends in "close" above
      route.onMessage((message) => {
        const text = typeof message === "string" ? message : message.toString("utf8");
        if (upstream.readyState === WsClient.OPEN) upstream.send(text);
        else if (upstream.readyState === WsClient.CONNECTING) pending.push(text);
      });
      route.onClose(() => {
        upstreams.delete(upstream);
        if (upstream.readyState === WsClient.OPEN) upstream.close(1000);
        else upstream.terminate();
      });
    },
  );
}
