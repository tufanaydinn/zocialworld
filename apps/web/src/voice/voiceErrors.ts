/**
 * Why voice, the microphone or a stage share failed, in words a player can act on.
 *
 * A failed voice start used to show only "Voice: ERROR"; each failure now gets an actionable message. The usual
 * causes, each with its own message:
 *
 *  - the game server has no voice server configured (`/voice/token` answers 503 `voice_unconfigured`) — in local
 *    development `npm run dev` now starts one (scripts/dev/livekit.mjs);
 *  - the page is not a secure context (http on a LAN IP): browsers only allow the microphone and screen sharing on
 *    https:// or http://localhost;
 *  - the microphone permission was denied, by the site setting or by the operating system;
 *  - there is no microphone, or another app holds it;
 *  - the server sees a guest (403 `wallet_required`), wants a confirmed name first (403 `name_required`, a name
 *    registry server) or does not know the session (403);
 *  - the voice server (LiveKit) cannot be reached, or the media connection (WebRTC over UDP) cannot be made.
 *
 * Pure: no DOM, no LiveKit import. Errors are recognised by their `name`, LiveKit's numeric `reason` and message text.
 */

export type VoiceFailureCause =
  /** No session capability yet: the game server connection isn't up (or was lost). */
  | "not_connected"
  /** http:// on something other than localhost: no getUserMedia / getDisplayMedia. */
  | "insecure_context"
  /** The browser lacks what voice or sharing needs (no mediaDevices, no WebRTC, no getDisplayMedia). */
  | "unsupported"
  /** `/voice/token` 503 with `voice_unconfigured`: no LiveKit configured on this game server. */
  | "voice_unconfigured"
  /** `/voice/token` failed some other way (network error, 5xx, proxy). */
  | "token_unavailable"
  /** `/voice/token` 403 `wallet_required`: the server sees a guest. */
  | "wallet_required"
  /** `/voice/token` 403 `name_required`: a name registry server gives talking/presenting only to an owned (confirmed) name. */
  | "name_required"
  /** `/voice/token` 403 without a reason: an unknown, revoked or superseded session capability. */
  | "session_rejected"
  /** LiveKit's signal connection failed (server down, wrong URL, blocked port). */
  | "sfu_unreachable"
  /** LiveKit refused the token (a key/secret mismatch between the game server and LiveKit). */
  | "sfu_rejected"
  /** Signalling worked but the media connection (ICE over UDP/TCP) didn't: a firewall, VPN or NAT. */
  | "media_blocked"
  /** The microphone (or screen capture) permission was denied for this site. */
  | "permission_denied"
  /** The operating system blocks the browser from the microphone or screen capture. */
  | "system_denied"
  /** No microphone (or the chosen one is gone). */
  | "no_device"
  /** The device exists but couldn't start (another app holds it, a driver problem). */
  | "device_busy"
  | "unknown";

/** What failed: getting a token and connecting, capturing the microphone, or capturing a screen for the stage. */
export type VoiceFailureStage = "connect" | "microphone" | "screen";

/** A `/voice/token` answer that wasn't 200: the HTTP status and the JSON `error` code, if any. */
export class VoiceTokenError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null) {
    super(`voice token request failed: HTTP ${status}${code ? ` (${code})` : ""}`);
    this.name = "VoiceTokenError";
    this.status = status;
    this.code = code;
  }
}

/** Thrown before anything is requested when the session has no capability yet. */
export class VoiceNotConnectedError extends Error {
  constructor() {
    super("not connected to the game server");
    this.name = "VoiceNotConnectedError";
  }
}

export interface VoiceEnvironment {
  /** `window.isSecureContext`. */
  readonly secureContext: boolean;
  /** `navigator.mediaDevices` exists (it is undefined in insecure contexts). */
  readonly mediaDevices: boolean;
}

/** The browser's own environment (safe outside a browser: then everything counts as available). */
export function browserVoiceEnvironment(): VoiceEnvironment {
  if (typeof window === "undefined" || typeof navigator === "undefined") return { secureContext: true, mediaDevices: true };
  return { secureContext: window.isSecureContext !== false, mediaDevices: Boolean(navigator.mediaDevices) };
}

/** LiveKit's ConnectionErrorReason values (livekit-client 2.x), kept here so this module stays import-free. */
const LK_NOT_ALLOWED = 0;
const LK_SERVER_UNREACHABLE = 1;
const LK_INTERNAL = 2;
const LK_CANCELLED = 3;
const LK_TIMEOUT = 5;
const LK_WEBSOCKET = 6;

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return String(error);
}

/** Maps any failure from the voice / microphone / share paths to one cause. Insecure contexts win over everything for media. */
export function classifyVoiceFailure(error: unknown, stage: VoiceFailureStage, environment: VoiceEnvironment): VoiceFailureCause {
  const name = errorName(error);
  const message = errorMessage(error);
  if (error instanceof VoiceNotConnectedError || name === "VoiceNotConnectedError") return "not_connected";
  if (error instanceof VoiceTokenError || name === "VoiceTokenError") {
    const { status, code } = error as VoiceTokenError;
    if (status === 503 && code === "voice_unconfigured") return "voice_unconfigured";
    if (status === 403 && code === "wallet_required") return "wallet_required";
    if (status === 403 && code === "name_required") return "name_required";
    if (status === 403) return "session_rejected";
    return "token_unavailable";
  }
  if (stage !== "connect" && (!environment.secureContext || !environment.mediaDevices)) return environment.secureContext ? "unsupported" : "insecure_context";
  if (name === "ConnectionError") {
    const reason = (error as { reason?: unknown }).reason;
    if (reason === LK_NOT_ALLOWED) return "sfu_rejected";
    if (reason === LK_INTERNAL && /pc connection|transport|connection not set|could not establish (publisher|subscriber)/i.test(message)) return "media_blocked";
    if (reason === LK_SERVER_UNREACHABLE || reason === LK_WEBSOCKET || reason === LK_TIMEOUT) return "sfu_unreachable";
    if (reason === LK_CANCELLED) return "unknown";
    return /pc connection|ice/i.test(message) ? "media_blocked" : "sfu_unreachable";
  }
  // fetch() itself failed (DNS, refused, CORS, offline): the game server's voice endpoint wasn't reachable.
  if (stage === "connect" && name === "TypeError" && /fetch|network|load failed/i.test(message)) return "token_unavailable";
  if (/closed while connecting/i.test(message)) return "media_blocked";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return /system/i.test(message) ? "system_denied" : "permission_denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "no_device";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "device_busy";
    case "NotSupportedError":
    case "DeviceUnsupportedError":
      return "unsupported";
    default:
      break;
  }
  if (stage !== "connect" && /getUserMedia|getDisplayMedia|mediaDevices|not supported/i.test(message)) return "unsupported";
  return "unknown";
}

export interface VoiceFailureMessage {
  /** One short sentence (the voice panel's error line, and the chat line's start). */
  readonly title: string;
  /** What to do about it. */
  readonly detail: string;
  /** A button that helps: open the wallet panel, or just try again. */
  readonly action: "open-wallet" | "retry" | "reload" | null;
}

export interface VoiceMessageContext {
  /** A development build (import.meta.env.DEV): mention `npm run dev` and the local LiveKit. */
  readonly dev: boolean;
  /** The page's host (location.host), for the insecure-context hint. */
  readonly host: string;
  /** What the player tried: talk (full voice), listen (watch mode / guest voice) or share on the stage. */
  readonly attempt: "talk" | "listen" | "share";
  /** A mainnet build — the name fee is real ZEC, not test coins. Default: the test chain. */
  readonly mainnet?: boolean;
}

const DEV_LIVEKIT_HINT = "Local development: `npm run dev` starts LiveKit for you (scripts/dev/livekit.mjs; SKIP_LOCAL_LIVEKIT=1 turns it off) — see apps/web/README.md § Voice.";

/** The message for a cause — precise and actionable, never a bare "error". */
export function voiceFailureMessage(cause: VoiceFailureCause, context: VoiceMessageContext): VoiceFailureMessage {
  const media = context.attempt === "share" ? "screen sharing" : "the microphone";
  switch (cause) {
    case "not_connected":
      return { title: "Not connected to the game server yet.", detail: "Wait for “Connected” at the top of the screen, then try again.", action: "retry" };
    case "insecure_context":
      return {
        title: `This page isn't secure, so the browser blocks ${media}.`,
        detail: `Browsers allow ${media} only on https:// or on http://localhost — this page is http://${context.host}. Open the game over https (or on localhost on this computer).`,
        action: null,
      };
    case "unsupported":
      if (context.attempt === "share") return { title: "This browser can't share a screen or tab.", detail: "Use Chrome or Edge on a desktop computer to present on the stage.", action: null };
      // Talking: voice itself connects (listening works); only the microphone can't open — e.g. an in-app or embedded
      // browser with no permission prompt, which answers getUserMedia with NotSupportedError.
      return context.attempt === "talk"
        ? { title: "This browser can't open a microphone here.", detail: "You can still hear others. To talk, use a current Chrome, Edge, Firefox or Safari on a desktop computer — in-app and embedded browsers often have no microphone access.", action: null }
        : { title: "This browser can't use voice here.", detail: "Use a current Chrome, Edge, Firefox or Safari on a desktop computer.", action: null };
    case "voice_unconfigured":
      return {
        title: "Voice isn't set up on this game server.",
        detail: context.dev ? `The game server has no LiveKit voice server configured. ${DEV_LIVEKIT_HINT}` : "The server has no voice server (LiveKit) configured. Ask the operator — chat still works.",
        action: null,
      };
    case "token_unavailable":
      return { title: "The game server's voice service didn't answer.", detail: "Check your connection and try again in a moment.", action: "retry" };
    case "wallet_required":
      return { title: "Talking needs a wallet — the server sees you as a guest.", detail: "Connect or unlock your wallet, then press Enable Voice again. Guests can listen.", action: "open-wallet" };
    case "name_required":
      return {
        title: "Talking and presenting on this server need a confirmed name.",
        detail: `Confirm your name (${context.mainnet ? "a small fee in ZEC" : "a small test-coin fee"}), then press Enable Voice again. You can still hear others.`,
        action: null,
      };
    case "session_rejected":
      return { title: "The voice server didn't recognise this game session.", detail: "Reload the page to start a fresh session.", action: "reload" };
    case "sfu_unreachable":
      return {
        title: "Couldn't reach the voice server.",
        detail: context.dev ? `LiveKit isn't answering. ${DEV_LIVEKIT_HINT}` : "The voice server (LiveKit) isn't answering — it may be down or blocked by your network. Try again later.",
        action: "retry",
      };
    case "sfu_rejected":
      return {
        title: "The voice server refused the connection.",
        detail: context.dev ? "The game server's LIVEKIT_API_KEY / LIVEKIT_API_SECRET don't match the LiveKit server (the --dev keys are devkey / secret)." : "The server's voice keys don't match its voice server. Ask the operator.",
        action: null,
      };
    case "media_blocked":
      return {
        title: "Connected to the voice server, but the audio connection couldn't be made.",
        detail: "A firewall, VPN or strict network is blocking WebRTC (UDP). Try another network or turn the VPN off.",
        action: "retry",
      };
    case "permission_denied":
      return context.attempt === "share"
        ? { title: "Screen sharing was blocked for this site.", detail: "Allow screen sharing for this site in the browser's site settings, then press “Start sharing” again.", action: "retry" }
        : { title: "Microphone access is blocked for this site.", detail: "Click the lock/microphone icon in the address bar, allow the microphone, then press Enable Voice again. You can still hear others.", action: "retry" };
    case "system_denied":
      return context.attempt === "share"
        ? { title: "Your operating system blocks the browser from capturing the screen.", detail: "macOS: System Settings → Privacy & Security → Screen Recording → allow your browser, then restart it.", action: null }
        : {
            title: "Your operating system blocks the browser from the microphone.",
            detail: "Windows: Settings → Privacy & security → Microphone → allow desktop apps. macOS: System Settings → Privacy & Security → Microphone → allow your browser.",
            action: "retry",
          };
    case "no_device":
      return { title: "No microphone found.", detail: "Plug one in (or pick it in ⚙ Voice settings), then press Enable Voice again. You can still hear others.", action: "retry" };
    case "device_busy":
      return context.attempt === "share"
        ? { title: "The browser couldn't start the capture.", detail: "Close other apps that capture the screen and try again.", action: "retry" }
        : { title: "The microphone couldn't start.", detail: "Another app (a call, a recorder) may be using it. Close it and press Enable Voice again.", action: "retry" };
    default:
      return {
        title: context.attempt === "share" ? "Sharing couldn't start." : context.attempt === "listen" ? "Listening couldn't start." : "Voice couldn't start.",
        detail: "Try again in a moment. If it keeps failing, reload the page.",
        action: "retry",
      };
  }
}

/** Reads `/voice/token`'s JSON error code without ever throwing (non-JSON bodies give null). */
export async function readTokenErrorCode(response: Pick<Response, "headers" | "text">): Promise<string | null> {
  try {
    const type = response.headers.get("Content-Type") ?? "";
    if (!type.includes("json")) return null;
    const body = JSON.parse(await response.text()) as { error?: unknown };
    return typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}
