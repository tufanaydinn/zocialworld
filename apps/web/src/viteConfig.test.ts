import { test } from "node:test";
import assert from "node:assert/strict";
import { brandAssets, contentEntry, devServerPort, installedAssetPacks, resolveNetwork, walletEngine } from "../vite.config.ts";

// The dev server moves off 5174 only when WEB_PORT says so.
test("devServerPort: 5174 by default, WEB_PORT when set, a bad value fails loudly", () => {
  assert.equal(devServerPort(undefined), 5174);
  assert.equal(devServerPort(""), 5174);
  assert.equal(devServerPort(" 5340 "), 5340);
  for (const bad of ["80", "70000", "5340.5", "abc", "-1"]) assert.throws(() => devServerPort(bad), /WEB_PORT/, bad);
});

// A build fails closed without a network; only the local dev server defaults to "test".
test("resolveNetwork: explicit wins; dev server defaults to test; a build does not", () => {
  assert.deepEqual(resolveNetwork("main", "serve", "development"), { network: "main", defaulted: false });
  assert.deepEqual(resolveNetwork(undefined, "serve", "development"), { network: "test", defaulted: true });
  assert.deepEqual(resolveNetwork(undefined, "build", "production"), { network: undefined, defaulted: false });
});

test("contentEntry: the deployment's content module when present, the sample otherwise; ZW_CONTENT forces either", () => {
  const root = "/web";
  const production = "/web/src/content/production/index.ts";
  const sample = "/web/src/content/sample/index.ts";
  const present = (file: string): boolean => file === production;
  const absent = (): boolean => false;
  assert.equal(contentEntry(root, undefined, present), production);
  assert.equal(contentEntry(root, "", present), production);
  assert.equal(contentEntry(root, undefined, absent), sample);
  assert.equal(contentEntry(root, "sample", present), sample);
  assert.equal(contentEntry(root, "production", present), production);
  assert.throws(() => contentEntry(root, "production", absent), /no production content/);
  assert.throws(() => contentEntry(root, "prod", present), /ZW_CONTENT/);
});

test("walletEngine: main requires the engine binary; test falls back to the stand-in without it", () => {
  const root = "/repo/apps/web";
  const all = (): boolean => true;
  const none = (): boolean => false;
  assert.deepEqual(walletEngine("main", root, all), { dir: "/repo/vendor/webzjs-wallet-main", entry: "/repo/vendor/webzjs-wallet-main/webzjs_wallet.js", stub: false });
  assert.throws(() => walletEngine("main", root, none), /FAIL_CLOSED: the wallet engine is missing/);
  assert.deepEqual(walletEngine("test", root, all), { dir: "/repo/vendor/webzjs-wallet", entry: "/repo/vendor/webzjs-wallet/webzjs_wallet.js", stub: false });
  assert.deepEqual(walletEngine("test", root, none), { dir: "/repo/vendor/webzjs-wallet", entry: "/repo/apps/web/src/zcash/core/engineStub.js", stub: true });
  for (const bad of [undefined, "", "mainnet", "regtest"]) assert.throws(() => walletEngine(bad, root, all), /FAIL_CLOSED: VITE_ZCASH_NETWORK/, String(bad));
});

test("installedAssetPacks: a pack counts only when every registered file is present", () => {
  const registry = JSON.stringify([
    { location: "apps/web/public/assets/characters/heroes", files: [{ path: "A.glb" }, { path: "LICENSE.txt" }] },
    { location: "apps/web/public/assets/props/crates", files: [{ path: "crate.glb" }] },
  ]);
  const files = new Set(["/repo/assets/asset-registry.json", "/repo/apps/web/public/assets/characters/heroes/A.glb", "/repo/apps/web/public/assets/characters/heroes/LICENSE.txt"]);
  assert.deepEqual(installedAssetPacks("/repo", (f) => files.has(f), () => registry), ["characters/heroes"]);
  files.delete("/repo/apps/web/public/assets/characters/heroes/LICENSE.txt");
  assert.deepEqual(installedAssetPacks("/repo", (f) => files.has(f), () => registry), []);
  assert.deepEqual(installedAssetPacks("/repo", () => false, () => registry), []);
});

test("installedAssetPacks: a deployment content module's own registry adds its packs when it exists", () => {
  const shared = JSON.stringify([{ location: "apps/web/public/assets/props/crates", files: [{ path: "crate.glb" }] }]);
  const content = JSON.stringify([{ location: "apps/web/public/assets/props/lamps", files: [{ path: "lamp.gltf" }] }]);
  const contentRegistry = "/repo/apps/web/src/content/production/asset-registry.json";
  const read = (file: string): string => (file === contentRegistry ? content : shared);
  const files = new Set(["/repo/assets/asset-registry.json", contentRegistry, "/repo/apps/web/public/assets/props/crates/crate.glb", "/repo/apps/web/public/assets/props/lamps/lamp.gltf"]);
  assert.deepEqual(installedAssetPacks("/repo", (f) => files.has(f), read), ["props/crates", "props/lamps"]);
  files.delete(contentRegistry);
  assert.deepEqual(installedAssetPacks("/repo", (f) => files.has(f), read), ["props/crates"]);
});

test("brandAssets: the placeholder favicon and no artwork flag unless the deployment provides its own", () => {
  const none = brandAssets("/app", () => false);
  assert.match(none.head, /favicon\.svg/);
  assert.equal(none.brand, false);
  const art = brandAssets("/app", (file) => file === "/app/public/brand/logo.webp");
  assert.equal(art.brand, true);
  assert.match(art.head, /favicon\.svg/, "artwork images without a head snippet keep the placeholder icon");
});
