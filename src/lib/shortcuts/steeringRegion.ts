/**
 * The region cursor of keyboard steering mode: one highlighted control inside a
 * surface that has no tab bar to step through — the side panel, the mail /
 * calendar / to-do overlays, a pane's + menu, the settings dialog. ↑/↓ walk
 * it, Enter presses it.
 *
 * It is deliberately NOT DOM focus. Focusing a control runs its focus handlers
 * (the header buttons open their menus on focus, a menu closes when focus
 * leaves it), and every key is steering's while the mode is on anyway — so the
 * cursor is a class on the element (`.steer-cursor`) and Enter is a `click()`.
 * DOM focus moves only where the user is about to type: Enter on a text field
 * leaves steering with the caret in it (`activateRegionCursor`).
 *
 * The walk is generic on purpose. What can be pressed is found, not listed:
 * the focusable controls plus anything the stylesheet marks clickable
 * (`cursor: pointer` — tree rows, list rows, chips are divs with an onClick),
 * so a surface needs no steering code of its own to be walkable.
 */
import { experimentalEnabled } from "../experimental";
import type { FilesPanelView, Settings } from "../../types";
import type { SteeringRegion } from "../../stores/keyboardSteering";

const CURSOR_CLASS = "steer-cursor";

/** Controls that are pressable by their nature, whatever their cursor. */
const PRESSABLE =
  'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), ' +
  "select:not(:disabled), textarea:not(:disabled), [contenteditable='true'], " +
  '[tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"], [role="treeitem"], ' +
  '[role="option"], [role="menuitem"], [role="checkbox"], [role="switch"]';

/** The side panel's views in the order ←/→ walk them — the four its edge rail
 *  and switcher lead with (`AppShell`'s EDGE_VIEWS). */
export const SIDE_PANEL_VIEWS: readonly FilesPanelView[] = ["files", "git", "windows", "agents"];

/** The header apps steering can open, and the gate each one's button has. */
export type SteeringApp = "mail" | "calendar" | "todo";

export function steeringAppEnabled(app: SteeringApp, settings: Settings | null | undefined): boolean {
  switch (app) {
    case "mail":
      return experimentalEnabled(settings, "mail_client");
    case "calendar":
      return settings?.calendar_global_app ?? false;
    case "todo":
      return settings?.todo_board ?? false;
  }
}

let cursor: HTMLElement | null = null;

function lastMatch(selector: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(selector);
  return all.length > 0 ? all[all.length - 1] : null;
}

/** The element a region's cursor walks inside, or null while it is not on
 *  screen (the overlay still loading, the panel closed by the pointer). */
export function regionRoot(region: SteeringRegion): HTMLElement | null {
  switch (region) {
    case "side":
      return document.querySelector<HTMLElement>(".side-panel.open");
    case "addTab":
      return lastMatch(".tab-add-menu");
    case "settings":
      // The page, not the whole dialog: ←/→ step the left-hand list
      // (`stepSettingsPage`), so ↑/↓ need not wade through it.
      return settingsDialog()?.querySelector<HTMLElement>(".settings-panel-content") ?? null;
    default:
      // The three header overlays share the root console's frame; each adds
      // its own class. The last one mounted is the one on top.
      return (
        document.querySelector<HTMLElement>(`.root-overlay.${region}-overlay`) ??
        lastMatch(".app-overlay-backdrop .root-overlay")
      );
  }
}

/** The settings dialog, while it is open. */
export function settingsDialog(): HTMLElement | null {
  return lastMatch(".settings-dialog");
}

/** Open the previous / next page of the settings dialog's left-hand list
 *  (the search narrows it, and so what this steps through). False when there
 *  is no other page to go to. */
export function stepSettingsPage(delta: 1 | -1): boolean {
  const pages = Array.from(
    settingsDialog()?.querySelectorAll<HTMLElement>(".settings-navigation-links button") ?? [],
  );
  if (pages.length === 0) return false;
  const at = pages.findIndex((el) => el.matches('[aria-current]:not([aria-current="false"])'));
  const next = at < 0 ? (delta > 0 ? 0 : pages.length - 1) : (at + delta + pages.length) % pages.length;
  if (next === at) return false;
  pages[next].click();
  return true;
}

function shown(el: HTMLElement): boolean {
  if (el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function pointerish(el: Element): boolean {
  return getComputedStyle(el).cursor === "pointer";
}

/** Everything in `root` the cursor can land on, in document order. A clickable
 *  row counts once — its label spans inherit `cursor: pointer` but are not
 *  targets of their own — while a real control nested in it (a row's × button)
 *  is one. */
export function regionTargets(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const pressable = el.matches(PRESSABLE);
    if (!pressable) {
      if (!pointerish(el)) continue;
      const parent = el.parentElement;
      if (parent && parent !== root && root.contains(parent) && pointerish(parent)) continue;
    }
    if (shown(el)) out.push(el);
  }
  return out;
}

function setCursor(el: HTMLElement | null) {
  if (cursor === el) return;
  cursor?.classList.remove(CURSOR_CLASS);
  cursor = el;
  if (!el) return;
  el.classList.add(CURSOR_CLASS);
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

export function clearRegionCursor() {
  setCursor(null);
}

/** The element under the cursor, if it is still on screen. */
export function regionCursor(): HTMLElement | null {
  return cursor?.isConnected ? cursor : null;
}

/** Put the cursor on `root`'s selected control (the active view tab, the open
 *  message), else its first one. False when there is nothing to land on yet. */
export function placeRegionCursor(root: HTMLElement): boolean {
  if (cursor?.isConnected && root.contains(cursor)) return true;
  const targets = regionTargets(root);
  if (targets.length === 0) return false;
  const selected = targets.find((el) =>
    el.matches('[aria-selected="true"], [aria-current]:not([aria-current="false"]), .selected'),
  );
  // Never land on a dialog's × first: Enter there would close what was just
  // opened.
  setCursor(selected ?? targets.find((el) => !el.matches(".dialog-close-btn")) ?? targets[0]);
  return true;
}

/** Step the cursor through `root`'s targets, wrapping. A cursor that fell off
 *  the page (its row re-rendered away) restarts at the near end. */
export function moveRegionCursor(root: HTMLElement, delta: 1 | -1): void {
  const targets = regionTargets(root);
  if (targets.length === 0) {
    setCursor(null);
    return;
  }
  const at = cursor ? targets.indexOf(cursor) : -1;
  const next =
    at < 0
      ? delta > 0
        ? 0
        : targets.length - 1
      : (at + delta + targets.length) % targets.length;
  setCursor(targets[next]);
}

function isTextEntry(el: HTMLElement): boolean {
  if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  if (!(el instanceof HTMLInputElement)) return false;
  return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].includes(
    el.type,
  );
}

/**
 * Press the control under the cursor. "type" — it takes text, so it now has
 * DOM focus and the caller leaves steering for the user to type; "press" — it
 * was clicked; null — no cursor.
 */
/** `root`'s first shown text field — the + menu's filter, a search box. */
export function regionSearchField(root: HTMLElement): HTMLElement | null {
  return regionTargets(root).find(isTextEntry) ?? null;
}

/** Hand `root`'s first text field the caret (steering's `/`). False when the
 *  surface has none. */
export function focusRegionSearch(root: HTMLElement): boolean {
  const field = regionSearchField(root);
  if (!field) return false;
  setCursor(null);
  field.focus();
  return true;
}

/** Close a dropdown list open in `root` (Enter opened it), the cursor back on
 *  its trigger — what Escape does before it leaves the surface. False when
 *  none is open. */
export function closeRegionDropdown(root: HTMLElement): boolean {
  const trigger = root.querySelector<HTMLElement>('.dropdown-trigger[aria-expanded="true"]');
  if (!trigger) return false;
  trigger.click();
  setCursor(trigger);
  return true;
}

export function activateRegionCursor(): "type" | "press" | null {
  const el = regionCursor();
  if (!el) return null;
  if (isTextEntry(el)) {
    setCursor(null);
    el.focus();
    return "type";
  }
  // A dropdown option closes its list, taking the cursor with it: hand the
  // cursor back to the dropdown, so the next ↑/↓ goes on from there.
  const trigger =
    el.getAttribute("role") === "option"
      ? el.closest(".dropdown")?.querySelector<HTMLElement>(".dropdown-trigger")
      : null;
  el.click();
  if (trigger) setCursor(trigger);
  return "press";
}
