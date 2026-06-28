import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settings";

/** Subset of the backend `OllamaModelInfo` the menu needs (installed models). */
interface LocalModelInfo {
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
  // Every installed model (from list_ollama_models_detailed). Resident ones are
  // selectable as the active local model; the rest can be loaded into memory.
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Models currently being loaded into memory, keyed by name (from the global
  // `ollama-load-progress` events emitted by `load_ollama_model`, so a load
  // started anywhere — here or the settings panel — shows here too). Ollama
  // streams no load percentage, so this is an indeterminate state, not a pct.
  const [loads, setLoads] = useState<Record<string, "loading" | "error">>({});
  // Live pull progress per model ref (from the global `ollama-pull-progress`
  // events emitted by `pull_ollama_model`), so downloads started anywhere show
  // here too. `pct` is null during the manifest/verify phases (no byte totals).
  const [downloads, setDownloads] = useState<Record<string, { pct: number | null }>>({});
  const closeTimer = useRef<number | null>(null);

  // Detect whether Ollama is installed. Poll while it's still missing so that
  // installing Ollama mid-session is picked up without restarting Eldrun; stop
  // once detected (it won't be uninstalled live, and `ollama_status` polling
  // takes over from here — see below).
  useEffect(() => {
    if (installed) return;
    let cancelled = false;
    const check = () =>
      invoke<boolean>("ollama_is_installed")
        .then((ok) => {
          if (!cancelled) setInstalled(ok);
        })
        .catch(() => {});
    void check();
    const id = window.setInterval(check, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [installed]);

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

  // Track in-flight loads-into-memory regardless of which surface started them.
  useEffect(() => {
    const un = listen<{ model: string; status: string }>("ollama-load-progress", (e) => {
      const { model, status } = e.payload;
      setLoads((d) => {
        if (status === "success") {
          const { [model]: _done, ...rest } = d;
          return rest;
        }
        return { ...d, [model]: status === "error" ? "error" : "loading" };
      });
      // Once a model becomes resident, re-read the list so it moves into the
      // selectable (loaded) section.
      if (status === "success") void fetchModels();
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Read the full installed-model list (resident + on-disk). Used on hover and
  // re-run after a load completes so a freshly-resident model moves up.
  const fetchModels = () => {
    setLoading(true);
    setError(null);
    return invoke<LocalModelInfo[]>("list_ollama_models_detailed")
      .then((all) => setModels(all))
      .catch((e: string) => {
        setModels([]);
        setError(e === "not_running" ? "Ollama not running" : "Failed to load models");
      })
      .finally(() => setLoading(false));
  };

  const reveal = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
    if (!installed) return; // nothing to list yet — only the install entry shows
    void fetchModels();
  };

  // Warm a model into memory and keep it resident. The button reflects progress
  // via the `loads` map (driven by `ollama-load-progress`); we also optimistically
  // mark it loading immediately so the bar shows without waiting for the event.
  const loadIntoMemory = (model: string) => {
    setLoads((d) => ({ ...d, [model]: "loading" }));
    setError(null);
    invoke("load_ollama_model", { model })
      .then(() => fetchModels())
      .catch((e: string) => {
        setLoads((d) => ({ ...d, [model]: "error" }));
        setError(typeof e === "string" && e === "not_running" ? "Ollama not running" : "Failed to load model");
      });
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

  // Resident models are selectable; the rest are offered as "load into memory".
  const running = models.filter((m) => m.running);
  const available = models.filter((m) => !m.running);

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
          ) : loading && models.length === 0 ? (
            <div className="tab-new-menu-hint">Loading…</div>
          ) : error ? (
            <div className="tab-new-menu-hint">{error}</div>
          ) : models.length === 0 ? (
            <div className="tab-new-menu-hint">
              {status === "stopped" ? "Server stopped" : "No models installed"}
            </div>
          ) : (
            <>
              {/* Resident models — selectable as the active local model. */}
              {running.length === 0 ? (
                <div className="tab-new-menu-hint">No model loaded</div>
              ) : (
                running.map((m) => (
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
              {/* Installed-but-not-resident models — click to load into memory. */}
              {available.length > 0 && (
                <>
                  <div className="tab-new-menu-group-label">Load into memory</div>
                  {available.map((m) => {
                    const st = loads[m.name];
                    return (
                      <div key={m.name} className="local-model-load-row">
                        <button
                          className="tab-new-menu-item"
                          disabled={st === "loading"}
                          title={
                            st === "error"
                              ? "Failed to load — click to retry"
                              : "Load into memory"
                          }
                          onClick={() => loadIntoMemory(m.name)}
                        >
                          <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
                            ●
                          </span>
                          <span className="local-model-loaded-name">{m.name}</span>
                          <span className="local-model-loaded-badges">
                            {m.parameter_size && <span>{m.parameter_size}</span>}
                            <span>
                              {st === "loading" ? "Loading…" : st === "error" ? "Failed" : "Load"}
                            </span>
                          </span>
                        </button>
                        {st === "loading" && (
                          <div className="ollama-download-bar local-model-load-bar">
                            <div className="ollama-download-bar-fill indeterminate" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </>
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
