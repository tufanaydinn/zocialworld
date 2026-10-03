/**
 * Shared UI styling, injected once as a single <style> tag.
 *
 * Deviation from the file list in the task spec (which only named
 * InteractionPrompt.ts and PrototypePanel.ts under ui/): a shared
 * stylesheet module avoids duplicating the "dark translucent panel,
 * amber accent" look across every widget. See docs/OVERVIEW.md.
 *
 * Per master spec section 67: fantasy 3D world, modern readable UI —
 * dark translucent panels, amber accent, rounded corners, sans-serif.
 */

let injected = false;

const CSS = `
.zw-ui * {
  box-sizing: border-box;
}

.zw-panel {
  background: rgba(16, 18, 24, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(201, 138, 60, 0.35);
  border-radius: 10px;
  color: #f1e9dd;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
}

.zw-interaction-prompt {
  position: absolute;
  left: 50%;
  bottom: 14%;
  transform: translateX(-50%);
  padding: 10px 18px;
  font-size: 15px;
  letter-spacing: 0.01em;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
  white-space: nowrap;
}

.zw-interaction-prompt.visible {
  opacity: 1;
}

.zw-interaction-prompt kbd {
  display: inline-block;
  padding: 1px 7px;
  margin-right: 8px;
  border-radius: 5px;
  background: #c98a3c;
  color: #1a1206;
  font-weight: 700;
  font-size: 13px;
}

.zw-hud-corner {
  position: absolute;
  top: 12px;
  left: 12px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: #cbd3de;
  pointer-events: none;
}

.zw-hud-corner .zw-title {
  color: #f1e9dd;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 2px;
}

.zw-location-label {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 8px 14px;
  font-size: 13px;
  pointer-events: none;
}

.zw-location-label .zw-location-name {
  color: #e8ad5c;
  font-weight: 600;
}

.zw-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(5, 6, 9, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  z-index: 10;
}

.zw-modal-backdrop.visible {
  opacity: 1;
  pointer-events: auto;
}

.zw-modal {
  width: min(480px, 86vw);
  max-height: 72vh;
  overflow-y: auto;
  padding: 22px 24px;
}

.zw-modal h2 {
  margin: 0 0 4px;
  font-size: 19px;
  color: #f1e9dd;
}

.zw-modal .zw-modal-subtitle {
  margin: 0 0 16px;
  font-size: 13px;
  color: #9aa4b2;
}

.zw-project-card {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
}

.zw-project-card:last-child {
  margin-bottom: 0;
}

.zw-project-card .zw-project-name {
  font-weight: 600;
  color: #e8ad5c;
  font-size: 14px;
}

.zw-project-card .zw-project-stage {
  font-size: 11px;
  color: #9aa4b2;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.zw-project-card p {
  margin: 6px 0 0;
  font-size: 13px;
  color: #cbd3de;
}

.zw-modal-close-hint {
  margin-top: 16px;
  font-size: 11px;
  color: #74808f;
  text-align: center;
}

.zw-nameplate {
  position: absolute;
  top: 0;
  left: 0;
  padding: 3px 9px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  will-change: transform;
}

.zw-connection-status {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  font-size: 12px;
  display: flex;
  gap: 10px;
  align-items: center;
}

.zw-connection-status .zw-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #74808f;
  display: inline-block;
}

.zw-connection-status[data-state="connected"] .zw-status-dot {
  background: #5fbf7a;
}

.zw-connection-status[data-state="connecting"] .zw-status-dot {
  background: #e8ad5c;
}

.zw-connection-status[data-state="disconnected"] .zw-status-dot {
  background: #c25b4a;
}

.zw-input {
  display: block;
  width: 100%;
  margin: 10px 0;
  padding: 8px 10px;
  background: rgba(5, 6, 9, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: #f1e9dd;
  font-family: inherit;
  font-size: 13px;
}

.zw-input:focus {
  outline: none;
  border-color: rgba(201, 138, 60, 0.6);
}

.zw-button {
  display: inline-block;
  padding: 7px 14px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  color: #f1e9dd;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  text-decoration: none; /* also used on <a> elements — CORE-005's external project links */
}

.zw-button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}

.zw-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.zw-button-primary {
  background: #c98a3c;
  border-color: #c98a3c;
  color: #1a1206;
  font-weight: 600;
}

.zw-button-primary:hover:not(:disabled) {
  background: #d99a4c;
}

.zw-nickname-controls {
  /* Bottom-right, not top-right: DebugStats' stats.js panel (dev-only)
     occupies the top-right corner — see apps/web/src/ui/DebugStats.ts. */
  position: absolute;
  bottom: 12px;
  right: 12px;
  padding: 6px 10px;
  font-size: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
}

.zw-nickname-controls .zw-input {
  width: 120px;
  margin: 0;
  padding: 4px 8px;
}

.zw-nickname-controls .zw-button {
  padding: 4px 10px;
}

/* A separate backdrop class from .zw-modal-backdrop (rather than sharing
   it) so the two overlays never collide under a single-element CSS
   selector — see tests/e2e/app.spec.ts's .zw-modal-backdrop lookups,
   which assume exactly one such element (the project board panel). */
.zw-player-card-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(5, 6, 9, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  z-index: 10;
}

.zw-player-card-backdrop.visible {
  opacity: 1;
  pointer-events: auto;
}

.zw-player-context-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.zw-player-context-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex-shrink: 0;
}

.zw-player-context-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.zw-voice-controls {
  /* Bottom-left: bottom-right is NicknameControls, top-left is the HUD
     corner label, top-center is ConnectionStatus, top-right is
     DebugStats (dev-only) — see each widget's own file for why. */
  position: absolute;
  bottom: 12px;
  left: 12px;
  padding: 6px 10px;
  font-size: 12px;
  display: flex;
  gap: 10px;
  align-items: center;
}

.zw-voice-controls .zw-button {
  padding: 4px 10px;
}

/* CORE-005: project discovery (ProjectDiscoveryPanel / ProjectDetailPanel) */

.zw-project-discovery-hidden {
  display: none;
}

.zw-project-discovery-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 14px;
}

.zw-project-discovery-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Reset button chrome so a <button> card reads identically to the plain
   .zw-project-card div it replaces (CORE-005 §40: real <button>
   elements for accessibility, not a div with a click handler). */
.zw-project-card-button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.zw-project-card-button:hover {
  border-color: rgba(201, 138, 60, 0.5);
}

.zw-project-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 4px;
}

.zw-project-detail-badges {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}

.zw-project-detail-badge {
  font-size: 11px;
  color: #9aa4b2;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.zw-project-detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
}

.zw-project-tag {
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 11px;
  color: #cbd3de;
}

.zw-project-detail-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
`;

export function injectUiStyles(): void {
  if (injected) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  injected = true;
}
