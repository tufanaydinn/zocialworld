import { injectUiStyles } from "../ui/styles.ts";
import { ProjectDetailPanel } from "./ProjectDetailPanel.ts";
import { getAllProjects, getFeaturedProjects, getProjectById, getProjectsByCategory, getUsedCategories, searchProjects } from "./ProjectRegistry.ts";
import { PROJECT_CATEGORY_LABELS, PROJECT_STATUS_LABELS, type Project, type ProjectCategory } from "./ProjectTypes.ts";

type DiscoveryFilter = "all" | "featured" | ProjectCategory;

/**
 * Prototype project discovery UI (CORE-005 §§ 16-19) — opened via the
 * existing "View Projects" board interaction (CORE-001's
 * `buildProjectBoard`, unchanged) or directly to a specific project via
 * `openProject()` (used by `ProjectBoothInteractable`). Reuses the same
 * `.zw-modal-backdrop`/`.zw-panel.zw-modal` structure and `open`/`close`/
 * `isOpen`/`dispose` API the CORE-001 placeholder panel it replaces
 * already had, so `App.ts`'s wiring (Esc-to-close, dispose on teardown)
 * needs no new code path — see that file's own comments.
 *
 * One backdrop, two views (list and detail), toggled in place — not two
 * stacked modals. Keeps `.zw-modal-backdrop` unique in the DOM, which
 * `tests/e2e/README.md` already documents as something the existing
 * CORE-001 suite assumes.
 */
export class ProjectDiscoveryPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly listView: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly filterRow: HTMLDivElement;
  private readonly cardsContainer: HTMLDivElement;
  private readonly detailPanel: ProjectDetailPanel;

  private readonly filterButtons = new Map<DiscoveryFilter, HTMLButtonElement>();
  private activeFilter: DiscoveryFilter = "all";

  constructor(container: HTMLElement) {
    injectUiStyles();

    this.backdrop = document.createElement("div");
    this.backdrop.className = "zw-ui zw-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "zw-panel zw-modal";

    const heading = document.createElement("h2");
    heading.textContent = "Builders Hall — Projects";
    modal.appendChild(heading);

    const subtitle = document.createElement("p");
    subtitle.className = "zw-modal-subtitle";
    subtitle.textContent = "Prototype project discovery — a static, repository-curated registry. Not final data, not a project submission system.";
    modal.appendChild(subtitle);

    this.listView = document.createElement("div");
    this.listView.className = "zw-project-discovery-list-view";

    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.className = "zw-input";
    this.searchInput.placeholder = "Search projects…";
    this.searchInput.addEventListener("input", () => this.renderCards());
    this.searchInput.addEventListener("keydown", (event) => event.stopPropagation()); // CORE-003/004 pattern: never let a typed key reach InputManager
    this.listView.appendChild(this.searchInput);

    this.filterRow = document.createElement("div");
    this.filterRow.className = "zw-project-discovery-filters";
    this.buildFilterButtons();
    this.listView.appendChild(this.filterRow);

    this.cardsContainer = document.createElement("div");
    this.cardsContainer.className = "zw-project-discovery-cards";
    this.listView.appendChild(this.cardsContainer);

    modal.appendChild(this.listView);

    this.detailPanel = new ProjectDetailPanel(() => this.showList());
    this.detailPanel.element.classList.add("zw-project-discovery-hidden");
    modal.appendChild(this.detailPanel.element);

    const closeHint = document.createElement("div");
    closeHint.className = "zw-modal-close-hint";
    closeHint.textContent = "Press Esc or click outside to close";
    modal.appendChild(closeHint);

    this.backdrop.appendChild(modal);
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });

    container.appendChild(this.backdrop);
  }

  private buildFilterButtons(): void {
    const entries: Array<[DiscoveryFilter, string]> = [
      ["all", "All"],
      ["featured", "Featured"],
      ...getUsedCategories().map((category): [DiscoveryFilter, string] => [category, PROJECT_CATEGORY_LABELS[category]]),
    ];

    for (const [filter, label] of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "zw-button";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.activeFilter = filter;
        this.updateFilterButtonStyles();
        this.renderCards();
      });
      this.filterButtons.set(filter, button);
      this.filterRow.appendChild(button);
    }
  }

  private updateFilterButtonStyles(): void {
    for (const [filter, button] of this.filterButtons) {
      button.classList.toggle("zw-button-primary", filter === this.activeFilter);
    }
  }

  private currentlyFilteredProjects(): readonly Project[] {
    const byFilter =
      this.activeFilter === "all"
        ? getAllProjects()
        : this.activeFilter === "featured"
          ? getFeaturedProjects()
          : getProjectsByCategory(this.activeFilter);

    return searchProjects(this.searchInput.value, byFilter);
  }

  private renderCards(): void {
    const projects = this.currentlyFilteredProjects();

    if (projects.length === 0) {
      const empty = document.createElement("p");
      empty.className = "zw-modal-subtitle";
      empty.textContent = "No projects match that search/filter.";
      this.cardsContainer.replaceChildren(empty);
      return;
    }

    this.cardsContainer.replaceChildren(
      ...projects.map((project) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "zw-project-card zw-project-card-button";
        card.addEventListener("click", () => this.showDetail(project.id));

        const name = document.createElement("div");
        name.className = "zw-project-name";
        name.textContent = project.name;
        card.appendChild(name);

        const meta = document.createElement("div");
        meta.className = "zw-project-stage";
        meta.textContent = `${PROJECT_CATEGORY_LABELS[project.category]} · ${PROJECT_STATUS_LABELS[project.status]}`;
        card.appendChild(meta);

        const pitch = document.createElement("p");
        pitch.textContent = project.shortDescription;
        card.appendChild(pitch);

        return card;
      }),
    );
  }

  private showList(): void {
    this.listView.classList.remove("zw-project-discovery-hidden");
    this.detailPanel.element.classList.add("zw-project-discovery-hidden");
    this.renderCards();
  }

  private showDetail(projectId: string): void {
    const project = getProjectById(projectId);
    if (!project) {
      // Should never happen — every caller (card clicks, booth
      // interactions) only ever passes an id that already exists in
      // the registry. Fail back to the list rather than show a blank
      // detail view if it somehow does.
      console.warn(`ProjectDiscoveryPanel: unknown projectId "${projectId}"`);
      this.showList();
      return;
    }

    this.activateDetailView(project);
  }

  private activateDetailView(project: Project): void {
    this.listView.classList.add("zw-project-discovery-hidden");
    this.detailPanel.element.classList.remove("zw-project-discovery-hidden");
    this.detailPanel.render(project);
  }

  /** Opens straight to the discovery list, search/filter reset — the "View Projects" board path. */
  open(): void {
    this.searchInput.value = "";
    this.activeFilter = "all";
    this.updateFilterButtonStyles();
    this.showList();
    this.backdrop.classList.add("visible");
  }

  /** Opens straight to one project's detail view — the project-booth path (CORE-005 § 11). */
  openProject(projectId: string): void {
    this.showDetail(projectId);
    this.backdrop.classList.add("visible");
  }

  /**
   * Test/dev-only (reachable via `window.__projectDiscoveryPanel` in dev
   * builds — see App.ts): renders an arbitrary `Project` object directly,
   * bypassing the registry lookup. Exists specifically so
   * `tests/e2e/projects.spec.ts` can exercise the REAL `detailPanel.render()`
   * code path against hostile content the static fixture dataset would
   * never contain (CORE-005 § 31 Test 13) — same reasoning CORE-003's
   * `window.__remotePlayers.spawn()` e2e XSS tests already established
   * for nickname rendering. Never called from normal app code.
   */
  showDetailForTesting(project: Project): void {
    this.activateDetailView(project);
    this.backdrop.classList.add("visible");
  }

  close(): void {
    this.backdrop.classList.remove("visible");
  }

  get isOpen(): boolean {
    return this.backdrop.classList.contains("visible");
  }

  dispose(): void {
    this.backdrop.remove();
  }
}
