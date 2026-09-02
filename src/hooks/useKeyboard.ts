import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PLATFORM } from "../lib/dragPlatform";
import { allGroups, findGroup, useTabsStore } from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore, stepZoom } from "../stores/settings";
import { useSubwindowNavStore } from "../stores/subwindowNav";
import {
  projectStations,
  useKeyboardSteeringStore,
} from "../stores/keyboardSteering";
import {
  chordMatches,
  isLoneModifier,
  resolveChord,
  type ShortcutAction,
  type ShortcutMap,
} from "../lib/shortcuts";

interface KeyboardOptions {
  onTogglePanels: () => void;
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
 * The navigation chords are user-rebindable (see `src/lib/shortcuts.ts` and the
 * "Keyboard Shortcuts" settings panel); the defaults below are applied when
 * `settings.keyboard_shortcuts` has no override for an action. F11 (OS
 * fullscreen), Super/F9 (panels — Super on Linux, F9 on Windows where the lone
 * Win key belongs to the OS) and Escape (exit fullscreen) are fixed.
 *
 * Default bindings:
 *   - Ctrl+Enter           → toggle fullscreen for the focused subwindow
 *   - Escape               → exit fullscreen (when active) [fixed]
 *   - Shift+Ctrl+Tab       → cycle to the next active project
 *   - Shift+Left/Right     → previous / next tab within the focused subwindow
 *   - Shift+Up/Down        → cycle the focused subwindow (numbered preview shown
 *                            while Shift is held; focus commits on Shift release)
 *   - Shift+Tab            → cycle tabs within the focused subwindow
 *   - Shift+Ctrl+W         → close the focused subwindow
 *   - Ctrl+W               → close the active tab
 *   - Shift+Ctrl+←         → cycle to the previous active project
 *   - F1                   → open the shortcut cheat sheet (window event)
 *   - Ctrl+Shift+Space     → toggle keyboard steering mode (see below)
 *
 * Steering mode (`steeringMode` chord): a modal layer for the fixed keys in
 * `STEERING_KEYS`, captured on `document` in the CAPTURE phase so xterm never
 * sees them and the mode works FROM a focused terminal — the point is that the
 * hands never leave the keyboard. While active every key is swallowed.
 */
export function useKeyboard({ onTogglePanels }: KeyboardOptions) {
  useEffect(() => {
    const win = getCurrentWindow();

    // ── Keyboard steering mode ────────────────────────────────────────────
    // A capture-phase listener on `document`, which threads two needles at
    // once: it runs BEFORE xterm's textarea handlers (target phase), so a
    // steered key is stopped before the PTY can see it — and BEFORE this
    // hook's own editable-target guard by construction, so the toggle chord
    // works from a focused terminal (the whole point). But it runs AFTER the
    // settings panel's chord-capture listener (window, capture phase), so
    // rebinding the steering chord itself still captures instead of toggling.
    function onSteeringKeyDown(e: KeyboardEvent) {
      const steering = useKeyboardSteeringStore.getState();
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;

      // The chord toggles: enter when inactive, exit when active.
      if (chordMatches(resolveChord("steeringMode", overrides), e)) {
        e.preventDefault();
        e.stopPropagation();
        if (steering.active) steering.exit();
        else steering.enter();
        return;
      }
      if (!steering.active) return;

      // Lone modifiers pass through unswallowed so Shift+Tab still composes.
      if (isLoneModifier(e.key)) return;

      // The mode owns the keyboard: every non-modifier key below — mapped or
      // not — is swallowed here, so nothing ever leaks to the app underneath.
      e.preventDefault();
      e.stopPropagation();

      const tabs = useTabsStore.getState();

      if (e.key === "Escape" || e.key === "Enter") {
        steering.exit();
        return;
      }

      // 1–9 — jump to the Nth station of the SAME ring cycleProject walks:
      // 1 = the root scope, 2 = the first project pill (display order) — the
      // numbers the pill badges show. Jumping leaves the mode.
      if (/^[1-9]$/.test(e.key)) {
        const target = projectStations()[Number(e.key) - 1];
        steering.exit();
        if (target !== undefined) {
          const ps = useProjectsStore.getState();
          if (target !== ps.activeId) void ps.setActive(target);
        }
        return;
      }

      // Arrows — move the subwindow focus in document order (↓/→ forward,
      // ↑/← back), committing immediately via focusGroup (no Shift-preview:
      // the badges re-anchor each step). Stays in the mode.
      if (e.key.startsWith("Arrow")) {
        const ids = allGroups(tabs.layout).map((g) => g.id);
        const n = ids.length;
        if (n >= 2) {
          const fwd = e.key === "ArrowDown" || e.key === "ArrowRight";
          const from = tabs.focusedGroupId ? ids.indexOf(tabs.focusedGroupId) : -1;
          const base = from >= 0 ? from : 0;
          tabs.focusGroup(ids[(base + (fwd ? 1 : -1) + n) % n]);
        }
        return;
      }

      const focused = tabs.focusedGroupId;
      const group = focused ? findGroup(tabs.layout, focused) : null;

      // Tab / Shift+Tab — next / previous tab in the focused subwindow.
      if (e.key === "Tab") {
        if (group && group.tabKeys.length > 1) {
          const len = group.tabKeys.length;
          const cur = group.activeKey ? group.tabKeys.indexOf(group.activeKey) : 0;
          const next = group.tabKeys[(cur + (e.shiftKey ? -1 : 1) + len) % len];
          tabs.setGroupActive(group.id, next);
        }
        return;
      }

      // ? — the shortcut cheat sheet (its host listens for the event; part of
      // the later steering work). Opening an overlay leaves the mode.
      if (e.key === "?") {
        steering.exit();
        window.dispatchEvent(new Event("eldrun:open-shortcut-help"));
        return;
      }

      switch (e.key.toLowerCase()) {
        case "f": // toggle the focused subwindow's docked file viewer
          if (focused && group) tabs.setGroupFiles(focused, !group.filesOpen);
          return;
        case "p": // toggle the side panels
          onTogglePanels();
          return;
        case "w": // close the active tab
          if (tabs.activeKey) tabs.removeTab(tabs.activeKey);
          return;
        case "s": // open settings — same door the header ⚙ menu fires
          steering.exit();
          window.dispatchEvent(
            new CustomEvent("eldrun:open-settings", { detail: "main" }),
          );
          return;
        // Anything else: swallowed above, mode stays on.
      }
    }

    async function onKeyDown(e: KeyboardEvent) {
      // F11 — OS fullscreen toggle. On Windows, real fullscreen strips the
      // window styles that Aero Snap and native title-bar dragging rely on (see
      // AppShell's startup), so toggle MAXIMIZE there instead — same "fill the
      // screen" effect, but the window stays snappable/draggable like other apps.
      if (e.key === "F11") {
        e.preventDefault();
        if (PLATFORM === "windows") {
          if (await win.isMaximized()) win.unmaximize();
          else win.maximize();
        } else {
          const isFs = await win.isFullscreen();
          win.setFullscreen(!isFs);
        }
        return;
      }

      // Super key — toggle side panel. Linux only: on macOS Cmd reports as
      // "Meta" and is the platform-primary shortcut modifier (see
      // shortcuts.chordMatches), so a lone-key toggle would fire on every Cmd+key
      // chord. On Windows the lone Win key belongs to the OS — the Start menu
      // opens on key *release* at the shell level and preventDefault() cannot
      // stop it, and every global Win+X shortcut pressed while Eldrun is focused
      // fires a lone "Meta" keydown first, spuriously toggling the panels.
      // Windows therefore uses F9 (below) instead.
      if (PLATFORM === "linux" && (e.key === "Meta" || e.key === "Super")) {
        e.preventDefault();
        onTogglePanels();
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
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const cur = useSettingsStore.getState().settings?.ui_zoom;
        const set1 = (z: number) => {
          e.preventDefault();
          void useSettingsStore
            .getState()
            .updateSettings({ ui_zoom: z === 1 ? undefined : z });
        };
        if (e.code === "Equal") return set1(stepZoom(cur, 1));
        if (e.code === "Minus") return set1(stepZoom(cur, -1));
        if (e.code === "Digit0") return set1(1);
      }

      const tabs = useTabsStore.getState();

      // Escape exits app-internal fullscreen (when active). Only act if we're
      // fullscreen, otherwise let overlays / terminals see the Escape.
      if (e.key === "Escape" && tabs.fullscreenGroupId) {
        e.preventDefault();
        tabs.toggleFullscreen(null);
        return;
      }

      // Don't steal keys from a focused text field (e.g. inline tab rename).
      if (isEditableTarget(e.target)) return;

      // Resolve the configured chord for an action (user override or default).
      const overrides = useSettingsStore.getState().settings
        ?.keyboard_shortcuts as ShortcutMap | undefined;
      const is = (action: ShortcutAction) =>
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
          tabs.removeTab(tabs.activeKey);
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

      // Cycle the focused subwindow. Enters a Shift-held preview: the frame moves
      // to the previewed group and numbered badges show over every subwindow;
      // focus only commits on Shift release (keyup below). Numbering is anchored
      // to the committed focus (id 0), so stepping wraps in document order.
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
      const nav = useSubwindowNavStore.getState();
      if (nav.active && (e.key === "Shift" || !e.shiftKey)) {
        if (nav.previewGroupId) useTabsStore.getState().focusGroup(nav.previewGroupId);
        nav.end();
      }
    }
    function onBlur() {
      const nav = useSubwindowNavStore.getState();
      if (nav.active) nav.end();
      // Steering must not survive a window blur either — coming back to a
      // window silently swallowing every key would read as a hung app.
      const steering = useKeyboardSteeringStore.getState();
      if (steering.active) steering.exit();
    }

    document.addEventListener("keydown", onSteeringKeyDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onSteeringKeyDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [onTogglePanels]);
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
