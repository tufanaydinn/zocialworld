/**
 * Project data model — see
 * `docs/privacy/PROJECT_DISCOVERY_THREAT_MODEL.md`.
 *
 * Deliberately excludes anything wallet/payment-shaped (no wallet
 * address, no donation address, no payment info) — project discovery
 * must work with zero wallet connection, per the wallet/social-identity
 * separation rule in `docs/privacy/PRIVACY_MODEL.md`.
 */

/** Bounded status model — never arbitrary free text. UI renders a human-friendly label via `PROJECT_STATUS_LABELS`. */
export const PROJECT_STATUSES = ["active", "building", "beta", "paused", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active",
  building: "Building",
  beta: "Beta",
  paused: "Paused",
  archived: "Archived",
};

/** Bounded category model — prototype taxonomy, not a permanent ontology. */
export const PROJECT_CATEGORIES = [
  "wallet",
  "privacy",
  "payments",
  "defi",
  "infrastructure",
  "developer-tools",
  "social",
  "education",
  "other",
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

export const PROJECT_CATEGORY_LABELS: Record<ProjectCategory, string> = {
  wallet: "Wallet",
  privacy: "Privacy",
  payments: "Payments",
  defi: "DeFi",
  infrastructure: "Infrastructure",
  "developer-tools": "Developer Tools",
  social: "Social",
  education: "Education",
  other: "Other",
};

/**
 * Repository-curated static project data — no project
 * submission/ownership/editing exists yet. Every field here is public,
 * non-financial metadata; see `urlSafety.ts` for how the three optional
 * URL fields are validated before ever being rendered as a link.
 */
export interface Project {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly category: ProjectCategory;
  readonly status: ProjectStatus;
  readonly websiteUrl?: string;
  readonly repositoryUrl?: string;
  readonly socialUrl?: string;
  readonly tags: readonly string[];
  readonly featured: boolean;
  /** Informational — which world booth (if any) currently represents this project. The authoritative direction is the reverse: a booth references a `projectId`, not this field. */
  readonly boothId?: string;
  /** Optional, deliberately never rendered as an <img> (no image-heavy cards) — captured for a future visual pass only. */
  readonly previewImagePath?: string;
  readonly teamDisplayNames?: readonly string[];
  /** ISO 8601 date string, e.g. "2026-09-01". */
  readonly lastUpdated?: string;
  /** Hue seed (0-360) for a small accent swatch, same pattern as `RemotePlayer.colorSeed` — not an identity, just a visual tint. */
  readonly accentSeed?: number;
}
