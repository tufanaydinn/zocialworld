/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket endpoint for apps/server. Falls back to `ws://<page host>:8787` in dev if unset — see networking/config.ts. */
  readonly VITE_WS_URL?: string;
  /** Voice-token HTTP endpoint. Falls back to `http://<page host>:8787/voice/token` in dev if unset — see voice/config.ts. Not a secret — just an endpoint URL. */
  readonly VITE_VOICE_TOKEN_URL?: string;
  /** The model packs under /assets/ this build has, comma-separated (set by vite.config.ts; see ./assets/assetPacks.ts). */
  readonly VITE_ASSET_PACKS?: string;
  /** "1" when the build has the deployment's artwork under /brand/ (set by vite.config.ts; see ./ui/brand.ts). */
  readonly VITE_BRAND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
