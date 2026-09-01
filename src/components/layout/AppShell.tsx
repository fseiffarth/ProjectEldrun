import {
  lazy,
  Suspense,
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
import {
  usePowerStore,
  useQuiesce,
  saverInterval,
  startFocusTracking,
} from "../../stores/power";
import { applyFastModeAttribute, useFastMode } from "../../lib/fastMode";
import { useOllamaAutoloadOnLaunch } from "../../stores/ollamaAutoload";
import { useRendererWatchdog } from "../../lib/rendererWatchdog";
import { CenterPanel } from "./CenterPanel";
import { HeaderBar } from "./HeaderBar";
import { SidePanel } from "./SidePanel";
import { LogoIcon } from "./LogoIcon";
import { MobileBridgeHost } from "../mobile/MobileBridgeHost";
import { ScreenshotSaveOverlay } from "./ScreenshotSaveOverlay";
import { VpnPasswordPrompt } from "./VpnPasswordPrompt";
import { AlarmPopup } from "../calendar/AlarmPopup";
import { SteeringLegend } from "./SteeringLegend";
import { ShortcutHelpOverlay } from "./ShortcutHelpOverlay";
import { RemoteConnectDialog } from "../projects/RemoteConnectDialog";
import { RemoteMachinesDialogHost } from "../projects/RemoteMachinesWindow";
import { GlobalMachineMonitorDialogHost } from "../monitoring/GlobalMachineMonitorDialog";
import { HpcPipelineWizardHost } from "../projects/HpcPipelineWizard";
import { BigFolderDialogHost } from "../projects/BigFolderExcludeDialog";
import { BoxEditorHost } from "../projects/BoxEditorDialog";
import { BrowserDownloadHost } from "../browser/BrowserDownloadHost";
import { MailOverlayHost } from "../mail/MailOverlay";
import { CalendarOverlayHost } from "../calendar/CalendarOverlay";
import { CalDavSyncHost } from "../calendar/CalDavSyncHost";
import { AgentCronHost } from "./AgentCronHost";
import { CalDavConflictDialog } from "../calendar/CalDavConflictDialog";
import { TodoOverlayHost } from "../todo/TodoOverlay";
import { SkillsOverlayHost } from "../skills/SkillsOverlay";
import { InstallOverlayHost } from "./InstallOverlay";
import { LocalLossDialog } from "../common/LocalLossDialog";
import { HostKeyConfirmDialog } from "../common/HostKeyConfirmDialog";
import { HpcGuardDialog } from "../common/HpcGuardDialog";
import { StopProjectDialog } from "../common/StopProjectDialog";
import { SyncConfirmDialog } from "../common/SyncConfirmDialog";
import { RemoteUsageWarningDialog } from "../common/RemoteUsageWarningDialog";
import { QuickOpen } from "../files/QuickOpen";
import { HintHost } from "./HintHost";
import { TourHost } from "./TourHost";
import { StatsRecapHost } from "../stats/StatsRecapHost";
import { HowToStart } from "./HowToStart";
import { RemoteFeaturesPrompt } from "./RemoteFeaturesPrompt";
import { LessonsMenu } from "./LessonsMenu";
import { useHintsStore } from "../../stores/hints";
import {
  useProjectsStore,
  listenProjectRuntimeSwitched,
  silentReconnectDeadHost,
} from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { disconnectAllTunnelsOnQuit } from "../../stores/vpnStatus";
import { listenDetachedHost, shutdownDetachedWindows } from "../../stores/detached";
import { listenPdfReveal } from "../../stores/pdfSync";
import { listenSyncProgress } from "../../stores/sync";
import { autoConnectVpnOnLaunch } from "../../lib/vpnAutoConnect";
import { initRemoteAutoReconnect } from "../../lib/remoteAutoReconnect";
import { initExperimentalSweep } from "../../lib/experimentalSweep";
import { initMachineSync } from "../../lib/machineSync";
import { installWindowsEvents } from "../../stores/windows";
import { listenEditorJump } from "../../stores/editorJump";
import { listenSourceJump } from "../embed/FileViewerPane";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { useTimerStore } from "../../stores/timer";
import { flushUsage } from "../../stores/usage";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useT, useI18nStore, translate } from "../../lib/i18n";
import { noteTerminalOutputChars } from "../../dev/terminalOutputRate";

// Dev-only perf panel (src/dev/). The ternary is statically resolved at build
// time (`import.meta.env.DEV` → false), so in a shipped bundle the lazy() —
// and with it the whole src/dev/ chunk — is dead code and never emitted.
const DevPerfHost = import.meta.env.DEV
  ? lazy(() => import("../../dev/DevPerfHost").then((m) => ({ default: m.DevPerfHost })))
  : null;

// Width of the right-edge band that reveals the (unpinned) side panel on hover.
// Kept wide because on Windows/WebView2 the window often isn't true-fullscreen
// (the Windows platform backend is a stub, so setFullscreen may not take) and
// the OS resize border swallows mousemove events for the last few edge pixels —
// a 2px strip there is unreachable, so the panel never opened. A wider band is
// crossed on the way to the edge, so the reveal fires before the dead-zone.
const REVEAL_EDGE_PX = 8;

// Side-panel width bounds. The default matches the historical fixed 280px so
// existing installs (no stored width) look unchanged; the max is capped against
// the live window so the panel can never swallow the whole workspace.
const SIDE_PANEL_MIN = 220;
const SIDE_PANEL_DEFAULT = 280;
function clampPanelWidth(px: number): number {
  const max = Math.max(SIDE_PANEL_MIN, Math.min(900, window.innerWidth - 240));
  return Math.round(Math.max(SIDE_PANEL_MIN, Math.min(max, px)));
}

/**
 * A small launch curtain gives the otherwise-empty WebView a clear "Eldrun is
 * starting" state while the settings and project records arrive over IPC. It
 * has a minimum display time so a warm launch does not flash a single frame.
 */
function StartupSplash({ ready }: { ready: boolean }) {
  const [closing, setClosing] = useState(false);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (!ready) return;
    const closeAfter = Math.max(0, 700 - performance.now());
    const closeTimer = window.setTimeout(() => setClosing(true), closeAfter);
    const removeTimer = window.setTimeout(() => setShown(false), closeAfter + 360);
    return () => {
      window.clearTimeout(closeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [ready]);

  if (!shown) return null;
  const message = ready ? "Workspace ready" : "Opening your workspace…";

  return (
    <div
      className={`startup-splash${closing ? " leaving" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={message}
    >
      <div className="startup-splash-mark" aria-hidden="true">
        <span className="startup-splash-orbit startup-splash-orbit-one" />
        <span className="startup-splash-orbit startup-splash-orbit-two" />
        <LogoIcon />
      </div>
      <div className="startup-splash-name">ELDRUN</div>
      <div className="startup-splash-message">{message}</div>
      <div className="startup-splash-progress" aria-hidden="true"><span /></div>
    </div>
  );
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
  const t = useT();
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  // Each read falls back to the pre-rename `right_panel_*` spelling so an install
  // that last wrote settings.json under the old name keeps its pin state, width
  // and edge. Only the `side_panel_*` keys are ever written back.
  const pinnedSetting = useSettingsStore(
    (s) => s.settings?.side_panel_pinned ?? s.settings?.right_panel_pinned ?? false,
  );
  const widthSetting = useSettingsStore(
    (s) => s.settings?.side_panel_width ?? s.settings?.right_panel_width ?? SIDE_PANEL_DEFAULT,
  );
  const panelSide = useSettingsStore(
    (s) => s.settings?.side_panel_edge ?? s.settings?.right_panel_side ?? "right",
  );
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const loadProjects = useProjectsStore((s) => s.load);
  const projectsLoaded = useProjectsStore((s) => s.loaded);
  const projectCount = useProjectsStore((s) => s.projects.length);
  const onboardingSeen = useSettingsStore((s) => s.settings?.onboarding_seen ?? false);
  const remoteFeaturesPrompted = useSettingsStore(
    (s) => s.settings?.remote_features_prompted ?? false,
  );
  const loadBoxes = useBoxesStore((s) => s.load);
  const activeId = useProjectsStore((s) => s.activeId);
  const rootDir = useProjectsStore((s) => s.rootDir);
  const scope = useTabsStore((s) => s.scope);
  // The side panel also opens for an active box scope (multi-root file view),
  // even when no project is the current activeId — and for the ROOT scope, whose
  // `~/eldrun/root` is the app's unfiled/scratch area: the place data lands while
  // it is only being looked at, or before it belongs to any one project. That
  // folder had a terminal but no file view, so the only way to see what was in it
  // was to `ls`. Gated on `rootDir` because it arrives with the projects load —
  // an empty root would give the panel no tree to mount.
  const panelTarget =
    activeId !== null || scope.startsWith(BOX_SCOPE_PREFIX) || (scope === ROOT_SCOPE && !!rootDir);
  const switchToast = useProjectsStore((s) => s.switchToast);
  const clearSwitchToast = useProjectsStore((s) => s.clearSwitchToast);
  const connToast = useProjectsStore((s) => s.connToast);
  const clearConnToast = useProjectsStore((s) => s.clearConnToast);
  const initTimer = useTimerStore((s) => s.init);
  const flushTimer = useTimerStore((s) => s.flush);
  const quiesce = useQuiesce();
  const fastMode = useFastMode();
  // Load the armed local (Ollama) models into memory at launch — main window
  // only, and skipped (loudly) while Energy Saver is on. See stores/ollamaAutoload.
  useOllamaAutoloadOnLaunch();
  // Reload the renderer if its JS heap runs away, before it OOM-crashes the
  // webview (a 44 GB leak was observed 2026-07-31). See lib/rendererWatchdog.
  useRendererWatchdog();
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelPinned, setRightPinned] = useState(false);
  const [panelWidth, setPanelWidth] = useState(SIDE_PANEL_DEFAULT);
  const [resizingPanel, setResizingPanel] = useState(false);
  const latestPanelWidth = useRef(SIDE_PANEL_DEFAULT);
  const [showHowToStart, setShowHowToStart] = useState(false);
  const [showRemoteFeaturesPrompt, setShowRemoteFeaturesPrompt] = useState(false);
  // Set only on the fresh-install path, where HowToStart takes the screen
  // first — this defers the remote-features ask until HowToStart closes
  // instead of stacking two modals on the very first launch.
  const [pendingRemoteFeaturesPrompt, setPendingRemoteFeaturesPrompt] = useState(false);
  const [showLessons, setShowLessons] = useState(false);
  const panelCloseTimer = useRef<number | null>(null);

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
      const w = clampPanelWidth(widthSetting);
      latestPanelWidth.current = w;
      setPanelWidth(w);
    }
  }, [settingsLoaded, widthSetting]);

  // First-run "How to start": show once on a genuinely empty install (the
  // `projects.length === 0` guard keeps upgrading users — who already have
  // projects but no flag — from seeing it). Mark seen immediately (optimistic)
  // so a hot-reload or transient re-render can't reopen it.
  //
  // The "Using VPN or remote machines?" ask rides the same effect so the two
  // never stack: on a fresh install it waits behind HowToStart (queued via
  // `pendingRemoteFeaturesPrompt`, shown from HowToStart's onClose below);
  // otherwise — including an upgrading install that already has projects and
  // so skips HowToStart — it shows immediately. Both settings are written in
  // one `updateSettings` call on the fresh-install branch so a fast second
  // effect run can't read a stale `current` and drop one of the two flags.
  useEffect(() => {
    if (!settingsLoaded || !projectsLoaded) return;
    if (!onboardingSeen && projectCount === 0) {
      setShowHowToStart(true);
      if (!remoteFeaturesPrompted) {
        setPendingRemoteFeaturesPrompt(true);
        void updateSettings({ onboarding_seen: true, remote_features_prompted: true });
      } else {
        void updateSettings({ onboarding_seen: true });
      }
      return;
    }
    if (!remoteFeaturesPrompted) {
      setShowRemoteFeaturesPrompt(true);
      void updateSettings({ remote_features_prompted: true });
    }
  }, [
    settingsLoaded,
    projectsLoaded,
    onboardingSeen,
    projectCount,
    remoteFeaturesPrompted,
    updateSettings,
  ]);

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
      if (panelCloseTimer.current !== null) {
        window.clearTimeout(panelCloseTimer.current);
        panelCloseTimer.current = null;
      }
      setPanelOpen(true);
    };
    window.addEventListener("eldrun:open-lessons", openLessons);
    window.addEventListener("eldrun:reveal-side-panel", revealPanel);
    return () => {
      window.removeEventListener("eldrun:open-lessons", openLessons);
      window.removeEventListener("eldrun:reveal-side-panel", revealPanel);
    };
  }, []);

  // Load boxes once projects are in memory so the stale-`box_id` strip (see
  // boxes store `load`) runs over the loaded project list.
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

  // Install the tunnel-up → reconnect subscription (and the launch-time global-
  // machine sweep) once, on first mount — before the VPN launch effect above can
  // bring a tunnel up, so its `→ connected` transition is already being watched.
  useEffect(() => {
    initRemoteAutoReconnect();
    initMachineSync();
    // App-registry changes (a launched app exiting) → scoped Apps-view refresh.
    installWindowsEvents();
  }, []);

  // Withdraw the tabs (and live browser windows) of any experiment that is
  // switched off — now and on every settings change. Installed here rather than
  // in the Settings panel because a flag can go off without that panel being
  // open: Debug mode carries every unset flag with it, and settings arrive
  // asynchronously at launch. See lib/experimentalSweep.
  useEffect(() => initExperimentalSweep(), []);

  const togglePin = () => {
    setRightPinned((v) => {
      const next = !v;
      void updateSettings({ side_panel_pinned: next });
      return next;
    });
  };

  // Flip the panel to the opposite edge. Persisted only — the layout (docked
  // inset, slide direction, resize math, reveal edge) reads `panelSide`, so no
  // local mirror state is needed.
  const toggleSide = () => {
    void updateSettings({ side_panel_edge: panelSide === "left" ? "right" : "left" });
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
    setResizingPanel(true);
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingPanel) return;
    // The grip straddles the panel's inner edge — on the right that's the left
    // border (width = innerWidth - cursorX); flipped to the left it's the right
    // border (width = cursorX).
    const w = clampPanelWidth(panelSide === "left" ? e.clientX : window.innerWidth - e.clientX);
    latestPanelWidth.current = w;
    setPanelWidth(w);
  };

  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingPanel) return;
    setResizingPanel(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    void updateSettings({ side_panel_width: latestPanelWidth.current });
    // Terminals and other panes refit off the DOM resize event; the docked body
    // inset just changed, so nudge them to remeasure at the new width.
    window.dispatchEvent(new Event("resize"));
  };

  // Apply tab layout / side-panel restores emitted by the backend's
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
      // the prompt is answered — asked exactly once: if the user dismisses it, the
      // backend marks that tunnel declined so RunEvent::Exit won't re-prompt for it
      // with the window already gone (that used to raise a parentless pkexec dialog
      // that could stall shutdown). So a "no" here just warns and the quit proceeds —
      // it does not block the app from closing.
      const tunnelsDown = await disconnectAllTunnelsOnQuit().catch(() => true);
      if (!tunnelsDown) {
        const lang = useI18nStore.getState().lang;
        await message(translate(lang, "appShell.vpnStillActiveMessage"), {
          title: translate(lang, "appShell.vpnStillActiveTitle"),
          kind: "warning",
        }).catch(() => {});
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
      // it and the tab would reopen at the project root. The side-panel folder
      // is saved eagerly and needs no flush; only the tab layout is debounced.
      const { activeId, projects } = useProjectsStore.getState();
      const localFile = activeId
        ? projects.find((p) => p.id === activeId)?.local_file
        : undefined;
      if (localFile) {
        await useTabsStore.getState().saveLayout(localFile).catch(() => {});
      }
      // A clean Eldrun quit ends only the local tmux sessions named and owned by
      // Eldrun. It runs after the layout flush so an abnormal close still has a
      // durable tab/session pairing to restore, but before `destroy()` causes the
      // backend's general PTY teardown. A crash never reaches this path: its tmux
      // sessions remain alive and the saved tabs reattach on the next launch.
      await invoke<void>("local_tmux_kill_eldrun_sessions").catch(() => {});
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
  // out from under it, or an HPC job's long queue wait past `ControlPersist`) —
  // and only lazily, the next time some command happens to touch that
  // project's pool entry. `useRemoteStatusStore` otherwise only ever moves on
  // an explicit connect/disconnect result, so without this a project whose
  // pooled session died keeps showing "connected" (green lamp, the Connect
  // dialog claiming it's already up) indefinitely, while anything that
  // actually asks the pool — e.g. the network-traffic pane's own poll —
  // correctly reports disconnected. A project the store still marks
  // "connected" that the backend no longer lists is handed to
  // `silentReconnectDeadHost`, which re-authenticates it with no prompt when
  // that's possible (headless + key/agent auth or a saved password) and only
  // falls back to a red "error" lamp when it isn't — so a background HPC watch
  // tab's host reconnects on its own instead of sitting disconnected until the
  // user notices and clicks reconnect by hand.
  useEffect(() => {
    const id = setInterval(() => {
      const { byProject, byHost } = useRemoteStatusStore.getState();
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
      // store marks connected that the backend no longer lists gets a silent
      // reconnect attempt rather than an immediate red lamp.
      void invoke<Array<[string, string]>>("remote_connected_targets")
        .then((targets) => {
          const live = new Set(targets.map(([p, h]) => `${p}${h}`));
          for (const [projectId, hostId] of stillConnected) {
            if (!live.has(`${projectId}${hostId}`)) {
              void silentReconnectDeadHost(projectId, hostId);
            }
          }
        })
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  // Point the file-churn watcher at the active scope, so the recap's
  // created/modified/deleted counts follow whatever the user is working on. The
  // backend resolves which directory that is (a remote project is watched through
  // its local mirror; one with no mirror is not watchable at all, since inotify
  // cannot see an SFTP tree, and records no file stats).
  //
  // The ROOT scope is a scope like any other here — `~/eldrun/root` is a real
  // local tree, its terminals already file every other counter under `"root"`
  // (`stores/usage`), and it is where a file that has not found a project yet
  // gets worked on. This used to send `""`, the backend's "watch nothing", so
  // that half of the recap silently reported zero for it. `?? ROOT_SCOPE`, not
  // `?? ""`: the empty string still means stop watching, and nothing here wants
  // that.
  useEffect(() => {
    void invoke("usage_watch_project", { projectId: activeId ?? ROOT_SCOPE }).catch(() => {});
  }, [activeId]);

  // Track per-project terminal activity for the running-task pill indicator.
  // One global listener covers background projects too (their PTYs keep
  // emitting even while their tab views are unmounted).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenDigest: (() => void) | undefined;
    listen<{ id: string; data: string }>("terminal-output", (ev) => {
      // The chunk itself rides along: the store classifies a quiet agent tab —
      // finished vs blocked on a prompt — off its tail.
      notePtyOutput(ev.payload.id, ev.payload.data);
      // Development-only transport-rate readout in the side-panel footer.
      // Count here because this is already the one app-wide listener: adding a
      // second listener just for profiling would add dispatch work to the hot
      // path being measured. Vite folds this branch away in production.
      if (import.meta.env.DEV) {
        noteTerminalOutputChars(ev.payload.id, ev.payload.data.length);
      }
    })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    // A HIDDEN pane's PTY emits no terminal-output at all (visible-only
    // streaming): the backend condenses its output into these throttled
    // digests, which carry the same tail the classifier needs — so background
    // agent tabs keep their working/decision/done pills without their full
    // streams ever crossing IPC. (`terminal-replay`, the show-again catch-up,
    // is deliberately NOT fed in here: its bytes were already digested live,
    // and re-noting them would flash a quiet tab "working" on every show.)
    listen<{ id: string; data: string }>("terminal-activity", (ev) => {
      notePtyOutput(ev.payload.id, ev.payload.data);
    })
      .then((fn) => { unlistenDigest = fn; })
      .catch(() => {});
    return () => { unlisten?.(); unlistenDigest?.(); };
  }, []);

  // Recompute the running-task indicators on a fixed cadence. Split from the
  // listener above so re-arming it on a quiesce flip doesn't drop the
  // terminal-output listener. On battery — or unfocused — the pill lags a
  // little more but the 300ms churn stops.
  useEffect(() => {
    const id = setInterval(
      () => useActivityStore.getState().recompute(),
      saverInterval(300, quiesce),
    );
    return () => clearInterval(id);
  }, [quiesce]);

  // Poll AC/battery state so Energy Saver ("on battery") can react to plug/unplug.
  useEffect(() => usePowerStore.getState().start(), []);

  // Track window focus: blur engages the same throttles as Energy Saver, plus
  // the wholesale animation pause (`[data-blurred]` in themes.css) — a blurred
  // window that keeps animating never lets its render thread reach idle.
  useEffect(() => startFocusTracking(), []);

  // Publish the effective quiesce state (Energy Saver OR blurred) on the
  // document root so the CSS in themes.css can collapse continuous idle
  // animations (`[data-energy-saver]`).
  useEffect(() => {
    const root = document.documentElement;
    if (quiesce) root.dataset.energySaver = "on";
    else delete root.dataset.energySaver;
  }, [quiesce]);

  // The same publication for fast mode (`[data-fast-mode]`), which collapses
  // animations *and* transitions — a standing preference rather than a
  // battery reading, so it is its own attribute rather than a third writer of
  // `data-energy-saver`.
  useEffect(() => applyFastModeAttribute(fastMode), [fastMode]);

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

  const revealPanel = panelTarget && !panelsHidden && (panelOpen || panelPinned);

  const handleBodyMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!panelTarget || panelsHidden || panelOpen) return;
    const nearEdge =
      panelSide === "left"
        ? event.clientX <= REVEAL_EDGE_PX
        : window.innerWidth - event.clientX <= REVEAL_EDGE_PX;
    if (nearEdge) {
      useHintsStore.getState().markSeen("file-tree");
      reveal(panelCloseTimer, setPanelOpen);
    }
  };

  return (
    <div className="app-shell">
      <StartupSplash ready={settingsLoaded && projectsLoaded} />
      <MobileBridgeHost />
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
        className={`app-body${revealPanel && panelPinned ? (panelSide === "left" ? " left-docked" : " right-docked") : ""}${resizingPanel ? " resizing" : ""}`}
        style={
          revealPanel && panelPinned
            ? panelSide === "left"
              ? { paddingLeft: panelWidth }
              : { paddingRight: panelWidth }
            : undefined
        }
        onMouseMove={handleBodyMouseMove}
      >
        <CenterPanel />
        {panelTarget && !panelsHidden && (
          <SidePanel
            open={revealPanel}
            pinned={panelPinned}
            side={panelSide}
            width={panelWidth}
            resizing={resizingPanel}
            onResizeStart={onResizeStart}
            onResizeMove={onResizeMove}
            onResizeEnd={onResizeEnd}
            onTogglePin={togglePin}
            onToggleSide={toggleSide}
            onMouseEnter={() => reveal(panelCloseTimer, setPanelOpen)}
            onMouseLeave={() => !panelPinned && scheduleClose(panelCloseTimer, setPanelOpen)}
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
            unmounts the moment the panel is open (revealPanel). It doubles as
            the *edge marker*: unpinned, the panel is invisible, so this labelled
            tab is the only thing saying which side it will slide in from. */}
        {panelTarget && !panelsHidden && !revealPanel && (
          <button
            type="button"
            className={`side-panel-reveal-handle${panelSide === "left" ? " left" : ""}`}
            aria-label={t("appShell.showFilesPanel")}
            title={t("appShell.showFilesPanel")}
            onClick={() => reveal(panelCloseTimer, setPanelOpen)}
            onMouseEnter={() => reveal(panelCloseTimer, setPanelOpen)}
          >
            <span className="srh-chevron" aria-hidden="true">
              {panelSide === "left" ? "›" : "‹"}
            </span>
            <span className="srh-label" aria-hidden="true">{t("appShell.filesEdgeLabel")}</span>
          </button>
        )}
      </div>
      <VpnPasswordPrompt />
      {/* "Where should this screenshot go?" — the consent step between a capture
          and any project write. At the shell because the capture can come from the
          header's global-app menu or from any visible PDF viewer, and because the
          backend reports OS-tool captures as an app-wide event with no component of
          its own to land in. */}
      <ScreenshotSaveOverlay />
      {/* "Is this the right machine?" — shown before a password is sent to a host
          whose SSH key has never been accepted here. At the shell because it can be
          raised by any connect surface (the Connect modal, a create/extend dialog,
          the Machines menu), and each of them must not carry its own copy. */}
      <HostKeyConfirmDialog />
      {/* The HPC tag's per-act confirmation (disk scan, login-node run). Mounted
          here for the same reason the host-key prompt is: the caller is a lib
          function with no component of its own to render into. */}
      <HpcGuardDialog />
      <StopProjectDialog />
      {/* "This will overwrite that side" — the confirmation every byte-sync
          transfer asks for. Here for the same reason as the two above: a pull or
          push can be started from the file tree, the file view's toolbar or the
          diverged-files list, and none of them may carry its own copy of the
          question. */}
      <SyncConfirmDialog />
      <RemoteConnectDialog />
      {/* Multi-host remote: the "Remote machines" manager, opened from a pill's
          Runtime menu or a right-click on its remote lamp. */}
      <RemoteMachinesDialogHost />
      {/* The header Machines menu's "System monitor…" button, per global machine. */}
      <GlobalMachineMonitorDialogHost />
      {/* The guided HPC/SLURM pipeline wizard (login → create → load → run → watch),
          launched from the project-switcher + menu (docs/quirky-knitting-umbrella). */}
      <HpcPipelineWizardHost />
      {/* "These folders are giant — sync them?", asked once when a project is first
          paired with a host. Lives at the shell for the same reason the manager
          above does: the project that asked may not be the active one by the time
          its census (local walk + one host `du`) comes back. */}
      <BigFolderDialogHost />
      {/* Box editor (#41): rename / member list / explicit dissolve. */}
      <BoxEditorHost />
      {/* Same reason as the alarm below: lockstep/sync can delete a file from the local
          mirror during a background pass, and the user must hear about it wherever they
          are — including when the file panel it happened in is closed (#28q). */}
      <LocalLossDialog />
      {/* The in-app browser's download consent (#61). Mounted once per window,
          not per pane: the dialog is portaled to <body> and CenterPanel keeps
          every tab mounted, so a pane-rendered one would appear once per browser
          tab. It also owns the browser event listeners, so a download raised by a
          live-page window is answerable even when no browser tab is open. */}
      <BrowserDownloadHost />
      {/* Mail as a global app: the header's ✉ button opens the ordinary MailPane
          as an overlay over whatever is on screen. At the shell rather than in
          the header because it covers the window, not the header — and because
          it must survive a project switch, which mail (unlike a tab) ignores. */}
      <MailOverlayHost />
      {/* The calendar's twin of the above: the header's 🗓 button opens the
          ordinary CalendarPane as an overlay, at the shell for the same reason —
          it covers the window and must survive a project switch. */}
      <CalendarOverlayHost />
      {/* CalDAV's scheduled sync (docs/caldav_plan.md Phase 2). Renders nothing,
          and starts no timer at all until an account exists — at the shell for
          the alarm ticker's reason: the surfaces that read a synced calendar
          (the header badge, the board's agenda rail, the reminders) are not the
          calendar pane, so refreshing only while that pane is open would leave
          the calendar stale exactly where it is looked at. */}
      <CalDavSyncHost />
      {/* The agent warm-up cron (Manage CLIs → Scheduled warm-up). Renders
          nothing and starts no timer until an agent is scheduled — at the shell
          for `CalDavSyncHost`'s reason turned around: the panel that configures
          it is precisely the surface nobody has open at 06:00, so a timer living
          there would only ever fire while its own settings page was being read.
          Main window only, so two windows cannot both send the morning's
          message. */}
      <AgentCronHost />
      {/* The push half's one question (Phase 3): a `412` means the resource
          changed elsewhere, which is the user's decision and not the app's. Here
          rather than in the calendar pane because the conflicting edit can come
          from the board, the overlay or the header's day list — and because the
          pane is exactly what has been closed by the time an answer is needed. */}
      <CalDavConflictDialog />
      {/* The todo board, third of the same family — and mounted LAST of the
          three deliberately: all three are `.modal-backdrop` at one z-index and
          nothing makes them mutually exclusive, so DOM order is the tie-break
          and the surface opened most recently should be the one on top. */}
      <TodoOverlayHost />
      {/* The 🧠 menu's Skills Library — the machine-level door into the library
          the project tab hosts. At the shell for the family's reason (it covers
          the window and must survive a project switch), and after the three
          above because it is opened from a header menu that sits over them. */}
      <SkillsOverlayHost />
      {/* One-click installs' terminal (`runInstallInTab`): a centered attach-only
          view of the root-scope install tab, so the install is watched — and its
          prompts answered — where it was clicked. After the overlay family and
          the settings surfaces in DOM order so it lands on top of the dialog the
          install was started from; closing it leaves the install running in the
          root terminal. */}
      <InstallOverlayHost />
      {/* The shortcut cheat sheet (F1, `?` in steering mode, or the ⚙ menu) —
          after the overlay family above so the sheet, openable from the
          keyboard while any of them is up, lands on top (same z-index, DOM
          order is the tie-break). */}
      <ShortcutHelpOverlay />
      {/* Fires once per connect (manual or silent auto-connect): warns that the
          host's load/memory/logged-in sessions suggest it's already in use. */}
      <RemoteUsageWarningDialog />
      {/* Calendar reminders live at the shell, not in the calendar pane: an alarm
          must reach the user whatever tab they are on — and even if they have
          never opened a calendar tab this session. */}
      <AlarmPopup />
      {/* Keyboard steering mode's bottom legend — display-only echo of the
          swallowed keys, mounted at the shell like the other overlays. */}
      <SteeringLegend />
      <QuickOpen />
      <HintHost />
      <TourHost />
      <StatsRecapHost />
      {/* Dev-only floating perf monitor (Ctrl+Alt+P). Main window only, like
          the renderer watchdog; null in production builds by construction. */}
      {DevPerfHost && (
        <Suspense fallback={null}>
          <DevPerfHost />
        </Suspense>
      )}
      {showHowToStart && (
        <HowToStart
          onClose={() => {
            setShowHowToStart(false);
            if (pendingRemoteFeaturesPrompt) {
              setPendingRemoteFeaturesPrompt(false);
              setShowRemoteFeaturesPrompt(true);
            }
          }}
        />
      )}
      {showRemoteFeaturesPrompt && (
        <RemoteFeaturesPrompt onClose={() => setShowRemoteFeaturesPrompt(false)} />
      )}
      {showLessons && <LessonsMenu onClose={() => setShowLessons(false)} />}
    </div>
  );
}
