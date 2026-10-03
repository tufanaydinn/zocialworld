/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket endpoint for apps/server. Falls back to `ws://<page host>:8787` in dev if unset — see networking/config.ts. */
  readonly VITE_WS_URL?: string;
  /** Voice-token HTTP endpoint (CORE-004). Falls back to `http://<page host>:8787/voice/token` in dev if unset — see voice/config.ts. Not a secret — just an endpoint URL. */
  readonly VITE_VOICE_TOKEN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
