import { TerminalView } from "../terminal/TerminalView";
import { FileBrowser } from "../files/FileBrowser";
import { ProjectFilesTab } from "../files/ProjectFilesTab";
import { EmbedPane } from "../embed/EmbedPane";
import { FileViewerPane } from "../embed/FileViewerPane";
import { ProjectBlobPane } from "../common/ProjectBlobPane";
import { NetworkTrafficPane } from "../monitoring/NetworkTrafficPane";
import { SystemMonitorPane } from "../monitoring/SystemMonitorPane";
import { DiskUsagePane } from "../monitoring/DiskUsagePane";
import { CalendarPane } from "../calendar/CalendarPane";
import { RemotePaneHold } from "../projects/RemotePaneHold";
import { effectiveTabLocation, type TabEntry } from "../../stores/tabs";

/**
 * The single per-tab `kind → pane` render switch, shared by the main window
 * (`CenterPanel`) and every detached popout (`DetachedCenterPanel`). Both windows
 * are separate React roots in separate JS heaps, so this used to be TWO
 * hand-maintained switches that silently drifted — a new pane kind or prop added
 * to one was routinely forgotten in the other (that is the whole class of "works
 * in the main window, dead in a popout" bugs). Keeping it here means a new pane
 * kind or prop lands in both windows at once.
 *
 * Everything that GENUINELY differs between the two windows is lifted into a
 * prop the HOST computes, because a popout is inert to the `projects`/`tabs`
 * stores and can't derive it:
 *  - `attachOnly` — a popout's terminals attach to the main window's PTY, never
 *    spawn (so all the terminal spawn inputs below are cosmetic there).
 *  - `ownsTabs` — only the main window owns the tab store, so only it may let a
 *    pane retitle its tab (`tabKey`) or open new tabs (`canOpenTabs`). A popout
 *    runs on a streamed COPY with no write channel back, so it passes neither.
 *  - `filesProjectDir` / `terminalCwd` / `sandbox` / `holdRemoteTerminal` /
 *    `onConnect` — all resolved from the projects store, which the popout lacks.
 *
 * Values that are computed IDENTICALLY from the tab alone in both windows
 * (`projectId` from the scope, `localOnly`, `zoomable`) are derived here rather
 * than threaded as props.
 */
export interface TabPaneProps {
  tab: TabEntry;
  /** The owning scope key ("root" or a project id). Also names the PTY id. */
  scope: string;
  /** Laid out on screen (its group's active tab, and not hidden by fullscreen). */
  visible: boolean;
  /** The group this pane sits in (viewer scroll-sync). Undefined in a popout. */
  groupId?: string;
  /** Popout: attach to the main window's PTY instead of spawning one. */
  attachOnly?: boolean;
  /** Main window only: the host owns the tab store (retitle / open-tabs). */
  ownsTabs?: boolean;
  /** Open the connect dialog (network pane + a held remote terminal). */
  onConnect?: () => void;
  /** A remote terminal whose SSH pool is down — hold rather than spawn. */
  holdRemoteTerminal?: boolean;
  /** The held terminal's host label (only read when `holdRemoteTerminal`). */
  remoteHost?: string;
  /** The Files-tab browse dir (mirror-swapped while a remote is disconnected). */
  filesProjectDir: string;
  /** The terminal's cwd (the mirror path for a local-on-remote tab). */
  terminalCwd: string;
  /** Run this (agent/shell) tab inside the project's session container. */
  sandbox?: boolean;
}

export function TabPane({
  tab,
  scope,
  visible,
  groupId,
  attachOnly = false,
  ownsTabs = false,
  onConnect,
  holdRemoteTerminal = false,
  remoteHost = "",
  filesProjectDir,
  terminalCwd,
  sandbox = false,
}: TabPaneProps) {
  // Identical in both windows: null for the root scope, else the scope id.
  const projectId = scope === "root" ? null : scope;
  const zoomable = tab.kind === "agent" || tab.kind === "local_agent";

  switch (tab.kind) {
    case "projects3d":
      return <ProjectBlobPane />;
    case "calendar":
      return <CalendarPane visible={visible} />;
    case "network":
      return <NetworkTrafficPane projectId={scope} visible={visible} onConnect={onConnect} />;
    case "monitor":
      return <SystemMonitorPane projectId={projectId} visible={visible} />;
    case "diskusage":
      return (
        <DiskUsagePane
          projectId={projectId}
          projectCwd={tab.cwd}
          // A popout can't retitle its tab (no write channel back), so it gets no
          // tabKey — its Disk Usage tab keeps the label it was given.
          {...(ownsTabs ? { tabKey: tab.key } : {})}
          visible={visible}
        />
      );
    case "files":
      return <FileBrowser projectDir={filesProjectDir} projectId={projectId} active={visible} />;
    case "projectfiles":
      return (
        <ProjectFilesTab
          scope={scope}
          cwd={tab.cwd}
          // Same as Disk Usage above: no write channel back from a popout, so no
          // tabKey (browsed folder stays the popout's) and no open-in-new-tab.
          {...(ownsTabs ? { tabKey: tab.key, canOpenTabs: true } : {})}
          folder={tab.folder}
          visible={visible}
        />
      );
    case "embed":
      return tab.viewer ? (
        <FileViewerPane
          viewer={tab.viewer}
          path={tab.embedPath ?? ""}
          projectId={projectId}
          tabKey={tab.key}
          visible={visible}
          groupId={groupId}
        />
      ) : (
        <EmbedPane
          path={tab.embedPath ?? ""}
          exec={tab.embedExec}
          projectId={projectId}
          visible={visible}
        />
      );
    default:
      // Remote terminal pane while the pool is down (main window only): show a
      // Connect placeholder rather than mount TerminalView, which would spawn
      // `ssh -tt` and block on the dead pool.
      if (holdRemoteTerminal) {
        return <RemotePaneHold host={remoteHost} onConnect={onConnect ?? (() => {})} />;
      }
      return (
        <TerminalView
          // PTY ids include the scope: tab keys alone collide across projects.
          id={`${scope}:${tab.key}`}
          cmd={tab.cmd}
          args={tab.args ?? []}
          env={tab.env ?? {}}
          // A popout is attach-only and never spawns, and its `terminal-ready`
          // never fires, so it takes no initialInput (matches its old behavior).
          initialInput={attachOnly ? undefined : tab.initialInput}
          cwd={terminalCwd}
          localOnly={effectiveTabLocation(tab) === "local"}
          projectId={projectId}
          sandbox={sandbox}
          zoomable={zoomable}
          visible={visible}
          focused={visible}
          attachOnly={attachOnly}
        />
      );
  }
}
