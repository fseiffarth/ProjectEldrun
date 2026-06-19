import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { notePtyOutput, useActivityStore } from "../../stores/activity";
import { CenterPanel } from "./CenterPanel";
import { HeaderBar } from "./HeaderBar";
import { RightPanel } from "./RightPanel";
import { VpnPasswordPrompt } from "./VpnPasswordPrompt";
import { useProjectsStore, listenProjectRuntimeSwitched } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTimerStore } from "../../stores/timer";
import { useKeyboard } from "../../hooks/useKeyboard";

export function AppShell() {
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const pinnedSetting = useSettingsStore((s) => s.settings?.right_panel_pinned ?? false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const loadProjects = useProjectsStore((s) => s.load);
  const projectsLoaded = useProjectsStore((s) => s.loaded);
  const activeId = useProjectsStore((s) => s.activeId);
  const switchToast = useProjectsStore((s) => s.switchToast);
  const clearSwitchToast = useProjectsStore((s) => s.clearSwitchToast);
  const initTimer = useTimerStore((s) => s.init);
  const flushTimer = useTimerStore((s) => s.flush);
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightPinned, setRightPinned] = useState(false);
  const rightCloseTimer = useRef<number | null>(null);

  useEffect(() => {
    loadSettings();
    loadProjects();
    getCurrentWindow().setFullscreen(true).catch(() => {});
  }, [loadSettings, loadProjects]);

  // Restore the pinned state once settings finish loading.
  useEffect(() => {
    if (settingsLoaded) setRightPinned(pinnedSetting);
  }, [settingsLoaded, pinnedSetting]);

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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win.onCloseRequested(async (event) => {
      event.preventDefault();
      await flushTimer().catch(() => {});
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

  useKeyboard({ onTogglePanels: () => setPanelsHidden((v) => !v) });

  const revealRight = activeId !== null && !panelsHidden && (rightOpen || rightPinned);

  const handleBodyMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (activeId === null || panelsHidden || rightOpen) return;
    if (window.innerWidth - event.clientX <= 2) {
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
        {activeId !== null && !panelsHidden && (
          <RightPanel
            open={revealRight}
            pinned={rightPinned}
            onTogglePin={togglePin}
            onMouseEnter={() => reveal(rightCloseTimer, setRightOpen)}
            onMouseLeave={() => !rightPinned && scheduleClose(rightCloseTimer, setRightOpen)}
          />
        )}
      </div>
      <VpnPasswordPrompt />
    </div>
  );
}
