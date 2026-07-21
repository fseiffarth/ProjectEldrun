import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type MutableRefObject,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PLATFORM } from "../../lib/dragPlatform";
import { nextWindowState } from "../../lib/windowState";
import { notePtyOutput, useActivityStore } from "../../stores/activity";
import { usePowerStore, useEnergySaver, saverInterval } from "../../stores/power";
import { CenterPanel } from "./CenterPanel";
import { HeaderBar } from "./HeaderBar";
import { RightPanel } from "./RightPanel";
import { VpnPasswordPrompt } from "./VpnPasswordPrompt";
import { AlarmPopup } from "../calendar/AlarmPopup";
import { RemoteConnectDialog } from "../projects/RemoteConnectDialog";
import { RemoteMachinesDialogHost } from "../projects/RemoteMachinesWindow";
import { HpcPipelineWizardHost } from "../projects/HpcPipelineWizard";
import { LocalLossDialog } from "../common/LocalLossDialog";
import { RemoteUsageWarningDialog } from "../common/RemoteUsageWarningDialog";
import { QuickOpen } from "../files/QuickOpen";
import { HintHost } from "./HintHost";
import { TourHost } from "./TourHost";
import { StatsRecapHost } from "../stats/StatsRecapHost";
import { HowToStart } from "./HowToStart";
import { LessonsMenu } from "./LessonsMenu";
import { useHintsStore } from "../../stores/hints";
import { useProjectsStore, listenProjectRuntimeSwitched } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { disconnectAllTunnelsOnQuit } from "../../stores/vpnStatus";
import { listenDetachedHost, shutdownDetachedWindows } from "../../stores/detached";
import { listenPdfReveal } from "../../stores/pdfSync";
import { listenSyncProgress } from "../../stores/sync";
import { autoConnectVpnOnLaunch } from "../../lib/vpnAutoConnect";
import { listenEditorJump } from "../../stores/editorJump";
import { listenSourceJump } from "../embed/FileViewerPane";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { useTimerStore } from "../../stores/timer";
import { flushUsage } from "../../stores/usage";
import { useKeyboard } from "../../hooks/useKeyboard";

// Width of the right-edge band that reveals the (unpinned) right panel on hover.
// Kept wide because on Windows/WebView2 the window often isn't true-fullscreen
// (the Windows platform backend is a stub, so setFullscreen may not take) and
// the OS resize border swallows mousemove events for the last few edge pixels —
// a 2px strip there is unreachable, so the panel never opened. A wider band is
// crossed on the way to the edge, so the reveal fires before the dead-zone.
const REVEAL_EDGE_PX = 8;

// Right-panel width bounds. The default matches the historical fixed 280px so
// existing installs (no stored width) look unchanged; the max is capped against
// the live window so the panel can never swallow the whole workspace.
const RIGHT_PANEL_MIN = 220;
const RIGHT_PANEL_DEFAULT = 280;
function clampRightWidth(px: number): number {
  const max = Math.max(RIGHT_PANEL_MIN, Math.min(900, window.innerWidth - 240));
  return Math.round(Math.max(RIGHT_PANEL_MIN, Math.min(max, px)));
}

/**
 * Snapshot the main window's geometry and persist it if it actually changed, so
 * the backend can reopen the window on the same monitor next launch
 * (`restore_main_window` in lib.rs). What to store — and the subtlety of what to
 * store while MAXIMIZED — lives in `nextWindowState`.
 *
 * Shared by the debounced move/resize listener and the close path: a quit during
 * the debounce window would otherwise lose the user's last move, which is exactly
 * the move they care about.
 */
async function saveWindowGeometry(): Promise<void> {
  const win = getCurrentWindow();
  // A fullscreen window's rect is just the monitor, not a restore geometry. macOS
  // only — Linux/Windows never enter fullscreen (see the startup effect).
  if (await win.isFullscreen()) return;
  const [pos, size, maximized] = await Promise.all([
    win.outerPosition(),
    win.outerSize(),
    win.isMaximized(),
  ]);
  // outerPosition/outerSize are already PHYSICAL px, which is what the backend
  // consumes — nothing is converted anywhere along this path (src/lib/coords.ts).
  const store = useSettingsStore.getState();
  const next = nextWindowState(
    store.settings?.window_state,
    { x: pos.x, y: pos.y, w: size.width, h: size.height },
    maximized,
  );
  if (next) await store.saveWindowState(next);
}

export function AppShell() {
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const pinnedSetting = useSettingsStore((s) => s.settings?.right_panel_pinned ?? false);
  const widthSetting = useSettingsStore((s) => s.settings?.right_panel_width ?? RIGHT_PANEL_DEFAULT);
  const panelSide = useSettingsStore((s) => s.settings?.right_panel_side ?? "right");
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
  const connToast = useProjectsStore((s) => s.connToast);
  const clearConnToast = useProjectsStore((s) => s.clearConnToast);
  const initTimer = useTimerStore((s) => s.init);
  const flushTimer = useTimerStore((s) => s.flush);
  const energySaver = useEnergySaver();
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightPinned, setRightPinned] = useState(false);
  const [rightWidth, setRightWidth] = useState(RIGHT_PANEL_DEFAULT);
  const [resizingRight, setResizingRight] = useState(false);
  const latestRightWidth = useRef(RIGHT_PANEL_DEFAULT);
  const [showHowToStart, setShowHowToStart] = useState(false);
  const [showLessons, setShowLessons] = useState(false);
  const rightCloseTimer = useRef<number | null>(null);

  useEffect(() => {
    loadSettings();
    loadProjects();
    // Startup window geometry — which monitor, what size, maximized or not — is
    // owned ENTIRELY by the backend now (`restore_main_window` in lib.rs), which
    // reapplies the rect saved by the effect below before the window is ever shown.
    // Nothing may be re-asserted from here: a `maximize()` fired after load would
    // land on top of a restore onto the secondary monitor and undo it.
    //
    // macOS is the exception and stays here: real fullscreen (its own Space) is the
    // platform-expected behavior, and the system traffic-light controls keep the
    // window manageable. Linux must never follow suit — a window the WM has put into
    // fullscreen keeps `_NET_WM_STATE_FULLSCREEN`, which under KWin wins over
    // MAXIMIZED and makes the window UNMOVABLE (KWin refuses the
    // `_NET_WM_MOVERESIZE` that `startDragging` sends, so the header title-bar drag
    // silently no-ops). See the matching note in `restore_main_window`.
    if (PLATFORM === "macos") {
      getCurrentWindow().setFullscreen(true).catch(() => {});
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

  // Remember where the user puts the window, so it reopens there. Mirrors the
  // popout's bounds streaming (DetachedApp.tsx): a drag fires a storm of events,
  // so debounce and write once it settles. Gated on `settingsLoaded` because the
  // save diffs against the currently-saved rect to skip no-op writes, and before
  // load there is nothing to diff against.
  useEffect(() => {
    if (!settingsLoaded) return;
    const win = getCurrentWindow();
    const unlisteners: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void saveWindowGeometry().catch(() => {});
      }, 300);
    };
    win.onMoved(schedule).then((fn) => unlisteners.push(fn)).catch(() => {});
    win.onResized(schedule).then((fn) => unlisteners.push(fn)).catch(() => {});
    return () => {
      if (timer) clearTimeout(timer);
      unlisteners.forEach((fn) => fn());
    };
  }, [settingsLoaded]);

  // Restore the pinned state once settings finish loading.
  useEffect(() => {
    if (settingsLoaded) setRightPinned(pinnedSetting);
  }, [settingsLoaded, pinnedSetting]);

  // Restore the stored panel width once settings load (clamped to the current
  // window so a width saved on a wider monitor can't strand the panel off-screen).
  useEffect(() => {
    if (settingsLoaded) {
      const w = clampRightWidth(widthSetting);
      latestRightWidth.current = w;
      setRightWidth(w);
    }
  }, [settingsLoaded, widthSetting]);

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

  // Bring up the tunnel armed as "connect on launch" in the header's VPN menu, if any.
  // Waits for both stores: the setting says *which* config, and a project's spec may
  // hold the auth username for it. Self-guarded against a second run, and silent —
  // it never prompts, so a stale opt-in just leaves the tunnel down.
  useEffect(() => {
    if (settingsLoaded && projectsLoaded) void autoConnectVpnOnLaunch();
  }, [settingsLoaded, projectsLoaded]);

  const togglePin = () => {
    setRightPinned((v) => {
      const next = !v;
      void updateSettings({ right_panel_pinned: next });
      return next;
    });
  };

  // Flip the panel to the opposite edge. Persisted only — the layout (docked
  // inset, slide direction, resize math, reveal edge) reads `panelSide`, so no
  // local mirror state is needed.
  const toggleSide = () => {
    void updateSettings({ right_panel_side: panelSide === "left" ? "right" : "left" });
  };

  // Drag the panel's left border to resize. The panel is absolutely positioned
  // at right:0, so its width is just `innerWidth - cursorX`. We update local
  // state live (driving both the panel width and the docked body inset) and
  // persist only on release. Pointer capture keeps the gesture alive when the
  // cursor leaves the thin handle.
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    setResizingRight(true);
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRight) return;
    // The grip straddles the panel's inner edge — on the right that's the left
    // border (width = innerWidth - cursorX); flipped to the left it's the right
    // border (width = cursorX).
    const w = clampRightWidth(panelSide === "left" ? e.clientX : window.innerWidth - e.clientX);
    latestRightWidth.current = w;
    setRightWidth(w);
  };

  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRight) return;
    setResizingRight(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    void updateSettings({ right_panel_width: latestRightWidth.current });
    // Terminals and other panes refit off the DOM resize event; the docked body
    // inset just changed, so nudge them to remeasure at the new width.
    window.dispatchEvent(new Event("resize"));
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

  // SSH-sync Phase 1: subscribe to the backend's mirror-sync progress stream so
  // the remote file view reflects transfers + refreshes status on completion.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenSyncProgress()
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
      // Tear down any live OpenVPN tunnel *before* anything else and before the window
      // goes away. The backend also does this in RunEvent::Exit, but that runs only
      // after destroy(), so its elevated pkexec kill raised the polkit password prompt
      // against an already-gone window. Awaiting it here keeps Eldrun on screen until
      // the prompt is answered. If the user dismisses the prompt the tunnel is still up
      // (it reroutes the whole machine), so abort the quit and say so — running the
      // save/detached-shutdown steps first would have needlessly torn state down.
      const tunnelsDown = await disconnectAllTunnelsOnQuit().catch(() => true);
      if (!tunnelsDown) {
        await message(
          "The OpenVPN tunnel is still up and reroutes this whole machine. " +
            "Close the tunnel first (VPN control in the header), then quit Eldrun.",
          { title: "VPN tunnel still active", kind: "warning" },
        ).catch(() => {});
        return;
      }
      await flushTimer().catch(() => {});
      // Counters accrued since the last interval flush would otherwise be lost on
      // quit — including everything done in the final minutes of a session.
      await flushUsage().catch(() => {});
      // Capture the window's final geometry before it goes away — a quit inside
      // the 300ms save debounce would otherwise drop the user's last move.
      await saveWindowGeometry().catch(() => {});
      // Flush the active scope's tab layout for the same reason: CenterPanel
      // debounces its persistScope by 300ms, so a quit right after navigating a
      // Files (Project) tab into a subfolder (or any tab/split change) would drop
      // it and the tab would reopen at the project root. The right-panel folder
      // is saved eagerly and needs no flush; only the tab layout is debounced.
      const { activeId, projects } = useProjectsStore.getState();
      const localFile = activeId
        ? projects.find((p) => p.id === activeId)?.local_file
        : undefined;
      if (localFile) {
        await useTabsStore.getState().saveLayout(localFile).catch(() => {});
      }
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

  // Periodically commit the usage counters accrued in memory (see stores/usage).
  // Batched on its own, faster cadence than the timer: the counters are cheap to
  // accumulate but each flush is a whole-file rewrite, so this is the knob that
  // keeps a burst of typing from becoming a burst of disk writes.
  useEffect(() => {
    const id = setInterval(() => void flushUsage(), 30_000);
    return () => clearInterval(id);
  }, []);

  // Reconcile the SSH lamp/Connect-dialog status against the backend's actual
  // pool, which is the only side that ever notices a pooled connection dying on
  // its own (network drop, keepalive eviction, a VPN tunnel getting replaced
  // out from under it) — and only lazily, the next time some command happens to
  // touch that project's pool entry. `useRemoteStatusStore` otherwise only ever
  // moves on an explicit connect/disconnect result, so without this a project
  // whose pooled session died keeps showing "connected" (green lamp, the
  // Connect dialog claiming it's already up) indefinitely, while anything that
  // actually asks the pool — e.g. the network-traffic pane's own poll —
  // correctly reports disconnected. A project the store still marks
  // "connected" that the backend no longer lists gets corrected to "error" so
  // the lamp goes red and the Connect dialog offers a real reconnect.
  useEffect(() => {
    const id = setInterval(() => {
      const { byProject, byHost, setSsh } = useRemoteStatusStore.getState();
      // Every (project, host) the store believes is connected — the primary
      // (byProject) plus every worker host (byHost, multi-host remote).
      const stillConnected: Array<[string, string]> = [];
      for (const [projectId, s] of Object.entries(byProject)) {
        if (s.ssh === "connected") stillConnected.push([projectId, "primary"]);
      }
      for (const [projectId, hosts] of Object.entries(byHost)) {
        for (const [hostId, s] of Object.entries(hosts)) {
          if (s.ssh === "connected") stillConnected.push([projectId, hostId]);
        }
      }
      if (stillConnected.length === 0) return;
      // Per-host truth from the pool (`remote_connected_targets`); anything the
      // store marks connected that the backend no longer lists is corrected to
      // "error" so its lamp goes red and the Connect dialog offers a reconnect.
      void invoke<Array<[string, string]>>("remote_connected_targets")
        .then((targets) => {
          const live = new Set(targets.map(([p, h]) => `${p}${h}`));
          for (const [projectId, hostId] of stillConnected) {
            if (!live.has(`${projectId}${hostId}`)) {
              setSsh(projectId, "error", hostId);
            }
          }
        })
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  // Point the file-churn watcher at the active project, so the recap's
  // created/modified/deleted counts follow whatever the user is working on. The
  // backend resolves which directory that is (a remote project is watched through
  // its local mirror; one with no mirror is not watchable at all, since inotify
  // cannot see an SFTP tree, and records no file stats).
  useEffect(() => {
    void invoke("usage_watch_project", { projectId: activeId ?? "" }).catch(() => {});
  }, [activeId]);

  // Track per-project terminal activity for the running-task pill indicator.
  // One global listener covers background projects too (their PTYs keep
  // emitting even while their tab views are unmounted).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ id: string; data: string }>("terminal-output", (ev) => {
      // The chunk itself rides along: it is the ONLY view of a tab's screen that
      // exists for a pane the user has never opened (those buffer their output
      // instead of writing it to an xterm), and the store classifies a quiet
      // agent tab — finished vs blocked on a prompt — off its tail.
      notePtyOutput(ev.payload.id, ev.payload.data);
    })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  // Recompute the running-task indicators on a fixed cadence. Split from the
  // listener above so re-arming it on an Energy Saver flip doesn't drop the
  // terminal-output listener. On battery the pill lags a little more but the
  // 300ms churn stops.
  useEffect(() => {
    const id = setInterval(
      () => useActivityStore.getState().recompute(),
      saverInterval(300, energySaver),
    );
    return () => clearInterval(id);
  }, [energySaver]);

  // Poll AC/battery state so Energy Saver ("on battery") can react to plug/unplug.
  useEffect(() => usePowerStore.getState().start(), []);

  // Publish the effective Energy Saver state on the document root so the CSS in
  // themes.css can collapse continuous idle animations (`[data-energy-saver]`).
  useEffect(() => {
    const root = document.documentElement;
    if (energySaver) root.dataset.energySaver = "on";
    else delete root.dataset.energySaver;
  }, [energySaver]);

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

  useEffect(() => {
    if (!connToast) return;
    const t = setTimeout(clearConnToast, 3200);
    return () => clearTimeout(t);
  }, [connToast, clearConnToast]);

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
    const nearEdge =
      panelSide === "left"
        ? event.clientX <= REVEAL_EDGE_PX
        : window.innerWidth - event.clientX <= REVEAL_EDGE_PX;
    if (nearEdge) {
      useHintsStore.getState().markSeen("file-tree");
      reveal(rightCloseTimer, setRightOpen);
    }
  };

  return (
    <div className="app-shell">
      <HeaderBar />
      {switchToast != null && (
        <div
          key={switchToast}
          className={`project-switch-toast${switchToast.includes("\n") ? " multiline" : ""}`}
        >{switchToast}</div>
      )}
      {connToast != null && (
        <div key={connToast} className="project-switch-toast conn-toast">{connToast}</div>
      )}
      <div
        className={`app-body${revealRight && rightPinned ? (panelSide === "left" ? " left-docked" : " right-docked") : ""}${resizingRight ? " resizing" : ""}`}
        style={
          revealRight && rightPinned
            ? panelSide === "left"
              ? { paddingLeft: rightWidth }
              : { paddingRight: rightWidth }
            : undefined
        }
        onMouseMove={handleBodyMouseMove}
      >
        <CenterPanel />
        {panelTarget && !panelsHidden && (
          <RightPanel
            open={revealRight}
            pinned={rightPinned}
            side={panelSide}
            width={rightWidth}
            resizing={resizingRight}
            onResizeStart={onResizeStart}
            onResizeMove={onResizeMove}
            onResizeEnd={onResizeEnd}
            onTogglePin={togglePin}
            onToggleSide={toggleSide}
            onMouseEnter={() => reveal(rightCloseTimer, setRightOpen)}
            onMouseLeave={() => !rightPinned && scheduleClose(rightCloseTimer, setRightOpen)}
          />
        )}
        {/* Invisible marker at the reveal band so the guided tour has a stable
            element to spotlight for the "find your files" step. Follows the panel
            to whichever edge it docks against. */}
        {panelTarget && !panelsHidden && (
          <div
            className={`tour-edge-marker${panelSide === "left" ? " left" : ""}`}
            data-hint-anchor="file-tree-edge"
            aria-hidden
          />
        )}
        {/* Always-visible CLICK affordance to open the (closed, unpinned) file
            panel. The hover-only right-edge reveal (handleBodyMouseMove) depends
            on WebView2 delivering mousemove in the last few edge pixels — which it
            does NOT do reliably in the packaged Windows window, where the OS resize
            border swallows them. That left no way to open the panel at all, and so
            no way to reach the pin that lives inside it. A click is delivered even
            where the mousemove stream isn't, so this is the reliable path; it
            unmounts the moment the panel is open (revealRight). */}
        {panelTarget && !panelsHidden && !revealRight && (
          <button
            type="button"
            className={`right-panel-reveal-handle${panelSide === "left" ? " left" : ""}`}
            aria-label="Show files panel"
            title="Show files panel"
            onClick={() => reveal(rightCloseTimer, setRightOpen)}
            onMouseEnter={() => reveal(rightCloseTimer, setRightOpen)}
          >
            <span aria-hidden="true">{panelSide === "left" ? "›" : "‹"}</span>
          </button>
        )}
      </div>
      <VpnPasswordPrompt />
      <RemoteConnectDialog />
      {/* Multi-host remote: the "Remote machines" manager, opened from a pill's
          Runtime menu or a right-click on its remote lamp. */}
      <RemoteMachinesDialogHost />
      {/* The guided HPC/SLURM pipeline wizard (login → create → load → run → watch),
          launched from the project-switcher + menu (docs/quirky-knitting-umbrella). */}
      <HpcPipelineWizardHost />
      {/* Same reason as the alarm below: lockstep/sync can delete a file from the local
          mirror during a background pass, and the user must hear about it wherever they
          are — including when the file panel it happened in is closed (#28q). */}
      <LocalLossDialog />
      {/* Fires once per connect (manual or silent auto-connect): warns that the
          host's load/memory/logged-in sessions suggest it's already in use. */}
      <RemoteUsageWarningDialog />
      {/* Calendar reminders live at the shell, not in the calendar pane: an alarm
          must reach the user whatever tab they are on — and even if they have
          never opened a calendar tab this session. */}
      <AlarmPopup />
      <QuickOpen />
      <HintHost />
      <TourHost />
      <StatsRecapHost />
      {showHowToStart && <HowToStart onClose={() => setShowHowToStart(false)} />}
      {showLessons && <LessonsMenu onClose={() => setShowLessons(false)} />}
    </div>
  );
}
