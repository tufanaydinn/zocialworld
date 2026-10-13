import { test } from "node:test";
import assert from "node:assert/strict";
import { AssetManager } from "./AssetManager.ts";
import { AssetPackMissingError, assetPackOf, installedAssetPacks, isAssetAvailable } from "./assetPacks.ts";

test("assetPackOf names the pack folder of a runtime asset URL", () => {
  assert.equal(assetPackOf("/assets/props/kaykit-dungeon/keg.glb"), "props/kaykit-dungeon");
  assert.equal(assetPackOf("/assets/environment/kenney-fantasy-town/Textures/colormap.png"), "environment/kenney-fantasy-town");
  assert.equal(assetPackOf("/assets/favicon.svg"), null);
  assert.equal(assetPackOf("/favicon.svg"), null);
});

test("installedAssetPacks parses the build's list; an unset list means every pack is assumed present", () => {
  assert.equal(installedAssetPacks(undefined), null);
  assert.deepEqual([...installedAssetPacks("characters/kaykit-adventures, props/kaykit-dungeon")!], ["characters/kaykit-adventures", "props/kaykit-dungeon"]);
  assert.equal(installedAssetPacks("")!.size, 0);
});

test("isAssetAvailable refuses only files of packs known to be missing", () => {
  const installed = new Set(["props/kaykit-dungeon"]);
  assert.equal(isAssetAvailable("/assets/props/kaykit-dungeon/keg.glb", installed), true);
  assert.equal(isAssetAvailable("/assets/characters/kaykit-adventures/Mage.glb", installed), false);
  assert.equal(isAssetAvailable("/assets/characters/kaykit-adventures/Mage.glb", null), true);
  assert.equal(isAssetAvailable("/textures/sky.png", new Set()), true);
});

test("AssetManager rejects a missing pack's file without a request, and keeps rejecting it", async () => {
  const manager = new AssetManager();
  // Unit tests run without a build, so the manager assumes every pack is present; give it an empty list instead.
  (manager as unknown as { installedPacks: ReadonlySet<string> }).installedPacks = new Set();
  await assert.rejects(manager.loadGltf("/assets/characters/kaykit-adventures/Mage.glb"), AssetPackMissingError);
  await assert.rejects(manager.instantiate("/assets/characters/kaykit-adventures/Mage.glb"), AssetPackMissingError);
});
