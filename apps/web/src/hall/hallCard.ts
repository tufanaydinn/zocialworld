import {
  HALL_CARD_LINK_HOSTS,
  HALL_CARD_LINKS_MAX,
  HALL_CARD_NAME_MAX,
  HALL_CARD_TITLE_MAX,
  HALL_CARD_URL_MAX,
  HALL_EVENT_ID_PATTERN,
  HALL_LINK_KINDS,
  HALL_VIDEO_ID_PATTERN,
  type HallCard,
  type HallCardLink,
  type HallLinkKind,
} from "@project/shared";

/**
 * Speaker / project card rules on the client (docs/architecture/WATCH_HALL.md).
 * The server is the authority (apps/server/src/watchHall.ts validateHallCard); this mirrors it so
 * the client re-validates every card it receives (protocol.ts) and the stage UI can check a card
 * before sending it (a frame over MAX_MESSAGE_BYTES is dropped silently by the server).
 * Pure: no DOM. Cards are rendered with textContent only.
 */

/** Same cleanup as the server's chat sanitizer: controls, bidi overrides/isolates, zero-width and BOM become spaces; whitespace collapses. */
export function sanitizeHallText(raw: string, maxLength: number): string | null | "too_long" {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if ([...cleaned].length > maxLength) return "too_long";
  return cleaned;
}

/** `https://` on exactly one of HALL_CARD_LINK_HOSTS, no credentials, no port, ≤ HALL_CARD_URL_MAX. Returns the normalised URL or null. */
export function cleanHallCardUrl(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (raw.length > HALL_CARD_URL_MAX || /[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (!(HALL_CARD_LINK_HOSTS as readonly string[]).includes(url.hostname)) return null;
  return url.href.length <= HALL_CARD_URL_MAX ? url.href : null;
}

/** Shape + content check of an untrusted card. Returns a fresh card holding only known, clean fields, or null. */
export function validateHallCard(raw: unknown): HallCard | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.title !== "string") return null;
  const title = sanitizeHallText(value.title, HALL_CARD_TITLE_MAX);
  if (title === null || title === "too_long") return null;
  const card: HallCard = { title };
  for (const field of ["speaker", "project"] as const) {
    const text = value[field];
    if (text === undefined) continue;
    if (typeof text !== "string") return null;
    const clean = sanitizeHallText(text, HALL_CARD_NAME_MAX);
    if (clean === "too_long") return null;
    if (clean !== null) card[field] = clean;
  }
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > HALL_CARD_LINKS_MAX) return null;
    const links: HallCardLink[] = [];
    for (const entry of value.links as unknown[]) {
      if (typeof entry !== "object" || entry === null) return null;
      const link = entry as Record<string, unknown>;
      if (typeof link.kind !== "string" || !(HALL_LINK_KINDS as readonly string[]).includes(link.kind) || typeof link.url !== "string") return null;
      const url = cleanHallCardUrl(link.url);
      if (url === null) return null;
      links.push({ kind: link.kind as HallLinkKind, url });
    }
    if (links.length > 0) card.links = links;
  }
  if (value.eventId !== undefined) {
    if (typeof value.eventId !== "string" || !HALL_EVENT_ID_PATTERN.test(value.eventId)) return null;
    card.eventId = value.eventId;
  }
  if (value.videoId !== undefined) {
    if (typeof value.videoId !== "string" || !HALL_VIDEO_ID_PATTERN.test(value.videoId)) return null;
    card.videoId = value.videoId;
  }
  return card;
}
