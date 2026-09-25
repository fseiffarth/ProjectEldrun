import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MODELS_OVERLAY_TABS,
  useModelsOverlayStore,
  type ModelsOverlayTab,
} from "../../stores/modelsOverlay";
import { initLocalModelEvents, useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { AGENT_REGISTRY_CHANGED_EVENT } from "../../lib/agents/agentRegistry";
import { useT, type TranslationKey } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useFloatingFrame } from "../common/useFloatingFrame";
import { ModelsGlyph } from "../header/HeaderGlyphs";
import { AgentsPanel, OllamaPanel } from "../layout/SettingsSubPanels";
import { SkillsLibraryView } from "../skills/SkillsLibraryView";
import { AgentChips, LocalModelsSection, MachineMeters } from "./ModelsHubSections";
import { useModelsHub } from "./useModelsHub";

/**
 * The **Models & agents overlay** — what a click on the header's processor-chip
 * button (`layout/LocalModelMenu`) opens. The hover dropdown stays as it was;
 * this is the room it points into: everything the dropdown does, plus what it
 * used to send to Settings for (installing and removing agent CLIs, installing
 * Ollama, its storage and catalog) — so no door in it leads out to Settings,
 * and Settings keeps its own Agents / Ollama pages unchanged.
 *
 * Four fixed tabs, each a surface that already exists rather than a second copy:
 *  - **Agents & CLIs** — Settings' `AgentsPanel`, each installed card carrying
 *    the dropdown's Default · + tab · Root · MCP chips (`AgentChips`);
 *  - **Local models** — the dropdown's own sections (`ModelsHubSections`) over
 *    the shared `stores/agents/ollamaActivity`, in its order: models, then the
 *    Machine meters;
 *  - **Ollama** — Settings' `OllamaPanel` (install, storage, pulls, catalog);
 *  - **Skills** — the machine-level skills library the retired SkillsOverlay
 *    hosted (`SkillsLibraryView` with no project).
 *
 * The chrome is the header overlays' one (`.root-overlay.subwindow`, moved and
 * resized by `useFloatingFrame`), copied from the skills overlay it replaces.
 * A pane mounts the first time its tab is visited and then stays mounted,
 * `hidden`, because install logs are component state; the visited set resets
 * on close (the host renders nothing while closed).
 */
export function ModelsOverlayHost() {
  const open = useModelsOverlayStore((s) => s.open);
  if (!open) return null;
  return <ModelsOverlay />;
}

const TAB_LABEL: Record<ModelsOverlayTab, TranslationKey> = {
  agents: "modelsOverlay.tab.agents",
  models: "modelsOverlay.tab.models",
  ollama: "modelsOverlay.tab.ollama",
  skills: "modelsOverlay.tab.skills",
};

const TAB_INTRO: Record<ModelsOverlayTab, TranslationKey> = {
  agents: "modelsOverlay.intro.agents",
  models: "modelsOverlay.intro.models",
  ollama: "modelsOverlay.intro.ollama",
  skills: "modelsOverlay.intro.skills",
};

const tabId = (id: ModelsOverlayTab) => `models-overlay-tab-${id}`;
const paneId = (id: ModelsOverlayTab) => `models-overlay-pane-${id}`;

function ModelsOverlay() {
  const t = useT();
  const tab = useModelsOverlayStore((s) => s.tab);
  const setTab = useModelsOverlayStore((s) => s.setTab);
  const close = () => useModelsOverlayStore.getState().close();
  // Moves, resizes and fills like the root console; remembered per overlay.
  const { frameRef, frameStyle, frameClass, barProps, grips, fillButton } =
    useFloatingFrame("eldrun.modelsOverlayFrame");
  // `barProps.title` is the move hint; on the whole bar it would hover over the
  // tabs too, so it goes on the mark alone (the root console's placement).
  const { title: moveHint, ...barRest } = barProps;

  // Panes visited this opening. A pane is rendered once its tab has been shown
  // and is kept (hidden) after, so a running install's log survives a tab
  // switch. Derived with the active tab so a first visit renders in the same
  // frame, not one effect later.
  const [visited, setVisited] = useState<ReadonlySet<ModelsOverlayTab>>(() => new Set([tab]));
  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)));
  }, [tab]);
  const mounted = (id: ModelsOverlayTab) => id === tab || visited.has(id);

  // Roving focus over the strip: ←/→ (Home/End) move focus, Enter/Space (or a press)
  // activates — a pane is a real mount (Settings' panels probe the machine), so
  // arrowing across the strip must not open each one on the way.
  const [focusTab, setFocusTab] = useState<ModelsOverlayTab>(tab);
  // A switch made from inside a pane (Manage local models → Ollama) moves the
  // strip's tab stop with it.
  useEffect(() => setFocusTab(tab), [tab]);
  const tabRefs = useRef<Partial<Record<ModelsOverlayTab, HTMLDivElement | null>>>({});
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: ModelsOverlayTab) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setTab(id);
      return;
    }
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = MODELS_OVERLAY_TABS.indexOf(id);
    const n = MODELS_OVERLAY_TABS.length;
    const next =
      e.key === "Home"
        ? MODELS_OVERLAY_TABS[0]
        : e.key === "End"
          ? MODELS_OVERLAY_TABS[n - 1]
          : MODELS_OVERLAY_TABS[(i + (e.key === "ArrowRight" ? 1 : n - 1)) % n];
    setFocusTab(next);
    tabRefs.current[next]?.focus();
  };

  // On open, focus the active tab: keyboard users land on the strip, and focus
  // leaves the header button (which gets it back on close — LocalModelMenu).
  useEffect(() => {
    tabRefs.current[useModelsOverlayStore.getState().tab]?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // The root console opens above this overlay (a "Run in terminal"
      // install): its Escape is its own, and must not also close the room the
      // install was started from. Likewise any key aimed outside this frame
      // (focus on <body> still counts as ours — a click on the bar drops it
      // there).
      if (useRootOverlayStore.getState().open) return;
      const tgt = e.target;
      if (tgt instanceof Node && tgt !== document.body && !frameRef.current?.contains(tgt)) return;
      e.stopPropagation();
      useModelsOverlayStore.getState().close();
    };
    // Bubble phase on `window`, as the sibling overlays: a dropdown or field
    // inside that handles its own Escape marks it, and this one stands down.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frameRef]); // a `useRef` object: stable, so this still runs once

  return (
    <div
      className="modal-backdrop root-overlay-backdrop app-overlay-backdrop models-overlay-backdrop"
      onMouseDown={(e) => {
        // Backdrop only — a drag that starts inside the pane and ends out here
        // (selecting text in an install log) must not be read as "dismiss".
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={frameRef}
        className={`root-overlay subwindow focused models-overlay ${frameClass}`}
        style={frameStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t("modelsOverlay.title")}
      >
        {grips}
        {/* The root console's bar: mark, tab strip, controls. The bar is the
            move handle; the tabs and buttons keep their own press. */}
        <div {...barRest} className={`tab-bar root-overlay-bar ${barRest.className}`}>
          <div className="root-overlay-mark app-overlay-mark models-overlay-mark" title={moveHint}>
            <ModelsGlyph className="models-overlay-glyph" />
            <span className="app-overlay-label models-overlay-label">{t("modelsOverlay.title")}</span>
            <UntestedTag id="modelsOverlay.title" />
          </div>
          <div className="tab-strip models-tab-strip" role="tablist">
            {MODELS_OVERLAY_TABS.map((id) => {
              const isActive = id === tab;
              return (
                <div
                  key={id}
                  ref={(el) => {
                    tabRefs.current[id] = el;
                  }}
                  id={tabId(id)}
                  role="tab"
                  tabIndex={id === focusTab ? 0 : -1}
                  aria-selected={isActive}
                  // Only a rendered pane can be pointed at (unvisited ones aren't).
                  aria-controls={mounted(id) ? paneId(id) : undefined}
                  className={`tab models-tab${isActive ? " active" : ""}`}
                  onMouseDown={(e) => {
                    if (e.button === 0) setTab(id);
                  }}
                  onFocus={() => setFocusTab(id)}
                  onKeyDown={(e) => onTabKey(e, id)}
                >
                  <span className="tab-label">{t(TAB_LABEL[id])}</span>
                  {/* The skills library's pill moved here with the library
                      (from the retired SkillsOverlay's mark). */}
                  {id === "skills" && <UntestedTag id="skillsLibrary.overlayTitle" />}
                </div>
              );
            })}
          </div>
          <div className="tab-controls root-overlay-controls">
            {fillButton}
            <button
              type="button"
              className="subwindow-hide"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={close}
            >
              ×
            </button>
          </div>
        </div>
        <div className="subwindow-body models-overlay-body">
          {MODELS_OVERLAY_TABS.map((id) =>
            mounted(id) ? (
              <div
                key={id}
                id={paneId(id)}
                role="tabpanel"
                aria-labelledby={tabId(id)}
                className="models-overlay-pane"
                hidden={id !== tab}
              >
                <p className="settings-help models-overlay-intro">{t(TAB_INTRO[id])}</p>
                {/* No `onClose` to the embedded panels: it only feeds their
                    header's ×, which the CSS hides with the title row — the
                    overlay's bar has its own. */}
                {id === "agents" && <AgentsTab active={tab === "agents"} />}
                {id === "models" && (
                  <ModelsTab active={tab === "models"} onManageModels={() => setTab("ollama")} />
                )}
                {id === "ollama" && <OllamaPanel />}
                {/* No project: this surface belongs to the machine, so the
                    personal scope is the only one it can honestly offer. */}
                {id === "skills" && <SkillsLibraryView projectDir={null} visible={tab === "skills"} />}
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Settings' Agents panel, each installed card carrying the dropdown's chips.
 * `wired` (which CLIs the root MCP server is named to) is read when the tab
 * becomes visible and again whenever the agent registry changes — installing
 * or removing a CLI can change the answer. `null` until then, which draws no
 * MCP chip, as the dropdown does before its own read.
 */
function AgentsTab({ active }: { active: boolean }) {
  const [wired, setWired] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      invoke<{ wired_clis?: string[] }>("root_mcp_status")
        .then((s) => {
          if (!cancelled) setWired(s.wired_clis ?? null);
        })
        .catch(() => {
          if (!cancelled) setWired(null);
        });
    if (active) void read();
    const onChanged = () => void read();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, onChanged);
    };
  }, [active]);
  return (
    <AgentsPanel installedExtras={(a) => <AgentChips agent={a} wiredClis={wired} />} />
  );
}

/**
 * The dropdown's Local models section at full size, in the dropdown's order:
 * the "Local Models" band with its Running / On disk sub-bands, then the
 * Machine meters (what is left to run them with). `useModelsHub(active)` gates
 * the 2 s GPU/machine poll and the GPU-status read on this tab being the
 * visible one; the list and version are re-read each time it becomes visible,
 * as a hover does — but not the agents, which this tab doesn't show.
 */
function ModelsTab({ active, onManageModels }: { active: boolean; onManageModels: () => void }) {
  const hub = useModelsHub(active);
  const installed = useOllamaActivityStore((s) => s.installed);
  // The progress events, ref-counted with the header button's own subscription:
  // the tab stays live even if that button is ever not mounted.
  useEffect(() => initLocalModelEvents(), []);
  useEffect(() => {
    if (active) hub.refreshModels();
    // `refreshModels` is a fresh closure every render; what should re-run it is the
    // tab becoming visible (or Ollama turning up installed while it is).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, installed]);
  return (
    <div className="dialog-scroll models-overlay-models">
      <LocalModelsSection hub={hub} layout="overlay" onManageModels={onManageModels} />
      <MachineMeters hub={hub} />
    </div>
  );
}
