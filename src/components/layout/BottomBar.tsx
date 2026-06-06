import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ProjectPill } from "../projects/ProjectPill";
import { GLOBAL_APP_ROLES } from "./GlobalAppBar";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import type { GlobalAppEntry, ProjectEntry, Theme } from "../../types";
import { resolveProjectDirectory, THEMES } from "../../types";

const TERMINAL_OPTIONS = ["claude", "codex", "gemini", "vibe"];

interface OllamaModelInfo {
  name: string;
  size: number;
  parameter_size: string | null;
  quantization: string | null;
  family: string | null;
  running: boolean;
  size_vram: number;
}

interface CatalogEntry {
  name: string;
  description: string;
  tags: string[];
  size_hint: string;
}

interface ScaffoldPreviewItem {
  path: string;
  exists: boolean;
  kind: string;
}

const SCAFFOLD_FILL_OPTIONS = [
  { value: "none", label: "No filling" },
  { value: "manual", label: "Manual" },
  { value: "validation", label: "Validation" },
  { value: "claude", label: "Fill by Claude" },
  { value: "codex", label: "Fill by Codex" },
  { value: "gemini", label: "Fill by Gemini" },
  { value: "vibe", label: "Fill by Mistral" },
];

function sanitizeName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function projectDirectory(project: ProjectEntry) {
  return resolveProjectDirectory(project);
}

export function BottomBar() {
  const { projects, activeId, setActive, addProject, deactivateProject } = useProjectsStore();
  const [showSettings, setShowSettings] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<"main" | "global" | "filetypes" | "ollama">("main");
  const [ollamaInstalled, setOllamaInstalled] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [dialog, setDialog] = useState<"new" | "import" | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<boolean>("ollama_is_installed").then(setOllamaInstalled).catch(() => {});
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return projects
      .filter((p) => p.status === "inactive")
      .filter((p) => p.name.toLowerCase().includes(q) || projectDirectory(p).toLowerCase().includes(q))
      .sort((a, b) => a.position - b.position);
  }, [projects, query]);

  const activeProjects = useMemo(() => {
    return projects
      .filter((p) => p.status !== "inactive")
      .sort((a, b) => a.position - b.position);
  }, [projects]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) {
        setQuery("");
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const activateSearchResult = (project: ProjectEntry) => {
    setQuery("");
    void setActive(project.id);
  };

  return (
    <>
      {showSettings && createPortal(
        <SettingsDialog onClose={() => setShowSettings(false)} initialPanel={settingsPanel} />,
        document.body,
      )}

      {dialog === "new" && createPortal(
        <ProjectDialog
          kind="new"
          onClose={() => setDialog(null)}
          onProject={(project) => addProject(project)}
        />,
        document.body,
      )}
      {dialog === "import" && createPortal(
        <ProjectDialog
          kind="import"
          onClose={() => setDialog(null)}
          onProject={(project) => addProject(project)}
        />,
        document.body,
      )}

      <div
        className="bottom-bar"
        onClick={() => {
          setShowSettings(false);
          setShowSettingsMenu(false);
          setShowAddMenu(false);
        }}
      >
        <button
          className={`bottom-root-btn ${activeId === null ? "active" : ""}`}
          title="Root terminal"
          onClick={(e) => {
            e.stopPropagation();
            void setActive(null);
          }}
        >
          ▣
        </button>

        <div className="project-search-wrap" ref={searchRef} onClick={(e) => e.stopPropagation()}>
          <input
            className="project-search-entry"
            type="search"
            placeholder="Search inactive..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results.length === 1) {
                activateSearchResult(results[0]);
              }
              if (e.key === "Escape") {
                setQuery("");
              }
            }}
          />
          {query.trim() && (
            <div className="project-search-popover">
              {results.length === 0 ? (
                <div className="project-search-empty">No projects</div>
              ) : (
                results.map((project) => (
                  <button
                    key={project.id}
                    className="project-search-row"
                    onClick={() => activateSearchResult(project)}
                  >
                    <span>{project.name}</span>
                    {projectDirectory(project) && <small>{projectDirectory(project)}</small>}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="bottom-separator" />
        <div className="project-pills-scroll">
          {activeProjects.map((p) => (
            <ProjectPill
              key={p.id}
              project={p}
              active={p.id === activeId}
              onClick={() => setActive(p.id)}
              onClose={() => deactivateProject(p.id)}
            />
          ))}
        </div>
        <div className="bottom-separator" />

        <div className="bottom-add-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            className="bottom-action-btn"
            title="Settings"
            onClick={() => {
              setShowAddMenu(false);
              setShowSettingsMenu((v) => !v);
            }}
          >
            ⚙
          </button>
          {showSettingsMenu && (
            <div className="bottom-add-menu">
              <button onClick={() => { setShowSettingsMenu(false); setSettingsPanel("main"); setShowSettings(true); }}>
                Settings
              </button>
              {ollamaInstalled && (
                <button onClick={() => { setShowSettingsMenu(false); setSettingsPanel("ollama"); setShowSettings(true); }}>
                  Ollama Models
                </button>
              )}
            </div>
          )}
        </div>

        <div className="bottom-add-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            className="bottom-add-btn"
            title="Add or import project"
            onClick={() => {
              setShowSettings(false);
              setShowAddMenu((v) => !v);
            }}
          >
            +
          </button>
          {showAddMenu && (
            <div className="bottom-add-menu">
              <button onClick={() => { setShowAddMenu(false); setDialog("new"); }}>
                New Project
              </button>
              <button onClick={() => { setShowAddMenu(false); setDialog("import"); }}>
                Import Project
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

type SettingsPanel = "main" | "global" | "filetypes" | "ollama";

function SettingsDialog({
  onClose,
  initialPanel = "main",
}: {
  onClose: () => void;
  initialPanel?: SettingsPanel;
}) {
  const { settings, setTheme, updateSettings } = useSettingsStore();
  const [panel, setPanel] = useState<SettingsPanel>(initialPanel);
  const [gitProfileUrl, setGitProfileUrl] = useState(settings?.git_profile_url ?? "");
  const [gitToken, setGitToken] = useState(settings?.git_token ?? "");
  const [ollamaInstalled, setOllamaInstalled] = useState(false);

  useEffect(() => {
    invoke<boolean>("ollama_is_installed").then(setOllamaInstalled).catch(() => {});
  }, []);

  useEffect(() => {
    setGitProfileUrl(settings?.git_profile_url ?? "");
    setGitToken(settings?.git_token ?? "");
  }, [settings?.git_profile_url, settings?.git_token]);

  const terminal = settings?.terminal_command ?? "claude";
  const currentTheme = (settings?.color_scheme ?? "fancy_dark") as Theme;

  const saveGitProfileUrl = () => {
    void updateSettings({ git_profile_url: gitProfileUrl.trim() });
  };

  const saveGitToken = () => {
    void updateSettings({ git_token: gitToken.trim() });
  };

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        {panel === "main" && (
          <>
            <div className="settings-title-row">
              <h2>Settings</h2>
              <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
            </div>

            <div className="settings-row">
              <label htmlFor="terminal-command">Terminal</label>
              <select
                id="terminal-command"
                value={terminal}
                onChange={(e) => void updateSettings({ terminal_command: e.target.value })}
              >
                {TERMINAL_OPTIONS.map((cmd) => (
                  <option key={cmd} value={cmd}>{cmd}</option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="color-scheme">Theme</label>
              <select
                id="color-scheme"
                value={currentTheme}
                onChange={(e) => void setTheme(e.target.value as Theme)}
              >
                {THEMES.map((theme) => (
                  <option key={theme.value} value={theme.value}>{theme.label}</option>
                ))}
              </select>
            </div>

            <label className="settings-switch-row">
              <span>Manage workspaces</span>
              <input
                type="checkbox"
                checked={settings?.workspace_management ?? false}
                onChange={(e) => void updateSettings({ workspace_management: e.target.checked })}
              />
            </label>

            <label className="settings-switch-row">
              <span>Debug mode</span>
              <input
                type="checkbox"
                checked={settings?.debug ?? false}
                onChange={(e) => void updateSettings({ debug: e.target.checked })}
              />
            </label>

            <div className="settings-section-title">Git Hosting</div>
            <label className="settings-field">
              Profile URL
              <input
                value={gitProfileUrl}
                placeholder="https://github.com/username"
                onChange={(e) => setGitProfileUrl(e.target.value)}
                onBlur={saveGitProfileUrl}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveGitProfileUrl();
                }}
              />
            </label>
            <label className="settings-field">
              Access token
              <input
                type="password"
                value={gitToken}
                placeholder="ghp_... / glpat-..."
                onChange={(e) => setGitToken(e.target.value)}
                onBlur={saveGitToken}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveGitToken();
                }}
              />
            </label>

            <div className="settings-link-row">
              <button type="button" onClick={() => setPanel("global")}>Global Apps...</button>
              <button type="button" onClick={() => setPanel("filetypes")}>File Type Apps...</button>
              {ollamaInstalled && (
                <button type="button" onClick={() => setPanel("ollama")}>Ollama...</button>
              )}
            </div>
          </>
        )}
        {panel === "global" && <GlobalAppsSettings onBack={() => setPanel("main")} />}
        {panel === "filetypes" && <FileTypeSettings onBack={() => setPanel("main")} />}
        {panel === "ollama" && <OllamaPanel onBack={() => setPanel("main")} />}
      </div>
    </div>
  );
}

function GlobalAppsSettings({ onBack }: { onBack: () => void }) {
  const { settings, updateSettings } = useSettingsStore();
  const [apps, setApps] = useState<Record<string, GlobalAppEntry>>(settings?.global_apps ?? {});

  useEffect(() => {
    setApps(settings?.global_apps ?? {});
  }, [settings?.global_apps]);

  const saveApps = (next: Record<string, GlobalAppEntry>) => {
    setApps(next);
    void updateSettings({ global_apps: next });
  };

  const updateRole = (role: string, patch: Partial<GlobalAppEntry>) => {
    const current = apps[role] ?? { exec: "", visible: true };
    saveApps({ ...apps, [role]: { ...current, ...patch } });
  };

  const chooseExecutable = async (role: string) => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      updateRole(role, { exec: picked });
    }
  };

  return (
    <>
      <div className="settings-title-row">
        <h2>Global Apps</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">Apps that stay visible across workspaces. Checked apps appear in the top toolbar.</p>
      <div className="settings-list">
        {GLOBAL_APP_ROLES.map((role) => {
          const entry = apps[role.key] ?? { exec: "", visible: true };
          return (
            <div className="global-app-settings-row" key={role.key}>
              <input
                type="checkbox"
                checked={entry.visible !== false}
                onChange={(e) => updateRole(role.key, { visible: e.target.checked })}
                title={`Show ${role.label}`}
              />
              <span className="settings-role-icon" aria-hidden>{role.fallback}</span>
              <span className="settings-role-label">{role.label}</span>
              <input
                value={entry.exec}
                placeholder="not found"
                onChange={(e) => setApps({ ...apps, [role.key]: { ...entry, exec: e.target.value } })}
                onBlur={(e) => updateRole(role.key, { exec: e.target.value.trim() })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") updateRole(role.key, { exec: e.currentTarget.value.trim() });
                }}
              />
              <button type="button" onClick={() => void chooseExecutable(role.key)}>...</button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function FileTypeSettings({ onBack }: { onBack: () => void }) {
  const [apps, setApps] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ ext: "", app: "" });
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<Record<string, string>>("get_default_apps")
      .then(setApps)
      .catch((err) => setError(String(err)));
  }, []);

  const saveApps = (next: Record<string, string>) => {
    setApps(next);
    invoke<void>("save_default_apps", { defaultApps: next }).catch((err) => setError(String(err)));
  };

  const normalizeExt = (ext: string) => {
    const trimmed = ext.trim();
    if (!trimmed) return "";
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  };

  const chooseExecutable = async (ext: string) => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") {
      saveApps({ ...apps, [ext]: picked });
    }
  };

  const addEntry = () => {
    const ext = normalizeExt(draft.ext);
    const app = draft.app.trim();
    if (!ext || !app) return;
    saveApps({ ...apps, [ext]: app });
    setDraft({ ext: "", app: "" });
  };

  return (
    <>
      <div className="settings-title-row">
        <h2>File Type Apps</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">Double-clicking a project file opens it with the app below.</p>
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="settings-list">
        {Object.entries(apps).sort(([a], [b]) => a.localeCompare(b)).map(([ext, app]) => (
          <div className="filetype-settings-row" key={ext}>
            <input
              value={ext}
              onChange={(e) => {
                const nextExt = normalizeExt(e.target.value);
                const { [ext]: old, ...rest } = apps;
                if (nextExt) saveApps({ ...rest, [nextExt]: old });
              }}
            />
            <input
              value={app}
              onChange={(e) => setApps({ ...apps, [ext]: e.target.value })}
              onBlur={(e) => saveApps({ ...apps, [ext]: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveApps({ ...apps, [ext]: e.currentTarget.value.trim() });
              }}
            />
            <button type="button" onClick={() => void chooseExecutable(ext)}>...</button>
            <button
              type="button"
              onClick={() => {
                const { [ext]: _removed, ...rest } = apps;
                saveApps(rest);
              }}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
        <div className="filetype-settings-row">
          <input
            value={draft.ext}
            placeholder=".ext"
            onChange={(e) => setDraft({ ...draft, ext: e.target.value })}
          />
          <input
            value={draft.app}
            placeholder="app command"
            onChange={(e) => setDraft({ ...draft, app: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") addEntry();
            }}
          />
          <button type="button" onClick={addEntry}>Add</button>
        </div>
      </div>
    </>
  );
}

function fmtBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(0) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function OllamaPanel({ onBack }: { onBack: () => void }) {
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [serverRunning, setServerRunning] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<OllamaModelInfo[]>("list_ollama_models_detailed");
      setModels(result);
      setServerRunning(true);
    } catch (e) {
      if (String(e).includes("not_running")) {
        setServerRunning(false);
        setModels([]);
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    invoke<CatalogEntry[]>("list_installable_models").then(setCatalog).catch(() => {});
    void refresh();
  }, []);

  const startServer = async () => {
    setError(null);
    try {
      await invoke("ensure_ollama_running");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const installedNames = useMemo(() => new Set(models.map((m) => m.name)), [models]);
  const runningModels = models.filter((m) => m.running);
  const loadedLabel =
    runningModels.length === 0
      ? serverRunning
        ? "No model loaded"
        : "No loaded model"
      : `Loaded: ${runningModels.map((m) => m.name).join(", ")}`;

  return (
    <>
      <div className="settings-title-row">
        <h2>Ollama Models</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>

      <div className="ollama-status-bar">
        <span className={`ollama-status-dot ${runningModels.length > 0 ? "running" : "stopped"}`} />
        <span className="ollama-status-text">
          {serverRunning === null
            ? "Checking..."
            : serverRunning
              ? loadedLabel
              : "Server not running"}
        </span>
        {serverRunning === false && (
          <button type="button" className="ollama-action-btn" onClick={() => void startServer()}>
            Start
          </button>
        )}
        {serverRunning === true && (
          <button
            type="button"
            className="ollama-action-btn"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "..." : "Refresh"}
          </button>
        )}
      </div>

      {error && <div className="project-dialog-error">{error}</div>}

      <div className="settings-section-title">Installed Models</div>
      {loading ? (
        <div className="ollama-empty">Loading...</div>
      ) : models.length === 0 ? (
        <div className="ollama-empty">No models installed</div>
      ) : (
        <div className="settings-list">
          {models.map((m) => (
            <div className="ollama-model-row" key={m.name}>
              <div className="ollama-model-header">
                <span className="ollama-model-name">{m.name}</span>
                <span className="ollama-model-size">{fmtBytes(m.size)}</span>
              </div>
              <div className="ollama-model-details">
                {m.parameter_size && <span className="ollama-badge">{m.parameter_size}</span>}
                {m.quantization && <span className="ollama-badge">{m.quantization}</span>}
                {m.family && <span className="ollama-badge">{m.family}</span>}
                {m.running && (
                  <span className={`ollama-badge running${m.size_vram > 0 ? " gpu" : ""}`}>
                    {m.size_vram > 0 ? `GPU ${fmtBytes(m.size_vram)}` : "CPU"}
                  </span>
                )}
              </div>
              <div className="ollama-model-actions">
                {m.running && (
                  <button
                    type="button"
                    className="ollama-action-btn"
                    disabled={busy[`${m.name}:stop`]}
                    title="Unload from memory"
                    onClick={() =>
                      void withBusy(`${m.name}:stop`, () =>
                        invoke("stop_ollama_model", { model: m.name }),
                      )
                    }
                  >
                    {busy[`${m.name}:stop`] ? "..." : "Unload"}
                  </button>
                )}
                <button
                  type="button"
                  className="ollama-action-btn"
                  disabled={busy[`${m.name}:pull`]}
                  title="Check for update and download latest"
                  onClick={() =>
                    void withBusy(`${m.name}:pull`, () =>
                      invoke("pull_ollama_model", { model: m.name }),
                    )
                  }
                >
                  {busy[`${m.name}:pull`] ? "Updating..." : "Update"}
                </button>
                <button
                  type="button"
                  className="ollama-action-btn danger"
                  disabled={busy[`${m.name}:del`]}
                  title="Delete this model"
                  onClick={() =>
                    void withBusy(`${m.name}:del`, () =>
                      invoke("delete_ollama_model", { model: m.name }),
                    )
                  }
                >
                  {busy[`${m.name}:del`] ? "..." : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="settings-section-title ollama-section-title-row">
        <span>Available to Install</span>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? "..." : "Refresh"}
        </button>
      </div>
      <div className="settings-list">
        {catalog.map((entry) => (
          <div className="ollama-catalog-row" key={entry.name}>
            <div className="ollama-catalog-header">
              <span className="ollama-model-name">{entry.name}</span>
              <span className="ollama-catalog-hint">{entry.size_hint}</span>
            </div>
            <div className="ollama-catalog-desc">{entry.description}</div>
            <div className="ollama-catalog-tags">
              {entry.tags.map((tag) => {
                const fullName = `${entry.name}:${tag}`;
                const isInstalled = installedNames.has(fullName);
                const isBusy = busy[`${fullName}:pull`];
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`ollama-tag-btn${isInstalled ? " installed" : ""}`}
                    disabled={!!isBusy}
                    title={isInstalled ? `Update ${fullName}` : `Install ${fullName}`}
                    onClick={() =>
                      void withBusy(`${fullName}:pull`, () =>
                        invoke("pull_ollama_model", { model: fullName }),
                      )
                    }
                  >
                    {isBusy ? "..." : tag}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ProjectDialog({
  kind,
  onClose,
  onProject,
}: {
  kind: "new" | "import";
  onClose: () => void;
  onProject: (project: ProjectEntry) => void;
}) {
  const [projectsRoot, setProjectsRoot] = useState("");
  const [name, setName] = useState("");
  const [gitType, setGitType] = useState("private");
  const [mode, setMode] = useState("keep");
  const [sourceDir, setSourceDir] = useState("");
  const [scaffoldPreview, setScaffoldPreview] = useState<ScaffoldPreviewItem[]>([]);
  const [scaffoldFillModes, setScaffoldFillModes] = useState<Record<string, string>>({});
  const [scaffoldError, setScaffoldError] = useState("");
  const [manualValidationConfirmed, setManualValidationConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const safeName = sanitizeName(name);
  const targetDir = safeName && projectsRoot ? `${projectsRoot}/${safeName}` : "";

  useEffect(() => {
    invoke<string>("projects_root_dir").then(setProjectsRoot).catch(() => {});
  }, []);

  useEffect(() => {
    if (kind !== "import" || !sourceDir) {
      setScaffoldPreview([]);
      setScaffoldError("");
      return;
    }

    let cancelled = false;
    setScaffoldError("");
    invoke<ScaffoldPreviewItem[]>("preview_project_scaffold", { sourceDir })
      .then((items) => {
        if (cancelled) return;
        setScaffoldPreview(items);
        setScaffoldFillModes((current) => {
          const next: Record<string, string> = {};
          for (const item of items) next[item.path] = current[item.path] ?? "none";
          return next;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setScaffoldPreview([]);
        setScaffoldError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [kind, sourceDir]);

  useEffect(() => {
    setManualValidationConfirmed(false);
  }, [mode, sourceDir]);

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setSourceDir(picked);
      if (!name.trim()) {
        setName(picked.split("/").filter(Boolean).pop() ?? "");
      }
    }
  };

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      const project =
        kind === "new"
          ? await invoke<ProjectEntry>("create_project", {
              req: { name, directory: targetDir, gitType },
            })
          : await invoke<ProjectEntry>("import_project", {
              req: { sourceDir, name, gitType, mode, scaffoldFillModes, manualValidationConfirmed },
            });
      onProject(project);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    kind === "new"
      ? Boolean(name.trim() && targetDir && safeName)
      : Boolean(
          name.trim() &&
          sourceDir &&
          (mode === "keep" || safeName) &&
          (mode === "keep" || manualValidationConfirmed),
        );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="project-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{kind === "new" ? "New Project" : "Import Project"}</h2>

        {kind === "import" && (
          <label>
            Source folder
            <div className="folder-picker-row">
              <span title={sourceDir}>{sourceDir || "No folder selected"}</span>
              <button type="button" onClick={chooseFolder}>Browse...</button>
            </div>
          </label>
        )}

        <label>
          Project name
          <input
            autoFocus
            value={name}
            placeholder="my-project"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit && !busy) void submit();
              if (e.key === "Escape") onClose();
            }}
          />
        </label>

        <label>
          Visibility
          <select value={gitType} onChange={(e) => setGitType(e.target.value)}>
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
        </label>

        {kind === "import" && (
          <label>
            Import mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="keep">Keep location (register in place)</option>
              <option value="copy">Copy to ~/eldrun/projects/</option>
              <option value="move">Move to ~/eldrun/projects/</option>
            </select>
          </label>
        )}

        {kind === "import" && (
          <div className="scaffold-popover" role="group" aria-label="Import scaffold guidance">
            <div className="scaffold-popover-title">Import guidance</div>
            <ol className="scaffold-steps">
              <li>Select the source folder and project metadata.</li>
              <li>
                {mode === "keep"
                  ? "Register the project in its current location."
                  : mode === "copy"
                    ? "Copy the project to the Eldrun projects folder after manual validation."
                    : "Move the project to the Eldrun projects folder after manual validation."}
              </li>
              <li>Create missing scaffold files and acknowledge files already there.</li>
              <li>Write project.json and add the project to the switcher.</li>
            </ol>

            {mode !== "keep" && (
              <label className="manual-validation-row">
                <input
                  type="checkbox"
                  checked={manualValidationConfirmed}
                  onChange={(e) => setManualValidationConfirmed(e.target.checked)}
                />
                I manually validated the {mode} destination and source folder.
              </label>
            )}

            <div className="scaffold-list">
              {scaffoldPreview.map((item) => (
                <div className="scaffold-row" key={item.path}>
                  <div className="scaffold-file">
                    <span>{item.path}</span>
                    <small>{item.exists ? "Already there, will be kept" : "Missing, will be added"}</small>
                  </div>
                  <select
                    value={item.exists ? "none" : scaffoldFillModes[item.path] ?? "none"}
                    disabled={item.exists}
                    onChange={(e) =>
                      setScaffoldFillModes((current) => ({ ...current, [item.path]: e.target.value }))
                    }
                  >
                    {SCAFFOLD_FILL_OPTIONS.map((option) => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              ))}
              {!sourceDir && <div className="scaffold-empty">Choose a source folder to preview scaffold files.</div>}
              {sourceDir && !scaffoldPreview.length && !scaffoldError && (
                <div className="scaffold-empty">Loading scaffold preview...</div>
              )}
              {scaffoldError && <div className="project-dialog-error">{scaffoldError}</div>}
            </div>
          </div>
        )}

        <div className="project-dialog-path">
          {kind === "new" || mode !== "keep"
            ? targetDir
              ? `Destination: ${targetDir}`
              : ""
            : sourceDir
              ? `Location: ${sourceDir}`
              : ""}
        </div>
        {error && <div className="project-dialog-error">{error}</div>}

        <div className="project-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!canSubmit || busy} onClick={() => void submit()}>
            {busy ? "Working..." : kind === "new" ? "Create" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
