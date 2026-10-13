import * as THREE from "three";
import { PLAYER_AVATAR_COLOR_COUNT } from "@project/shared";

/**
 * The eight avatar colours (ADR-015). The wire carries a palette index
 * (`PlayerAvatar.color`, 0 .. PLAYER_AVATAR_COLOR_COUNT - 1); this file is the only place the
 * colours themselves live.
 *
 * Same saturation and lightness as the pre-ADR-015 per-session accent (`hsl(colorSeed, 55%, 50%)`),
 * at eight well-separated hues. The ZEC-gold band (40–50°) is skipped on purpose, so no player's
 * colour can pass for an official ZEC badge or the gold of the payment UI.
 *
 * The KayKit models share one atlas material, so the colour is an ACCENT — the placeholder's belt
 * and hat (low tier), the nameplate underline, the player-menu chip and the preview's base ring —
 * never a tint on the model itself.
 */
export const AVATAR_PALETTE_HUES: readonly number[] = [0, 25, 140, 175, 205, 235, 275, 320];
const SATURATION = 0.55;
const LIGHTNESS = 0.5;

/** Human names for the swatches (screen readers, tooltips). */
export const AVATAR_COLOR_NAMES: readonly string[] = ["Red", "Orange", "Green", "Teal", "Sky", "Blue", "Violet", "Pink"];

if (AVATAR_PALETTE_HUES.length !== PLAYER_AVATAR_COLOR_COUNT || AVATAR_COLOR_NAMES.length !== PLAYER_AVATAR_COLOR_COUNT) {
  throw new Error("avatar palette must have PLAYER_AVATAR_COLOR_COUNT entries");
}

/** A valid palette index for any number (out-of-range or non-integer values wrap/truncate — never throws). */
export function paletteIndex(color: number): number {
  const index = Math.trunc(Number.isFinite(color) ? color : 0) % PLAYER_AVATAR_COLOR_COUNT;
  return index < 0 ? index + PLAYER_AVATAR_COLOR_COUNT : index;
}

/** The colour of palette entry `color` as a THREE.Color (placeholder accent, preview ring). */
export function avatarColor(color: number): THREE.Color {
  return new THREE.Color().setHSL(AVATAR_PALETTE_HUES[paletteIndex(color)]! / 360, SATURATION, LIGHTNESS);
}

/** The same colour as a CSS string (nameplate underline, menu chip, swatches). */
export function avatarColorCss(color: number): string {
  return `#${avatarColor(color).getHexString()}`;
}
