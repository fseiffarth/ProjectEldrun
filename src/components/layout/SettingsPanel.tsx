import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { DEFAULT_MIN_SUBWINDOW_PX } from "../../stores/tabs";
import type { KeyboardChord, Theme } from "../../types";
import { THEMES } from "../../types";
import { TERMINAL_OPTIONS } from "../projects/scaffold";
import {
  SHORTCUT_DEFS,
  chordFromEvent,
  chordLabel,
  resolveChord,
  type ShortcutAction,
  type ShortcutMap,
} from "../../lib/shortcuts";
import { AgentsPanel, FileTypeSettings, GlobalAppsSettings, OllamaPanel } from "./SettingsSubPanels";
import { IS_WINDOWS } from "../../lib/paths";
import { useHintsStore } from "../../stores/hints";

// The panel-toggle key reads as the Windows key on Windows (the webview reports
// it as "Meta"), and "Super" on Linux/KDE — keep the help text honest per OS.
const PANEL_TOGGLE_KEY = IS_WINDOWS ? "the Windows key" : "Super";

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
    intro:
      `Eldrun keeps your AI-assisted development in a single window. Press ${PANEL_TOGGLE_KEY} while Eldrun is focused to toggle the panels, and F11 for fullscreen.`,
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

export type SettingsPanelKind = "main" | "global" | "filetypes" | "ollama" | "agents" | "shortcuts" | "help";

export function SettingsDialog({
  onClose,
  initialPanel = "main",
}: {
  onClose: () => void;
  initialPanel?: SettingsPanelKind;
}) {
  const { settings, setTheme, updateSettings } = useSettingsStore();
  const [panel, setPanel] = useState<SettingsPanelKind>(initialPanel);
  const [gitProfileUrl, setGitProfileUrl] = useState(settings?.git_profile_url ?? "");
  const [gitToken, setGitToken] = useState(settings?.git_token ?? "");

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
              <button type="button" onClick={() => useHintsStore.getState().reset()}>
                Reset hints
              </button>
            </div>

            <div className="settings-section-title">Layout</div>
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
              <button type="button" onClick={() => setPanel("agents")}>Manage Agents...</button>
              <button type="button" onClick={() => setPanel("shortcuts")}>Keyboard Shortcuts...</button>
              <button type="button" onClick={() => setPanel("help")}>Feature Guide...</button>
            </div>
          </>
        )}
        {panel === "global" && <GlobalAppsSettings onBack={() => setPanel("main")} />}
        {panel === "filetypes" && <FileTypeSettings onBack={() => setPanel("main")} />}
        {panel === "ollama" && <OllamaPanel onBack={() => setPanel("main")} />}
        {panel === "agents" && <AgentsPanel onBack={() => setPanel("main")} />}
        {panel === "shortcuts" && <ShortcutsSettings onBack={() => setPanel("main")} />}
        {panel === "help" && <HelpPanel onBack={() => setPanel("main")} />}
      </div>
    </div>
  );
}
