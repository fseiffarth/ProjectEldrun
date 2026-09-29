import { hasActiveModal } from "./useModalFocus";
import { useEffect } from "react";
import { PLATFORM } from "../lib/window/dragPlatform";
import { IS_MAC } from "../lib/platform";
import { toggleWindowFullscreen } from "../lib/window/fullscreenMode";
import { desktopOwnsSuperKey, probeSuperKeyOwnership } from "../lib/shortcuts/superKey";
import { zoomChord } from "../lib/shortcuts/zoomChord";
import { allGroups, findGroup, useTabsStore } from "../stores/tabs";
import { closeTabWithConfirm } from "../lib/remote/closeRemoteTab";
import { reopenClosedAgentTab } from "../stores/agents/closedAgentTabs";
import { useProjectsStore } from "../stores/projects";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../stores/boxes";
import { useSettingsStore, stepZoom } from "../stores/settings";
import { useSubwindowNavStore } from "../stores/subwindowNav";
import {
  projectStations,
  useKeyboardSteeringStore,
  type SteeringRegion,
} from "../stores/keyboardSteering";
import { useActivityStore } from "../stores/activity";
import { jumpToTab } from "../lib/shortcuts/tabJump";
import { nextStatusTab, statusTabs, type TabStatusKind } from "../lib/shortcuts/statusJump";
import { useMailStore } from "../stores/mail";
import { useCalendarStore } from "../stores/calendar/calendar";
import { useTodoStore } from "../stores/todo";
import { openProjectDialog } from "../lib/projects/projectDialogEvent";
import { sidePanelViewKey, sidePanelViewPatch } from "../lib/projects/sidePanelView";
import {
  SIDE_PANEL_VIEWS,
  activateRegionCursor,
  clearRegionCursor,
  focusRegionSearch,
  moveRegionCursor,
  placeRegionCursor,
  regionRoot,
  steeringAppEnabled,
  type SteeringApp,
} from "../lib/shortcuts/steeringRegion";
import {
  openProjectShellInRootConsole,
  toggleRootConsole,
  useRootOverlayStore,
} from "../stores/rootOverlay";
import { newTabRequestFor, requestNewTab } from "../lib/shortcuts/newTabChord";
import { isPaneTerminalTarget, terminalMayTakeChord } from "../lib/shortcuts/terminalTabChord";
import {
  chordMatches,
  isLoneModifier,
  normalizeKey,
  resolveChord,
  type ChordDescriptor,
  type ShortcutAction,
  type ShortcutMap,
} from "../lib/shortcuts/shortcuts";

interface KeyboardOptions {
  onTogglePanels: () => void;
  /** Open (showing the panels if they were hidden) or close the side panel —
   *  steering's B key, and Escape back out of it. */
  onSidePanel?: (open: boolean) => void;
}

/** The close actions a chord may still trigger while a text field or terminal
 *  has focus — on macOS, with ⌘, and nothing else (see
 *  {@link editorMayTakeChord}). */
const EDITOR_CLOSE_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  "closeTab",
  "closeSubwindow",
  "closeAllTabs",
]);

/** Whether `action` may be resolved for a keydown whose target is an editable
 *  field (an input, the code editor, xterm's helper textarea).
 *
 *  Normally never: those keys are the field's. The one exception is ⌘W and its
 *  close-family siblings on macOS, where ⌘ is never text editing — and where a
 *  ⌘W the frontend let pass used to reach the default menu's Close Window and
 *  quit the whole app from a focused terminal. The gate is strict on purpose:
 *  `IS_MAC && metaKey && !ctrlKey`. ⌃W is readline's delete-word on a Mac too,
 *  and on Linux and Windows Ctrl+W (and Super+W, which is `metaKey` there) must
 *  keep reaching the terminal. Shared with the popout's handler. */
export function editorMayTakeChord(action: ShortcutAction, e: KeyboardEvent): boolean {
  return isMacCommandChord(e) && EDITOR_CLOSE_ACTIONS.has(action);
}

/** ⌘ without ⌃ on macOS — the only keydown from an editable target that is
 *  worth resolving at all (see {@link editorMayTakeChord}). */
export function isMacCommandChord(e: KeyboardEvent): boolean {
  return IS_MAC && e.metaKey && !e.ctrlKey;
}

/** True when keystrokes belong to a text field (input/textarea/contenteditable)
 *  — we must not steal those for navigation chords. Exported so the detached
 *  popout's keyboard hook applies the exact same "don't shadow a focused text
 *  field / xterm textarea" rule as the main window. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

/**
 * #62: fast keyboard navigation across projects / subwindows / tabs, plus an
 * app-internal fullscreen toggle and keyboard close. Chords are deliberately
 * unambiguous (Shift+Ctrl, Shift+Arrow) so terminal (xterm) input is never
 * shadowed; we only `preventDefault` when we actually act, and never while a
 * text field (e.g. an inline tab rename) is focused.
 *
 * The navigation chords are user-rebindable (see `src/lib/shortcuts/shortcuts.ts` and the
 * "Keyboard Shortcuts" settings panel); the defaults below are applied when
 * `settings.keyboard_shortcuts` has no override for an action. F11 (OS
 * fullscreen), Super/F9 (panels — Super on Linux, F9 on Windows where the lone
 * Win key belongs to the OS) and Escape (exit fullscreen) are fixed.
 *
 * Default bindings:
 *   - Ctrl+Enter           → toggle fullscreen for the focused subwindow
 *   - Escape               → exit fullscreen (when active) [fixed]
 *   - Shift+Ctrl+Tab       → cycle to the next active project
 *   - Ctrl+Shift+Left/Right → previous / next tab within the focused subwindow,
 *                            from a focused pane terminal too (terminalTabChord)
 *                            — plain Shift+Arrow is left alone because an agent
 *                            CLI inside the terminal (e.g. Codex) uses it itself
 *   - Ctrl+Shift+Up/Down    → cycle the focused subwindow (numbered preview shown
 *                            while Shift is held; focus commits on Shift release)
 *   - Shift+Tab            → cycle tabs within the focused subwindow
 *   - Shift+Ctrl+W         → close the focused subwindow
 *   - Ctrl+W               → close the active tab
 *   - Ctrl+Shift+T         → reopen the last closed agent tab
 *   - Alt+Shift+←          → cycle to the previous active project
 *   - F1                   → open the shortcut cheat sheet (window event)
 *   - Shift+Space          → toggle keyboard steering mode (see below)
 *   - Ctrl+Shift+R         → open / close the root console
 *   - Ctrl+Shift+S         → root console shell at the active project's root
 *   - Ctrl+Shift+N / M     → new shell / System Monitor tab in the focused pane
 *   - Ctrl+1 … Ctrl+9      → new agent tab there: 1 = the default agent, 2–9
 *                            the + menu's other agents in order
 *
 * Steering mode (`steeringMode` chord): a modal layer for the fixed keys in
 * `STEERING_KEYS`, captured on `document` in the CAPTURE phase so xterm never
 * sees them and the mode works FROM a focused terminal — the point is that the
 * hands never leave the keyboard. While active every key is swallowed. The
 * mode is a hierarchy (`SteeringLevel`): projects → subwindows → tabs, ↓ in and
 * ↑ out (E S D F double the arrows), opening on the tabs; Space, Escape or
 * Enter leave it. Plus a region cursor (`lib/shortcuts/steeringRegion`) for the
 * side panel, the header apps and a pane's + menu.
 */
/** `KeyboardEvent.key` of the Super/Windows/Command key, as the engines name it. */
function isSuperKey(key: string): boolean {
  return key === "Meta" || key === "Super" || key === "OS";
}

/**
 * How long a released lone Super waits before toggling the panels. A desktop
 * that answers the key itself takes focus on that same release; its blur
 * reaches us well inside this window and cancels the toggle. Long enough for
 * that, short enough that the toggle still reads as immediate where the key is
 * ours.
 */
export const SUPER_RELEASE_SETTLE_MS = 150;

export function useKeyboard({ onTogglePanels, onSidePanel }: KeyboardOptions) {
  useEffect(() => {
    // Lone-Super press tracking (Linux only; see the binding in `onKeyDown`).
    let superHeld = false;
    let superChorded = false;
    let superToggleTimer: number | null = null;
    const cancelSuperToggle = () => {
      if (superToggleTimer !== null) {
        window.clearTimeout(superToggleTimer);
        superToggleTimer = null;
      }
    };

    // ── Keyboard steering mode ────────────────────────────────────────────
    // A capture-phase listener on `document`, which threads two needles at
    // once: it runs BEFORE xterm's textarea handlers (target phase), so a
    // steered key is stopped before the PTY can see it — and BEFORE this
    // hook's own editable-target guard by construction, so the toggle chord
    // works from a focused terminal (the whole point). But it runs AFTER the
    // settings panel's chord-capture listener (window, capture phase), so
    // rebinding the steering chord itself still captures instead of toggling.
    // Steering's own bookkeeping, outside the store because nothing renders it:
    // whether the side panel is open because steering opened it (Escape out of
    // it closes it again), and the pending retry that lands the region cursor
    // once a surface has mounted.
    let panelOpenedBySteering = false;
    // When the last text character was typed outside the mode (event time).
    let lastTypedAt = -Infinity;
    let placeTimer: number | null = null;
    const cancelPlace = () => {
      if (placeTimer !== null) {
        window.clearTimeout(placeTimer);
        placeTimer = null;
      }
    };
    // A surface steering just opened is not on screen yet (the panel mounts its
    // tree on open, mail and the board are lazy chunks): try for about a second.
    const placeCursorSoon = (region: SteeringRegion, tries = 20) => {
      cancelPlace();
      const root = regionRoot(region);
      if (root && placeRegionCursor(root)) return;
      if (tries <= 0) return;
      placeTimer = window.setTimeout(() => {
        placeTimer = null;
        const s = useKeyboardSteeringStore.getState();
        if (s.active && s.region === region) placeCursorSoon(region, tries - 1);
      }, 50);
    };
    const exitSteering = () => {
      cancelPlace();
      clearRegionCursor();
      panelOpenedBySteering = false;
      useKeyboardSteeringStore.getState().exit();
    };
    // Escape out of a region: close what steering opened for it, back to the
    // level it was entered from.
    const leaveRegion = (region: SteeringRegion) => {
      cancelPlace();
      clearRegionCursor();
      if (region === "side") {
        if (panelOpenedBySteering) onSidePanel?.(false);
        panelOpenedBySteering = false;
      } else if (region === "addTab") {
        // The menu request toggles; only send it while the menu is still up.
        if (regionRoot("addTab")) requestNewTab({ kind: "menu" });
      } else {
        closeApp(region);
      }
      useKeyboardSteeringStore.getState().leaveRegion();
    };
    const enterRegion = (region: SteeringRegion) => {
      clearRegionCursor();
      useKeyboardSteeringStore.getState().enterRegion(region);
      placeCursorSoon(region);
    };
    const openSidePanel = () => {
      if (!regionRoot("side")) {
        onSidePanel?.(true);
        panelOpenedBySteering = true;
      }
      enterRegion("side");
    };
    const openApp = (app: SteeringApp) => {
      if (!steeringAppEnabled(app, useSettingsStore.getState().settings)) return;
      const store = appStore(app);
      if (!store.overlayOpen) store.openOverlay();
      enterRegion(app);
    };

    // The project level: ←/→ walk the station ring, ↓ goes into its windows.
    function steerProjects(e: KeyboardEvent, key: string) {
      const steering = useKeyboardSteeringStore.getState();
      if (key === "Escape" || key === "Enter") {
        exitSteering();
        return;
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        cycleProject(key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (key === "ArrowDown") {
        const tabs = useTabsStore.getState();
        const first = allGroups(tabs.layout)[0]?.id;
        if (!tabs.focusedGroupId && first) tabs.focusGroup(first);
        steering.setLevel("panes");
        return;
      }
      // 1–9 — jump to the Nth station of the SAME ring cycleProject walks:
      // 1 = the root scope, 2 = the first project pill (display order) — the
      // numbers the pill badges show. Stays on this level: ↓ goes in.
      const digit = steeringDigit(e);
      if (digit !== null) {
        const target = projectStations()[digit - 1];
        if (target !== undefined) {
          const ps = useProjectsStore.getState();
          if (target !== ps.activeId) void ps.setActive(target);
        }
        return;
      }
      switch (key.toLowerCase()) {
        case "n": // new project — the + menu's New project dialog
          exitSteering();
          openProjectDialog("new");
          return;
        case "m":
          openApp("mail");
          return;
        case "c":
          openApp("calendar");
          return;
        case "t":
          openApp("todo");
          return;
      }
      steerCommon(e, key);
    }

    // The panes and tabs levels. With one subwindow there is nothing for ←/→
    // to walk between, so they step its tabs at once.
    function steerPanes(e: KeyboardEvent, key: string, level: "panes" | "tabs") {
      const steering = useKeyboardSteeringStore.getState();
      const tabs = useTabsStore.getState();
      const ids = allGroups(tabs.layout).map((g) => g.id);
      const walksPanes = level === "panes" && ids.length >= 2;
      const focused = tabs.focusedGroupId;
      const group = focused ? findGroup(tabs.layout, focused) : null;

      if (key === "ArrowUp") {
        // One subwindow: the panes level would step the same tabs again.
        steering.setLevel(level === "tabs" && ids.length >= 2 ? "panes" : "projects");
        return;
      }
      // Enter / Escape: work here — steering steps aside, focus stays where it
      // was put. (The mode opens on this level, so Escape climbing out through
      // three levels would be three presses to leave.)
      if (key === "Enter" || key === "Escape") {
        exitSteering();
        return;
      }
      if (key === "ArrowDown") {
        if (walksPanes) steering.setLevel("tabs");
        return;
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        const fwd = key === "ArrowRight";
        if (walksPanes) {
          // Document order, wrapping, committed at once via focusGroup (no
          // Shift-preview: the badges re-anchor each step).
          const from = focused ? ids.indexOf(focused) : -1;
          const base = from >= 0 ? from : 0;
          tabs.focusGroup(ids[(base + (fwd ? 1 : -1) + ids.length) % ids.length]);
        } else if (group && group.tabKeys.length > 1) {
          const len = group.tabKeys.length;
          const cur = group.activeKey ? group.tabKeys.indexOf(group.activeKey) : 0;
          tabs.setGroupActive(group.id, group.tabKeys[(cur + (fwd ? 1 : -1) + len) % len]);
        }
        return;
      }
      // New tabs in the focused pane, the Ctrl+Shift+N / M / Ctrl+1–9 set
      // without the modifiers; the new tab takes the keyboard, so steering
      // steps aside. An agent number with nothing behind it does nothing.
      const digit = steeringDigit(e);
      if (digit !== null) {
        if (requestNewTab({ kind: "agent", slot: digit - 1 })) exitSteering();
        return;
      }
      if (key === "+" || key === "=") {
        // The whole + menu, walked with the region cursor.
        if (requestNewTab({ kind: "menu" })) enterRegion("addTab");
        return;
      }
      switch (key.toLowerCase()) {
        case "n":
          if (requestNewTab({ kind: "shell" })) exitSteering();
          return;
        case "m":
          if (requestNewTab({ kind: "monitor" })) exitSteering();
          return;
        case "v": // toggle the focused subwindow's docked file viewer
          if (focused && group) tabs.setGroupFiles(focused, !group.filesOpen);
          return;
        case "w": // close the active tab
          if (tabs.activeKey) closeTabWithConfirm(tabs.activeKey);
          return;
      }
      steerCommon(e, key);
    }

    // The keys every tab-bar level shares.
    function steerCommon(e: KeyboardEvent, key: string) {
      const status = STATUS_KEYS[key.toLowerCase()];
      if (status) {
        // Next (Shift: previous) tab needing an answer / working / finished,
        // in any project; steering follows it down to the tab level.
        const activity = useActivityStore.getState();
        const tabs = useTabsStore.getState();
        const target = nextStatusTab(
          statusTabs(status, activity.busyByTab, activity.attentionByTab, tabs.tabsByScope),
          tabs.activeKey ? { scope: tabs.scope, key: tabs.activeKey } : null,
          e.shiftKey ? -1 : 1,
        );
        if (target) {
          jumpToTab(target.scope, target.key);
          useKeyboardSteeringStore.getState().setLevel("tabs");
        }
        return;
      }
      switch (key.toLowerCase()) {
        case "b":
          openSidePanel();
          return;
        case "p": // toggle the side panels
          onTogglePanels();
          return;
        case ",": // open settings — same door the header ⚙ menu fires
          exitSteering();
          window.dispatchEvent(new CustomEvent("eldrun:open-settings", { detail: "main" }));
          return;
        // Anything else: swallowed, mode stays on.
      }
    }

    // The region cursor: ↑/↓ walk the surface's controls, Enter presses one
    // (Space leaves the mode, as on every level).
    function steerRegion(key: string, region: SteeringRegion) {
      if (key === "Escape") {
        leaveRegion(region);
        return;
      }
      const root = regionRoot(region);
      if (!root) {
        // Closed under the cursor (the pointer, the surface's own ×).
        leaveRegion(region);
        return;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        cancelPlace();
        moveRegionCursor(root, key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        cancelPlace();
        const delta = key === "ArrowRight" ? 1 : -1;
        if (region === "side") {
          stepSidePanelView(delta);
          clearRegionCursor();
          placeCursorSoon("side");
        } else {
          moveRegionCursor(root, delta);
        }
        return;
      }
      // / — type into the surface's search field (the + menu's filter). It
      // never takes the keyboard by itself: E S D F keep steering until asked.
      if (key === "/") {
        if (focusRegionSearch(root)) exitSteering();
        return;
      }
      if (key === "Enter") {
        const done = activateRegionCursor();
        if (done === "type") {
          exitSteering();
        } else if (done === "press") {
          // A pick that closed the surface: a + menu row has opened its tab,
          // which now has the keyboard; anything else goes back a level.
          window.requestAnimationFrame(() => {
            const s = useKeyboardSteeringStore.getState();
            if (!s.active || s.region !== region || regionRoot(region)) return;
            if (region === "addTab") exitSteering();
            else {
              clearRegionCursor();
              s.leaveRegion();
            }
          });
        }
        return;
      }
    }

    function onSteeringKeyDown(e: KeyboardEvent) {
      const steering = useKeyboardSteeringStore.getState();
      if (hasActiveModal()) {
        // A dialog owns the keyboard now (one steering opened, or any other);
        // a legend still promising steering keys would be lying.
        if (steering.active) exitSteering();
        return;
      }
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;

      // The chord toggles: enter when inactive, exit when active.
      // A chord that types text (the Shift+Space default) is left alone in the
      // middle of a typing burst: "I am" with the Shift still down from the I
      // is a space, not a request to steer.
      const steerChord = resolveChord("steeringMode", overrides);
      if (
        chordMatches(steerChord, e) &&
        (steering.active || !typesText(steerChord) || e.timeStamp - lastTypedAt > TYPING_BURST_MS)
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        else {
          // The mode opens on the tabs, so a subwindow has to hold the focus.
          const tabs = useTabsStore.getState();
          const first = allGroups(tabs.layout)[0]?.id;
          if (!tabs.focusedGroupId && first) tabs.focusGroup(first);
          steering.enter();
        }
        return;
      }
      // The root console toggles from anywhere, a focused terminal included —
      // and from inside steering mode, which it leaves (two modes owning the
      // keyboard at once is one too many).
      if (chordMatches(resolveChord("rootConsole", overrides), e)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        toggleRootConsole();
        return;
      }
      if (chordMatches(resolveChord("projectShell", overrides), e)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        openProjectShellInRootConsole();
        return;
      }
      // A new tab in the focused pane, keyboard focus and all — from a focused
      // terminal too, which is where the hands are when the next one is
      // wanted. It lands in the workspace, so the root console steps aside.
      // An agent number with no agent behind it passes the key on.
      const newTab = newTabRequestFor(e, overrides);
      if (newTab && requestNewTab(newTab)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) exitSteering();
        const overlay = useRootOverlayStore.getState();
        if (overlay.open) overlay.close();
        return;
      }
      // Reopen the last agent tab closed in this scope — from a focused
      // terminal too, since the tab it lands in after a close is usually one.
      // With nothing to reopen the key goes on to wherever it was typed.
      if (chordMatches(resolveChord("reopenClosedTab", overrides), e)) {
        if (reopenClosedAgentTab(useTabsStore.getState().scope)) {
          e.preventDefault();
          e.stopPropagation();
          if (steering.active) exitSteering();
          return;
        }
      }
      if (!steering.active) {
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) lastTypedAt = e.timeStamp;
        return;
      }

      // Lone modifiers pass through unswallowed so a Shift+key still composes.
      if (isLoneModifier(e.key)) return;

      // The mode owns the keyboard: every non-modifier key below — mapped or
      // not — is swallowed here, so nothing ever leaks to the app underneath.
      e.preventDefault();
      e.stopPropagation();

      // ? — the shortcut cheat sheet, from every level (its host listens for
      // the event). Opening an overlay leaves the mode.
      if (e.key === "?") {
        exitSteering();
        window.dispatchEvent(new Event("eldrun:open-shortcut-help"));
        return;
      }

      // Space leaves the mode from anywhere.
      if (e.key === " ") {
        exitSteering();
        return;
      }
      // E S D F steer like the arrows, so the left hand never leaves the home
      // row after Shift+Space.
      const key = HOME_ROW_ARROWS[e.key.toLowerCase()] ?? e.key;
      switch (steering.level) {
        case "projects":
          steerProjects(e, key);
          return;
        case "panes":
        case "tabs":
          steerPanes(e, key, steering.level);
          return;
        case "region":
          if (steering.region) steerRegion(key, steering.region);
          else steering.setLevel(steering.regionReturn);
          return;
      }
    }

    async function onKeyDown(e: KeyboardEvent) {
      if (hasActiveModal()) return;
      // Super key — toggle the side panels, where that key is actually ours.
      //
      // On macOS Cmd reports as "Meta" and is the platform-primary shortcut
      // modifier (see shortcuts.chordMatches), so a lone-key toggle would fire
      // on every Cmd+key chord. On Windows the lone Win key belongs to the OS —
      // the Start menu opens on key *release* at the shell level and
      // preventDefault() cannot stop it, and every global Win+X shortcut
      // pressed while Eldrun is focused fires a lone "Meta" keydown first,
      // spuriously toggling the panels. Both therefore use F9 (below).
      //
      // `PLATFORM === "linux"` used to be the whole test, which quietly said
      // "on Linux this key is free". True of Cinnamon, where the binding was
      // written; false of GNOME, which opens the Activities overview on Super
      // and forwards a lone "Meta" keydown ahead of every Super+<key> shell
      // shortcut — reintroducing the exact Windows symptom on the branch
      // assumed safe (user, 2026-09-07, after a move to GNOME/Wayland: panels
      // gone, and with them the reveal handle, with nothing on screen saying
      // why). Ownership of the bare key is a property of the DESKTOP, not the
      // OS, so ask the backend which one is running.
      //
      // And the toggle fires on RELEASE, not here, and only for a LONE press —
      // see `onKeyUp`. The keydown just arms it. That is what keeps the panels
      // in place on a desktop the probe could not classify: a backend that
      // predates the probe answers nothing, the key then counts as ours, and
      // the shell's Super+Tab / Super+1 / Super+arrow and a bare Super for the
      // overview all used to fire the toggle off this keydown. Now a chord
      // disarms it and a lost focus cancels it (user, 2026-09-07: the memory
      // watchdog had just reloaded the window, one Super press later the side
      // panel was gone).
      if (PLATFORM === "linux" && !desktopOwnsSuperKey() && isSuperKey(e.key)) {
        e.preventDefault();
        if (!e.repeat) {
          superHeld = true;
          superChorded = false;
        }
        return;
      }
      // Any other key while Super is down makes the press a chord, not a toggle.
      if (superHeld) superChorded = true;

      // F11 — the window's fullscreen mode, on every platform (the same toggle
      // as the fullscreen button in `WindowControls`; see
      // `lib/window/fullscreenMode` for why it is recorded).
      if (e.key === "F11") {
        e.preventDefault();
        void toggleWindowFullscreen();
        return;
      }

      // F9 — panel toggle on Windows (see above; also harmless elsewhere, but
      // only advertised on Windows to keep the per-OS onboarding copy simple).
      if (e.key === "F9") {
        e.preventDefault();
        onTogglePanels();
        return;
      }

      // Ctrl +/- / Ctrl+0 — per-window UI zoom (this is the MAIN window; a popout
      // handles its own — see DetachedApp). Handled before the editable-target
      // guard so it works from a focused terminal too (the browser-zoom
      // convention). Agent panes consume these for font zoom and stopPropagation,
      // so those never reach here. Persisted to `ui_zoom` (the main window's own
      // value), which `updateSettings` also re-applies to this webview.
      const zoom = zoomChord(e);
      if (zoom) {
        const cur = useSettingsStore.getState().settings?.ui_zoom;
        const z = zoom === "reset" ? 1 : stepZoom(cur, zoom === "in" ? 1 : -1);
        e.preventDefault();
        void useSettingsStore
          .getState()
          .updateSettings({ ui_zoom: z === 1 ? undefined : z });
        return;
      }

      const tabs = useTabsStore.getState();

      // Escape exits app-internal fullscreen (when active). Only act if we're
      // fullscreen, otherwise let overlays / terminals see the Escape.
      if (e.key === "Escape" && tabs.fullscreenGroupId) {
        e.preventDefault();
        tabs.toggleFullscreen(null);
        return;
      }

      // Don't steal keys from a focused text field (e.g. inline tab rename) —
      // except the macOS ⌘W family, which `editorMayTakeChord` admits, and the
      // tab steps a pane terminal hands over (`terminalMayTakeChord`).
      const editable = isEditableTarget(e.target);
      if (editable && !isMacCommandChord(e) && !isPaneTerminalTarget(e.target)) return;

      // Resolve the configured chord for an action (user override or default).
      // From an editable target only those exceptions may match.
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;
      const is = (action: ShortcutAction) =>
        (!editable || editorMayTakeChord(action, e) || terminalMayTakeChord(action, e)) &&
        chordMatches(resolveChord(action, overrides), e);

      // Toggle app-internal fullscreen of the focused subwindow.
      if (is("toggleFullscreen")) {
        const focused = tabs.focusedGroupId;
        if (focused) {
          e.preventDefault();
          tabs.toggleFullscreen(focused);
        }
        return;
      }

      // Cycle to the next / previous active project.
      if (is("cycleProject")) {
        e.preventDefault();
        cycleProject(1);
        return;
      }
      if (is("cycleProjectBack")) {
        e.preventDefault();
        cycleProject(-1);
        return;
      }

      // Cycle to the next / previous box (the box pills' row order).
      if (is("cycleBox")) {
        e.preventDefault();
        cycleBox(1);
        return;
      }
      if (is("cycleBoxBack")) {
        e.preventDefault();
        cycleBox(-1);
        return;
      }

      // Open the shortcut cheat sheet. This hook only fires the door event
      // (the header-menu pattern); the overlay host owns the dialog.
      if (is("shortcutHelp")) {
        e.preventDefault();
        window.dispatchEvent(new Event("eldrun:open-shortcut-help"));
        return;
      }

      // Close the focused subwindow. Mirror the mouse close button, which only
      // appears when groupCount > 1 (Subwindow.showClose): never close the last
      // remaining subwindow from the keyboard either, so the scope can't be left
      // empty by a stray chord.
      if (is("closeSubwindow")) {
        const focused = tabs.focusedGroupId;
        if (focused && allGroups(tabs.layout).length > 1) {
          e.preventDefault();
          tabs.closeGroup(focused);
        }
        return;
      }

      // Hide the focused subwindow (park it in the side-panel Hidden list,
      // keeping its tabs/PTYs alive). Unlike closeSubwindow this is allowed even
      // for the last remaining subwindow — hiding it just shows the +-placeholder.
      if (is("hideSubwindow")) {
        const focused = tabs.focusedGroupId;
        if (focused) {
          e.preventDefault();
          tabs.hideGroup(focused);
        }
        return;
      }

      // Toggle the focused subwindow's docked file viewer (same flag the ◫
      // button and the sidebar's resize-edge double-click write).
      if (is("toggleSubwindowFiles")) {
        const focused = tabs.focusedGroupId;
        const group = focused ? findGroup(tabs.layout, focused) : null;
        if (focused && group) {
          e.preventDefault();
          tabs.setGroupFiles(focused, !group.filesOpen);
        }
        return;
      }

      // Close the active tab.
      if (is("closeTab")) {
        if (tabs.activeKey) {
          e.preventDefault();
          closeTabWithConfirm(tabs.activeKey);
        }
        return;
      }

      // Close every tab in the current project (scope). The active project's
      // debounced saveLayout effect then persists the now-empty layout.
      if (is("closeAllTabs")) {
        if ((tabs.tabsByScope[tabs.scope] ?? []).length > 0) {
          e.preventDefault();
          tabs.closeAllTabs();
        }
        return;
      }

      // Previous / next tab within the focused subwindow, and the equivalent
      // Shift+Tab cycle. All three step the focused group's active tab.
      const prev = is("prevTab");
      if (prev || is("nextTab") || is("cycleTabs")) {
        const focused = tabs.focusedGroupId;
        const group = focused ? findGroup(tabs.layout, focused) : null;
        if (group && group.tabKeys.length > 1) {
          e.preventDefault();
          const len = group.tabKeys.length;
          const cur = group.activeKey
            ? group.tabKeys.indexOf(group.activeKey)
            : 0;
          const delta = prev ? -1 : 1;
          const next = group.tabKeys[(cur + delta + len) % len];
          tabs.setGroupActive(group.id, next);
        }
        return;
      }

      // Cycle the focused subwindow. Enters a Shift-held preview (default chord
      // Ctrl+Shift+↑/↓): the frame moves to the previewed group and numbered
      // badges show over every subwindow; focus only commits on Shift release
      // (keyup below), Ctrl included or not. Numbering is anchored to the
      // committed focus (id 0), so stepping wraps in document order.
      const down = is("subwindowDown");
      if (down || is("subwindowUp")) {
        const ids = allGroups(tabs.layout).map((g) => g.id);
        const n = ids.length;
        if (n >= 2) {
          e.preventDefault();
          const nav = useSubwindowNavStore.getState();
          const base =
            nav.active && nav.previewGroupId
              ? nav.previewGroupId
              : tabs.focusedGroupId;
          const baseIdx = base ? ids.indexOf(base) : -1;
          const from = baseIdx >= 0 ? baseIdx : 0;
          const nextIdx = (from + (down ? 1 : -1) + n) % n;
          nav.preview(ids[nextIdx]);
        }
        return;
      }
    }

    // Commit the previewed subwindow focus when Shift is released; cancel (no
    // focus move) if the window loses focus mid-preview.
    function onKeyUp(e: KeyboardEvent) {
      if (hasActiveModal()) {
        superHeld = false;
        superChorded = false;
        cancelSuperToggle();
        return;
      }
      // The lone-Super toggle (armed in `onKeyDown`) lands here, after a short
      // settle: the shell that owns this key takes focus on the same release
      // (GNOME's overview, KDE's launcher), and the blur that follows cancels
      // the pending toggle instead of racing it.
      if (superHeld && isSuperKey(e.key)) {
        const lone = !superChorded;
        superHeld = false;
        superChorded = false;
        if (lone && PLATFORM === "linux" && !desktopOwnsSuperKey()) {
          e.preventDefault();
          cancelSuperToggle();
          superToggleTimer = window.setTimeout(() => {
            superToggleTimer = null;
            if (!hasActiveModal()) onTogglePanels();
          }, SUPER_RELEASE_SETTLE_MS);
        }
      }
      const nav = useSubwindowNavStore.getState();
      if (nav.active && (e.key === "Shift" || !e.shiftKey)) {
        if (nav.previewGroupId) useTabsStore.getState().focusGroup(nav.previewGroupId);
        nav.end();
      }
    }
    function onBlur() {
      // Focus left with Super down or just released: the desktop answered the
      // key (overview, launcher, a window switch) — not a panel toggle.
      superHeld = false;
      superChorded = false;
      cancelSuperToggle();
      const nav = useSubwindowNavStore.getState();
      if (nav.active) nav.end();
      // Steering must not survive a window blur either — coming back to a
      // window silently swallowing every key would read as a hung app.
      if (useKeyboardSteeringStore.getState().active) exitSteering();
    }

    // Which desktop is running decides whether the bare Super key is ours (see
    // the binding above). One cached probe per session; fire-and-forget,
    // because until it answers the handler keeps the pre-existing behavior.
    if (PLATFORM === "linux") void probeSuperKeyOwnership();

    document.addEventListener("keydown", onSteeringKeyDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelSuperToggle();
      cancelPlace();
      document.removeEventListener("keydown", onSteeringKeyDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [onTogglePanels, onSidePanel]);
}

/** Steering's status-jump letters (`STEERING_KEYS`' Q / R / D rows). */
const STATUS_KEYS: Record<string, TabStatusKind | undefined> = {
  q: "decision",
  r: "working",
  x: "done",
};

/** Steering's home-row arrows: E ↑, D ↓, S ←, F → (the arrows work too). */
const HOME_ROW_ARROWS: Record<string, string | undefined> = {
  e: "ArrowUp",
  d: "ArrowDown",
  s: "ArrowLeft",
  f: "ArrowRight",
};

/** A steering chord typed within this long of the last text key is text. */
const TYPING_BURST_MS = 400;

/** Whether a chord would type a character (no Ctrl / Alt / Meta held). */
function typesText(chord: ChordDescriptor): boolean {
  return !chord.ctrl && !chord.alt && !chord.meta && normalizeKey(chord.key).length === 1;
}

/** A steering digit 1–9, by character or by physical key — AZERTY types `&`
 *  on the key US calls 1 (`chordMatches`' reason for the same fallback). */
function steeringDigit(e: KeyboardEvent): number | null {
  if (/^[1-9]$/.test(e.key)) return Number(e.key);
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}

/** The overlay store behind a header app — the same `openOverlay` /
 *  `closeOverlay` its header button calls. */
function appStore(app: SteeringApp): {
  overlayOpen: boolean;
  openOverlay: () => void;
  closeOverlay: () => void;
} {
  switch (app) {
    case "mail":
      return useMailStore.getState();
    case "calendar":
      return useCalendarStore.getState();
    case "todo":
      return useTodoStore.getState();
  }
}

function closeApp(app: SteeringApp) {
  const store = appStore(app);
  if (store.overlayOpen) store.closeOverlay();
}

/** Put the side panel on the next / previous of its views — the settings patch
 *  its switcher and edge rail write. */
function stepSidePanelView(delta: 1 | -1) {
  const settings = useSettingsStore.getState().settings;
  const key = sidePanelViewKey(
    useProjectsStore.getState().activeId,
    useTabsStore.getState().scope,
  );
  const current = settings?.side_panel_view_by_project?.[key] ?? settings?.side_panel_view ?? "files";
  const at = SIDE_PANEL_VIEWS.indexOf(current);
  const n = SIDE_PANEL_VIEWS.length;
  const next = SIDE_PANEL_VIEWS[at < 0 ? 0 : (at + delta + n) % n];
  void useSettingsStore.getState().updateSettings(sidePanelViewPatch(next, key, settings));
}

/**
 * Cycle the active scope to the next one (by display order).
 *
 * The **root terminal is a station in the cycle**, not a hole in it: it is the
 * pill strip's first pill, so a shortcut that walks the strip has to stop there
 * too. It was skipped, and worse than skipped — cycling *out* of the root scope
 * worked (no pill matches a `null` activeId, so `-1 + 1` landed on the first
 * project) while cycling *back into* it was impossible, making the shortcut a
 * one-way door out of the root terminal.
 *
 * `null` leads the ring for the same reason the pill is pinned to the left edge.
 *
 * The ring itself lives in `stores/keyboardSteering.projectStations` — the
 * steering digits and pill badges number the same list, so the three surfaces
 * can never disagree about which project is station N.
 */
function cycleProject(delta: 1 | -1) {
  const ps = useProjectsStore.getState();
  const stations = projectStations();
  if (stations.length < 2) return;
  const idx = stations.indexOf(ps.activeId);
  const next = stations[(idx + delta + stations.length) % stations.length];
  if (next !== ps.activeId) void ps.setActive(next);
}

/**
 * Walk the boxes in row order — the order their pills stand in beside the
 * scope chip — and open the next / previous one (`openBox`, which moves the
 * tab scope into the box; the switcher follows the scope into the slice).
 * From outside any box the first step lands on the first box (walking back:
 * the last), so the chord is also the way INTO the boxes from a project.
 */
export function cycleBox(delta: 1 | -1) {
  const store = useBoxesStore.getState();
  const boxes = [...store.boxes].sort((a, b) => a.position - b.position);
  if (boxes.length === 0) return;
  const scope = useTabsStore.getState().scope;
  const current = scope.startsWith(BOX_SCOPE_PREFIX)
    ? scope.slice(BOX_SCOPE_PREFIX.length)
    : null;
  const idx = current ? boxes.findIndex((b) => b.id === current) : -1;
  const next =
    idx < 0
      ? boxes[delta > 0 ? 0 : boxes.length - 1]
      : boxes[(idx + delta + boxes.length) % boxes.length];
  if (next.id !== current) void store.openBox(next.id);
}
