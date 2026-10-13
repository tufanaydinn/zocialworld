import { injectUiStyles } from "../ui/styles.ts";
import type { Project } from "./ProjectTypes.ts";
import { PROJECT_CATEGORY_LABELS, PROJECT_STATUS_LABELS } from "./ProjectTypes.ts";
import { createSafeExternalLink, isSafeExternalUrl } from "./urlSafety.ts";
import { subscribeToCapabilities } from "../zcash/participation.ts";
import { ZcashWalletAdapter } from "../zcash/ZcashWalletAdapter.ts";
import { createSupportIntent, validateSupportConfirmation } from "../zcash/SupportFlow.ts";
import { getNetworkConfig, getSupportRecipient } from "../zcash/config.ts";
import { parseZecDecimalToZatoshi } from "../zcash/core/decimal.ts";
import type { ProjectSupportTarget, SupportConfirmation } from "../zcash/WalletTypes.ts";

/**
 * Renders a single project's detail view. Not its own
 * modal/backdrop — `ProjectDiscoveryPanel` owns the one backdrop and
 * swaps this view in/out, same reasoning the existing codebase already
 * uses one `.zw-modal-backdrop` per concern rather than stacking
 * multiple overlays (see `tests/e2e/README.md`'s note on
 * `.zw-player-card-backdrop` existing specifically to avoid colliding
 * with `.zw-modal-backdrop`).
 *
 * Security: every piece of project text is rendered via
 * `textContent` — never `innerHTML`, never string-concatenated markup.
 * Links only ever render through `createSafeExternalLink()`, which
 * itself refuses anything that isn't `isSafeExternalUrl()`-checked
 * `http`/`https` — a missing optional URL simply never
 * produces a link element at all (links render only if present),
 * never a dead/disabled button.
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
  private readonly actionsRow: HTMLDivElement;

  private supportButton: HTMLButtonElement | null = null;
  private supportFlowPanel: HTMLDivElement | null = null;
  private currentProject: Project | null = null;
  private unsubscribeCapabilities: (() => void) | null = null;

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

    this.actionsRow = document.createElement("div");
    this.actionsRow.className = "zw-project-detail-actions";
    this.element.appendChild(this.actionsRow);
  }

  render(project: Project): void {
    this.currentProject = project;
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

    // Wire support button after links to avoid DOM removal (replaceChildren above would otherwise remove it)
    this.ensureSupportButton();
  }

  /** Wire support button and subscription on first use */
  ensureSupportButton(): void {
    if (this.supportButton) return;

    this.supportButton = document.createElement("button");
    this.supportButton.type = "button";
    this.supportButton.className = "zw-button";
    this.supportButton.textContent = "💜 Support with ZEC";
    this.supportButton.setAttribute("data-testid", "support-button");
    this.supportButton.addEventListener("click", () => this.openSupportFlow());
    this.actionsRow.appendChild(this.supportButton);

    // Subscribe to capabilities to enable/disable support button
    this.unsubscribeCapabilities = subscribeToCapabilities((capabilities) => {
      if (this.supportButton) {
        this.supportButton.disabled = !capabilities.canSupportProjects;
        this.supportButton.title = capabilities.canSupportProjects ? "Support this project" : "Connect wallet to support";
        this.supportButton.setAttribute("data-participation", capabilities.canSupportProjects ? "ready" : "guest");
      }
    });
  }

  private openSupportFlow(): void {
    if (!this.currentProject || !this.supportButton) return;

    const walletState = ZcashWalletAdapter.state;
    if (walletState.status !== "ready") {
      alert("Wallet not connected. Please create or import a wallet first.");
      return;
    }

    // Create the support flow UI
    const backdrop = document.createElement("div");
    backdrop.className = "zw-modal-backdrop";
    backdrop.setAttribute("data-testid", "support-flow-backdrop");

    this.supportFlowPanel = document.createElement("div");
    this.supportFlowPanel.className = "zw-modal zw-support-flow";
    this.supportFlowPanel.setAttribute("data-testid", "support-flow-panel");

    const amountInput = document.createElement("input");
    amountInput.type = "text";
    amountInput.className = "zw-input";
    amountInput.placeholder = "Amount in ZEC (e.g., 1.5)";
    amountInput.setAttribute("data-testid", "support-amount-input");

    const errorMsg = document.createElement("p");
    errorMsg.className = "zw-error-message";
    errorMsg.setAttribute("data-testid", "support-error");
    errorMsg.style.display = "none";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "zw-button";
    confirmBtn.textContent = "Review & Confirm";
    confirmBtn.setAttribute("data-testid", "support-confirm-button");

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "zw-button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.setAttribute("data-testid", "support-cancel-button");

    amountInput.addEventListener("input", () => {
      errorMsg.style.display = "none";
      if (!amountInput.value) return;

      try {
        parseZecDecimalToZatoshi(amountInput.value);
      } catch (e: any) {
        errorMsg.textContent = e?.message || "Invalid amount";
        errorMsg.style.display = "block";
      }
    });

    confirmBtn.addEventListener("click", () => {
      if (!amountInput.value) {
        errorMsg.textContent = "Please enter an amount";
        errorMsg.style.display = "block";
        return;
      }

      let amountZatoshi: bigint;
      try {
        amountZatoshi = parseZecDecimalToZatoshi(amountInput.value);
      } catch (e: any) {
        errorMsg.textContent = e?.message || "Invalid amount";
        errorMsg.style.display = "block";
        return;
      }

      try {
        const config = getNetworkConfig();
        const recipientAddress = getSupportRecipient(this.currentProject!.id, config.network);

        const target: ProjectSupportTarget = {
          projectId: this.currentProject!.id,
          recipientAddress,
          network: config.network as "main" | "test",
          label: this.currentProject!.name,
        };

        const intent = createSupportIntent(target, amountZatoshi);
        const confirmation: SupportConfirmation = {
          intent,
          confirmed: false,
        };

        // Show confirmation screen
        this.showConfirmationScreen(backdrop, confirmation);
      } catch (e: any) {
        errorMsg.textContent = e?.message || "Invalid support target";
        errorMsg.style.display = "block";
      }
    });

    cancelBtn.addEventListener("click", () => {
      backdrop.remove();
      this.supportFlowPanel = null;
    });

    this.supportFlowPanel.appendChild(document.createElement("h3")).textContent = `Support: ${this.currentProject.name}`;
    this.supportFlowPanel.appendChild(amountInput);
    this.supportFlowPanel.appendChild(errorMsg);
    this.supportFlowPanel.appendChild(confirmBtn);
    this.supportFlowPanel.appendChild(cancelBtn);

    backdrop.appendChild(this.supportFlowPanel);
    document.body.appendChild(backdrop);
  }

  private showConfirmationScreen(backdrop: HTMLDivElement, confirmation: SupportConfirmation): void {
    if (!this.supportFlowPanel) return;

    const confirmPanel = document.createElement("div");
    confirmPanel.setAttribute("data-testid", "support-confirmation");
    confirmPanel.className = "zw-confirmation-panel";

    const title = document.createElement("h3");
    title.textContent = "Confirm Support Payment";
    confirmPanel.appendChild(title);

    const details = document.createElement("div");
    details.className = "zw-confirmation-details";
    const projectLine = document.createElement("p");
    projectLine.textContent = `Project: ${confirmation.intent.target.label}`;
    const amountLine = document.createElement("p");
    amountLine.textContent = `Amount: ${confirmation.intent.amountDisplayZec} ZEC`;
    const addressLine = document.createElement("p");
    const addr = confirmation.intent.target.recipientAddress;
    const masked = addr.length > 20 ? `${addr.slice(0, 10)}…${addr.slice(-10)}` : addr;
    addressLine.textContent = `To: ${masked}`;
    details.appendChild(projectLine);
    details.appendChild(amountLine);
    details.appendChild(addressLine);
    confirmPanel.appendChild(details);

    const finalConfirmBtn = document.createElement("button");
    finalConfirmBtn.type = "button";
    finalConfirmBtn.className = "zw-button";
    finalConfirmBtn.textContent = "Send Payment";
    finalConfirmBtn.setAttribute("data-testid", "support-final-confirm");

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "zw-button";
    backBtn.textContent = "Back";

    finalConfirmBtn.addEventListener("click", async () => {
      try {
        // Re-check wallet readiness before final send
        // (do not rely only on disabled-button UI state)
        const walletState = ZcashWalletAdapter.state;
        if (walletState.status !== "ready") {
          alert("Wallet is no longer ready. Please unlock your wallet and try again.");
          backdrop.remove();
          this.supportFlowPanel = null;
          return;
        }

        confirmation.confirmed = true;
        const validation = validateSupportConfirmation(confirmation);
        if (!validation.ok) {
          alert(`Validation failed: ${validation.errors.join(", ")}`);
          return;
        }

        // Attempt to send the payment
        finalConfirmBtn.disabled = true;
        finalConfirmBtn.textContent = "Sending...";

        const txid = await ZcashWalletAdapter.sendShielded(
          confirmation.intent.target.recipientAddress,
          confirmation.intent.amountDisplayZec,
          confirmation.intent.memo
        );

        alert(`Payment sent! Transaction ID: ${txid}`);
        backdrop.remove();
        this.supportFlowPanel = null;
      } catch (e: any) {
        alert(`Payment failed: ${e?.message || "Unknown error"}`);
        finalConfirmBtn.disabled = false;
        finalConfirmBtn.textContent = "Send Payment";
      }
    });

    backBtn.addEventListener("click", () => {
      this.supportFlowPanel?.replaceChildren();
      this.openSupportFlow();
    });

    confirmPanel.appendChild(finalConfirmBtn);
    confirmPanel.appendChild(backBtn);
    this.supportFlowPanel.replaceChildren(confirmPanel);
  }

  dispose(): void {
    // Clean up capability subscription listener
    if (this.unsubscribeCapabilities) {
      this.unsubscribeCapabilities();
      this.unsubscribeCapabilities = null;
    }

    // Close support flow if open
    if (this.supportFlowPanel) {
      const backdrop = this.supportFlowPanel.parentElement;
      if (backdrop) backdrop.remove();
      this.supportFlowPanel = null;
    }

    // Clear button reference
    this.supportButton = null;
  }

}
