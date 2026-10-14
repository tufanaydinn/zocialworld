import { defineConfig, loadEnv, type Plugin } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cross-origin isolation: the in-game wallet (WebZjs) needs SharedArrayBuffer
 * for its proving thread pool, which browsers only allow on a page served with
 * COOP + COEP. Anything served cross-origin must then opt in (CORS or CORP) —
 * the game server's content gateway, media relay and wallet bridge do. Any
 * host serving the built client must send the same two headers.
 *
 * Referrer-Policy: no-referrer mirrors production (apps/server/src/staticSite.ts) so dev reproduces
 * it — notably the opt-in YouTube player, which must set referrerpolicy="strict-origin" on its
 * iframe or YouTube refuses to play under this policy (Error 153; ADR-014 § 7).
 */
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Referrer-Policy": "no-referrer",
};

/**
 * Which network this run uses. A BUILD (`vite build`, what CI and every deploy run) still fails closed without
 * an explicit VITE_ZCASH_NETWORK. The local DEV SERVER on a fresh clone (no apps/web/.env yet) defaults to the safe
 * "test" network and says so — mainnet always needs an explicit `main` (`npm run dev:main`).
 */
export function resolveNetwork(explicit: string | undefined, command: 'serve' | 'build', mode: string): { network: string | undefined; defaulted: boolean } {
  if (explicit !== undefined && explicit !== '') return { network: explicit, defaulted: false };
  if (command === 'serve' && mode === 'development') return { network: 'test', defaulted: true };
  return { network: explicit, defaulted: false };
}

/**
 * The dev server's port: 5174, or WEB_PORT when that one is taken on this computer. Another port also needs the game server's ALLOWED_ORIGINS to name it. Anything that is not a
 * whole number 1024–65535 fails loudly instead of silently using another port.
 */
export function devServerPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 5174;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`WEB_PORT must be a whole number from 1024 to 65535 (got ${JSON.stringify(raw)})`);
  return port;
}

/**
 * The module behind the `@zw/content` import (src/content/README.md). ZW_CONTENT unset or empty: the deployment's
 * content module when `src/content/production/index.ts` exists, else the sample content — a tree without that
 * directory always builds the sample. `sample` forces the sample; `production` requires the deployment's module.
 */
export function contentEntry(webRoot: string, selector: string | undefined, exists: (file: string) => boolean = fs.existsSync): string {
  const production = path.join(webRoot, 'src/content/production/index.ts');
  const sample = path.join(webRoot, 'src/content/sample/index.ts');
  if (selector === undefined || selector === '') return exists(production) ? production : sample;
  if (selector === 'sample') return sample;
  if (selector === 'production') {
    if (!exists(production)) throw new Error(`ZW_CONTENT=production, but there is no production content at ${production}`);
    return production;
  }
  throw new Error(`ZW_CONTENT must be "sample", "production" or unset (got ${JSON.stringify(selector)})`);
}

/**
 * The third-party model packs present under public/assets/ (`npm run assets:fetch` downloads them): a pack counts
 * when every file assets/asset-registry.json lists for it exists. A deployment's content module may list extra packs
 * in src/content/production/asset-registry.json, which is read too when it exists. The list reaches the
 * client as VITE_ASSET_PACKS (src/assets/assetPacks.ts), which never requests a file of a missing pack, so a checkout
 * without the packs runs on the procedural placeholders. Returned as pack folders relative to public/assets/
 * ("characters/kaykit-adventures").
 */
export function installedAssetPacks(
  repoRoot: string = path.resolve(__dirname, '../..'),
  exists: (file: string) => boolean = fs.existsSync,
  read: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): string[] {
  const registryFile = path.join(repoRoot, 'assets/asset-registry.json');
  if (!exists(registryFile)) return [];
  type Pack = { location: string; files: { path: string }[] };
  const registry = JSON.parse(read(registryFile)) as Pack[];
  const contentRegistryFile = path.join(repoRoot, 'apps/web', 'src/content/production/asset-registry.json');
  if (exists(contentRegistryFile)) registry.push(...(JSON.parse(read(contentRegistryFile)) as Pack[]));
  const prefix = 'apps/web/public/assets/';
  return registry
    .filter((pack) => pack.location.startsWith(prefix) && pack.files.every((file) => exists(path.join(repoRoot, pack.location, file.path))))
    .map((pack) => pack.location.slice(prefix.length));
}

export interface WalletEngine {
  /** The vendored engine package directory. */
  readonly dir: string;
  /** The module `@chainsafe/webzjs-wallet` resolves to. */
  readonly entry: string;
  /** True when `entry` is the stand-in engine (src/zcash/core/engineStub.js). */
  readonly stub: boolean;
}

/**
 * The wallet engine of the build's network. `main` always requires the vendored mainnet engine and fails closed
 * without its binary. `test` uses the vendored test-network engine when its binary is present, else a stand-in module
 * whose every call fails with `engine_not_installed` — so a checkout without the binary still typechecks, builds and
 * runs everything except the wallet. Any other network fails closed, like apps/web/src/zcash/config.ts does at runtime.
 */
export function walletEngine(network: string | undefined, root: string = __dirname, exists: (file: string) => boolean = fs.existsSync): WalletEngine {
  const engine = (dir: string): WalletEngine => ({ dir, entry: path.join(dir, 'webzjs_wallet.js'), stub: false });
  if (network === 'main') {
    const dir = path.resolve(root, '../../vendor/webzjs-wallet-main');
    if (!exists(path.join(dir, 'webzjs_wallet_bg.wasm'))) {
      throw new Error(`FAIL_CLOSED: the wallet engine is missing at ${dir}. A main build needs the mainnet engine binary: run \`npm run engine:fetch\` (or build it with scripts/wallet-engine/build-engine.sh); a test build without a binary uses the stand-in engine.`);
    }
    return engine(dir);
  }
  if (network === 'test') {
    const dir = path.resolve(root, '../../vendor/webzjs-wallet');
    if (exists(path.join(dir, 'webzjs_wallet_bg.wasm'))) return engine(dir);
    return { dir, entry: path.resolve(root, 'src/zcash/core/engineStub.js'), stub: true };
  }
  throw new Error(`FAIL_CLOSED: VITE_ZCASH_NETWORK must be exactly "test" or "main" (got ${JSON.stringify(network)}) — see apps/web/.env.example`);
}

/**
 * A build id for the "Update ready — reload" prompt (ADR-018): VITE_BUILD_ID if set, else the
 * build's start time and a random suffix. The game server announces the id of the client it serves
 * (dist/build-id.txt, written below), and a client running an older build offers to reload.
 */
function buildId(env: Record<string, string>): string {
  return env.VITE_BUILD_ID || `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Copies the vendored wallet engine (WebZjs, ~60 MB wasm + rayon worker snippets) into dist/webzjs/
 * unchanged, except the two directory imports (`import('../../..')`) that only bundlers resolve —
 * they are pointed at webzjs_wallet.js so plain browser module loading works. With the stand-in
 * engine, dist/webzjs/ holds only the stand-in as webzjs_wallet.js.
 */
function copyWalletEngine(engine: WalletEngine, id: string): Plugin {
  const source = engine.dir;
  return {
      name: 'copy-wallet-engine',
      apply: 'build',
      closeBundle() {
        const target = path.resolve(__dirname, 'dist/webzjs');
        fs.rmSync(target, { recursive: true, force: true });
        if (engine.stub) {
          fs.mkdirSync(target, { recursive: true });
          fs.copyFileSync(engine.entry, path.join(target, 'webzjs_wallet.js'));
          fs.writeFileSync(path.resolve(__dirname, 'dist/build-id.txt'), `${id}\n`);
          return;
        }
        fs.cpSync(source, target, { recursive: true });
        const patch = (relative: string, from: string, to: string): void => {
          const file = path.join(target, relative);
          const text = fs.readFileSync(file, 'utf8');
          if (!text.includes(from)) throw new Error(`copyWalletEngine: anchor not found in ${relative}`);
          fs.writeFileSync(file, text.replace(from, to));
        };
        const rayon = fs.readdirSync(path.join(target, 'snippets')).find((dir) => dir.startsWith('wasm-bindgen-rayon-'))!;
        const thread = fs.readdirSync(path.join(target, 'snippets')).find((dir) => dir.startsWith('wasm_thread-'))!;
        patch(`snippets/${rayon}/src/workerHelpers.js`, "import('../../..')", "import('../../../webzjs_wallet.js')");
        patch(`snippets/${thread}/src/wasm32/js/web_worker_module.bundler.js`, 'from "../../../../../"', 'from "../../../../../webzjs_wallet.js"');
        fs.writeFileSync(path.resolve(__dirname, 'dist/build-id.txt'), `${id}\n`);
      },
    };
  }

/**
 * The page head's icons and link-preview tags. A deployment that ships its own artwork provides them as
 * `src/content/production/brand-head.html` (with the images under `public/brand/`); without it the page uses the
 * placeholder `favicon.svg`. `brand` tells the app whether the artwork images exist (`VITE_BRAND`).
 */
export function brandAssets(root: string = __dirname, exists: (file: string) => boolean = fs.existsSync): { head: string; brand: boolean } {
  const snippet = path.join(root, 'src/content/production/brand-head.html');
  const head = exists(snippet) ? fs.readFileSync(snippet, 'utf8').trim() : '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
  return { head, brand: exists(path.join(root, 'public/brand/logo.webp')) };
}

function brandHead(head: string): Plugin {
  return {
    name: 'brand-head',
    transformIndexHtml(html) {
      if (!html.includes('<!--zw:brand-head-->')) throw new Error('brand-head: the <!--zw:brand-head--> marker is missing from index.html');
      return html.replace('<!--zw:brand-head-->', head);
    },
  };
}

  export default defineConfig(({ mode, command }) => {
    const env = loadEnv(mode, __dirname, 'VITE_');
    const { network, defaulted } = resolveNetwork(process.env.VITE_ZCASH_NETWORK ?? env.VITE_ZCASH_NETWORK, command, mode);
    if (defaulted) console.warn('[vite] VITE_ZCASH_NETWORK is not set — the dev server uses the test network ("test"). Copy apps/web/.env.example to apps/web/.env to choose; builds always need it set.');
    const engine = walletEngine(network);
    if (engine.stub) console.warn(`[vite] No wallet engine binary at ${engine.dir}: this ${command} uses the stand-in engine, and the in-game wallet reports "not installed".`);
    const content = contentEntry(__dirname, process.env.ZW_CONTENT);
    const assetPacks = installedAssetPacks();
    const brand = brandAssets();
    const id = buildId({ ...env, ...(process.env.VITE_BUILD_ID ? { VITE_BUILD_ID: process.env.VITE_BUILD_ID } : {}) });
    return {
    plugins: [copyWalletEngine(engine, id), brandHead(brand.head)],
    define: {
      'import.meta.env.VITE_BUILD_ID': JSON.stringify(id),
      'import.meta.env.VITE_ASSET_PACKS': JSON.stringify(assetPacks.join(',')),
      'import.meta.env.VITE_BRAND': JSON.stringify(brand.brand ? '1' : ''),
      // The dev server's default reaches the app's own fail-closed check (zcash/config.ts) as an explicit value.
      ...(defaulted ? { 'import.meta.env.VITE_ZCASH_NETWORK': JSON.stringify(network) } : {}),
    },
    // The minimal CSP (staticSite.ts MINIMAL_PAGE_CSP) for `vite preview` only: there the page and the game
    // server are different origins, so the deployed full policy (staticSite.ts buildPageCsp) does not apply.
    preview: { headers: { ...crossOriginIsolation, "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" } },
    server: {
      headers: crossOriginIsolation,
      port: devServerPort(process.env.WEB_PORT),
      strictPort: true,
      // Pre-transform the app's module graph at startup so the first page load doesn't wait on on-demand transforms.
      warmup: { clientFiles: ["./src/main.ts", "./src/core/App.ts"] },
    },
    resolve: {
      alias: {
        // The engine of this build's network (dev and build alike).
        '@chainsafe/webzjs-wallet': engine.entry,
        // The content provider: the deployment's module when present, else the sample (contentEntry above).
        '@zw/content': content,
        '@chainsafe/webzjs-keys': path.resolve(__dirname, '../../node_modules/@chainsafe/webzjs-keys/webzjs_keys.js'),
      },
    },
    optimizeDeps: {
      exclude: ['@chainsafe/webzjs-wallet', '@chainsafe/webzjs-keys'],
    },
    // The wallet engine is BUNDLED: marked external, it would leave a bare
    // `import("@chainsafe/webzjs-wallet")` in the build that no browser can resolve. Vite emits the
    // ~60 MB .wasm and the rayon worker as assets; they load only when a player opens the wallet.
    worker: { format: 'es' },
    build: {
      target: 'esnext',
      chunkSizeWarningLimit: 4096,
      rollupOptions: {
        output: { format: 'es' },
      },
    },
  };
});
