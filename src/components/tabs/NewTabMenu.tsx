import { invoke } from "@tauri-apps/api/core";
import {
  BLOB_TAB_CMD,
  BROWSER_TAB_CMD,
  PRINTING_TAB_CMD,
  DISKUSAGE_TAB_CMD,
  MONITOR_TAB_CMD,
  NETWORK_TAB_CMD,
  SKILLSLIBRARY_TAB_CMD,
  PROMPTCHART_TAB_CMD,
  type TabEntry,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { PROJECT_FILES_TAB_CMD } from "../../stores/tabs";
import {
  SHELL_ITEMS,
  TAB_ACCENT,
  agentMenuEntries,
  compactAgentMenuEntries,
  isFileTabKind,
  itemLabel,
  type StaticMenuItem,
} from "./newTabItems";
import { AddTabMenuList } from "./AddTabMenuList";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { useAddTabMenuData } from "./useAddTabMenuData";
import { localModelMenuGroup, useLocalModelPlacement } from "./localModelGroup";
import { useAgentWorktreePicker } from "./agentWorktrees";
import { useExperimental } from "../../lib/experimental";
import { useT } from "../../lib/i18n";
import { registerHostBoundTab } from "../../lib/remote/hostBound";

interface Props {
  /** Scope (project id or "root") the new tab belongs to. Feeds the shared
   *  entry data (`useAddTabMenuData`) and the host-bound registration; no
   *  section but the root-only 3D project cloud is gated on it — the monitoring
   *  trio answers for the machine, so the root console offers all three. */
  scope: string;
  /** cwd for the new tab (the popout group's project directory). */
  projectCwd: string;
  /** Project name, used to auto-name an agent's session on launch. May be empty
   *  (the detached window is inert to the projects store) — then session-rename
   *  is simply skipped. */
  projectName: string;
  /** Anchor position (viewport px) — the menu opens at this point and grows
   *  down/right, clamped back inside the viewport once measured. */
  anchor: { x: number; y: number };
  /** Called with the fully-resolved tab payload (minus the store-minted key)
   *  when the user picks an entry. The caller creates the tab. */
  onPick: (spec: Omit<TabEntry, "key">) => void;
  onClose: () => void;
  /** Open the manage-custom-agents dialog. Hosted by the parent (this menu
   *  unmounts on `onClose`, so it can't own the dialog itself). */
  onManageAgents: () => void;
}

/**
 * The "+" add-tab menu, factored out of the main-window `TabBar` so the detached
 * popout (#42) can offer the same choices. It resolves each entry to a full tab
 * payload via `buildStaticTabSpec` (shared with `TabBar`) and hands it to
 * `onPick`; the caller decides how to create the tab (the main window calls
 * `addTab`; the popout streams an "add" edit to the main window).
 */
export function NewTabMenu({ scope, projectCwd, projectName, anchor, onPick, onClose, onManageAgents }: Props) {
  const t = useT();

  // Experimental — off for users, on in debug. This menu is the DETACHED
  // window's, and it is a separate React root: an entry added only to `TabBar`
  // exists in the main window and is silently missing from every popout.
  const webBrowser = useExperimental("web_browser");
  const browserHome = useSettingsStore((s) => s.settings?.browser_home_url);
  // The 3D project cloud is the root scope's own view (TabBar offers it there
  // only), so the root console's "+" carries it too. A popout's projects store
  // is inert and empty, which keeps it out of every popout's copy.
  const hasProjects = useProjectsStore((s) => s.projects.length > 0);
  const showProjects3d = scope === "root" && hasProjects;

  // All the probe/registry/settings plumbing behind the entries is the shared
  // hook — one implementation with TabBar's "+" menu, so the two cannot drift.
  const {
    localModel,
    localModelOffInRoot,
    localDrivers,
    enabledAgents,
    vibeForLocalModel,
    compactAgentBins,
    customAgents,
    installedCustom,
    boxMembers,
  } = useAddTabMenuData(scope);
  // This menu only exists while open, so the GPU gate probes for its lifetime.
  const localModelGpu = useLocalModelPlacement(localModel, true);

  // "+ agent" on a project with linked worktrees asks which one first (#23).
  // The popout cannot tell a remote project from a local one (it is inert to
  // the projects store), so the listing is the mirror side's — a local call.
  const worktreePicker = useAgentWorktreePicker({ projectCwd, projectName, enabled: true });
  const { asking } = worktreePicker;

  // Outside-click / Escape dismissal and the viewport clamp are the shared
  // `ContextMenuPortal`'s — the same one TabBar's "+" menu and tab context menu
  // use, so the popout's copy can't drift from theirs. The one local rule: while
  // the worktree question is up, dismissal is suspended (`dismiss={!asking}`).
  // Its dialog is portaled outside the menu, so a click into it would otherwise
  // read as an outside click, unmount this menu, and take the pending answer
  // (and the tab) with it. The dialog owns Escape for that stretch.

  const pickStatic = (item: StaticMenuItem) => {
    void worktreePicker.specFor(item).then((spec) => {
      if (spec) onPick(spec);
      onClose();
    });
  };

  const pickFixed = (spec: Omit<TabEntry, "key">) => {
    onPick(spec);
    onClose();
  };

  // Mistral/vibe drives the local model through its own per-model VIBE_HOME.
  const pickOllamaModel = async (model: string) => {
    onClose();
    try {
      await invoke("ensure_ollama_running");
      const { vibe_home, alias } = await invoke<{ vibe_home: string; alias: string }>(
        "prepare_local_agent",
        { model },
      );
      onPick({
        label: model,
        cmd: "vibe",
        args: [],
        // ELDRUN_LOCAL_MODEL: which model this tab drives, for the usage recap's
        // per-model breakdown (VIBE_ACTIVE_MODEL is the resolved alias). A label,
        // never an authority — the right to run outside the project's container
        // is `hostBoundUid`, a marker the backend records in the state dir (#150).
        env: { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias, ELDRUN_LOCAL_MODEL: model },
        cwd: projectCwd,
        kind: "local_agent",
        hostBoundUid: await registerHostBoundTab(scope),
      });
    } catch {
      /* ollama down / prep failed — don't create a broken tab */
    }
  };

  // Other agents drive the same model via `ollama launch` (or a direct fallback);
  // the backend resolves the spawn command so the tab carries everything in cmd+args.
  const pickLocalLaunch = async (agentId: string, label: string, model: string) => {
    onClose();
    try {
      await invoke("ensure_ollama_running");
      const { cmd, args } = await invoke<{ cmd: string; args: string[] }>(
        "prepare_local_launch",
        { agent: agentId, model },
      );
      onPick({
        label: `${model} · ${label}`,
        cmd,
        args,
        // cmd/args are the resolved launcher and name no model — record it here.
        // Label only; the container exemption is `hostBoundUid` (#150).
        env: { ELDRUN_LOCAL_MODEL: model },
        cwd: projectCwd,
        kind: "local_agent",
        hostBoundUid: await registerHostBoundTab(scope),
      });
    } catch {
      /* ollama launch unavailable / prep failed */
    }
  };

  return (
    <>
    {worktreePicker.dialogs}
    <ContextMenuPortal
      x={anchor.x}
      y={anchor.y}
      onClose={onClose}
      className="tab-new-menu tab-add-menu"
      dismiss={!asking}
      // Same as the main bar's "+": stays under its button, scrolls when tall.
      keepBelow
    >
      <AddTabMenuList
        groups={[
          {
            label: t("newTabMenu.groupAgents"),
            moreLabel: t("newTabMenu.moreAgents"),
            entries: agentMenuEntries({
              installedBuiltins: enabledAgents,
              installedCmds: installedCustom,
              customAgents,
              pick: pickStatic,
              onAddCustom: () => {
                onClose();
                onManageAgents();
              },
              t,
            }),
            compactEntries: compactAgentMenuEntries(
              agentMenuEntries({
                installedBuiltins: enabledAgents,
                installedCmds: installedCustom,
                customAgents,
                pick: pickStatic,
                onAddCustom: () => {
                  onClose();
                  onManageAgents();
                },
                t,
              }),
              compactAgentBins,
            ),
          },
          ...(boxMembers.length > 0
            ? [{
                label: t("newTabMenu.groupBoxMembers"),
                entries: boxMembers.flatMap((m) => [
                  {
                    key: `boxfiles:${m.id}`,
                    label: t("newTabMenu.boxMemberFiles", { name: m.name }),
                    dot: "▤",
                    color: TAB_ACCENT.projectfiles,
                    untested: "newTabMenu.boxMemberFiles",
                    onPick: () => {
                      onPick({
                        label: t("newTabMenu.boxMemberFiles", { name: m.name }),
                        cmd: PROJECT_FILES_TAB_CMD,
                        args: [],
                        env: {},
                        cwd: m.dir,
                        kind: "projectfiles",
                      });
                      onClose();
                    },
                  },
                  {
                    key: `boxshell:${m.id}`,
                    label: t("newTabMenu.boxMemberShell", { name: m.name }),
                    color: TAB_ACCENT.shell,
                    untested: "newTabMenu.boxMemberShell",
                    onPick: () => {
                      onPick({
                        label: t("newTabMenu.boxMemberShell", { name: m.name }),
                        cmd: "",
                        args: [],
                        env: {},
                        cwd: m.dir,
                        kind: "shell",
                      });
                      onClose();
                    },
                  },
                ]),
              }]
            : []),
          localModelMenuGroup({
            localModel,
            localModelOffInRoot,
            localDrivers,
            vibeForLocalModel,
            gpu: localModelGpu,
            onVibe: (model) => void pickOllamaModel(model),
            onLaunch: (id, label, model) => void pickLocalLaunch(id, label, model),
            t,
          }),
          {
            label: t("newTabMenu.groupShell"),
            entries: SHELL_ITEMS.filter((i) => i.kind === "shell").map((item) => ({
              key: item.cmd || "shell",
              label: itemLabel(item, t),
              color: TAB_ACCENT[item.kind],
              onPick: () => pickStatic(item),
            })),
          },
          {
            label: t("newTabMenu.groupFiles"),
            entries: SHELL_ITEMS.filter((i) => isFileTabKind(i.kind)).map((item) => ({
              key: item.cmd,
              label: itemLabel(item, t),
              color: TAB_ACCENT[item.kind],
              disabled: !projectCwd,
              onPick: () => pickStatic(item),
            })),
          },
          // The same three `TabBar` offers, in the same order — this menu is the
          // ROOT CONSOLE's and every popout's, and System Monitor was missing
          // from both: a whole-machine view with nowhere to open it when no
          // project is on screen. Network Traffic joins it for the same reason;
          // without a project its remote half simply does not render, leaving
          // this machine's interfaces and sockets (see `NetworkTrafficPane`).
          {
            label: t("newTabMenu.groupMonitoring"),
            entries: [
              {
                key: "monitor",
                label: t("newTabMenu.itemSystemMonitor"),
                color: TAB_ACCENT.monitor,
                untested: "newTabMenu.itemSystemMonitor",
                onPick: () =>
                  pickFixed({
                    label: t("newTabMenu.itemSystemMonitor"),
                    cmd: MONITOR_TAB_CMD,
                    cwd: projectCwd,
                    kind: "monitor",
                  }),
              },
              {
                key: "diskusage",
                label: t("newTabMenu.itemDiskUsage"),
                dot: "◕",
                color: TAB_ACCENT.diskusage,
                onPick: () =>
                  pickFixed({
                    label: t("newTabMenu.itemDiskUsage"),
                    cmd: DISKUSAGE_TAB_CMD,
                    cwd: projectCwd,
                    kind: "diskusage",
                  }),
              },
              {
                key: "network",
                label: t("newTabMenu.itemNetworkTraffic"),
                color: TAB_ACCENT.network,
                untested: "newTabMenu.itemNetworkTraffic",
                onPick: () =>
                  pickFixed({
                    label: t("newTabMenu.itemNetworkTraffic"),
                    cmd: NETWORK_TAB_CMD,
                    cwd: projectCwd,
                    kind: "network",
                  }),
              },
            ],
          },
          ...(showProjects3d
            ? [{
                label: t("newTabMenu.groupWorkspace"),
                entries: [{
                  key: "blob",
                  label: t("newTabMenu.itemProjects3d"),
                  dot: "◍",
                  color: TAB_ACCENT.projects3d,
                  untested: "newTabMenu.itemProjects3d#root",
                  onPick: () =>
                    pickFixed({
                      label: t("newTabMenu.tabLabelProjects"),
                      cmd: BLOB_TAB_CMD,
                      cwd: projectCwd,
                      kind: "projects3d",
                    }),
                }],
              }]
            : []),
          {
            label: t("printing.title"),
            entries: [{
              key: "printing",
              label: t("printing.title"),
              dot: "⎙",
              color: TAB_ACCENT.printing,
              untested: "printing.title#2",
              onPick: () =>
                pickFixed({
                  label: t("printing.title"),
                  cmd: PRINTING_TAB_CMD,
                  cwd: projectCwd,
                  kind: "printing",
                }),
            }],
          },
          // Offered at the root scope too, since the personal install scope
          // (`~/.claude/skills/`) gave it something to do there: the catalog is
          // machine state, and a skill can now be installed for every project
          // on this machine without one being open. It was hidden while a
          // project was the only possible destination.
          {
            label: t("skillsLibrary.title"),
            entries: [{
              key: "skillslibrary",
              label: t("skillsLibrary.title"),
              dot: "◧",
              color: TAB_ACCENT.skillslibrary,
              untested: "skillsLibrary.title",
              onPick: () =>
                pickFixed({
                  label: t("skillsLibrary.title"),
                  cmd: SKILLSLIBRARY_TAB_CMD,
                  cwd: projectCwd,
                  kind: "skillslibrary",
                }),
            }],
          },
          // The scope's prompt chart — every draft, queued, scheduled and sent
          // agent prompt on one timeline, one column per agent tab. It was a
          // section of the side panel's Agents view; the columns want a tab.
          {
            label: t("promptChart.heading"),
            entries: [{
              key: "promptchart",
              label: t("promptChart.heading"),
              dot: "⧗",
              color: TAB_ACCENT.promptchart,
              untested: "promptChart.heading#2",
              onPick: () =>
                pickFixed({
                  label: t("promptChart.heading"),
                  cmd: PROMPTCHART_TAB_CMD,
                  cwd: projectCwd,
                  kind: "promptchart",
                }),
            }],
          },
          ...(webBrowser
            ? [{
                label: t("newTabMenu.browser"),
                entries: [{
                  key: "browser",
                  label: t("newTabMenu.browser"),
                  dot: "◎",
                  color: TAB_ACCENT.browser,
                  untested: "newTabMenu.browser",
                  onPick: () =>
                    pickFixed({
                      label: t("newTabMenu.browser"),
                      cmd: BROWSER_TAB_CMD,
                      cwd: projectCwd,
                      kind: "browser",
                      url: browserHome || undefined,
                    }),
                }],
              }]
            : []),
        ]}
      />
    </ContextMenuPortal>
    </>
  );
}
