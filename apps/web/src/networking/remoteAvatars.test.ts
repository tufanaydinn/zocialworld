import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAYER_AVATAR_COLOR_COUNT, PLAYER_AVATAR_MODELS, defaultPlayerAvatar } from "@project/shared";
import { AVATAR_MODELS } from "../player/avatarModels.ts";
import { avatarModelFor, npcModelFor } from "./remoteAvatars.ts";
import { AVATAR_PALETTE_HUES, avatarColor, avatarColorCss, paletteIndex } from "../player/avatarPalette.ts";

// ADR-015: the default avatar keeps every player's pre-ADR-015 look; the palette avoids ZEC gold.

test("the default avatar's model is exactly the pre-ADR-015 avatarModelFor(colorSeed) for every seed the server can send", () => {
  for (let seed = 0; seed < 360; seed++) assert.equal(npcModelFor(defaultPlayerAvatar(seed).model), avatarModelFor(seed), `colorSeed ${seed}`);
});

test("wire model ids and the KayKit models line up one to one, in the same order", () => {
  assert.equal(PLAYER_AVATAR_MODELS.length, AVATAR_MODELS.length);
  PLAYER_AVATAR_MODELS.forEach((model, index) => assert.equal(npcModelFor(model), AVATAR_MODELS[index]));
});

test("the palette has PLAYER_AVATAR_COLOR_COUNT distinct colours at s 0.55 / l 0.5, none in the ZEC-gold band (40–50°)", () => {
  assert.equal(AVATAR_PALETTE_HUES.length, PLAYER_AVATAR_COLOR_COUNT);
  for (const hue of AVATAR_PALETTE_HUES) assert.ok(hue < 40 || hue > 50, `hue ${hue}`);
  const css = new Set(AVATAR_PALETTE_HUES.map((_, index) => avatarColorCss(index)));
  assert.equal(css.size, PLAYER_AVATAR_COLOR_COUNT);
  const hsl = { h: 0, s: 0, l: 0 };
  avatarColor(4).getHSL(hsl);
  assert.ok(Math.abs(hsl.s - 0.55) < 0.01 && Math.abs(hsl.l - 0.5) < 0.01);
  assert.equal(paletteIndex(9), 1, "out-of-range indices wrap instead of throwing");
  assert.equal(paletteIndex(-1), 7);
});
