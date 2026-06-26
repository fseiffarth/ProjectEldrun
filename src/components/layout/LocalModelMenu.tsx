import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";

/**
 * Header button (left of the global-apps button) that sets the single active
 * local (Ollama) model. Hovering reveals the installed models — reusing the same
 * `list_ollama_models` command the rest of the app uses — and picking one writes
 * `settings.ollama_model`. A "Local Model" tab (TabBar's add menu) then launches
 * whichever model is active. Only shown when Ollama is installed.
 */
export function LocalModelMenu() {
  const { settings, updateSettings } = useSettingsStore();
  const activeModel = settings?.ollama_model;
  const [installed, setInstalled] = useState(false);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    invoke<boolean>("ollama_is_installed").then(setInstalled).catch(() => {});
  }, []);

  const reveal = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
    // Refresh the installed-model list each reveal (same command used elsewhere).
    setLoading(true);
    setError(null);
    invoke<string[]>("list_ollama_models")
      .then((m) => setModels(m))
      .catch((e: string) => {
        setModels([]);
        setError(e === "not_running" ? "Ollama not running" : "Failed to load models");
      })
      .finally(() => setLoading(false));
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

  if (!installed) return null;

  return (
    <div className="global-apps-menu no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn"
        title={activeModel ? `Local model: ${activeModel}` : "Set local model"}
        aria-label="Local model"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ color: "var(--warning)" }}
      >
        🧠
      </button>
      {open && (
        <div className="tab-new-menu">
          <div className="tab-new-menu-group-label">Local Model</div>
          {loading ? (
            <div className="tab-new-menu-hint">Loading…</div>
          ) : error ? (
            <div className="tab-new-menu-hint">{error}</div>
          ) : models.length === 0 ? (
            <div className="tab-new-menu-hint">No models installed</div>
          ) : (
            models.map((m) => (
              <button key={m} className="tab-new-menu-item" onClick={() => select(m)}>
                <span
                  className="tab-new-menu-dot"
                  style={{ color: activeModel === m ? "var(--warning)" : "transparent" }}
                >
                  ●
                </span>
                {m}
              </button>
            ))
          )}
          {activeModel && (
            <button className="tab-new-menu-item" onClick={() => select(undefined)}>
              <span className="tab-new-menu-dot" style={{ color: "transparent" }}>
                ●
              </span>
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
