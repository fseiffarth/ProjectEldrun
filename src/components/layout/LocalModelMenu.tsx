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

/** Subset of the backend `AgentInfo` the menu lists (installed agent CLIs). */
interface AgentInfo {
  id: string;
  label: string;
  installed: boolean;
}

/**
 * The tasks a loaded model can be tagged for. Each maps to a key under
 * `settings.ollama_roles`; a model wearing a tag is the one used for that task
 * (autocomplete + grammar in the editor, "Local Model" agent tabs), so several
 * resident models can each own a different job. A task with no tag falls back to
 * the default `ollama_model`. Mirrors the consumers in `FileViewerPane`/`TabBar`.
 */
const MODEL_ROLES: Array<{ key: string; label: string }> = [
  { key: "autocomplete", label: "Autocomplete" },
  { key: "grammar", label: "Grammar" },
  { key: "tabs", label: "Tabs" },
];

function fmtBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(0) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

/**
 * Header button (left of the global-apps button) for the local (Ollama) models.
 * Hovering reveals the models currently loaded in memory (the running set from
 * `list_ollama_models_detailed`), each shown with a green "loaded" lamp. Clicking
 * a model's name makes it the default (`settings.ollama_model`); its task tags
 * (Autocomplete / Grammar / Tabs → `settings.ollama_roles`) pin individual jobs
 * to specific loaded models, so several can run different tasks in parallel. A
 * task with no tag falls back to the default model. Always shown: when Ollama
 * isn't installed (or no
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
  // Installed agent CLIs (from list_agents), shown in the Agents section so the
  // ones already available are visible without opening "Manage agents".
  const [agents, setAgents] = useState<AgentInfo[]>([]);
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
  // Models whose download the user paused this session — each offers Resume/Delete.
  const [paused, setPaused] = useState<Set<string>>(new Set());
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
        if (status === "paused") {
          setDownloads((d) => {
            const { [model]: _drop, ...rest } = d;
            return rest;
          });
          setPaused((p) => new Set(p).add(model));
          return;
        }
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

  // Probe the installed agent CLIs (cheap PATH lookups in the backend) so the
  // Agents section can list the ones already available.
  const fetchAgents = () => {
    invoke<AgentInfo[]>("list_agents")
      .then((all) => setAgents(all.filter((a) => a.installed)))
      .catch(() => {});
  };

  const reveal = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
    fetchAgents();
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

  // Pause an in-flight download; the backend keeps the partial blobs and emits a
  // "paused" event that flips the row to Resume / Delete.
  const pausePull = (model: string) => {
    void invoke("pause_ollama_pull", { model });
  };

  // Resume a paused download — Ollama continues from the partial blobs.
  const resumePull = (model: string) => {
    setPaused((p) => {
      const n = new Set(p);
      n.delete(model);
      return n;
    });
    invoke("pull_ollama_model", { model }).catch(() => {});
  };

  // Delete a paused download's partial data.
  const deletePausedPull = (model: string) => {
    setPaused((p) => {
      const n = new Set(p);
      n.delete(model);
      return n;
    });
    void invoke("delete_ollama_pull", { model }).catch(() => {});
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

  // The first model to become resident is, by default, the default model and is
  // wired to every task (autocomplete/grammar/tabs) so a fresh install works out
  // of the box. Only fires when nothing has been configured yet, so it never
  // overrides an explicit choice the user later makes.
  useEffect(() => {
    if (!settings) return;
    if (settings.ollama_model || Object.keys(settings.ollama_roles ?? {}).length > 0) return;
    const first = models.find((m) => m.running);
    if (!first) return;
    const allRoles: Record<string, string> = {};
    for (const r of MODEL_ROLES) allRoles[r.key] = first.name;
    void updateSettings({ ollama_model: first.name, ollama_roles: allRoles });
  }, [models, settings, updateSettings]);

  // Per-task model tags. Each task maps to exactly one model; tagging a model for
  // a task it already owns clears the tag (toggle). Kept open so several tags can
  // be assigned in one pass. Unassigned tasks fall back to the default model.
  const roles = settings?.ollama_roles ?? {};
  const toggleRole = (role: string, model: string) => {
    const next = { ...roles };
    if (next[role] === model) delete next[role];
    else next[role] = model;
    void updateSettings({ ollama_roles: next });
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
          {installed && (Object.keys(downloads).length > 0 || paused.size > 0) && (
            <div className="local-model-downloads">
              {Object.entries(downloads).map(([model, d]) => (
                <div key={model} className="local-model-download-row" title="Downloading">
                  <div className="local-model-download-head">
                    <span className="local-model-loaded-name">{model}</span>
                    <span className="local-model-download-pct">
                      {d.pct != null ? `${d.pct}%` : "…"}
                    </span>
                    <button
                      type="button"
                      className="local-model-download-action"
                      title="Pause download"
                      onClick={() => pausePull(model)}
                    >
                      Pause
                    </button>
                  </div>
                  <div className="ollama-download-bar">
                    <div
                      className={`ollama-download-bar-fill${d.pct == null ? " indeterminate" : ""}`}
                      style={d.pct != null ? { width: `${d.pct}%` } : undefined}
                    />
                  </div>
                </div>
              ))}
              {[...paused].map((model) => (
                <div key={`paused:${model}`} className="local-model-download-row" title="Paused">
                  <div className="local-model-download-head">
                    <span className="local-model-loaded-name">{model}</span>
                    <span className="local-model-download-pct">paused</span>
                    <button
                      type="button"
                      className="local-model-download-action"
                      title="Resume download"
                      onClick={() => resumePull(model)}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="local-model-download-action danger"
                      title="Delete partial download"
                      onClick={() => deletePausedPull(model)}
                    >
                      Delete
                    </button>
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
                  <div key={m.name} className="local-model-row">
                    <button
                      className="tab-new-menu-item local-model-pick"
                      title={
                        activeModel === m.name
                          ? "Default local model · loaded in memory"
                          : "Loaded in memory — click to make default"
                      }
                      onClick={() => select(m.name)}
                    >
                      {/* Green lamp: this model is resident in Ollama's memory. */}
                      <span className="local-model-lamp" aria-hidden="true" />
                      <span className="local-model-loaded-name">{m.name}</span>
                      {activeModel === m.name && (
                        <span className="local-model-default-tag">default</span>
                      )}
                      <span className="local-model-loaded-badges">
                        {m.parameter_size && <span>{m.parameter_size}</span>}
                        {m.quantization && <span>{m.quantization}</span>}
                        <span className={m.size_vram > 0 ? "gpu" : "cpu"}>
                          {m.size_vram > 0 ? `GPU ${fmtBytes(m.size_vram)}` : "CPU"}
                        </span>
                      </span>
                    </button>
                    {/* Task tags: pin this model to a job (autocomplete/grammar/
                        tabs). Several loaded models can each own a different one. */}
                    <div className="local-model-roles">
                      {MODEL_ROLES.map((r) => {
                        const on = roles[r.key] === m.name;
                        return (
                          <button
                            key={r.key}
                            type="button"
                            className={`local-model-role-chip${on ? " on" : ""}`}
                            title={
                              on
                                ? `Used for ${r.label.toLowerCase()} — click to unassign`
                                : `Use ${m.name} for ${r.label.toLowerCase()}`
                            }
                            onClick={() => toggleRole(r.key, m.name)}
                          >
                            {r.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
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
          {agents.map((a) => (
            <div key={a.id} className="local-model-agent-row" title={`${a.label} installed`}>
              {/* Green lamp mirrors a loaded model: this agent CLI is installed. */}
              <span className="local-model-lamp" aria-hidden="true" />
              <span className="local-model-loaded-name">{a.label}</span>
            </div>
          ))}
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
