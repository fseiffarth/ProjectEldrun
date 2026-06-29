import { IS_MAC, IS_WINDOWS } from "./platform";

// The panel-toggle key reads as the Windows key on Windows (the webview reports
// it as "Meta"), "Cmd (⌘)" on macOS, and "Super" on Linux/KDE — keep onboarding
// copy honest per OS. Single source of truth shared by the Feature Guide, the
// How-to-start dialog, and the contextual hints so the wording never drifts.
export const PANEL_TOGGLE_KEY = IS_MAC
  ? "Cmd (⌘)"
  : IS_WINDOWS
    ? "the Windows key"
    : "Super";

// How to enter "focus mode" (panels hidden). On Linux/Windows a lone modifier
// (Super / the Windows key) toggles the panels; on macOS that key is reserved
// for Cmd shortcuts, so the lone-key toggle is disabled (see useKeyboard) — there
// the panels stay reachable via the cursor-to-edge reveal. F11 always toggles
// fullscreen. Keeps the onboarding copy accurate per OS.
export const FOCUS_MODE_TIP = IS_MAC
  ? "Panels auto-reveal when you push the cursor to a screen edge; press F11 for fullscreen."
  : `Press ${PANEL_TOGGLE_KEY} (while Eldrun is focused) to hide the panels for a full-screen terminal, and F11 for fullscreen.`;

/** One numbered step in the first-run "How to start" instruction. The same copy
 *  feeds the dialog and the Feature Guide so onboarding stays in lockstep. */
export interface HowToStep {
  title: string;
  body: string;
}

export const HOW_TO_START_STEPS: HowToStep[] = [
  {
    title: "Use the root terminal",
    body:
      "The ▣ logo (top-left) is your always-on control terminal, living in Eldrun's root folder. Click + on its tab bar to open a shell or an AI agent there.",
  },
  {
    title: "Create or import a project",
    body:
      "Click + in the project bar to create a new project (scaffolds files and a git repo) or import an existing folder. Each project gets its own terminals, tabs, and file tree.",
  },
  {
    title: "Add agents and tabs",
    body:
      "Use + on a project's tab bar to add a Claude, Codex, or Gemini agent — or a plain shell. Drag a tab to a pane edge to split the view side-by-side.",
  },
  {
    title: "Find your files and focus",
    body:
      `Push your cursor to the right edge to reveal the file tree; click the pin to dock it. ${FOCUS_MODE_TIP}`,
  },
];

/** Stable id for a contextual hint. Persisted in `settings.hints_seen`, so renaming
 *  one resets it for everyone — pick carefully. */
export type HintId = "create-project" | "add-tab" | "toggle-panels" | "file-tree";

/** A snapshot of the bits of app state the hint predicates care about, assembled
 *  by HintHost from the projects/tabs stores. Kept tiny and serializable-ish so
 *  predicates stay pure and testable. */
export interface HintCtx {
  /** Number of active project pills. */
  projectCount: number;
  /** The current project scope, or null at root / no active project. */
  activeId: string | null;
}

export interface HintDef {
  id: HintId;
  /** Higher wins when several hints are eligible at once (shown one at a time). */
  priority: number;
  /** `document.querySelector` selector for the element to point at, or null to
   *  render as a centered top banner (no anchor). */
  anchor: string | null;
  /** Which side of the anchor the bubble sits on. Ignored for banners. */
  placement: "top" | "bottom";
  title: string;
  body: string;
  /** Eligible to surface only while this returns true for the current context. */
  when: (ctx: HintCtx) => boolean;
}

export const HINTS: HintDef[] = [
  {
    id: "create-project",
    priority: 100,
    anchor: '[data-hint-anchor="add-project"]',
    placement: "bottom",
    title: "Create your first project",
    body:
      "Click + here to create or import a project. Each one gets its own terminal, tabs, and file tree.",
    when: (c) => c.projectCount === 0,
  },
  {
    id: "add-tab",
    priority: 80,
    anchor: '[data-hint-anchor="tab-add"]',
    placement: "bottom",
    title: "Add an AI agent",
    body:
      "Use + on the tab bar to open a Claude, Codex, or Gemini agent — or a plain shell. Drag tabs to a pane edge to split the view.",
    when: (c) => c.activeId !== null,
  },
  {
    id: "toggle-panels",
    priority: 60,
    anchor: null,
    placement: "top",
    title: "Focus mode",
    body: FOCUS_MODE_TIP,
    when: (c) => c.activeId !== null,
  },
  {
    id: "file-tree",
    priority: 50,
    anchor: null,
    placement: "top",
    title: "Your project files",
    body:
      "Push your cursor to the right edge to reveal the file tree. Click the pin to keep it docked.",
    when: (c) => c.activeId !== null,
  },
];

/** Pure selection: the highest-priority unseen hint eligible for this context,
 *  or null. Returns null when hints are disabled. Exported for unit tests. */
export function pickHint(
  ctx: HintCtx,
  seen: ReadonlySet<string>,
  enabled: boolean,
): HintId | null {
  if (!enabled) return null;
  const eligible = HINTS.filter((h) => !seen.has(h.id) && h.when(ctx)).sort(
    (a, b) => b.priority - a.priority,
  );
  return eligible[0]?.id ?? null;
}
