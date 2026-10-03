import { PROJECTS } from "./projectData.ts";
import { PROJECT_CATEGORIES, PROJECT_STATUSES, type Project, type ProjectCategory } from "./ProjectTypes.ts";
import { isSafeExternalUrl } from "./urlSafety.ts";

/**
 * CORE-005 § 9: the one reusable source of truth for project data.
 * Booth interactions, the discovery list, and the detail panel all
 * query through here — none of them hold a second copy of project
 * metadata (task brief's explicit "avoid duplicating project metadata"
 * requirement).
 *
 * `PROJECTS` is validated once, at module load (see `validateProjects()`
 * below) — an invalid static registry fails loudly at import time
 * rather than silently breaking interactions later (task brief § 30).
 */
validateProjects(PROJECTS);

/** CORE-005 § 30: throws with a specific, actionable message for the first problem found. Exported for its own direct unit test coverage. */
export function validateProjects(projects: readonly Project[]): void {
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();

  for (const project of projects) {
    if (seenIds.has(project.id)) throw new Error(`ProjectRegistry: duplicate project id "${project.id}"`);
    seenIds.add(project.id);

    if (seenSlugs.has(project.slug)) throw new Error(`ProjectRegistry: duplicate project slug "${project.slug}"`);
    seenSlugs.add(project.slug);

    if (!project.name.trim()) throw new Error(`ProjectRegistry: project "${project.id}" has an empty name`);

    if (!(PROJECT_STATUSES as readonly string[]).includes(project.status)) {
      throw new Error(`ProjectRegistry: project "${project.id}" has an invalid status "${project.status}"`);
    }

    if (!(PROJECT_CATEGORIES as readonly string[]).includes(project.category)) {
      throw new Error(`ProjectRegistry: project "${project.id}" has an invalid category "${project.category}"`);
    }

    if (!project.tags.every((tag) => typeof tag === "string")) {
      throw new Error(`ProjectRegistry: project "${project.id}" has a non-string tag`);
    }

    for (const [field, value] of [
      ["websiteUrl", project.websiteUrl],
      ["repositoryUrl", project.repositoryUrl],
      ["socialUrl", project.socialUrl],
    ] as const) {
      if (value !== undefined && !isSafeExternalUrl(value)) {
        throw new Error(`ProjectRegistry: project "${project.id}" has an unsafe ${field} "${value}"`);
      }
    }
  }
}

export function getAllProjects(): readonly Project[] {
  return PROJECTS;
}

export function getProjectById(id: string): Project | undefined {
  return PROJECTS.find((project) => project.id === id);
}

export function getProjectBySlug(slug: string): Project | undefined {
  return PROJECTS.find((project) => project.slug === slug);
}

export function getFeaturedProjects(): readonly Project[] {
  return PROJECTS.filter((project) => project.featured);
}

export function getProjectsByCategory(category: ProjectCategory): readonly Project[] {
  return PROJECTS.filter((project) => project.category === category);
}

/** Every category actually present in the current registry, in `PROJECT_CATEGORIES` order — used to build filter UI without empty categories. */
export function getUsedCategories(): readonly ProjectCategory[] {
  const present = new Set(PROJECTS.map((project) => project.category));
  return PROJECT_CATEGORIES.filter((category) => present.has(category));
}

/**
 * Case-insensitive substring match against name, short description, and
 * tags (task brief § 10) — deterministic, no fuzzy-search dependency.
 * An empty/whitespace-only query returns every project, so callers can
 * always route through this function rather than branching on "is there
 * a query" themselves.
 */
export function searchProjects(query: string, projects: readonly Project[] = PROJECTS): readonly Project[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;

  return projects.filter((project) => {
    if (project.name.toLowerCase().includes(needle)) return true;
    if (project.shortDescription.toLowerCase().includes(needle)) return true;
    return project.tags.some((tag) => tag.toLowerCase().includes(needle));
  });
}
