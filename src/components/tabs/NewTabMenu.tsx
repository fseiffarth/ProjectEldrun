import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  BROWSER_TAB_CMD,
  PRINTING_TAB_CMD,
  DISKUSAGE_TAB_CMD,
  NETWORK_TAB_CMD,
  SKILLSLIBRARY_TAB_CMD,
  type TabEntry,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
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
import { useAddTabMenuData } from "./useAddTabMenuData";
import { useAgentWorktreePicker } from "./agentWorktrees";
import { useExperimental } from "../../lib/experimental";
import { useT } from "../../lib/i18n";
import { registerHostBoundTab } from "../../lib/hostBound";

interface Props {
  /** Scope (project id or "root") the new tab belongs to. Gates the project-only
   *  sections (Network Traffic, which needs a host/SSH link). */
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);

  // Experimental — off for users, on in debug. This menu is the DETACHED
  // window's, and it is a separate React root: an entry added only to `TabBar`
  // exists in the main window and is silently missing from every popout.
  const webBrowser = useExperimental("web_browser");
  const browserHome = useSettingsStore((s) => s.settings?.browser_home_url);

  // All the probe/registry/settings plumbing behind the entries is the shared
  // hook — one implementation with TabBar's "+" menu, so the two cannot drift.
  const {
    localModel,
    localDrivers,
    enabledAgents,
    compactAgentBins,
    customAgents,
    installedCustom,
    boxMembers,
  } = useAddTabMenuData(scope);

  // "+ agent" on a project with linked worktrees asks which one first (#23).
  // The popout cannot tell a remote project from a local one (it is inert to
  // the projects store), so the listing is the mirror side's — a local call.
  const worktreePicker = useAgentWorktreePicker({ projectCwd, projectName, enabled: true });
  const { asking } = worktreePicker;

  // Outside-click / Escape closes the menu — except while the worktree question
  // is up: its dialog is portaled outside the menu, so a click into it would
  // read as an outside click, unmount this menu, and take the pending answer
  // (and the tab) with it. The dialog owns Escape for that stretch.
  useEffect(() => {
    if (asking) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [asking, onClose]);

  // Keep the menu inside the viewport (mirrors TabBar's clamp).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let nx = pos.x;
    let ny = pos.y;
    if (rect.right > window.innerWidth - margin) {
      nx = Math.max(margin, window.innerWidth - margin - rect.width);
    }
    if (rect.bottom > window.innerHeight - margin) {
      ny = Math.max(margin, window.innerHeight - margin - rect.height);
    }
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
  }, [pos]);

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

  return createPortal(
    <>
    {worktreePicker.dialogs}
    <div
      className="tab-new-menu"
      ref={menuRef}
      style={{ position: "fixed", left: pos.x, top: pos.y }}
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
                    untested: true,
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
                    untested: true,
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
          {
            label: localModel
              ? t("newTabMenu.groupLocalModelWithName", { model: localModel })
              : t("newTabMenu.groupLocalModel"),
            entries: localModel
              ? [
                  ...(enabledAgents?.has("vibe")
                    ? [{
                        key: "vibe",
                        label: "Mistral",
                        color: TAB_ACCENT["local_agent"],
                        onPick: () => void pickOllamaModel(localModel),
                      }]
                    : []),
                  // `heavy_harness` cautions, it never withholds — see
                  // lib/localDrivers.ts. The row stays pickable because which
                  // local models cope is not something the backend can probe.
                  ...localDrivers.filter((d) => d.available).map((d) => ({
                    key: d.id,
                    label: d.label,
                    color: TAB_ACCENT["local_agent"],
                    caution: d.heavy_harness
                      ? t("newTabMenu.localDriverHeavyHarness", { agent: d.label })
                      : undefined,
                    onPick: () => void pickLocalLaunch(d.id, d.label, localModel),
                  })),
                ]
              : [],
            // An empty list has two causes and they need different sentences:
            // no agent is installed, or the model can't drive the ones that
            // are. Without the second, withholding the entries would read as a
            // bug — the agent is right there in the Agents group above.
            hint: !localModel
              ? t("newTabMenu.noLocalModelHint")
              : localDrivers.some((d) => d.needs_tools_unsupported)
                ? t("newTabMenu.localModelNoToolsHint", { model: localModel })
                : t("newTabMenu.noLocalAgentHint"),
          },
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
          // Disk Usage can scan anywhere, so it is offered in every scope; Network
          // Traffic is per-project (host/SSH link), so the root scope has none.
          {
            label: t("newTabMenu.groupMonitoring"),
            entries: [
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
              ...(scope !== "root"
                ? [{
                    key: "network",
                    label: t("newTabMenu.itemNetworkTraffic"),
                    color: TAB_ACCENT.network,
                    onPick: () =>
                      pickFixed({
                        label: t("newTabMenu.itemNetworkTraffic"),
                        cmd: NETWORK_TAB_CMD,
                        cwd: projectCwd,
                        kind: "network",
                      }),
                  }]
                : []),
            ],
          },
          {
            label: t("printing.title"),
            entries: [{
              key: "printing",
              label: t("printing.title"),
              dot: "⎙",
              color: TAB_ACCENT.printing,
              untested: true,
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
              untested: true,
              onPick: () =>
                pickFixed({
                  label: t("skillsLibrary.title"),
                  cmd: SKILLSLIBRARY_TAB_CMD,
                  cwd: projectCwd,
                  kind: "skillslibrary",
                }),
            }],
          },
          ...(webBrowser
            ? [{
                label: t("newTabMenu.browser"),
                entries: [{
                  key: "browser",
                  label: t("newTabMenu.browser"),
                  dot: "🌐",
                  color: TAB_ACCENT.browser,
                  untested: true,
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
    </div>
    </>,
    document.body,
  );
}
