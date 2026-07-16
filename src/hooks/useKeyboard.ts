import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PLATFORM } from "../lib/dragPlatform";
import { allGroups, findGroup, useTabsStore } from "../stores/tabs";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore } from "../stores/settings";
import { useSubwindowNavStore } from "../stores/subwindowNav";
import {
  chordMatches,
  resolveChord,
  type ShortcutAction,
  type ShortcutMap,
} from "../lib/shortcuts";

interface KeyboardOptions {
  onTogglePanels: () => void;
}

/** True when keystrokes belong to a text field (input/textarea/contenteditable)
 *  — we must not steal those for navigation chords. */
function isEditableTarget(target: EventTarget | null): boolean {
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
 */
export function useKeyboard({ onTogglePanels }: KeyboardOptions) {
  useEffect(() => {
    const win = getCurrentWindow();

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

      // Super key — toggle right panel. Linux only: on macOS Cmd reports as
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

      // Cycle to the next active project.
      if (is("cycleProject")) {
        e.preventDefault();
        cycleProject();
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

      // Hide the focused subwindow (park it in the right-panel Hidden list,
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
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [onTogglePanels]);
}

/** Cycle the active project to the next one (by display order). */
function cycleProject() {
  const ps = useProjectsStore.getState();
  // Active = not inactive; ordered by `position` (the pill display order).
  const active = ps.projects
    .filter((p) => p.status !== "inactive")
    .sort((a, b) => a.position - b.position);
  if (active.length < 2) return;
  const idx = active.findIndex((p) => p.id === ps.activeId);
  const next = active[(idx + 1) % active.length];
  if (next && next.id !== ps.activeId) void ps.setActive(next.id);
}
