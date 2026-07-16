import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { VIEWER_PREF_TYPES } from "../../lib/viewers/fileUtils";
import { PythonInterpreterWindow } from "../projects/PythonInterpreterWindow";
import type { ProjectEntry, ViewerPref } from "../../types";

/**
 * The file-view filters (which endings/paths a project's tree hides) and the
 * Project Settings dialog that edits them. Shared by the right panel and the
 * "Files (Project)" tab so the two views hide the same files: the lists live in
 * the project's own `project.json`, not in either host's state.
 */

type ProjectJson = Record<string, unknown>;

const PANEL_HIDDEN_ENDINGS_KEY = "panel_hidden_endings";
const PANEL_HIDDEN_PATHS_KEY = "panel_hidden_paths";
const PANEL_SHOWN_PATHS_KEY = "panel_shown_paths";

/** File endings that mark a project as holding Python — gates the interpreter
 *  picker, mirroring the pill's `PYTHON_ENDINGS`. */
const PYTHON_ENDINGS = new Set([".py", ".pyw", ".pyi"]);

function readStringList(project: ProjectJson | null, key: string): string[] {
  const raw = project?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function mergeEndings(...groups: string[][]): string[] {
  const endings = new Map<string, string>();
  for (const group of groups) {
    for (const ending of group) {
      const trimmed = ending.trim();
      if (!trimmed) continue;
      endings.set(trimmed.toLowerCase(), trimmed);
    }
  }
  return [...endings.values()].sort((a, b) => a.localeCompare(b));
}

export interface ProjectFileFilters {
  hiddenEndings: string[];
  hiddenPaths: string[];
  shownPaths: string[];
  availableEndings: string[];
  error: string | null;
  toggleHiddenEnding: (ending: string, checked: boolean) => void;
}

/**
 * Load a project's tree-hiding lists from its `project.json`, and save endings
 * back to it. `remoteBlocked` suppresses the ending SCAN only: it walks the
 * project dir over SFTP for a remote project and would freeze the main thread
 * while the pool is down — `load_project` reads the local file and is always safe.
 */
export function useProjectFileFilters(opts: {
  localFile?: string;
  projectDir: string;
  remoteBlocked: boolean;
}): ProjectFileFilters {
  const { localFile, projectDir, remoteBlocked } = opts;
  const [project, setProject] = useState<ProjectJson | null>(null);
  const [hiddenEndings, setHiddenEndings] = useState<string[]>([]);
  const [availableEndings, setAvailableEndings] = useState<string[]>([]);
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [shownPaths, setShownPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!localFile || !projectDir) {
      setProject(null);
      setHiddenEndings([]);
      setAvailableEndings([]);
      setHiddenPaths([]);
      setShownPaths([]);
      return;
    }
    Promise.all([
      invoke<ProjectJson>("load_project", { localFile }),
      remoteBlocked
        ? Promise.resolve<string[]>([])
        : invoke<string[]>("list_project_endings", { projectDir }).catch(() => []),
    ])
      .then(([loaded, endings]) => {
        const savedHiddenEndings = readStringList(loaded, PANEL_HIDDEN_ENDINGS_KEY);
        setProject(loaded);
        setHiddenEndings(savedHiddenEndings);
        setAvailableEndings(mergeEndings(endings, savedHiddenEndings));
        setHiddenPaths(readStringList(loaded, PANEL_HIDDEN_PATHS_KEY));
        setShownPaths(readStringList(loaded, PANEL_SHOWN_PATHS_KEY));
      })
      .catch((e) => {
        setProject(null);
        setHiddenEndings([]);
        setAvailableEndings([]);
        setHiddenPaths([]);
        setShownPaths([]);
        setError(String(e));
      });
  }, [localFile, projectDir, remoteBlocked]);

  const saveHiddenEndings = async (nextEndings: string[]) => {
    if (!localFile || !project) return;
    const nextProject = {
      ...project,
      [PANEL_HIDDEN_ENDINGS_KEY]: nextEndings,
      [PANEL_HIDDEN_PATHS_KEY]: hiddenPaths,
      [PANEL_SHOWN_PATHS_KEY]: shownPaths,
    };
    setHiddenEndings(nextEndings);
    setProject(nextProject);
    setError(null);
    try {
      await invoke("save_project", { localFile, project: nextProject });
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleHiddenEnding = (ending: string, checked: boolean) => {
    const existing = new Set(hiddenEndings.map((item) => item.toLowerCase()));
    const nextEndings = checked
      ? existing.has(ending.toLowerCase())
        ? hiddenEndings
        : [...hiddenEndings, ending]
      : hiddenEndings.filter((item) => item.toLowerCase() !== ending.toLowerCase());
    void saveHiddenEndings(nextEndings);
  };

  return {
    hiddenEndings,
    hiddenPaths,
    shownPaths,
    availableEndings,
    error,
    toggleHiddenEnding,
  };
}

/** Project Settings: which file endings the tree hides, plus the (global)
 *  native-viewer preferences. Portaled, so it opens the same from the panel's
 *  gear and the Files (Project) tab's. */
export function ProjectFilesSettingsDialog({
  localFile,
  project,
  filters,
  onClose,
}: {
  localFile: string;
  /** The project this gear belongs to — used to offer the Python interpreter
   *  picker (the same one the project pill opens). Null in root/box scope. */
  project: ProjectEntry | null;
  filters: ProjectFileFilters;
  onClose: () => void;
}) {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { availableEndings, hiddenEndings, error, toggleHiddenEnding } = filters;
  const [showPython, setShowPython] = useState(false);

  // Offer the Python interpreter picker on the same terms the pill does: the
  // project holds Python files (a probed ending), or it's remote (probed on the
  // host, which may hold Python the local mirror doesn't).
  const hasPython =
    !!project &&
    (!!project.remote ||
      availableEndings.some((e) => PYTHON_ENDINGS.has(e.toLowerCase())));

  return createPortal(
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog project-settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>Project Settings</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-section-title">File Hiding</div>
        <p className="settings-help">
          Click an ending to hide matching files in the project file views. Dimmed endings are hidden.
        </p>
        {availableEndings.length === 0 ? (
          <div className="settings-empty">No file endings found in this project.</div>
        ) : (
          <div className="settings-list project-ending-list">
            {availableEndings.map((ending) => {
              const checked = hiddenEndings.some((item) => item.toLowerCase() === ending.toLowerCase());
              return (
                <button
                  type="button"
                  className={`project-ending-toggle${checked ? " is-hidden" : ""}`}
                  key={ending}
                  aria-pressed={checked}
                  onClick={() => toggleHiddenEnding(ending, !checked)}
                  title={checked ? `Show ${ending} files` : `Hide ${ending} files`}
                >
                  {ending}
                </button>
              );
            })}
          </div>
        )}
        {error && <div className="settings-error">{error}</div>}

        {hasPython && project && (
          <>
            <div className="settings-section-title">Python</div>
            <p className="settings-help">
              Which interpreter the code viewer's Run and Debug buttons use.
              Auto-detect by default; pin a venv or other environment when
              Eldrun can't infer it.
            </p>
            <button
              className="tab-add-btn"
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={() => setShowPython(true)}
            >
              {project.python_interpreter ? "✓ " : ""}Python interpreter…
            </button>
          </>
        )}

        {/* #48 per-file-type native-viewer settings (global, not per-project).
            Toggles opt-in local autocomplete (#45) per type, plus the global
            autosave (#47). */}
        <div className="settings-section-title">Native Viewers</div>
        <p className="settings-help">
          Eldrun renders these file types in-app. Disable a type to open its
          files in your external default app instead. Autocomplete is
          local-only (Ollama) and opt-in.
        </p>
        <label className="viewer-pref-toggle" style={{ marginBottom: 6 }}>
          <Toggle
            size="sm"
            checked={settings?.autosave !== false}
            onChange={(e) => void updateSettings({ autosave: e.target.checked })}
          />
          <span>Autosave edits</span>
        </label>
        <label className="viewer-pref-toggle" style={{ marginBottom: 6 }}>
          <Toggle
            size="sm"
            checked={settings?.change_tint !== false}
            onChange={(e) => void updateSettings({ change_tint: e.target.checked })}
          />
          <span>Highlight recent edits (new→old colour trail)</span>
        </label>
        <div className="viewer-prefs-list">
          {VIEWER_PREF_TYPES.map((t) => {
            const pref: ViewerPref = settings?.viewer_prefs?.[t.id] ?? {};
            const enabled = pref.enabled !== false;
            const patch = (next: ViewerPref) =>
              void updateSettings({
                viewer_prefs: {
                  ...(settings?.viewer_prefs ?? {}),
                  [t.id]: { ...pref, ...next },
                },
              });
            return (
              <div className="viewer-pref-row" key={t.id}>
                <span className="viewer-pref-name">{t.label}</span>
                <span className="viewer-pref-exts">{t.extensions.join(" ")}</span>
                <label className="viewer-pref-toggle">
                  <Toggle
                    size="sm"
                    checked={enabled}
                    onChange={(e) => patch({ enabled: e.target.checked })}
                  />
                  <span>Enabled</span>
                </label>
                {t.autocomplete && (
                  <>
                    <label className="viewer-pref-toggle">
                      <Toggle
                        size="sm"
                        checked={pref.autocomplete === true}
                        disabled={!enabled}
                        onChange={(e) => patch({ autocomplete: e.target.checked })}
                      />
                      <span>Autocomplete</span>
                    </label>
                    {/* #45 default completion-length mode; toggled live
                        in-editor with Shift+Tab while a suggestion shows. */}
                    <Dropdown
                      className="viewer-pref-mode"
                      value={pref.autocomplete_mode ?? "sentence"}
                      disabled={!enabled || pref.autocomplete !== true}
                      title="Default completion length (toggle live with Shift+Tab)"
                      onChange={(v) =>
                        patch({ autocomplete_mode: v as ViewerPref["autocomplete_mode"] })
                      }
                      options={[
                        { value: "sentence", label: "Sentence" },
                        { value: "block", label: "Block" },
                        { value: "scope", label: "Scope" },
                      ]}
                    />
                    {/* Local-model grammar/spelling check — underlines typos
                        (red), grammar (blue), style (green) in the editor. */}
                    <label className="viewer-pref-toggle">
                      <Toggle
                        size="sm"
                        checked={pref.grammar_check === true}
                        disabled={!enabled}
                        onChange={(e) => patch({ grammar_check: e.target.checked })}
                      />
                      <span>Grammar</span>
                    </label>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {settings?.debug && (
          <>
            <div className="settings-section-title">Debug</div>
            <button
              className="tab-add-btn"
              style={{ fontSize: 11, padding: "2px 8px", width: "100%", color: "var(--danger, #f85149)" }}
              onClick={() => {
                invoke("clear_project_session", { localFile }).then(() => {
                  window.location.reload();
                }).catch(console.error);
              }}
            >
              Clear session storage
            </button>
          </>
        )}
      </div>

      {showPython && project && (
        <PythonInterpreterWindow project={project} onClose={() => setShowPython(false)} />
      )}
    </div>,
    document.body,
  );
}
