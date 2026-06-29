import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { PLATFORM } from "../../lib/dragPlatform";
import { notePtyOutput, useActivityStore } from "../../stores/activity";
import { CenterPanel } from "./CenterPanel";
import { HeaderBar } from "./HeaderBar";
import { RightPanel } from "./RightPanel";
import { VpnPasswordPrompt } from "./VpnPasswordPrompt";
import { QuickOpen } from "../files/QuickOpen";
import { HintHost } from "./HintHost";
import { TourHost } from "./TourHost";
import { HowToStart } from "./HowToStart";
import { LessonsMenu } from "./LessonsMenu";
import { useHintsStore } from "../../stores/hints";
import { useProjectsStore, listenProjectRuntimeSwitched } from "../../stores/projects";
import { listenDetachedHost, shutdownDetachedWindows } from "../../stores/detached";
import { listenPdfReveal } from "../../stores/pdfSync";
import { listenEditorJump } from "../../stores/editorJump";
import { listenSourceJump } from "../embed/FileViewerPane";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { useTimerStore } from "../../stores/timer";
import { useKeyboard } from "../../hooks/useKeyboard";

// Width of the right-edge band that reveals the (unpinned) right panel on hover.
// Kept wide because on Windows/WebView2 the window often isn't true-fullscreen
// (the Windows platform backend is a stub, so setFullscreen may not take) and
// the OS resize border swallows mousemove events for the last few edge pixels —
// a 2px strip there is unreachable, so the panel never opened. A wider band is
// crossed on the way to the edge, so the reveal fires before the dead-zone.
const REVEAL_EDGE_PX = 24;

export function AppShell() {
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const pinnedSetting = useSettingsStore((s) => s.settings?.right_panel_pinned ?? false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const loadProjects = useProjectsStore((s) => s.load);
  const projectsLoaded = useProjectsStore((s) => s.loaded);
  const projectCount = useProjectsStore((s) => s.projects.length);
  const onboardingSeen = useSettingsStore((s) => s.settings?.onboarding_seen ?? false);
  const loadBoxes = useBoxesStore((s) => s.load);
  const activeId = useProjectsStore((s) => s.activeId);
  const scope = useTabsStore((s) => s.scope);
  // The right panel also opens for an active box scope (multi-root file view),
  // even when no project is the current activeId.
  const panelTarget = activeId !== null || scope.startsWith(BOX_SCOPE_PREFIX);
  const switchToast = useProjectsStore((s) => s.switchToast);
  const clearSwitchToast = useProjectsStore((s) => s.clearSwitchToast);
  const initTimer = useTimerStore((s) => s.init);
  const flushTimer = useTimerStore((s) => s.flush);
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightPinned, setRightPinned] = useState(false);
  const [showHowToStart, setShowHowToStart] = useState(false);
  const [showLessons, setShowLessons] = useState(false);
  const rightCloseTimer = useRef<number | null>(null);

  useEffect(() => {
    loadSettings();
    loadProjects();
    const win = getCurrentWindow();
    if (PLATFORM === "macos") {
      // macOS: real fullscreen is the platform-expected behavior (own Space) and
      // the system traffic-light controls keep the window manageable, so keep it.
      win.setFullscreen(true).catch(() => {});
    } else {
      // Windows AND Linux: real (borderless) fullscreen makes the window
      // UNMOVABLE — the OS refuses to let a fullscreen window be dragged, so the
      // header title-bar drag (startDragging) silently does nothing. On Windows it
      // additionally strips the resizable/maximize styles Aero Snap relies on. Use
      // a normal MAXIMIZED window instead: with decorations:false it fills the
      // monitor identically, but keeps the standard styles so dragging the header
      // restores-and-follows the cursor (and snaps to edges on Windows) like any
      // other app. (Windows' fullscreen backend is a stub anyway — see the resize
      // bridge and REVEAL_EDGE_PX notes below.)
      win.setFullscreen(false).then(() => win.maximize()).catch(() => {});
    }
  }, [loadSettings, loadProjects]);

  // WebKitGTK doesn't reliably fire DOM 'resize' / ResizeObserver for OS-level
  // window size changes — notably the startup fullscreen transition, which on a
  // larger screen jumps the window from its 1400x900 config size to the full
  // monitor, and switching the window to a differently-sized monitor. Terminals
  // (and other panes) refit off the DOM 'resize' event, so without this they
  // open at the pre-fullscreen size and never refit. Bridge Tauri's reliable
  // window events into a DOM resize event:
  //  - onResized: monitor-size switches while fullscreen, manual drag-resize.
  //  - onScaleChanged: moving to a monitor with a different DPI — the logical
  //    (CSS px) viewport changes but WebKitGTK stays silent.
  // rAF-coalesce the live stream so a manual drag-resize doesn't flood
  // listeners, and add a trailing re-fire: a monitor switch settles the final
  // window geometry a few frames after the event, so a single immediate fire can
  // measure mid-transition.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let raf = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          window.dispatchEvent(new Event("resize"));
        });
      }
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(() => {
        trailing = undefined;
        window.dispatchEvent(new Event("resize"));
      }, 250);
    };
    const win = getCurrentWindow();
    win.onResized(fire).then((fn) => unlisteners.push(fn)).catch(() => {});
    win.onScaleChanged(fire).then((fn) => unlisteners.push(fn)).catch(() => {});
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (trailing) clearTimeout(trailing);
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Restore the pinned state once settings finish loading.
  useEffect(() => {
    if (settingsLoaded) setRightPinned(pinnedSetting);
  }, [settingsLoaded, pinnedSetting]);

  // First-run "How to start": show once on a genuinely empty install (the
  // `projects.length === 0` guard keeps upgrading users — who already have
  // projects but no flag — from seeing it). Mark seen immediately (optimistic)
  // so a hot-reload or transient re-render can't reopen it.
  useEffect(() => {
    if (settingsLoaded && projectsLoaded && !onboardingSeen && projectCount === 0) {
      setShowHowToStart(true);
      void updateSettings({ onboarding_seen: true });
    }
  }, [settingsLoaded, projectsLoaded, onboardingSeen, projectCount, updateSettings]);

  // Let the Settings dialog / gear menu re-open the welcome on demand.
  useEffect(() => {
    const open = () => setShowHowToStart(true);
    window.addEventListener("eldrun:open-how-to-start", open);
    return () => window.removeEventListener("eldrun:open-how-to-start", open);
  }, []);

  // Open the lessons picker on demand, and let a tour/lesson step force the
  // (otherwise hover-revealed) file panel open so it has something to spotlight.
  useEffect(() => {
    const openLessons = () => setShowLessons(true);
    const revealPanel = () => {
      if (rightCloseTimer.current !== null) {
        window.clearTimeout(rightCloseTimer.current);
        rightCloseTimer.current = null;
      }
      setRightOpen(true);
    };
    window.addEventListener("eldrun:open-lessons", openLessons);
    window.addEventListener("eldrun:reveal-right-panel", revealPanel);
    return () => {
      window.removeEventListener("eldrun:open-lessons", openLessons);
      window.removeEventListener("eldrun:reveal-right-panel", revealPanel);
    };
  }, []);

  // Load boxes once projects are in memory so deriving each project's box_id
  // (from the authoritative member_ids) runs over the loaded project list.
  useEffect(() => {
    if (projectsLoaded) void loadBoxes();
  }, [projectsLoaded, loadBoxes]);

  const togglePin = () => {
    setRightPinned((v) => {
      const next = !v;
      void updateSettings({ right_panel_pinned: next });
      return next;
    });
  };

  // Apply tab layout / right-panel restores emitted by the backend's
  // project-runtime switch (which runs off the UI thread).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenProjectRuntimeSwitched()
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // #42: register the MAIN window's host side of the detached-subwindow
  // protocol exactly once. This responds to a popped-out window's seed request
  // (shipping its group's tabs+subtree), applies edits streamed back, and docks
  // a group back on request. The detached window renders `DetachedApp` (a
  // different App branch) and never reaches AppShell, so this only ever runs on
  // the main window. Without this wiring a detached window hangs on
  // "Loading subwindow…" forever.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenDetachedHost()
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: SyncTeX forward search may reveal a PDF that's popped out into a detached
  // window (a separate webview/store). Listen for cross-window reveal broadcasts
  // so this window's PdfCanvas reveals the box even when the TeX editor that asked
  // lives in another window. (The detached window registers its own listener.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenPdfReveal()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: the mirror image — SyncTeX reverse search (Ctrl+click in a popped-out
  // PDF) lands the source-line jump here, the window that owns the editor layout.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenSourceJump()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // #42: a reverse-search jump applied in another window (e.g. a detached PDF
  // that owns its source editor) broadcasts here so an editor for that path in
  // THIS window scrolls too. Mirror image of the detached window's listener.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenEditorJump()
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win.onCloseRequested(async (event) => {
      event.preventDefault();
      await flushTimer().catch(() => {});
      // Close any popped-out subwindows so they don't strand on screen; they
      // persist + re-open at their saved bounds next launch (see the helper).
      await shutdownDetachedWindows().catch(() => {});
      await win.destroy();
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [flushTimer]);

  // Periodically commit elapsed time so a crash doesn't lose the whole session.
  // If the tick fires much later than expected the system was likely sleeping;
  // reset the timer start so sleep duration isn't counted as usage.
  useEffect(() => {
    const INTERVAL = 60_000;
    let lastTickAt = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      if (now - lastTickAt > 2 * INTERVAL) {
        useTimerStore.setState((s) => ({
          appStartedAt: s.paused ? null : now,
          projectStartedAt: s.paused ? null : now,
        }));
      }
      lastTickAt = now;
      void flushTimer();
    }, INTERVAL);
    return () => clearInterval(id);
  }, [flushTimer]);

  // Track per-project terminal activity for the running-task pill indicator.
  // One global listener covers background projects too (their PTYs keep
  // emitting even while their tab views are unmounted).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ id: string }>("terminal-output", (ev) => {
      notePtyOutput(ev.payload.id);
    })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    const id = setInterval(() => useActivityStore.getState().recompute(), 300);
    return () => { unlisten?.(); clearInterval(id); };
  }, []);

  useEffect(() => {
    if (projectsLoaded) {
      void initTimer(activeId);
    }
    // Only fire once when projects finish loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded]);

  useEffect(() => {
    if (!switchToast) return;
    const t = setTimeout(clearSwitchToast, 2200);
    return () => clearTimeout(t);
  }, [switchToast, clearSwitchToast]);

  const reveal = (
    timer: MutableRefObject<number | null>,
    setter: (open: boolean) => void,
  ) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setter(true);
  };

  const scheduleClose = (
    timer: MutableRefObject<number | null>,
    setter: (open: boolean) => void,
    delay = 250,
  ) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setter(false);
      timer.current = null;
    }, delay);
  };

  useKeyboard({
    onTogglePanels: () => {
      useHintsStore.getState().markSeen("toggle-panels");
      setPanelsHidden((v) => !v);
    },
  });

  const revealRight = panelTarget && !panelsHidden && (rightOpen || rightPinned);

  const handleBodyMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!panelTarget || panelsHidden || rightOpen) return;
    if (window.innerWidth - event.clientX <= REVEAL_EDGE_PX) {
      useHintsStore.getState().markSeen("file-tree");
      reveal(rightCloseTimer, setRightOpen);
    }
  };

  return (
    <div className="app-shell">
      <HeaderBar />
      {switchToast != null && (
        <div key={switchToast} className="project-switch-toast">{switchToast}</div>
      )}
      <div
        className={`app-body${revealRight && rightPinned ? " right-docked" : ""}`}
        onMouseMove={handleBodyMouseMove}
      >
        <CenterPanel />
        {panelTarget && !panelsHidden && (
          <RightPanel
            open={revealRight}
            pinned={rightPinned}
            onTogglePin={togglePin}
            onMouseEnter={() => reveal(rightCloseTimer, setRightOpen)}
            onMouseLeave={() => !rightPinned && scheduleClose(rightCloseTimer, setRightOpen)}
          />
        )}
        {/* Invisible marker at the right-edge reveal band so the guided tour has
            a stable element to spotlight for the "find your files" step. */}
        {panelTarget && !panelsHidden && (
          <div className="tour-edge-marker" data-hint-anchor="file-tree-edge" aria-hidden />
        )}
      </div>
      <VpnPasswordPrompt />
      <QuickOpen />
      <HintHost />
      <TourHost />
      {showHowToStart && <HowToStart onClose={() => setShowHowToStart(false)} />}
      {showLessons && <LessonsMenu onClose={() => setShowLessons(false)} />}
    </div>
  );
}
