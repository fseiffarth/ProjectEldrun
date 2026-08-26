import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import {
  EMPTY_CUSTOM_AGENTS,
  DEFAULT_COMPACT_AGENT_IDS,
  SHELL_ITEMS,
  TAB_ACCENT,
  agentMenuEntries,
  buildStaticTabSpec,
  compactAgentMenuEntries,
  enabledInstalledAgentBins,
  isFileTabKind,
  itemLabel,
  type StaticMenuItem,
} from "./newTabItems";
import { AddTabMenuList } from "./AddTabMenuList";
import { listLocalDrivers, type LocalDriverInfo } from "../../lib/localDrivers";
import { useExperimental } from "../../lib/experimental";
import { useT } from "../../lib/i18n";
import { registerHostBoundTab } from "../../lib/hostBound";
import { AGENT_REGISTRY_CHANGED_EVENT } from "../../lib/agentRegistry";

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

  const localModel = useSettingsStore(
    (s) => s.settings?.ollama_roles?.tabs ?? s.settings?.ollama_model,
  );
  const customAgents = useSettingsStore(
    (s) => s.settings?.custom_agents ?? EMPTY_CUSTOM_AGENTS,
  );
  // Built-in agents the user turned off in "Manage Agents" (Settings) despite
  // being installed — hidden from this menu without uninstalling the CLI.
  const disabledAgents = useSettingsStore((s) => s.settings?.disabled_agents);
  const compactAgentIds = useSettingsStore(
    (s) => s.settings?.compact_tab_agents ?? DEFAULT_COMPACT_AGENT_IDS,
  );

  // Installed agent CLIs (id == cmd); only offer ones actually present. `null`
  // until the probe resolves, so the Agents list renders nothing (not a flash of
  // all agents) until we know.
  const [agentStatuses, setAgentStatuses] = useState<
    { id: string; bin: string; installed: boolean }[] | null
  >(null);
  // Installed commands minus Manage Agents' disabled registry ids — the set every tab-choice consumer
  // below (Agents group, Mistral/vibe local-model driver) should use.
  const enabledAgents = useMemo(() => {
    if (!agentStatuses) return null;
    return enabledInstalledAgentBins(agentStatuses, disabledAgents);
  }, [agentStatuses, disabledAgents]);
  const compactAgentBins = useMemo(() => {
    if (!agentStatuses) return new Set<string>();
    const compactIds = new Set(compactAgentIds);
    return new Set(
      agentStatuses
        .filter((agent) => compactIds.has(agent.id) || compactIds.has(agent.bin))
        .map((agent) => agent.bin),
    );
  }, [agentStatuses, compactAgentIds]);
  // Installed *custom*-agent commands, probed separately (they aren't in the
  // built-in registry). `null` until resolved — custom agents render enabled
  // until a probe proves one missing.
  const [installedCustom, setInstalledCustom] = useState<Set<string> | null>(null);
  const [localDrivers, setLocalDrivers] = useState<LocalDriverInfo[]>([]);
  const refreshInstalledAgents = useCallback(() => {
    void invoke<{ id: string; bin: string; installed: boolean }[]>("list_agents")
      .then(setAgentStatuses)
      .catch(() => setAgentStatuses([]));
  }, []);
  useEffect(() => {
    refreshInstalledAgents();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, refreshInstalledAgents);
    return () => window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, refreshInstalledAgents);
  }, [refreshInstalledAgents]);
  // Re-probed whenever the active local model changes: `available` depends on
  // it, because these are all tool-calling agents and a completion-only model
  // (llama3 is one) can't drive one at all — Ollama refuses the first request
  // and the tab dies on arrival. Withholding the entry is the whole guard; the
  // backend refuses again on launch for the stale-menu case. A model that
  // *passes* may still meet `ollama launch`'s own "Launch anyway?" prompt in
  // the tab — left to the user on purpose (see lib/localDrivers.ts).
  const refreshLocalDrivers = useCallback(() => {
    void listLocalDrivers(localModel)
      .then(setLocalDrivers)
      .catch(() => {});
  }, [localModel]);
  useEffect(() => {
    refreshLocalDrivers();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, refreshLocalDrivers);
    return () => window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, refreshLocalDrivers);
  }, [refreshLocalDrivers]);
  // Re-probe custom commands whenever the set changes (adding one in the dialog).
  useEffect(() => {
    const cmds = customAgents.map((a) => a.cmd);
    if (cmds.length === 0) {
      setInstalledCustom(new Set());
      return;
    }
    invoke<string[]>("probe_binaries", { bins: cmds })
      .then((found) => setInstalledCustom(new Set(found)))
      .catch(() => setInstalledCustom(new Set()));
  }, [customAgents]);

  // Outside-click / Escape closes the menu.
  useEffect(() => {
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
  }, [onClose]);

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
    onPick(buildStaticTabSpec(item, projectCwd, projectName, t));
    onClose();
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
    </div>,
    document.body,
  );
}
