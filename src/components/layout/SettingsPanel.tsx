import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSettingsStore, clampZoom, MIN_UI_ZOOM, MAX_UI_ZOOM } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { DEFAULT_MIN_SUBWINDOW_PX } from "../../stores/tabs";
import type { ArchivedProject, KeyboardChord, ProjectEntry, Theme, UnsyncedReport } from "../../types";
import { THEMES } from "../../types";
import { TERMINAL_OPTIONS, summarizeScaffoldRepair, type ProjectScaffoldRepair } from "../projects/scaffold";
import {
  SHORTCUT_DEFS,
  chordFromEvent,
  chordLabel,
  resolveChord,
  type ShortcutAction,
  type ShortcutMap,
} from "../../lib/shortcuts";
import { AgentsPanel, FileTypeSettings, GlobalAppsSettings, OllamaPanel } from "./SettingsSubPanels";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { IS_MAC, IS_WINDOWS } from "../../lib/platform";
import { useHintsStore } from "../../stores/hints";

// The workspace-layout help text. On Linux/Windows a lone modifier (Super / the
// Windows key) toggles the panels; on macOS that key is reserved for Cmd
// shortcuts, so the lone-key toggle is disabled (see useKeyboard) — there the
// panels stay reachable via the cursor-to-edge reveal. Keep the copy honest per OS.
const WORKSPACE_LAYOUT_INTRO = IS_MAC
  ? "Eldrun keeps your AI-assisted development in a single window. Push your cursor to a screen edge to reveal the panels, and press F11 for fullscreen."
  : `Eldrun keeps your AI-assisted development in a single window. Press ${
      IS_WINDOWS ? "the Windows key" : "Super"
    } while Eldrun is focused to toggle the panels, and F11 for fullscreen.`;

interface HelpItem {
  term: string;
  desc: string;
}

interface HelpSection {
  title: string;
  intro?: string;
  items: HelpItem[];
}

const HELP_SECTIONS: HelpSection[] = [
  {
    title: "Workspace layout",
    intro: WORKSPACE_LAYOUT_INTRO,
    items: [
      { term: "Root terminal (▣)", desc: "The control terminal that always lives in Eldrun's root folder, independent of any project." },
      { term: "Project pills", desc: "One pill per active project in the project switcher. Click to switch; each project keeps its own terminal and tabs. Drag pills to reorder them." },
      { term: "Center panel & tabs", desc: "The active project's terminals. Right-click the tab bar to add a Claude/Codex/Gemini agent or a plain shell, rename, or close tabs. Drag tabs to reorder." },
      { term: "Right file panel", desc: "A file-tree overlay for the active project. Open files, rename, and toggle hidden file types. The panel remembers the last folder per project." },
    ],
  },
  {
    title: "Projects",
    items: [
      { term: "Add (+)", desc: "Create a New Project (scaffolds files and a git repo in Eldrun's projects folder) or Import an existing folder without touching its contents." },
      { term: "Search inactive", desc: "The search box finds projects that aren't currently open; pick one to activate its pill and terminal." },
      { term: "Remote (SSH) projects", desc: "Projects on a remote host are sshfs-mounted locally and behave like any other project. Requires sshfs/FUSE installed." },
      { term: "Tasks", desc: "Right-click a tab to set, complete, or clear an agent task. Tasks persist in the project's project.json and can seed a new agent's prompt." },
    ],
  },
  {
    title: "AI & terminals",
    items: [
      { term: "Default agent", desc: "Choose the default terminal command (claude, codex, gemini, vibe, aider, opencode, cursor, copilot, grok, qwen, openclaw) in Settings. Missing commands fall back to a shell; closed agents respawn." },
      { term: "Ollama models", desc: "When Ollama is installed, the gear menu shows local models. Ctrl+K opens the local-model prompt dialog for the active context." },
    ],
  },
  {
    title: "Settings & extras",
    items: [
      { term: "Settings (⚙)", desc: "Theme, default agent, Git hosting profile/token, workspace management, background scripts, and debug mode." },
      { term: "Workspace integration", desc: "Optional KDE/X11 virtual-desktop isolation per project when workspace management is enabled (Linux only)." },
      { term: "Time tracking", desc: "Eldrun records active session time so you can see how long you spend per project." },
    ],
  },
];

/**
 * Group L / #62 — let the user rebind the eight navigation chords. Click a
 * row's chord button to enter capture mode; the next non-modifier keydown is
 * stored as the override (persisted to `settings.keyboard_shortcuts`). "Reset"
 * clears an override back to its built-in default.
 */
function ShortcutsSettings({ onBack }: { onBack: () => void }) {
  const { settings, updateSettings } = useSettingsStore();
  const overrides = (settings?.keyboard_shortcuts ?? {}) as ShortcutMap;
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);

  const saveMap = (next: ShortcutMap) => {
    void updateSettings({ keyboard_shortcuts: next as Record<string, KeyboardChord> });
  };

  const rebind = (action: ShortcutAction, chord: KeyboardChord) => {
    saveMap({ ...overrides, [action]: chord });
  };

  const reset = (action: ShortcutAction) => {
    const next = { ...overrides };
    delete next[action];
    saveMap(next);
  };

  // While capturing, the next real key sets the chord. Capture at the window
  // level so the keystroke is grabbed even though our hidden field, not a
  // terminal, has focus; ignore lone modifiers so the user can hold them.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setCapturing(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // lone modifier — keep waiting
      e.preventDefault();
      e.stopPropagation();
      rebind(capturing, chord);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, overrides]);

  return (
    <>
      <div className="settings-title-row">
        <h2>Keyboard Shortcuts</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">
        Click a shortcut, then press the new key combination. F11 (OS fullscreen)
        and Escape (exit fullscreen) are fixed and cannot be rebound.
      </p>
      <div className="settings-list">
        {SHORTCUT_DEFS.map((def) => {
          const active = capturing === def.action;
          const effective = resolveChord(def.action, overrides);
          const isCustom = !!overrides[def.action];
          return (
            <div className="settings-row shortcut-row" key={def.action}>
              <span className="settings-role-label">{def.label}</span>
              <button
                type="button"
                className={`shortcut-capture-btn${active ? " capturing" : ""}`}
                onClick={() => setCapturing(active ? null : def.action)}
                title="Click, then press a key combination"
              >
                {active ? "Press keys…" : chordLabel(effective)}
              </button>
              <button
                type="button"
                className="settings-back-btn"
                disabled={!isCustom}
                onClick={() => reset(def.action)}
                title="Reset to default"
              >
                Reset
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Git hosting profile + access token, broken out of the main settings panel
 * into its own sub-menu. Manages its own draft state (mirroring the saved
 * settings) and persists on blur / Enter, same as it did inline.
 */
function GitHostingSettings({ onBack }: { onBack: () => void }) {
  const { settings, updateSettings } = useSettingsStore();
  const [gitProfileUrl, setGitProfileUrl] = useState(settings?.git_profile_url ?? "");
  const [gitToken, setGitToken] = useState(settings?.git_token ?? "");

  useEffect(() => {
    setGitProfileUrl(settings?.git_profile_url ?? "");
    setGitToken(settings?.git_token ?? "");
  }, [settings?.git_profile_url, settings?.git_token]);

  const saveGitProfileUrl = () => {
    void updateSettings({ git_profile_url: gitProfileUrl.trim() });
  };

  const saveGitToken = () => {
    void updateSettings({ git_token: gitToken.trim() });
  };

  return (
    <>
      <div className="settings-title-row">
        <h2>Git Hosting</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">
        Your hosting profile and access token are used when publishing a
        project's repo to GitHub or GitLab.
      </p>
      <label className="settings-field">
        Profile URL
        <input
          value={gitProfileUrl}
          placeholder="https://github.com/me or https://gitlab.com/me"
          onChange={(e) => setGitProfileUrl(e.target.value)}
          onBlur={saveGitProfileUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveGitProfileUrl();
          }}
        />
      </label>
      <label className="settings-field">
        Access token
        <PasswordInput
          value={gitToken}
          placeholder="ghp_... / glpat-..."
          onChange={(e) => setGitToken(e.target.value)}
          onBlur={saveGitToken}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveGitToken();
          }}
        />
      </label>
    </>
  );
}

function ArchivedProjectsPanel({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<ArchivedProject[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // id of the row armed for permanent deletion + the name typed to confirm it.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Mirrors confirmId for stale-guarding the async unsynced check below.
  const confirmIdRef = useRef<string | null>(null);
  const [typed, setTyped] = useState("");
  // Unsynced-mirror check for the armed row (remote projects only): null while
  // loading/not-yet-fetched, else the offline report on local-only commits.
  const [unsynced, setUnsynced] = useState<UnsyncedReport | null>(null);
  // Typed guard for the "Clear archive" bulk action.
  const [clearing, setClearing] = useState(false);
  const [clearTyped, setClearTyped] = useState("");

  const refresh = () => {
    invoke<ArchivedProject[]>("list_archived_projects")
      .then(setItems)
      .catch((e) => {
        setError(String(e));
        setItems([]);
      });
  };

  useEffect(refresh, []);

  const resetConfirm = () => {
    setConfirmId(null);
    confirmIdRef.current = null;
    setTyped("");
    setUnsynced(null);
  };

  // Arm a row for permanent deletion; for remote projects, run the offline
  // unsynced-mirror check so the confirm step can warn about local-only commits.
  const armDelete = (a: ArchivedProject) => {
    setConfirmId(a.id);
    confirmIdRef.current = a.id;
    setTyped("");
    setUnsynced(null);
    if (a.remote) {
      invoke<UnsyncedReport>("archived_mirror_unsynced", { projectId: a.id })
        // Drop a late result if the user moved to a different row; ignore failures
        // (the type-to-confirm guard still stands without the hint).
        .then((r) => confirmIdRef.current === a.id && setUnsynced(r))
        .catch(() => {});
    }
  };

  const restore = async (a: ArchivedProject) => {
    setBusyId(a.id);
    setError("");
    try {
      const restored = await invoke<ProjectEntry>("restore_archived_project", { projectId: a.id });
      // Splice the restored (inactive) entry back into the live list without a
      // full reload, so box grouping / active project are left undisturbed.
      useProjectsStore.setState((s) => ({
        projects: [...s.projects.filter((p) => p.id !== restored.id), restored],
      }));
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const deleteForever = async (a: ArchivedProject) => {
    setBusyId(a.id);
    setError("");
    try {
      await invoke("delete_archived_project", { projectId: a.id });
      resetConfirm();
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const clearAll = async () => {
    setBusyId("__all__");
    setError("");
    try {
      await invoke("clear_archive");
      setClearing(false);
      setClearTyped("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="settings-title-row">
        <h2>Archived Projects</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">
        Deleted projects are kept here so you can restore them. Permanent deletion
        removes the archived copy and its time-tracking history. A remote (SSH)
        project's files on its host are never touched.
      </p>
      {error && <div className="project-dialog-error">{error}</div>}
      {items === null ? (
        <p className="settings-help">Loading…</p>
      ) : items.length === 0 ? (
        <p className="settings-help">No archived projects.</p>
      ) : (
        <ul className="archived-projects-list">
          {items.map((a) => {
            const armed = confirmId === a.id;
            const rowBusy = busyId === a.id;
            return (
              <li key={a.id} className="archived-project-row">
                <div className="archived-project-info">
                  <span className="archived-project-name">{a.name}</span>
                  {a.remote && <span className="archived-project-tag">remote</span>}
                  <span className="archived-project-date">{a.archived_at.slice(0, 10)}</span>
                </div>
                {armed ? (
                  <div className="archived-project-confirm-group">
                    {unsynced && unsynced.total > 0 && (
                      <p className="archived-project-warn">
                        ⚠ {unsynced.verified ? (
                          <>
                            {unsynced.total} local commit{unsynced.total === 1 ? "" : "s"} on{" "}
                            {unsynced.branches.map((b) => b.name).join(", ")} {unsynced.total === 1 ? "was" : "were"}{" "}
                            never synced to the host and will be lost. The host's own files are unaffected.
                          </>
                        ) : (
                          <>
                            This mirror holds {unsynced.total} commit{unsynced.total === 1 ? "" : "s"} that could not
                            be verified against the host; deleting discards the local copy. The host's own files are
                            unaffected.
                          </>
                        )}
                      </p>
                    )}
                  <div className="archived-project-confirm">
                    <input
                      type="text"
                      autoFocus
                      placeholder={`Type “${a.name}” to delete`}
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") resetConfirm();
                      }}
                    />
                    <button type="button" onClick={resetConfirm} disabled={rowBusy}>Cancel</button>
                    <button
                      type="button"
                      className="danger"
                      disabled={rowBusy || typed.trim() !== a.name.trim()}
                      onClick={() => void deleteForever(a)}
                    >
                      {rowBusy ? "Deleting…" : "Delete forever"}
                    </button>
                  </div>
                  </div>
                ) : (
                  <div className="archived-project-actions">
                    <button type="button" disabled={rowBusy} onClick={() => void restore(a)}>
                      {rowBusy ? "Restoring…" : "Restore"}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={rowBusy}
                      onClick={() => armDelete(a)}
                    >
                      Delete permanently…
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items && items.length > 0 && (
        clearing ? (
          <div className="archived-project-confirm">
            <input
              type="text"
              autoFocus
              placeholder="Type “delete” to clear all"
              value={clearTyped}
              onChange={(e) => setClearTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setClearing(false); setClearTyped(""); }
              }}
            />
            <button type="button" onClick={() => { setClearing(false); setClearTyped(""); }}>Cancel</button>
            <button
              type="button"
              className="danger"
              disabled={busyId === "__all__" || clearTyped.trim().toLowerCase() !== "delete"}
              onClick={() => void clearAll()}
            >
              {busyId === "__all__" ? "Clearing…" : "Clear archive"}
            </button>
          </div>
        ) : (
          <div className="settings-link-row">
            <button type="button" className="danger" onClick={() => setClearing(true)}>
              Clear archive…
            </button>
          </div>
        )
      )}
    </>
  );
}

function ScaffoldRepairPanel({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<ProjectScaffoldRepair[] | null>(null);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const repaired = await invoke<ProjectScaffoldRepair[]>("repair_all_project_scaffolds");
      setResults(repaired);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-title-row">
        <h2>Repair Project Scaffold</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">
        Fills in any scaffold file (AGENTS.md, CLAUDE.md, .claude/settings.json, …)
        or default .gitignore pattern that a project is missing — e.g. because it
        was created before that file/pattern was added to the default scaffold.
        Existing files are never overwritten; a pre-existing .gitignore only has
        missing default lines appended. Runs across every managed project (local
        directory or, for remote projects, their local mirror).
      </p>
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="settings-link-row">
        <button type="button" disabled={busy} onClick={() => void run()}>
          {busy ? "Repairing…" : "Repair all projects now"}
        </button>
      </div>
      {results !== null && (
        results.length === 0 ? (
          <p className="settings-help">Every project's scaffold is already up to date.</p>
        ) : (
          <ul className="archived-projects-list">
            {results.map((r) => (
              <li key={r.projectId} className="archived-project-row">
                <div className="archived-project-info">
                  <span className="archived-project-name">{r.name}</span>
                  <span className="archived-project-date">{summarizeScaffoldRepair(r.report)}</span>
                </div>
              </li>
            ))}
          </ul>
        )
      )}
    </>
  );
}

function HelpPanel({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="settings-title-row">
        <h2>Eldrun Help</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>

      <p className="settings-help">
        A quick guide to what each part of Eldrun does. Hover the toolbar buttons for shortcuts too.
      </p>

      {HELP_SECTIONS.map((section) => (
        <div key={section.title} className="help-section">
          <div className="settings-section-title">{section.title}</div>
          {section.intro && <p className="settings-help">{section.intro}</p>}
          <dl className="help-list">
            {section.items.map((item) => (
              <div key={item.term} className="help-row">
                <dt>{item.term}</dt>
                <dd>{item.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  );
}

export type SettingsPanelKind = "main" | "global" | "filetypes" | "ollama" | "agents" | "shortcuts" | "git" | "archive" | "scaffoldRepair" | "help";

export function SettingsDialog({
  onClose,
  initialPanel = "main",
}: {
  onClose: () => void;
  initialPanel?: SettingsPanelKind;
}) {
  const { settings, setTheme, updateSettings } = useSettingsStore();
  const [panel, setPanel] = useState<SettingsPanelKind>(initialPanel);

  const terminal = settings?.terminal_command ?? "claude";
  const currentTheme = (settings?.color_scheme ?? "fancy_dark") as Theme;

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
              <label>Terminal</label>
              <Dropdown
                value={terminal}
                onChange={(v) => void updateSettings({ terminal_command: v })}
                options={TERMINAL_OPTIONS.map((cmd) => ({ value: cmd, label: cmd }))}
              />
            </div>

            <div className="settings-row">
              <label>Theme</label>
              <Dropdown
                value={currentTheme}
                onChange={(v) => void setTheme(v as Theme)}
                options={THEMES.map((theme) => ({ value: theme.value, label: theme.label }))}
              />
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
              <span>Run scripts in background</span>
              <input
                type="checkbox"
                checked={settings?.run_scripts_in_background ?? true}
                onChange={(e) => void updateSettings({ run_scripts_in_background: e.target.checked })}
              />
            </label>

            <label className="settings-switch-row">
              <span>Claude remote control</span>
              <input
                type="checkbox"
                checked={settings?.agent_remote_control ?? true}
                onChange={(e) => void updateSettings({ agent_remote_control: e.target.checked })}
              />
            </label>
            <p className="settings-help">
              Spawns Claude agent tabs with <code>--remote-control</code> so you can
              monitor and steer them from the Claude app or web. Requires a Claude
              subscription login (not an API key); only Claude supports it.
            </p>

            <label className="settings-switch-row">
              <span>Headless remote connections</span>
              <input
                type="checkbox"
                checked={settings?.connections_headless ?? true}
                onChange={(e) => void updateSettings({ connections_headless: e.target.checked })}
              />
            </label>
            <p className="settings-help">
              When on (default), Eldrun makes SSH/OpenVPN connections in the
              background, handling the password transiently. Turn it off to instead
              open each connection as an interactive terminal in the Eldrun root —
              you type the password directly into that terminal and Eldrun never
              handles it.
            </p>

            <label className="settings-switch-row">
              <span>Debug mode</span>
              <input
                type="checkbox"
                checked={settings?.debug ?? false}
                onChange={(e) => void updateSettings({ debug: e.target.checked })}
              />
            </label>

            <div className="settings-section-title">Resource monitor</div>
            <label className="settings-switch-row">
              <span>Show CPU usage</span>
              <input
                type="checkbox"
                checked={settings?.show_cpu_usage ?? true}
                onChange={(e) => void updateSettings({ show_cpu_usage: e.target.checked })}
              />
            </label>
            <label className="settings-switch-row">
              <span>Show RAM usage</span>
              <input
                type="checkbox"
                checked={settings?.show_ram_usage ?? true}
                onChange={(e) => void updateSettings({ show_ram_usage: e.target.checked })}
              />
            </label>
            <label className="settings-switch-row">
              <span>Show GPU usage</span>
              <input
                type="checkbox"
                checked={settings?.show_gpu_usage ?? true}
                onChange={(e) => void updateSettings({ show_gpu_usage: e.target.checked })}
              />
            </label>
            <p className="settings-help">
              CPU and RAM cover Eldrun's own process tree; GPU shows VRAM in use by
              local models loaded in Ollama. The pill appears in the header next to
              the timer.
            </p>

            <div className="settings-section-title">Hints & onboarding</div>
            <label className="settings-switch-row">
              <span>Show contextual hints</span>
              <input
                type="checkbox"
                checked={settings?.hints_enabled ?? true}
                onChange={(e) => void updateSettings({ hints_enabled: e.target.checked })}
              />
            </label>
            <div className="settings-link-row">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:open-how-to-start"));
                }}
              >
                How to start...
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:start-tour"));
                }}
              >
                Take a tour
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:open-lessons"));
                }}
              >
                Lessons
              </button>
              <button type="button" onClick={() => useHintsStore.getState().reset()}>
                Reset hints
              </button>
            </div>

            <div className="settings-section-title">Layout</div>
            <p className="settings-help">
              Global zoom scales the entire Eldrun interface — handy on 4K /
              high-DPI monitors. 100% is the default.
            </p>
            <div className="settings-row">
              <label>Global zoom</label>
              <Dropdown
                value={String(clampZoom(settings?.ui_zoom))}
                onChange={(v) => {
                  const z = parseFloat(v);
                  void updateSettings({
                    ui_zoom: z === 1 ? undefined : clampZoom(z),
                  });
                }}
                options={[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
                  .filter((z) => z >= MIN_UI_ZOOM && z <= MAX_UI_ZOOM)
                  .map((z) => ({
                    value: String(z),
                    label: `${Math.round(z * 100)}%${z === 1 ? " (default)" : ""}`,
                  }))}
              />
            </div>
            <p className="settings-help">
              Smallest a subwindow may be made by dragging a split divider.
              Defaults to {DEFAULT_MIN_SUBWINDOW_PX}px when left blank.
            </p>
            <div className="settings-row">
              <label htmlFor="min-subwindow-width">Min subwindow width (px)</label>
              <input
                id="min-subwindow-width"
                type="number"
                min={20}
                step={10}
                placeholder={String(DEFAULT_MIN_SUBWINDOW_PX)}
                value={settings?.min_subwindow_width ?? ""}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  void updateSettings({
                    min_subwindow_width: Number.isFinite(v) && v >= 20 ? v : undefined,
                  });
                }}
              />
            </div>
            <div className="settings-row">
              <label htmlFor="min-subwindow-height">Min subwindow height (px)</label>
              <input
                id="min-subwindow-height"
                type="number"
                min={20}
                step={10}
                placeholder={String(DEFAULT_MIN_SUBWINDOW_PX)}
                value={settings?.min_subwindow_height ?? ""}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  void updateSettings({
                    min_subwindow_height: Number.isFinite(v) && v >= 20 ? v : undefined,
                  });
                }}
              />
            </div>

            <div className="settings-section-title">Downloads</div>
            <p className="settings-help">
              Folders scanned by the right-panel Downloads section (the 📥 toggle),
              for quickly copying freshly downloaded files into a project. Read-only
              — Eldrun never changes any browser's download path. Defaults to your
              system Downloads folder when empty.
            </p>
            <div className="settings-list">
              {(settings?.download_sources ?? []).length === 0 ? (
                <div className="settings-empty">
                  No folders added — the system Downloads folder is used.
                </div>
              ) : (
                (settings?.download_sources ?? []).map((dir) => (
                  <div key={dir} className="settings-row" style={{ gap: 6 }}>
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                      }}
                      title={dir}
                    >
                      {dir}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void updateSettings({
                          download_sources: (settings?.download_sources ?? []).filter(
                            (d) => d !== dir,
                          ),
                        })
                      }
                      title="Remove this folder"
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="settings-link-row">
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const picked = await openDialog({
                      directory: true,
                      multiple: false,
                    }).catch(() => null);
                    if (!picked || Array.isArray(picked)) return;
                    const current = settings?.download_sources ?? [];
                    if (current.includes(picked)) return;
                    void updateSettings({ download_sources: [...current, picked] });
                  })();
                }}
              >
                Add download folder...
              </button>
            </div>

            <div className="settings-link-row">
              <button type="button" onClick={() => setPanel("git")}>Git Hosting...</button>
              <button type="button" onClick={() => setPanel("global")}>Global Apps...</button>
              <button type="button" onClick={() => setPanel("filetypes")}>File Type Apps...</button>
              <button type="button" onClick={() => setPanel("agents")}>Manage Agents...</button>
              <button type="button" onClick={() => setPanel("shortcuts")}>Keyboard Shortcuts...</button>
              <button type="button" onClick={() => setPanel("archive")}>Archived Projects...</button>
              <button type="button" onClick={() => setPanel("scaffoldRepair")}>Repair Project Scaffold...</button>
              <button type="button" onClick={() => setPanel("help")}>Feature Guide...</button>
            </div>
          </>
        )}
        {panel === "global" && <GlobalAppsSettings onBack={() => setPanel("main")} />}
        {panel === "filetypes" && <FileTypeSettings onBack={() => setPanel("main")} />}
        {panel === "ollama" && <OllamaPanel onBack={() => setPanel("main")} />}
        {panel === "agents" && <AgentsPanel onBack={() => setPanel("main")} />}
        {panel === "shortcuts" && <ShortcutsSettings onBack={() => setPanel("main")} />}
        {panel === "git" && <GitHostingSettings onBack={() => setPanel("main")} />}
        {panel === "archive" && <ArchivedProjectsPanel onBack={() => setPanel("main")} />}
        {panel === "scaffoldRepair" && <ScaffoldRepairPanel onBack={() => setPanel("main")} />}
        {panel === "help" && <HelpPanel onBack={() => setPanel("main")} />}
      </div>
    </div>
  );
}
