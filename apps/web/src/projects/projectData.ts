import type { Project } from "./ProjectTypes.ts";

/**
 * CORE-005 § 8: a small, clearly-fictional fixture dataset — not real
 * Zcash ecosystem projects, not final branding, no implied partnership
 * or endorsement. Repository-curated static data only (§ 36); there is
 * no project submission/ownership/editing system yet.
 *
 * Deliberately contains no wallet address, donation address, payment
 * info, or any other financial/user-private field — see `ProjectTypes.ts`.
 */
export const PROJECTS: readonly Project[] = [
  {
    id: "shieldkit",
    slug: "shieldkit",
    name: "ShieldKit",
    shortDescription: "A developer SDK for adding shielded-by-default flows to apps.",
    description:
      "ShieldKit is a prototype SDK concept for wiring shielded-by-default transaction flows into third-party applications, so developers don't have to think about privacy as an opt-in afterthought. Fictional prototype project — not a real, verified, or endorsed ecosystem entry.",
    category: "privacy",
    status: "active",
    websiteUrl: "https://shieldkit.example",
    repositoryUrl: "https://github.com/example/shieldkit",
    tags: ["sdk", "privacy", "developer-tools"],
    featured: true,
    boothId: "booth-shieldkit",
    accentSeed: 160,
  },
  {
    id: "privatepay",
    slug: "privatepay",
    name: "PrivatePay",
    shortDescription: "A point-of-sale concept for private, everyday payments.",
    description:
      "PrivatePay is a fictional point-of-sale prototype exploring what a private-by-default checkout experience could look like for small merchants. CORE-005 lists it as prototype/static data only — no real payment flow exists anywhere in this project yet.",
    category: "payments",
    status: "beta",
    websiteUrl: "https://privatepay.example",
    socialUrl: "https://social.example/privatepay",
    tags: ["payments", "pos", "merchants"],
    featured: true,
    boothId: "booth-privatepay",
    accentSeed: 30,
  },
  {
    id: "zk-forge",
    slug: "zk-forge",
    name: "ZK Forge",
    shortDescription: "Tooling to make zero-knowledge circuit development less painful.",
    description:
      "ZK Forge is a fictional developer-tooling concept for zero-knowledge circuit authoring, testing, and debugging. Presented here purely as prototype fixture data for CORE-005's project discovery system.",
    category: "developer-tools",
    status: "building",
    repositoryUrl: "https://github.com/example/zk-forge",
    tags: ["zero-knowledge", "developer-tools", "tooling"],
    featured: false,
    boothId: "booth-zk-forge",
    accentSeed: 265,
  },
  {
    id: "orchard-tools",
    slug: "orchard-tools",
    name: "Orchard Tools",
    shortDescription: "Infrastructure utilities for running and monitoring shielded-pool nodes.",
    description:
      "Orchard Tools is a fictional infrastructure-tooling concept covering node monitoring, health dashboards, and operational utilities for shielded-pool infrastructure. Fixture data only — not a real, operating service.",
    category: "infrastructure",
    status: "active",
    websiteUrl: "https://orchardtools.example",
    repositoryUrl: "https://github.com/example/orchard-tools",
    tags: ["infrastructure", "nodes", "monitoring"],
    featured: false,
    boothId: "booth-orchard-tools",
    accentSeed: 95,
  },
  {
    id: "cipher-market",
    slug: "cipher-market",
    name: "Cipher Market",
    shortDescription: "A prototype marketplace concept exploring private listings.",
    description:
      "Cipher Market is a fictional marketplace concept exploring what private, shielded-friendly listings could look like for a peer-to-peer goods marketplace. No real marketplace, listings, or transactions exist — this is prototype fixture data only.",
    category: "defi",
    status: "beta",
    websiteUrl: "https://ciphermarket.example",
    tags: ["marketplace", "defi"],
    featured: false,
    accentSeed: 200,
  },
  {
    id: "lantern-relay",
    slug: "lantern-relay",
    name: "Lantern Relay",
    shortDescription: "A lightweight relay concept for private builder-to-builder messaging.",
    description:
      "Lantern Relay is a fictional lightweight-relay concept for private messaging between ecosystem builders. It is paused as a fixture entry to exercise CORE-005's non-active status rendering — there is no real relay service behind this name.",
    category: "social",
    status: "paused",
    tags: ["messaging", "relay", "social"],
    featured: false,
    accentSeed: 40,
  },
  {
    id: "quiet-realms",
    slug: "quiet-realms",
    name: "Quiet Realms",
    shortDescription: "An educational hub concept for Zcash-native privacy concepts.",
    description:
      "Quiet Realms is a fictional educational-content concept intended to explain Zcash-native privacy concepts to newcomers. Marked archived here purely as fixture data to exercise CORE-005's full status range — not a real, currently-operating educational resource.",
    category: "education",
    status: "archived",
    socialUrl: "https://social.example/quietrealms",
    tags: ["education", "community"],
    featured: false,
    accentSeed: 285,
  },
];
