import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { createVerifyClient } from "./origin.js";

/**
 * Largest WebSocket message the server will read, enforced by `ws` while it
 * reads the frame: anything larger closes the connection with 1009 (Message
 * Too Big) before it is buffered. Without it `ws` buffers up to 100 MiB per
 * message, and `parseIncomingFrame` only drops frames over
 * `MAX_MESSAGE_BYTES` after the whole frame is in memory.
 *
 * It is twice `MAX_MESSAGE_BYTES`, so no legitimate frame comes near it.
 * Frames between the two limits are still dropped silently by the protocol
 * layer, and the connection stays open.
 */
export const WS_MAX_PAYLOAD_BYTES = 4096;

/** The gameplay WebSocket server on the shared HTTP server: Origin allowlist plus the frame-size cap. */
export function createGameSocketServer(server: Server, allowedOrigins: readonly string[]): WebSocketServer {
  return new WebSocketServer({ server, verifyClient: createVerifyClient(allowedOrigins), maxPayload: WS_MAX_PAYLOAD_BYTES });
}
