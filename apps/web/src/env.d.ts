/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  readonly VITE_VOICE_TOKEN_URL?: string;
  readonly VITE_ZCASH_NETWORK: string;
  /** Wallet bridge (grpc-web → lightwalletd) — defaults to `<page host>:8787/zcash/lwd`. */
  readonly VITE_LWD_URL?: string;
  readonly VITE_CONTENT_URL?: string;
  /** "same" (the game server serves this page), a URL, or unset for local dev (<host>:8787). */
  readonly VITE_SERVER_ORIGIN?: string;
  /** "1" exposes the window.__* debug hooks in a production build (end-to-end tests only). */
  readonly VITE_TEST_HOOKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
