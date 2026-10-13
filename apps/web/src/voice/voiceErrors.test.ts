import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceNotConnectedError, VoiceTokenError, classifyVoiceFailure, readTokenErrorCode, voiceFailureMessage, type VoiceFailureCause, type VoiceEnvironment } from "./voiceErrors.ts";

// Every voice / microphone / share failure gets a precise cause and an actionable message.

const SECURE: VoiceEnvironment = { secureContext: true, mediaDevices: true };
const INSECURE: VoiceEnvironment = { secureContext: false, mediaDevices: false };
const domError = (name: string, message = "x") => Object.assign(new Error(message), { name });
const lkError = (reason: number, message: string) => Object.assign(new Error(message), { name: "ConnectionError", reason });

test("token answers: 503 voice_unconfigured, 403 wallet_required, a bare 403, other statuses, a failed fetch", () => {
  assert.equal(classifyVoiceFailure(new VoiceTokenError(503, "voice_unconfigured"), "connect", SECURE), "voice_unconfigured");
  assert.equal(classifyVoiceFailure(new VoiceTokenError(503, null), "connect", SECURE), "token_unavailable", "a proxy's 503 is not 'unconfigured'");
  assert.equal(classifyVoiceFailure(new VoiceTokenError(403, "wallet_required"), "connect", SECURE), "wallet_required");
  assert.equal(classifyVoiceFailure(new VoiceTokenError(403, "name_required"), "connect", SECURE), "name_required");
  assert.equal(classifyVoiceFailure(new VoiceTokenError(403, null), "connect", SECURE), "session_rejected");
  assert.equal(classifyVoiceFailure(new VoiceTokenError(500, null), "connect", SECURE), "token_unavailable");
  assert.equal(classifyVoiceFailure(new TypeError("Failed to fetch"), "connect", SECURE), "token_unavailable");
  assert.equal(classifyVoiceFailure(new VoiceNotConnectedError(), "connect", SECURE), "not_connected");
});

test("LiveKit connection errors: unreachable, refused token, media (ICE) blocked", () => {
  assert.equal(classifyVoiceFailure(lkError(1, "could not establish signal connection"), "connect", SECURE), "sfu_unreachable");
  assert.equal(classifyVoiceFailure(lkError(6, "Encountered websocket error during connection establishment"), "connect", SECURE), "sfu_unreachable");
  assert.equal(classifyVoiceFailure(lkError(5, "room connection has timed out (signal)"), "connect", SECURE), "sfu_unreachable");
  assert.equal(classifyVoiceFailure(lkError(0, "invalid token"), "connect", SECURE), "sfu_rejected");
  assert.equal(classifyVoiceFailure(lkError(2, "could not establish pc connection"), "connect", SECURE), "media_blocked");
  assert.equal(classifyVoiceFailure(new Error("voice connection closed while connecting"), "connect", SECURE), "media_blocked");
});

test("microphone failures: insecure page first, then permission, OS block, no device, busy device", () => {
  assert.equal(classifyVoiceFailure(new TypeError("Cannot read properties of undefined (reading 'getUserMedia')"), "microphone", INSECURE), "insecure_context");
  assert.equal(classifyVoiceFailure(domError("NotAllowedError", "Permission denied"), "microphone", INSECURE), "insecure_context", "an insecure page explains everything else");
  assert.equal(classifyVoiceFailure(domError("NotAllowedError", "Permission denied"), "microphone", SECURE), "permission_denied");
  assert.equal(classifyVoiceFailure(domError("NotAllowedError", "Permission denied by system"), "microphone", SECURE), "system_denied");
  assert.equal(classifyVoiceFailure(domError("NotFoundError", "Requested device not found"), "microphone", SECURE), "no_device");
  assert.equal(classifyVoiceFailure(domError("OverconstrainedError"), "microphone", SECURE), "no_device");
  assert.equal(classifyVoiceFailure(domError("NotReadableError", "Could not start audio source"), "microphone", SECURE), "device_busy");
  assert.equal(classifyVoiceFailure(new Error("something odd"), "microphone", SECURE), "unknown");
  assert.equal(classifyVoiceFailure(new Error("getUserMedia is not supported"), "microphone", { secureContext: true, mediaDevices: false }), "unsupported");
  // A browser with no permission prompt (headless, some in-app browsers) answers getUserMedia with NotSupportedError.
  assert.equal(classifyVoiceFailure(domError("NotSupportedError", "Not supported"), "microphone", SECURE), "unsupported");
  assert.equal(voiceFailureMessage("unsupported", { dev: false, host: "x", attempt: "talk" }).title, "This browser can't open a microphone here.");
  assert.match(voiceFailureMessage("unsupported", { dev: false, host: "x", attempt: "talk" }).detail, /still hear others/);
});

test("screen-share failures: insecure page, OS block (macOS Screen Recording), unsupported browser", () => {
  assert.equal(classifyVoiceFailure(new TypeError("navigator.mediaDevices is undefined"), "screen", INSECURE), "insecure_context");
  assert.equal(classifyVoiceFailure(domError("NotAllowedError", "Permission denied by system"), "screen", SECURE), "system_denied");
  assert.equal(classifyVoiceFailure(domError("NotSupportedError", "getDisplayMedia is not supported"), "screen", SECURE), "unsupported");
});

test("every cause has a title and a detail; dev builds point at npm run dev; the action fits the cause", () => {
  const causes: VoiceFailureCause[] = [
    "not_connected",
    "insecure_context",
    "unsupported",
    "voice_unconfigured",
    "token_unavailable",
    "wallet_required",
    "name_required",
    "session_rejected",
    "sfu_unreachable",
    "sfu_rejected",
    "media_blocked",
    "permission_denied",
    "system_denied",
    "no_device",
    "device_busy",
    "unknown",
  ];
  for (const cause of causes) {
    for (const attempt of ["talk", "listen", "share"] as const) {
      const message = voiceFailureMessage(cause, { dev: false, host: "192.168.1.20:5174", attempt });
      assert.ok(message.title.length > 10 && message.detail.length > 10, `${cause}/${attempt}`);
      assert.ok(!/error/i.test(message.title) || cause === "unknown", `${cause}: no bare "error"`);
    }
  }
  assert.match(voiceFailureMessage("voice_unconfigured", { dev: true, host: "localhost:5174", attempt: "talk" }).detail, /npm run dev/);
  assert.doesNotMatch(voiceFailureMessage("voice_unconfigured", { dev: false, host: "play.example", attempt: "talk" }).detail, /npm run dev/);
  assert.match(voiceFailureMessage("insecure_context", { dev: false, host: "192.168.1.20:5174", attempt: "talk" }).detail, /http:\/\/192\.168\.1\.20:5174/);
  assert.equal(voiceFailureMessage("wallet_required", { dev: false, host: "x", attempt: "talk" }).action, "open-wallet");
  assert.equal(voiceFailureMessage("session_rejected", { dev: false, host: "x", attempt: "talk" }).action, "reload");
  assert.equal(voiceFailureMessage("insecure_context", { dev: false, host: "x", attempt: "talk" }).action, null);
  assert.match(voiceFailureMessage("system_denied", { dev: false, host: "x", attempt: "share" }).detail, /Screen Recording/);
});

test("name_required names the fee in ZEC on a mainnet build, test coins otherwise", () => {
  assert.match(voiceFailureMessage("name_required", { dev: false, host: "x", attempt: "talk" }).detail, /test-coin fee/);
  const mainnet = voiceFailureMessage("name_required", { dev: false, host: "x", attempt: "talk", mainnet: true }).detail;
  assert.match(mainnet, /fee in ZEC/);
  assert.doesNotMatch(mainnet, /test/);
});

test("readTokenErrorCode: the JSON error code or null, never a throw", async () => {
  const response = (type: string, body: string) => ({ headers: new Headers({ "Content-Type": type }), text: async () => body });
  assert.equal(await readTokenErrorCode(response("application/json", '{"error":"wallet_required"}')), "wallet_required");
  assert.equal(await readTokenErrorCode(response("application/json", '{"error":"<b>x</b>"}')), null);
  assert.equal(await readTokenErrorCode(response("application/json", "not json")), null);
  assert.equal(await readTokenErrorCode(response("text/html", '{"error":"voice_unconfigured"}')), null);
});
