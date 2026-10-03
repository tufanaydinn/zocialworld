import { injectUiStyles } from "../ui/styles.ts";
import type { Project } from "./ProjectTypes.ts";
import { PROJECT_CATEGORY_LABELS, PROJECT_STATUS_LABELS } from "./ProjectTypes.ts";
import { createSafeExternalLink, isSafeExternalUrl } from "./urlSafety.ts";

/**
 * Renders a single project's detail view (CORE-005 § 14). Not its own
 * modal/backdrop — `ProjectDiscoveryPanel` owns the one backdrop and
 * swaps this view in/out, same reasoning the existing codebase already
 * uses one `.zw-modal-backdrop` per concern rather than stacking
 * multiple overlays (see `tests/e2e/README.md`'s note on
 * `.zw-player-card-backdrop` existing specifically to avoid colliding
 * with `.zw-modal-backdrop`).
 *
 * Security (CORE-005 § 39): every piece of project text is rendered via
 * `textContent` — never `innerHTML`, never string-concatenated markup.
 * Links only ever render through `createSafeExternalLink()`, which
 * itself refuses anything that isn't `isSafeExternalUrl()`-checked
 * `http`/`https` (CORE-005 § 15) — a missing optional URL simply never
 * produces a link element at all (CORE-005 § 14: "Links must only
 * render if present"), never a dead/disabled button.
 */
export class ProjectDetailPanel {
  readonly element: HTMLDivElement;

  private readonly backButton: HTMLButtonElement;
  private readonly accentSwatch: HTMLSpanElement;
  private readonly nameHeading: HTMLHeadingElement;
  private readonly statusBadge: HTMLSpanElement;
  private readonly categoryBadge: HTMLSpanElement;
  private readonly shortDescription: HTMLParagraphElement;
  private readonly longDescription: HTMLParagraphElement;
  private readonly tagsRow: HTMLDivElement;
  private readonly linksRow: HTMLDivElement;

  constructor(onBack: () => void) {
    injectUiStyles();

    this.element = document.createElement("div");
    this.element.className = "zw-project-detail";

    this.backButton = document.createElement("button");
    this.backButton.type = "button";
    this.backButton.className = "zw-button";
    this.backButton.textContent = "← Back to projects";
    this.backButton.addEventListener("click", onBack);
    this.element.appendChild(this.backButton);

    const header = document.createElement("div");
    header.className = "zw-project-detail-header";

    this.accentSwatch = document.createElement("span");
    this.accentSwatch.className = "zw-player-context-swatch";
    header.appendChild(this.accentSwatch);

    this.nameHeading = document.createElement("h2");
    header.appendChild(this.nameHeading);
    this.element.appendChild(header);

    const badges = document.createElement("div");
    badges.className = "zw-project-detail-badges";
    this.statusBadge = document.createElement("span");
    this.statusBadge.className = "zw-project-detail-badge";
    this.categoryBadge = document.createElement("span");
    this.categoryBadge.className = "zw-project-detail-badge";
    badges.appendChild(this.statusBadge);
    badges.appendChild(this.categoryBadge);
    this.element.appendChild(badges);

    this.shortDescription = document.createElement("p");
    this.shortDescription.className = "zw-modal-subtitle";
    this.element.appendChild(this.shortDescription);

    this.longDescription = document.createElement("p");
    this.element.appendChild(this.longDescription);

    this.tagsRow = document.createElement("div");
    this.tagsRow.className = "zw-project-detail-tags";
    this.element.appendChild(this.tagsRow);

    this.linksRow = document.createElement("div");
    this.linksRow.className = "zw-project-detail-links";
    this.element.appendChild(this.linksRow);
  }

  render(project: Project): void {
    this.accentSwatch.style.background = `hsl(${project.accentSeed ?? 0}, 55%, 50%)`;
    this.nameHeading.textContent = project.name; // textContent only
    this.statusBadge.textContent = PROJECT_STATUS_LABELS[project.status];
    this.categoryBadge.textContent = PROJECT_CATEGORY_LABELS[project.category];
    this.shortDescription.textContent = project.shortDescription;
    this.longDescription.textContent = project.description;

    this.tagsRow.replaceChildren(
      ...project.tags.map((tag) => {
        const span = document.createElement("span");
        span.className = "zw-project-tag";
        span.textContent = tag;
        return span;
      }),
    );

    const links: HTMLAnchorElement[] = [];
    if (isSafeExternalUrl(project.websiteUrl)) links.push(createSafeExternalLink(project.websiteUrl, "Website"));
    if (isSafeExternalUrl(project.repositoryUrl)) links.push(createSafeExternalLink(project.repositoryUrl, "Repository"));
    if (isSafeExternalUrl(project.socialUrl)) links.push(createSafeExternalLink(project.socialUrl, "Social"));
    for (const link of links) link.className = "zw-button";
    this.linksRow.replaceChildren(...links);
  }
}
