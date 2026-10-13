import type { PlayerAvatar } from "@project/shared";
import { parseAvatar } from "../networking/protocol.ts";
import { checkNicknameLocally } from "./nicknameRules.ts";

/**
 * What this device remembers about its player between visits (ADR-015 § 7):
 * the chosen character and, for wallet holders only, the chosen name — so a returning player sees
 * "Welcome back". localStorage key `player-profile-v1`.
 *
 * Never stored: a Guest number, an address, a balance, anything else derived from the wallet, or
 * anything the server said. Every read and write is wrapped in try/catch (private mode, blocked
 * storage); corrupt data reads as "no profile", which means the first-visit flow.
 */

export const PROFILE_STORAGE_KEY = "player-profile-v1";

export type ProfileMode = "holder" | "guest";

export interface PlayerProfile {
  readonly v: 1;
  /** The character a wallet holder chose (guests never choose one — ADR-015: guests get the default character). */
  readonly avatar?: PlayerAvatar;
  /** A wallet holder's chosen name (never a Guest-####, never stored for guests). */
  readonly nickname?: string;
  /** How the player entered last time. */
  readonly lastMode: ProfileMode;
  /**
   * End-to-end tests only: skip onboarding and join as a guest at once. App honours it only in DEV
   * or VITE_TEST_HOOKS builds (playwright.config.ts seeds it through storageState).
   */
  readonly autoEnter?: "guest";
}

export type ProfileStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null where touching it throws (some privacy modes). */
export function profileStorage(): ProfileStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Validates an unknown value into a profile, or null. Optional fields that are invalid are dropped; a bad required field rejects the whole thing. */
export function parseProfile(raw: unknown): PlayerProfile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const autoEnter = value.autoEnter === "guest" ? ("guest" as const) : undefined;
  // A bare `{ autoEnter: "guest" }` (the e2e seed) is a valid, otherwise empty profile.
  if (value.v !== 1 && !(autoEnter && value.v === undefined)) return null;
  const lastMode = value.lastMode === undefined && autoEnter ? "guest" : value.lastMode;
  if (lastMode !== "holder" && lastMode !== "guest") return null;
  const avatar = parseAvatar(value.avatar);
  const name = typeof value.nickname === "string" ? checkNicknameLocally(value.nickname) : null;
  return {
    v: 1,
    lastMode,
    ...(avatar ? { avatar } : {}),
    // Names are a holder thing; a remembered name that no longer passes the rules is simply forgotten.
    ...(name?.ok && lastMode === "holder" ? { nickname: name.nickname } : {}),
    ...(autoEnter ? { autoEnter } : {}),
  };
}

export function loadProfile(storage: ProfileStorage | null = profileStorage()): PlayerProfile | null {
  try {
    const text = storage?.getItem(PROFILE_STORAGE_KEY);
    return text ? parseProfile(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** Writes the profile; false when storage is unavailable (the profile then lasts for this page only). */
export function saveProfile(profile: PlayerProfile, storage: ProfileStorage | null = profileStorage()): boolean {
  const clean = parseProfile(profile);
  if (!clean || !storage) return false;
  try {
    storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the profile entirely. */
export function clearProfile(storage: ProfileStorage | null = profileStorage()): void {
  try {
    storage?.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing was stored either.
  }
}

/**
 * The profile to remember after entering. A holder's choice is kept; a guest entry keeps a previous
 * holder's character and name only when the player chose "Enter as guest" from "Welcome back"
 * (`keepRemembered`) — "Forget this wallet" passes false and drops the name.
 */
export function profileAfterEntering(
  previous: PlayerProfile | null,
  entered: { readonly mode: ProfileMode; readonly avatar?: PlayerAvatar | null; readonly nickname?: string | null },
  keepRemembered = true,
): PlayerProfile {
  // A test-seeded autoEnter flag survives (so a reload in the same e2e context still skips onboarding); nothing else writes it.
  const test = previous?.autoEnter ? { autoEnter: previous.autoEnter } : {};
  if (entered.mode === "holder") {
    const avatar = entered.avatar ?? previous?.avatar;
    const nickname = entered.nickname ?? previous?.nickname;
    return { v: 1, lastMode: "holder", ...(avatar ? { avatar } : {}), ...(nickname ? { nickname } : {}), ...test };
  }
  if (keepRemembered && previous?.lastMode === "holder") {
    return { v: 1, lastMode: "holder", ...(previous.avatar ? { avatar: previous.avatar } : {}), ...(previous.nickname ? { nickname: previous.nickname } : {}), ...test };
  }
  return { v: 1, lastMode: "guest", ...(previous?.avatar ? { avatar: previous.avatar } : {}), ...test };
}
