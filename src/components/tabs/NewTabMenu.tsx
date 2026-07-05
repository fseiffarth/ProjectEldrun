import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  CALENDAR_TAB_CMD,
  NETWORK_TAB_CMD,
  type TabEntry,
} from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import {
  AGENT_ITEMS,
  SHELL_ITEMS,
  TAB_ACCENT,
  buildStaticTabSpec,
  type StaticMenuItem,
} from "./newTabItems";

interface Props {
  /** Scope (project id or "root") the new tab belongs to. Gates the root-only /
   *  project-only sections (Calendar vs Network). */
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
        env: { VIBE_HOME: vibe_home, VIBE_ACTIVE_MODEL: alias },
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
        env: {},
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
      <div className="tab-new-menu-group-label">Agents</div>
      {AGENT_ITEMS.filter((item) => installedAgents?.has(item.cmd)).map((item) => (
        <button key={item.cmd} className="tab-new-menu-item" onClick={() => pickStatic(item)}>
          <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
          {item.label}
        </button>
      ))}

      <div className="tab-new-menu-group-label">
        {localModel ? `Local Model · ${localModel}` : "Local Model"}
      </div>
      {localModel ? (
        (() => {
          const vibeInstalled = installedAgents?.has("vibe") ?? false;
          const drivers = localDrivers.filter((d) => d.available);
          if (!vibeInstalled && drivers.length === 0) {
            return (
              <div className="tab-new-menu-hint">
                No local agent installed — install one in the 🧠 menu
              </div>
            );
          }
          return (
            <>
              {vibeInstalled && (
                <button
                  className="tab-new-menu-item"
                  onClick={() => void pickOllamaModel(localModel)}
                >
                  <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT["local_agent"] }}>●</span>
                  Mistral
                </button>
              )}
              {drivers.map((d) => (
                <button
                  key={d.id}
                  className="tab-new-menu-item"
                  onClick={() => void pickLocalLaunch(d.id, d.label, localModel)}
                >
                  <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT["local_agent"] }}>●</span>
                  {d.label}
                </button>
              ))}
            </>
          );
        })()
      ) : (
        <div className="tab-new-menu-hint">No local model set — pick one in the app bar</div>
      )}

      <div className="tab-new-menu-group-label">Shell</div>
      {SHELL_ITEMS.filter((i) => i.kind === "shell").map((item) => (
        <button key={item.cmd} className="tab-new-menu-item" onClick={() => pickStatic(item)}>
          <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
          {item.label}
        </button>
      ))}

      <div className="tab-new-menu-group-label">Files</div>
      {SHELL_ITEMS.filter((i) => i.kind === "files").map((item) => (
        <button
          key={item.cmd}
          className="tab-new-menu-item"
          disabled={!projectCwd}
          onClick={() => pickStatic(item)}
        >
          <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT[item.kind] }}>●</span>
          {item.label}
        </button>
      ))}

      {scope !== "root" && (
        <>
          <div className="tab-new-menu-group-label">Monitoring</div>
          <button
            className="tab-new-menu-item"
            onClick={() =>
              pickFixed({
                label: "Network Traffic",
                cmd: NETWORK_TAB_CMD,
                cwd: projectCwd,
                kind: "network",
              })
            }
          >
            <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT.network }}>●</span>
            Network Traffic
          </button>
        </>
      )}

      {scope === "root" && (
        <>
          <div className="tab-new-menu-group-label">Calendar</div>
          <button
            className="tab-new-menu-item"
            onClick={() =>
              pickFixed({
                label: "Calendar",
                cmd: CALENDAR_TAB_CMD,
                cwd: projectCwd,
                kind: "calendar",
              })
            }
          >
            <span className="tab-new-menu-dot" style={{ color: TAB_ACCENT.calendar }}>◆</span>
            Calendar
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
