import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  CALENDAR_TAB_CMD,
  DISKUSAGE_TAB_CMD,
  NETWORK_TAB_CMD,
  type TabEntry,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import {
  AGENT_ITEMS,
  SHELL_ITEMS,
  TAB_ACCENT,
  buildStaticTabSpec,
  isFileTabKind,
  type StaticMenuItem,
} from "./newTabItems";
import { AddTabMenuList } from "./AddTabMenuList";

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
}

/**
 * The "+" add-tab menu, factored out of the main-window `TabBar` so the detached
 * popout (#42) can offer the same choices. It resolves each entry to a full tab
 * payload via `buildStaticTabSpec` (shared with `TabBar`) and hands it to
 * `onPick`; the caller decides how to create the tab (the main window calls
 * `addTab`; the popout streams an "add" edit to the main window).
 */
export function NewTabMenu({ scope, projectCwd, projectName, anchor, onPick, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);

  const localModel = useSettingsStore(
    (s) => s.settings?.ollama_roles?.tabs ?? s.settings?.ollama_model,
  );

  // Installed agent CLIs (id == cmd); only offer ones actually present. `null`
  // until the probe resolves, so the Agents list renders nothing (not a flash of
  // all agents) until we know.
  const [installedAgents, setInstalledAgents] = useState<Set<string> | null>(null);
  const [localDrivers, setLocalDrivers] = useState<
    { id: string; label: string; available: boolean }[]
  >([]);
  useEffect(() => {
    invoke<{ id: string; installed: boolean }[]>("list_agents")
      .then((list) => setInstalledAgents(new Set(list.filter((a) => a.installed).map((a) => a.id))))
      .catch(() => setInstalledAgents(new Set()));
    invoke<{ id: string; label: string; available: boolean }[]>("list_local_drivers")
      .then(setLocalDrivers)
      .catch(() => {});
  }, []);

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
    onPick(buildStaticTabSpec(item, projectCwd, projectName));
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
        // per-model breakdown (VIBE_ACTIVE_MODEL is the resolved alias).
        env: { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias, ELDRUN_LOCAL_MODEL: model },
        cwd: projectCwd,
        kind: "local_agent",
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
        env: { ELDRUN_LOCAL_MODEL: model },
        cwd: projectCwd,
        kind: "local_agent",
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
            label: "Agents",
            entries: AGENT_ITEMS.filter((item) => installedAgents?.has(item.cmd)).map(
              (item) => ({
                key: item.cmd,
                label: item.label,
                color: TAB_ACCENT[item.kind],
                onPick: () => pickStatic(item),
              }),
            ),
          },
          {
            label: localModel ? `Local Model · ${localModel}` : "Local Model",
            entries: localModel
              ? [
                  ...(installedAgents?.has("vibe")
                    ? [{
                        key: "vibe",
                        label: "Mistral",
                        color: TAB_ACCENT["local_agent"],
                        onPick: () => void pickOllamaModel(localModel),
                      }]
                    : []),
                  ...localDrivers.filter((d) => d.available).map((d) => ({
                    key: d.id,
                    label: d.label,
                    color: TAB_ACCENT["local_agent"],
                    onPick: () => void pickLocalLaunch(d.id, d.label, localModel),
                  })),
                ]
              : [],
            hint: localModel
              ? "No local agent installed — install one in the 🧠 menu"
              : "No local model set — pick one in the app bar",
          },
          {
            label: "Shell",
            entries: SHELL_ITEMS.filter((i) => i.kind === "shell").map((item) => ({
              key: item.cmd || "shell",
              label: item.label,
              color: TAB_ACCENT[item.kind],
              onPick: () => pickStatic(item),
            })),
          },
          {
            label: "Files",
            entries: SHELL_ITEMS.filter((i) => isFileTabKind(i.kind)).map((item) => ({
              key: item.cmd,
              label: item.label,
              color: TAB_ACCENT[item.kind],
              disabled: !projectCwd,
              onPick: () => pickStatic(item),
            })),
          },
          // Disk Usage can scan anywhere, so it is offered in every scope; Network
          // Traffic is per-project (host/SSH link), so the root scope has none.
          {
            label: "Monitoring",
            entries: [
              {
                key: "diskusage",
                label: "Disk Usage",
                dot: "◕",
                color: TAB_ACCENT.diskusage,
                onPick: () =>
                  pickFixed({
                    label: "Disk Usage",
                    cmd: DISKUSAGE_TAB_CMD,
                    cwd: projectCwd,
                    kind: "diskusage",
                  }),
              },
              ...(scope !== "root"
                ? [{
                    key: "network",
                    label: "Network Traffic",
                    color: TAB_ACCENT.network,
                    onPick: () =>
                      pickFixed({
                        label: "Network Traffic",
                        cmd: NETWORK_TAB_CMD,
                        cwd: projectCwd,
                        kind: "network",
                      }),
                  }]
                : []),
            ],
          },
          {
            label: "Calendar",
            entries: [{
              key: "calendar",
              label: "Calendar",
              dot: "◆",
              color: TAB_ACCENT.calendar,
              onPick: () =>
                pickFixed({
                  label: "Calendar",
                  cmd: CALENDAR_TAB_CMD,
                  cwd: projectCwd,
                  kind: "calendar",
                }),
            }],
          },
        ]}
      />
    </div>,
    document.body,
  );
}
