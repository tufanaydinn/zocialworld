import {
  HALL_CARD_LINK_HOSTS,
  HALL_CARD_LINKS_MAX,
  HALL_CARD_NAME_MAX,
  HALL_CARD_TITLE_MAX,
  HALL_LINK_KINDS,
  type HallCard,
  type HallCardLink,
  type HallLinkKind,
} from "@project/shared";
import { cleanHallCardUrl, sanitizeHallText, validateHallCard } from "./hallCard.ts";

/**
 * The stage widget's "Edit card" form (docs/architecture/WATCH_HALL.md):
 * turns what the holder or a host typed into a HallCard, with one short message per bad field,
 * BEFORE anything is sent — the server drops an invalid card with `hall_error{card, invalid}` and
 * an oversized frame silently. The rules are hallCard.ts's (the mirror of the server's); this only
 * adds friendly messages and the small conveniences of a form (blank link rows are ignored, a
 * bare "github.com/…" gets "https://"). Pure: no DOM.
 */

export interface CardLinkDraft {
  readonly kind: HallLinkKind;
  readonly url: string;
}

export interface CardDraft {
  readonly title: string;
  readonly speaker: string;
  readonly project: string;
  /** Up to HALL_CARD_LINKS_MAX rows; rows with an empty URL are ignored. */
  readonly links: readonly CardLinkDraft[];
  /** Kept from the card being edited (set from the Watch catalogue; not editable in the form). */
  readonly videoId?: string;
  readonly eventId?: string;
}

/** Form field ids: "title", "speaker", "project", "link0" … "link3", and "links" for the whole list. */
export type CardFormErrors = Partial<Record<string, string>>;

export type CardFormResult = { readonly ok: true; readonly card: HallCard } | { readonly ok: false; readonly errors: CardFormErrors };

const LINK_LABELS: Record<HallLinkKind, string> = { github: "GitHub", docs: "Docs", zechub: "ZecHub", forum: "Forum", web: "Website" };

/** A short label for a link kind ("GitHub", "Docs", "ZecHub", "Forum", "Website"). */
export function linkKindLabel(kind: HallLinkKind): string {
  return LINK_LABELS[kind];
}

/** The form's starting values: the current card, or empty. */
export function draftFromCard(card: Readonly<HallCard> | null): CardDraft {
  return {
    title: card?.title ?? "",
    speaker: card?.speaker ?? "",
    project: card?.project ?? "",
    links: (card?.links ?? []).map((link) => ({ kind: link.kind, url: link.url })),
    ...(card?.videoId ? { videoId: card.videoId } : {}),
    ...(card?.eventId ? { eventId: card.eventId } : {}),
  };
}

/** The link kind a URL most likely is (pre-selects the kind while the user types a URL). */
export function suggestLinkKind(raw: string): HallLinkKind {
  let host = "";
  try {
    host = new URL(withScheme(raw.trim())).hostname.toLowerCase();
  } catch {
    return "web";
  }
  if (host === "github.com") return "github";
  if (host === "zechub.wiki" || host === "www.zechub.wiki") return "zechub";
  if (host === "forum.zcashcommunity.com") return "forum";
  if (host === "zips.z.cash" || host === "zcash.readthedocs.io") return "docs";
  return "web";
}

/** "github.com/x" → "https://github.com/x"; anything with a scheme is left alone (so http:// is refused, not upgraded). */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

const HOSTS_HINT = `${HALL_CARD_LINK_HOSTS.filter((host) => !host.startsWith("www.")).slice(0, 4).join(", ")} …`;

/** Validates the form. On success the card is exactly what the server accepts (re-checked with validateHallCard). */
export function parseCardDraft(draft: CardDraft): CardFormResult {
  const errors: CardFormErrors = {};
  const title = sanitizeHallText(draft.title, HALL_CARD_TITLE_MAX);
  if (title === null) errors.title = "Give the card a title.";
  else if (title === "too_long") errors.title = `The title can be at most ${HALL_CARD_TITLE_MAX} characters.`;

  const names: Partial<Record<"speaker" | "project", string>> = {};
  for (const field of ["speaker", "project"] as const) {
    const clean = sanitizeHallText(draft[field], HALL_CARD_NAME_MAX);
    if (clean === "too_long") errors[field] = `At most ${HALL_CARD_NAME_MAX} characters.`;
    else if (clean !== null) names[field] = clean;
  }

  const links: HallCardLink[] = [];
  const rows = draft.links.map((row, index) => ({ row, index })).filter(({ row }) => row.url.trim() !== "");
  if (rows.length > HALL_CARD_LINKS_MAX) errors.links = `At most ${HALL_CARD_LINKS_MAX} links.`;
  for (const { row, index } of rows.slice(0, HALL_CARD_LINKS_MAX)) {
    const key = `link${index}`;
    if (!(HALL_LINK_KINDS as readonly string[]).includes(row.kind)) {
      errors[key] = "Choose what kind of link this is.";
      continue;
    }
    const raw = withScheme(row.url.trim());
    if (/^http:/i.test(raw)) {
      errors[key] = "Links must start with https://";
      continue;
    }
    const url = cleanHallCardUrl(raw);
    if (url === null) {
      errors[key] = `Use an https link on ${HOSTS_HINT}`;
      continue;
    }
    links.push({ kind: row.kind, url });
  }

  if (Object.keys(errors).length > 0 || title === null || title === "too_long") return { ok: false, errors };
  const candidate: HallCard = { title, ...names };
  if (links.length > 0) candidate.links = links;
  if (draft.eventId) candidate.eventId = draft.eventId;
  if (draft.videoId) candidate.videoId = draft.videoId;
  const card = validateHallCard(candidate);
  return card ? { ok: true, card } : { ok: false, errors: { title: "That card isn't valid." } };
}
