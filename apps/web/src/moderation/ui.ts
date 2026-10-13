import { injectUiStyles } from "../ui/styles.ts";

/**
 * The small DOM toolkit the moderation dialogs share — a modal dialog (Esc and the backdrop close it,
 * Enter/Esc never reach the game), element and button helpers, and one style sheet in the hall dialogs' wood-and-gold
 * look. Every string from the network is rendered with textContent only.
 */

export interface ModDialogParts {
  readonly backdrop: HTMLDivElement;
  readonly panel: HTMLFormElement;
  close(): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

export function button(label: string, title: string, onClick: () => void, primary = false): HTMLButtonElement {
  const element = el("button", `zw-button${primary ? " zw-button-primary" : ""}`);
  element.type = "button";
  element.textContent = label;
  element.title = title;
  element.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return element;
}

/** A modal dialog with a title; `wide` for the Moderation panel. */
export function openModDialog(container: HTMLElement, className: string, titleText: string, onClose: () => void, wide = false): ModDialogParts {
  injectModerationStyles();
  const backdrop = el("div", `zw-ui zw-mod-backdrop ${className}`);
  const panel = el("form", `zw-panel zw-mod-dialog${wide ? " zw-mod-dialog-wide" : ""}`);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.noValidate = true;
  const titleId = `zw-mod-dialog-${Math.random().toString(36).slice(2, 8)}`;
  panel.setAttribute("aria-labelledby", titleId);
  const title = el("h3", "zw-mod-title");
  title.id = titleId;
  title.textContent = titleText;
  panel.appendChild(title);
  backdrop.appendChild(panel);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    const active = document.activeElement;
    if (active instanceof HTMLElement && backdrop.contains(active)) active.blur();
    backdrop.remove();
    onClose();
  };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" || event.key === "Escape") event.stopPropagation();
  });
  document.exitPointerLock?.();
  container.appendChild(backdrop);
  return { backdrop, panel, close };
}

/** A radio group of choices (the checked one is highlighted); `value()` is the checked choice's value. */
export function choiceGroup<T>(legendText: string, name: string, choices: readonly { readonly value: T; readonly label: string }[], initial: number): { readonly element: HTMLFieldSetElement; value(): T } {
  const fieldset = el("fieldset", "zw-mod-choices");
  const legend = el("legend", "");
  legend.textContent = legendText;
  fieldset.appendChild(legend);
  const inputs: HTMLInputElement[] = [];
  const refresh = (): void => inputs.forEach((input) => input.parentElement?.classList.toggle("checked", input.checked));
  choices.forEach((choice, index) => {
    const label = el("label", "zw-mod-choice");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = String(index);
    input.checked = index === initial;
    input.addEventListener("change", refresh);
    const text = el("span", "");
    text.textContent = choice.label;
    label.append(input, text);
    fieldset.appendChild(label);
    inputs.push(input);
  });
  refresh();
  return {
    element: fieldset,
    value: () => choices[Math.max(0, inputs.findIndex((input) => input.checked))]!.value,
  };
}

let stylesInjected = false;
export function injectModerationStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  injectUiStyles();
  const style = document.createElement("style");
  style.textContent = `
.zw-mod-backdrop { position: absolute; inset: 0; z-index: 24; display: flex; align-items: center; justify-content: center; background: rgba(4,5,10,0.6); }
.zw-mod-dialog { width: min(460px, 92vw); max-height: 88vh; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  background: linear-gradient(180deg, rgba(40,28,18,0.97), rgba(24,17,11,0.97)); border: 2px solid rgba(160,110,56,0.85); }
.zw-mod-dialog-wide { width: min(760px, 94vw); height: min(640px, 86vh); }
.zw-mod-title { margin: 0; font: 700 18px Georgia, serif; color: #f4e3c1; }
.zw-mod-text { margin: 0; font-size: 13px; line-height: 1.5; color: #e6dccb; }
.zw-mod-note { margin: 0; font-size: 12px; line-height: 1.45; color: #c9bfae; }
.zw-mod-privacy { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(120,170,255,0.10); border: 1px solid rgba(120,170,255,0.28); font-size: 12px; line-height: 1.45; color: #d9e6ff; }
.zw-mod-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin: 0; padding: 0; border: 0; }
.zw-mod-choices legend { grid-column: 1 / -1; padding: 0 0 2px; font-size: 12px; font-weight: 600; color: #d9b77a; }
.zw-mod-choice { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); cursor: pointer; font-size: 13px; color: #f1e9dd; }
.zw-mod-choice.checked { border-color: rgba(230,170,80,0.85); background: rgba(201,138,60,0.18); }
.zw-mod-choice input { margin: 0; accent-color: #c98a3c; }
.zw-mod-field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #d9b77a; font-weight: 600; }
.zw-mod-field textarea { margin: 0; min-height: 70px; resize: vertical; }
.zw-mod-count { align-self: flex-end; font-size: 11px; color: #9b8f7e; font-weight: 400; }
.zw-mod-status { margin: 0; font-size: 12px; color: #ffcf8a; }
.zw-mod-status:empty { display: none; }
.zw-mod-status.bad { color: #ff8f7a; }
.zw-mod-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
.zw-mod-danger { background: #b4442f; border-color: #b4442f; color: #fff; font-weight: 600; }
.zw-mod-danger:hover:not(:disabled) { background: #c8553e; }
.zw-mod-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(201,138,60,0.3); }
.zw-mod-tab { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 8px 8px 0 0; font: 600 13px "Segoe UI", system-ui, sans-serif; color: #cfc3ad; }
.zw-mod-tab[aria-selected="true"] { background: rgba(201,138,60,0.28); color: #fff3dc; }
.zw-mod-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
.zw-mod-empty { margin: 18px 0; text-align: center; font-size: 13px; color: #b9ae9c; }
.zw-mod-row { display: flex; flex-direction: column; gap: 4px; padding: 9px 11px; border-radius: 10px; background: rgba(10,7,4,0.55); border: 1px solid rgba(255,255,255,0.08); }
.zw-mod-row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.zw-mod-row-name { font-weight: 700; font-size: 14px; color: #fff; overflow-wrap: anywhere; }
.zw-mod-row-tag { padding: 1px 8px; border-radius: 999px; background: rgba(201,138,60,0.25); color: #ffd99a; font-size: 11px; font-weight: 700; }
.zw-mod-row-tag.left { background: rgba(255,255,255,0.10); color: #c9bfae; }
.zw-mod-row-meta { font-size: 11px; color: #a99d8b; margin-left: auto; }
.zw-mod-row-note { font-size: 13px; color: #efe6d6; overflow-wrap: anywhere; white-space: pre-wrap; }
.zw-mod-row-by { font-size: 12px; color: #c9bfae; }
.zw-mod-row-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.zw-mod-row-actions .zw-button { padding: 4px 10px; }
.zw-mod-section-title { margin: 6px 0 0; font: 700 13px "Segoe UI", system-ui, sans-serif; color: #d9b77a; text-transform: uppercase; letter-spacing: 0.05em; }
.zw-mod-log-line { display: grid; grid-template-columns: 64px 1fr; gap: 8px; font-size: 12px; color: #e6dccb; padding: 4px 2px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.zw-mod-log-line time { color: #9b8f7e; }
.zw-removed { position: absolute; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(6,6,12,0.82); }
.zw-removed-card { width: min(480px, 92vw); padding: 22px 24px; display: flex; flex-direction: column; gap: 12px; text-align: left;
  background: linear-gradient(180deg, rgba(44,24,20,0.97), rgba(24,14,12,0.97)); border: 2px solid rgba(190,90,60,0.85); }
.zw-removed-title { margin: 0; font: 700 20px Georgia, serif; color: #ffe0cc; }
.zw-removed-detail { margin: 0; font-size: 14px; line-height: 1.5; color: #f1e2d6; }
`;
  document.head.appendChild(style);
}
