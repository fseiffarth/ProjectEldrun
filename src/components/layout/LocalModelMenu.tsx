import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settings";

/** Subset of the backend `OllamaModelInfo` the menu's live-status line needs. */
interface LoadedModelInfo {
  name: string;
  parameter_size: string | null;
  quantization: string | null;
  running: boolean;
  /** VRAM bytes in use; non-zero → running on GPU. */
  size_vram: number;
}

function fmtBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(0) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

/**
 * Header button (left of the global-apps button) that sets the single active
 * local (Ollama) model. Hovering reveals the models currently loaded in memory
 * (the running set from `list_ollama_models_detailed`) — and picking one writes
 * `settings.ollama_model`. A "Local Model" tab (TabBar's add menu) then launches
 * whichever model is active. Always shown: when Ollama isn't installed (or no
 * models are present yet) the menu offers an "Install models…" entry that opens
 * the Ollama Settings panel, where Ollama itself and any model can be installed.
 */
export function LocalModelMenu() {
  const { settings, updateSettings } = useSettingsStore();
  const activeModel = settings?.ollama_model;
  const [installed, setInstalled] = useState(false);
  // Three-state Ollama health for the status lamp: "stopped" (server down, red),
  // "idle" (server up, no model in memory, yellow), "loaded" (a model is loaded
  // in memory, green).
  const [status, setStatus] = useState<"stopped" | "idle" | "loaded">("stopped");
  const [open, setOpen] = useState(false);
  // Models currently resident in memory (from /api/ps via list_ollama_models_detailed).
  // These are the only models the menu lets you pick as the active local model.
  const [loaded, setLoaded] = useState<LoadedModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live pull progress per model ref (from the global `ollama-pull-progress`
  // events emitted by `pull_ollama_model`), so downloads started anywhere show
  // here too. `pct` is null during the manifest/verify phases (no byte totals).
  const [downloads, setDownloads] = useState<Record<string, { pct: number | null }>>({});
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    invoke<boolean>("ollama_is_installed").then(setInstalled).catch(() => {});
  }, []);

  // Track in-flight downloads regardless of which surface started them.
  useEffect(() => {
    const un = listen<{ model: string; status: string; completed: number; total: number }>(
      "ollama-pull-progress",
      (e) => {
        const { model, status, completed, total } = e.payload;
        setDownloads((d) => {
          if (status === "success") {
            const { [model]: _done, ...rest } = d;
            return rest;
          }
          return {
            ...d,
            [model]: { pct: total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null },
          };
        });
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Once Ollama is installed, poll the server's health so the button can show a
  // live stopped/idle/loaded lamp without the user opening the menu.
  useEffect(() => {
    if (!installed) {
      setStatus("stopped");
      return;
    }
    let cancelled = false;
    const check = () =>
      invoke<"stopped" | "idle" | "loaded">("ollama_status")
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {});
    void check();
    const id = window.setInterval(check, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [installed]);

  const reveal = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
    if (!installed) return; // nothing to list yet — only the install entry shows
    // The menu only offers models currently loaded in memory, so the selectable
    // list is the running set from /api/ps (via list_ollama_models_detailed).
    setLoading(true);
    setError(null);
    invoke<LoadedModelInfo[]>("list_ollama_models_detailed")
      .then((all) => setLoaded(all.filter((m) => m.running)))
      .catch((e: string) => {
        setLoaded([]);
        setError(e === "not_running" ? "Ollama not running" : "Failed to load models");
      })
      .finally(() => setLoading(false));
  };

  // Open the Ollama Settings panel (owned by ProjectSwitcher) to install Ollama
  // and/or browse the installable-models catalog.
  const openInstall = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("eldrun:open-settings", { detail: "ollama" }));
  };

  // Open the "Manage Agents" panel to install AI coding-agent CLIs (Claude,
  // Codex, Gemini, Mistral, Aider, OpenCode, Cursor, Copilot, Grok, Qwen) that
  // Eldrun can then launch as agent tabs.
  const openAgents = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("eldrun:open-settings", { detail: "agents" }));
  };

  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 250);
  };

  const select = (model: string | undefined) => {
    void updateSettings({ ollama_model: model });
    setOpen(false);
  };

  return (
    <div className="global-apps-menu no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn local-model-btn"
        title={
          !installed
            ? "Install a local model"
            : `${
                status === "loaded"
                  ? "Ollama running · model loaded"
                  : status === "idle"
                    ? "Ollama running"
                    : "Ollama stopped"
              }${activeModel ? ` · model: ${activeModel}` : " · no model selected"}`
        }
        aria-label="Local model"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ color: "var(--warning)" }}
      >
        🧠
        {installed && (
          <span
            className={`local-model-status-dot ${status}`}
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div className="tab-new-menu">
          <div className="tab-new-menu-group-label">Local Model</div>
          {installed && Object.keys(downloads).length > 0 && (
            <div className="local-model-downloads">
              {Object.entries(downloads).map(([model, d]) => (
                <div key={model} className="local-model-download-row" title="Downloading">
                  <div className="local-model-download-head">
                    <span className="local-model-loaded-name">{model}</span>
                    <span className="local-model-download-pct">
                      {d.pct != null ? `${d.pct}%` : "…"}
                    </span>
                  </div>
                  <div className="ollama-download-bar">
                    <div
                      className={`ollama-download-bar-fill${d.pct == null ? " indeterminate" : ""}`}
                      style={d.pct != null ? { width: `${d.pct}%` } : undefined}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          {!installed ? (
            <div className="tab-new-menu-hint">Ollama not installed</div>
          ) : loading ? (
            <div className="tab-new-menu-hint">Loading…</div>
          ) : error ? (
            <div className="tab-new-menu-hint">{error}</div>
          ) : loaded.length === 0 ? (
            <div className="tab-new-menu-hint">
              {status === "stopped" ? "Server stopped" : "No model loaded"}
            </div>
          ) : (
            loaded.map((m) => (
              <button
                key={m.name}
                className="tab-new-menu-item"
                title="Loaded in memory"
                onClick={() => select(m.name)}
              >
                <span
                  className="tab-new-menu-dot"
                  style={{ color: activeModel === m.name ? "var(--warning)" : "transparent" }}
                >
                  ●
                </span>
                <span className="local-model-loaded-name">{m.name}</span>
                <span className="local-model-loaded-badges">
                  {m.parameter_size && <span>{m.parameter_size}</span>}
                  {m.quantization && <span>{m.quantization}</span>}
                  <span className={m.size_vram > 0 ? "gpu" : "cpu"}>
                    {m.size_vram > 0 ? `GPU ${fmtBytes(m.size_vram)}` : "CPU"}
                  </span>
                </span>
              </button>
            ))
          )}
          <button className="tab-new-menu-item" onClick={openInstall}>
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            {installed ? "Manage local models…" : "Install Ollama…"}
          </button>
          <div className="tab-new-menu-group-label">Agents</div>
          <button className="tab-new-menu-item" onClick={openAgents}>
            <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
              ●
            </span>
            Manage agents…
          </button>
        </div>
      )}
    </div>
  );
}
