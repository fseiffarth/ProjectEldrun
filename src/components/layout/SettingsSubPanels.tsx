import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { GLOBAL_APP_ROLES } from "./GlobalAppBar";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { IS_WINDOWS, PLATFORM } from "../../lib/platform";
import { runInstallInTab, type InstallShellKind } from "../../lib/installCommand";
import type { GlobalAppEntry } from "../../types";

interface OllamaModelInfo {
  name: string;
  size: number;
  parameter_size: string | null;
  quantization: string | null;
  family: string | null;
  running: boolean;
  size_vram: number;
}

/** One row from the live Ollama registry search (mirrors backend RegistryModel). */
interface RegistryModel {
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

/** Capability filters, mapped to Ollama's `c=` search param. */
const REGISTRY_TYPES = ["tools", "vision", "thinking", "embedding", "audio"] as const;

/** Parameter-size buckets (billions) for client-side filtering of results. */
const SIZE_BUCKETS: { key: string; label: string; lo: number; hi: number }[] = [
  { key: "xs", label: "<1B", lo: 0, hi: 1 },
  { key: "sm", label: "1–4B", lo: 1, hi: 4 },
  { key: "md", label: "4–9B", lo: 4, hi: 9 },
  { key: "lg", label: "9–32B", lo: 9, hi: 32 },
  { key: "xl", label: "32B+", lo: 32, hi: Infinity },
];

/** Largest parsable parameter size (billions) among a model's tags, for sorting. */
function modelMaxParamsB(sizes: string[]): number {
  const ps = sizes.map(tagParamsB).filter((n): n is number => n !== null);
  return ps.length ? Math.max(...ps) : 0;
}

/** Parse a human pull count ("65.8K", "30M", "1,203") into a number for sorting. */
function parsePulls(s: string): number {
  const m = /^([\d.,]+)\s*([kmbg]?)/i.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(n)) return 0;
  const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, g: 1e9 };
  return n * (mult[m[2].toLowerCase()] ?? 1);
}

/** Sort options for the registry browser. "popular"/"newest" map to Ollama's
 *  server-side `o=` param; the rest reorder the loaded rows client-side. */
const SORT_OPTIONS = [
  { key: "popular", label: "Most popular" },
  { key: "newest", label: "Newest" },
  { key: "pulls", label: "Most pulls" },
  { key: "name", label: "Name (A–Z)" },
  { key: "params-asc", label: "Size: small → large" },
  { key: "params-desc", label: "Size: large → small" },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]["key"];

/** True if any of a model's size tags falls into any selected bucket. */
function matchesSizeBuckets(sizes: string[], selected: Set<string>): boolean {
  if (selected.size === 0) return true;
  const buckets = SIZE_BUCKETS.filter((b) => selected.has(b.key));
  return sizes.some((s) => {
    const p = tagParamsB(s);
    return p !== null && buckets.some((b) => p >= b.lo && p < b.hi);
  });
}

export function GlobalAppsSettings({ onBack }: { onBack: () => void }) {
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
              <Toggle
                size="sm"
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

export function FileTypeSettings({ onBack }: { onBack: () => void }) {
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

/**
 * Parameter count (in billions) parsed from a catalog tag like "1b", "0.5b",
 * "135m", "405b". Non-parameter tags (quantization labels such as "q4_K_M",
 * "latest") yield null so they don't affect size sorting.
 */
function tagParamsB(tag: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([bm])$/i.exec(tag.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === "m" ? n / 1000 : n;
}

/** Official, distro-agnostic install command — kept in sync with the backend. */
/** One agent CLI + its install status (mirrors backend `AgentInfo`). */
interface AgentInfo {
  id: string;
  label: string;
  bin: string;
  /** Install command for the host OS; empty when no one-line installer exists. */
  install_cmd: string;
  /** Shell the command runs in: "bash", "PowerShell", or "PowerShell or Command Prompt". */
  shell: string;
  /** Machine-readable shell selection; display labels are not executable policy. */
  shell_kind: InstallShellKind;
  docs: string;
  installed: boolean;
}

/**
 * Per-OS command that installs Node.js (and with it `npm`). Most agent CLIs
 * install via `npm install -g …`, so when `npm` is missing the Manage Agents
 * panel offers this first. nvm installs Node without administrator rights and
 * works identically on Linux and macOS; Windows uses winget (present on Windows
 * 10/11) and runs in either PowerShell or Command Prompt.
 */
const NODE_INSTALL: Record<
  "windows" | "macos" | "linux",
  { command: string; shell: string; shellKind: InstallShellKind }
> = {
  linux: {
    command:
      'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts',
    shell: "bash",
    shellKind: "bash",
  },
  macos: {
    command:
      'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts',
    shell: "bash",
    shellKind: "bash",
  },
  windows: {
    command: "winget install OpenJS.NodeJS.LTS",
    shell: "PowerShell or Command Prompt",
    shellKind: "default",
  },
};
const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";

/**
 * "Install Node/npm first" helper for the Manage Agents panel. Most agent CLIs
 * install through `npm`, so when `npm` isn't on the host's PATH this points the
 * user at the one-click, no-admin Node install for their OS (and stays hidden
 * once npm is detected). Follows Eldrun's install-via-terminal-tab policy.
 */
function NodeRuntimeNotice() {
  // null = still probing; true/false = npm present or not.
  const [hasNpm, setHasNpm] = useState<boolean | null>(null);
  const recheck = () =>
    invoke<boolean>("npm_is_installed").then(setHasNpm).catch(() => setHasNpm(true));
  useEffect(() => void recheck(), []);

  // While probing, or once npm is present, there is nothing to nudge about.
  if (hasNpm !== false) return null;

  const { command, shell, shellKind } = NODE_INSTALL[PLATFORM];
  return (
    <div className="ollama-vibe-section agent-list-entry">
      <div className="settings-section-title">
        Node.js / npm{" "}
        <span className="ollama-status-text">not detected</span>
      </div>
      <p className="settings-help">
        Most agent CLIs install with <code>npm</code>, which ships with Node.js.
        Install it once (no administrator rights needed) in a{" "}
        <strong>{shell}</strong> terminal tab, then install your agents below:
      </p>
      <div className="ollama-install-cmd-row">
        <code className="ollama-install-cmd">{command}</code>
        <button
          type="button"
          className="ollama-action-btn primary"
          onClick={() => runInstallInTab("Install Node.js (npm)", command, shellKind)}
        >
          Run in terminal
        </button>
        <button type="button" className="ollama-action-btn" onClick={() => void recheck()}>
          Re-check
        </button>
      </div>
      <p className="settings-help">
        Prefer a manual install? See{" "}
        <a href={NODE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
          the Node.js downloads
        </a>
        .
      </p>
    </div>
  );
}

/**
 * "Manage Agents" panel: detect and one-click-install the AI coding-agent CLIs
 * Eldrun can launch as agent tabs (Claude, Codex, Gemini, Mistral/vibe, Aider,
 * OpenCode, Cursor, Copilot, Grok, Qwen, OpenClaw). The
 * registry lives in the backend (`commands::agents`); this just renders each
 * entry with an install button, a live install log, and a manual fallback.
 */
export function AgentsPanel({ onBack }: { onBack: () => void }) {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  // The agent id whose installer is currently running (only one at a time).
  const [installing, setInstalling] = useState<string | null>(null);
  // Per-agent live install log, keyed by agent id.
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = () => {
    invoke<AgentInfo[]>("list_agents").then(setAgents).catch(() => setAgents([]));
  };
  useEffect(refresh, []);

  // Keep the live install log pinned to its latest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, installing]);

  const installAgent = async (id: string) => {
    setInstalling(id);
    setErrors(({ [id]: _drop, ...rest }) => rest);
    setLogs((l) => ({ ...l, [id]: "" }));
    // Stream the installer's output, filtering to this agent's events.
    const unlisten = await listen<{ id: string; line: string }>(
      "agent-install-progress",
      (e) => {
        if (e.payload.id !== id) return;
        setLogs((l) => ({
          ...l,
          [id]: l[id] ? `${l[id]}\n${e.payload.line}` : e.payload.line,
        }));
      },
    );
    try {
      await invoke<string>("install_agent", { id });
      refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err) }));
    } finally {
      unlisten();
      setInstalling(null);
    }
  };

  const recheck = (id: string) => {
    void invoke<boolean>("agent_is_installed", { id })
      .then((ok) => {
        setAgents((prev) =>
          prev?.map((a) => (a.id === id ? { ...a, installed: ok } : a)) ?? prev,
        );
        if (!ok) {
          setErrors((e) => ({
            ...e,
            [id]: "Still not detected — try a fresh terminal so the install dir is on PATH.",
          }));
        }
      })
      .catch(() => {});
  };

  return (
    <>
      <div className="settings-title-row">
        <h2>Manage Agents</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>
      <p className="settings-help">
        AI coding agents Eldrun can launch as agent tabs. Install one with a
        single click (no administrator rights needed), then add it from a tab
        bar's <strong>+</strong> menu. Many installers need <code>npm</code> on
        your <code>PATH</code> — if it's missing, install Node.js first below.
      </p>
      <NodeRuntimeNotice />
      {agents === null ? (
        <p className="settings-help">Checking installed agents…</p>
      ) : (
        <div className="settings-list">
          {[...agents]
            .sort((a, b) => Number(b.installed) - Number(a.installed))
            .map((a) => (
            <div key={a.id} className="ollama-vibe-section agent-list-entry">
              <div className="settings-section-title">
                {a.label}{" "}
                {a.installed ? (
                  <span className="ollama-status-text">
                    <span className="ollama-status-dot running" /> installed
                  </span>
                ) : (
                  <span className="ollama-status-text">not installed</span>
                )}
              </div>
              {!a.installed && (
                <>
                  {/* Auto-install runs the Unix installer via `sh`, so it only
                      works on Linux/macOS. On Windows we show the manual
                      PowerShell command instead. */}
                  {!IS_WINDOWS && (
                    <>
                      <div className="ollama-install-cmd-row">
                        <button
                          type="button"
                          className="ollama-action-btn primary"
                          disabled={installing !== null}
                          onClick={() => void installAgent(a.id)}
                        >
                          {installing === a.id ? "Installing…" : `Install ${a.label}`}
                        </button>
                        {installing === a.id && (
                          <span className="ollama-status-text">Running installer…</span>
                        )}
                      </div>
                      {logs[a.id] && (
                        <pre
                          className="ollama-install-log"
                          ref={installing === a.id ? logRef : undefined}
                        >
                          {logs[a.id]}
                        </pre>
                      )}
                      {errors[a.id] && (
                        <div className="project-dialog-error">{errors[a.id]}</div>
                      )}
                    </>
                  )}
                  {a.install_cmd ? (
                    <>
                      <p className="settings-help">
                        {IS_WINDOWS ? "Install it in a " : "Or install it in a "}
                        <strong>{a.shell}</strong> terminal tab:
                      </p>
                      <div className="ollama-install-cmd-row">
                        <code className="ollama-install-cmd">{a.install_cmd}</code>
                        <button
                          type="button"
                          className="ollama-action-btn primary"
                          onClick={() =>
                            runInstallInTab(`Install ${a.label}`, a.install_cmd, a.shell_kind)
                          }
                        >
                          Run in terminal
                        </button>
                        <button
                          type="button"
                          className="ollama-action-btn"
                          disabled={installing !== null}
                          onClick={() => recheck(a.id)}
                        >
                          Re-check
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="settings-help">
                      No one-line Windows installer yet — see{" "}
                      <a href={a.docs} target="_blank" rel="noreferrer">
                        the install docs
                      </a>
                      , then click{" "}
                      <button
                        type="button"
                        className="ollama-action-btn"
                        disabled={installing !== null}
                        onClick={() => recheck(a.id)}
                      >
                        Re-check
                      </button>
                      .
                    </p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// Fallback install command shown before the OS-specific strategy loads from the
// backend. The real command comes from `ollama_install_strategy` (winget on
// Windows, the install script on Linux/macOS).
const OLLAMA_INSTALL_CMD_FALLBACK = "curl -fsSL https://ollama.com/install.sh | sh";
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
// Fallback Vibe install command shown before the OS-specific strategy loads from
// the backend. The real command comes from `vibe_install_strategy` (a uv-based
// PowerShell command on Windows, the install script on Linux/macOS).
const VIBE_INSTALL_CMD = "curl -LsSf https://mistral.ai/vibe/install.sh | bash";

/** OS-dependent Vibe install guidance (mirrors backend `VibeInstallStrategy`). */
interface VibeInstallStrategy {
  os: string; // "windows" | "macos" | "linux" | "unknown"
  command: string;
  auto: boolean;
  docs: string;
}

/** OS-dependent Ollama install guidance (mirrors backend `OllamaInstallStrategy`). */
interface OllamaInstallStrategy {
  os: string; // "windows" | "macos" | "linux" | "unknown"
  command: string;
  auto: boolean;
  download_url: string;
}

export function OllamaPanel({ onBack }: { onBack: () => void }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);
  // OS-dependent install strategy (command + whether one-click install works).
  const [strategy, setStrategy] = useState<OllamaInstallStrategy | null>(null);
  const installLogRef = useRef<HTMLPreElement>(null);
  // Vibe (local-model agent runtime) — required to launch Local Model tabs.
  const [vibeInstalled, setVibeInstalled] = useState<boolean | null>(null);
  // OS-dependent Vibe install command (uv/PowerShell on Windows, script elsewhere).
  const [vibeStrategy, setVibeStrategy] = useState<VibeInstallStrategy | null>(null);
  const [vibeInstalling, setVibeInstalling] = useState(false);
  const [vibeInstallLog, setVibeInstallLog] = useState<string | null>(null);
  const vibeInstallLogRef = useRef<HTMLPreElement>(null);
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [serverRunning, setServerRunning] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // Models currently being loaded into memory, keyed by name. Driven by the
  // global `ollama-load-progress` events so a load started from the brain menu
  // shows here too; Ollama streams no load percentage, so it's indeterminate.
  const [loadingMem, setLoadingMem] = useState<Record<string, boolean>>({});
  // Per-tag download size from the registry, fetched lazily on hover and cached.
  const [tagSizes, setTagSizes] = useState<Record<string, number | "loading" | "error">>({});
  // Free-text "pull any model" field — accepts any registry ref the catalog omits.
  const [pullName, setPullName] = useState("");
  // Live download progress per model ref, keyed by the exact ref passed to
  // `pull_ollama_model`. `pct` is null during non-download phases (manifest,
  // verify, write) where Ollama reports no byte totals.
  const [pullProgress, setPullProgress] = useState<
    Record<string, { pct: number | null; status: string }>
  >({});
  // Model refs whose download was interrupted by a previous Eldrun exit/crash,
  // persisted by the backend. Each can be resumed ("Continue") since Ollama
  // picks up a partially-fetched model where it left off.
  const [interrupted, setInterrupted] = useState<string[]>([]);
  // Model refs the user paused mid-download this session. A paused pull keeps its
  // partial blobs (so it can be resumed) and offers Resume / Delete.
  const [paused, setPaused] = useState<Set<string>>(new Set());
  // Orphaned partial layers in Ollama's blob cache with no recoverable model
  // name — surfaced only so the user can delete them to reclaim space.
  const [orphans, setOrphans] = useState<{ digest: string; size: number; path: string }[]>([]);
  // Live registry browser (ollama.com/search): query, filters, lazy-loaded pages.
  const [regQuery, setRegQuery] = useState("");
  const [regQueryLive, setRegQueryLive] = useState(""); // debounced
  const [regTypes, setRegTypes] = useState<Set<string>>(new Set()); // empty = any
  const [sortBy, setSortBy] = useState<SortKey>("popular");
  const [regSizes, setRegSizes] = useState<Set<string>>(new Set());
  const [regModels, setRegModels] = useState<RegistryModel[]>([]);
  const [regPage, setRegPage] = useState(0);
  const [regLoading, setRegLoading] = useState(false);
  const [regDone, setRegDone] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});

  // Fetch a tag's registry size once, when the user first hovers it.
  const fetchTagSize = (fullName: string) => {
    if (fullName in tagSizes) return;
    setTagSizes((p) => ({ ...p, [fullName]: "loading" }));
    invoke<number>("ollama_registry_size", { model: fullName })
      .then((bytes) => setTagSizes((p) => ({ ...p, [fullName]: bytes })))
      .catch(() => setTagSizes((p) => ({ ...p, [fullName]: "error" })));
  };

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

  // Load installed/running models once Ollama itself is present. When it is
  // missing we show the install flow instead. The registry browser below loads
  // independently (it queries ollama.com, not the local server).
  const loadAfterInstall = () => {
    void refresh();
  };

  useEffect(() => {
    void (async () => {
      const ok = await invoke<boolean>("ollama_is_installed").catch(() => false);
      setInstalled(ok);
      if (ok) loadAfterInstall();
      else setLoading(false);
    })();
    // OS-dependent install command/wording for the install panel below.
    invoke<OllamaInstallStrategy>("ollama_install_strategy").then(setStrategy).catch(() => {});
    // Vibe is independent of Ollama; check it regardless so its status shows in
    // both the install-Ollama and main panels.
    invoke<boolean>("vibe_is_installed").then(setVibeInstalled).catch(() => setVibeInstalled(false));
    invoke<VibeInstallStrategy>("vibe_install_strategy").then(setVibeStrategy).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track live download progress emitted by `pull_ollama_model`.
  useEffect(() => {
    const un = listen<{ model: string; status: string; completed: number; total: number }>(
      "ollama-pull-progress",
      (e) => {
        const { model, status, completed, total } = e.payload;
        // A paused pull stops streaming here — move it out of the live-progress
        // map and into the paused set so its row offers Resume / Delete.
        if (status === "paused") {
          setPullProgress((p) => {
            const { [model]: _drop, ...rest } = p;
            return rest;
          });
          setPaused((p) => new Set(p).add(model));
          return;
        }
        setPullProgress((p) => ({
          ...p,
          [model]: {
            pct: total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null,
            status,
          },
        }));
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Track in-flight loads-into-memory (from any surface). On success, re-read the
  // model list so the row flips to its resident state.
  useEffect(() => {
    const un = listen<{ model: string; status: string }>("ollama-load-progress", (e) => {
      const { model, status } = e.payload;
      setLoadingMem((p) => {
        if (status === "loading") return { ...p, [model]: true };
        const { [model]: _drop, ...rest } = p;
        return rest;
      });
      if (status === "success") void refresh();
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop a model's progress once its pull settles (success or error).
  const clearPullProgress = (model: string) =>
    setPullProgress((p) => {
      if (!(model in p)) return p;
      const { [model]: _drop, ...rest } = p;
      return rest;
    });

  // Live button label for an in-flight pull: a percentage when Ollama is
  // streaming byte totals, otherwise the caller's fallback (e.g. "Pulling…").
  const pullText = (model: string, busyFallback: string) => {
    const pct = pullProgress[model]?.pct;
    return pct != null ? `${pct}%` : busyFallback;
  };

  // Load the persisted interrupted-pull list + orphaned partial blobs once
  // Ollama is present.
  useEffect(() => {
    if (installed !== true) return;
    invoke<string[]>("list_pending_ollama_pulls").then(setInterrupted).catch(() => {});
    invoke<{ digest: string; size: number; path: string }[]>("list_orphan_partial_blobs")
      .then(setOrphans)
      .catch(() => {});
  }, [installed]);

  // Delete an orphaned partial layer to reclaim its disk space.
  const deleteOrphan = (path: string) => {
    setOrphans((p) => p.filter((o) => o.path !== path));
    void invoke("delete_partial_blob", { path }).catch((e) => setError(String(e)));
  };

  // Reconcile interrupted entries against what's actually installed: any model
  // that completed before the crash (or has since finished) is dropped and its
  // stale record cleared on the backend.
  useEffect(() => {
    if (interrupted.length === 0) return;
    const names = new Set(models.map((m) => m.name));
    const done = interrupted.filter(
      (ref) => names.has(ref) || (!ref.includes(":") && names.has(`${ref}:latest`)),
    );
    if (done.length === 0) return;
    setInterrupted((p) => p.filter((m) => !done.includes(m)));
    done.forEach((m) => void invoke("clear_pending_ollama_pull", { model: m }));
  }, [models, interrupted]);

  // Resume an interrupted download — Ollama continues from the partial blobs.
  const continuePull = (model: string) => {
    setInterrupted((p) => p.filter((m) => m !== model));
    void withBusy(`${model}:pull`, () => invoke("pull_ollama_model", { model }));
  };

  // Forget an interrupted download without resuming it.
  const dismissPull = (model: string) => {
    setInterrupted((p) => p.filter((m) => m !== model));
    void invoke("clear_pending_ollama_pull", { model });
  };

  // Pause an in-flight download. The backend stops the stream at the next chunk,
  // keeps the partial blobs, and emits a "paused" progress event that flips the
  // row into the paused state (Resume / Delete).
  const pausePull = (model: string) => {
    void invoke("pause_ollama_pull", { model });
  };

  // Resume a paused download — re-pull, which Ollama continues from the partials.
  const resumePull = (model: string) => {
    setPaused((p) => {
      const n = new Set(p);
      n.delete(model);
      return n;
    });
    void withBusy(`${model}:pull`, () => invoke("pull_ollama_model", { model }));
  };

  // Delete a paused download: drop its partial blobs and clear its pending record.
  const deletePausedPull = (model: string) => {
    setPaused((p) => {
      const n = new Set(p);
      n.delete(model);
      return n;
    });
    setInterrupted((p) => p.filter((m) => m !== model));
    void invoke("delete_ollama_pull", { model })
      .then(() => refresh())
      .catch((e) => setError(String(e)));
  };

  const installVibe = async () => {
    setVibeInstalling(true);
    setVibeInstallLog("");
    const unlisten = await listen<{ line: string }>("vibe-install-progress", (e) => {
      setVibeInstallLog((prev) => (prev ? `${prev}\n${e.payload.line}` : e.payload.line));
    });
    try {
      await invoke<string>("install_vibe");
      setVibeInstalled(true);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setVibeInstalling(false);
    }
  };

  // Keep the live Vibe install log pinned to the latest line.
  useEffect(() => {
    const el = vibeInstallLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [vibeInstallLog]);

  const installOllama = async () => {
    setInstalling(true);
    setError(null);
    setInstallLog("");
    // Stream the installer's output line-by-line so the user sees live progress.
    const unlisten = await listen<{ line: string }>("ollama-install-progress", (e) => {
      setInstallLog((prev) => (prev ? `${prev}\n${e.payload.line}` : e.payload.line));
    });
    try {
      await invoke<string>("install_ollama");
      setInstalled(true);
      // Start the server and load the model catalog so the user can immediately
      // pick what to install next.
      loadAfterInstall();
      await startServer();
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setInstalling(false);
    }
  };

  // Keep the live install log pinned to the latest line.
  useEffect(() => {
    const el = installLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [installLog]);

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
      if (key.endsWith(":pull")) clearPullProgress(key.slice(0, -":pull".length));
    }
  };

  // Pull an arbitrary model ref typed into the free-text field. Reuses the same
  // pull command as the catalog, so it accepts anything on the registry
  // (`name`, `name:tag`, `namespace/name:tag`) — not just the curated catalog.
  const pullTyped = async () => {
    const model = pullName.trim();
    if (!model) return;
    const key = `${model}:pull`;
    setBusy((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await invoke("pull_ollama_model", { model });
      setPullName(""); // clear only on success; errors keep the typed ref
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }));
      clearPullProgress(model);
    }
  };

  const installedNames = useMemo(() => new Set(models.map((m) => m.name)), [models]);

  // ── Live registry browser ────────────────────────────────────────────────
  // Only "popular"/"newest" are server-side (Ollama's `o=`); the name/size/pulls
  // sorts reorder loaded rows client-side, so they fetch in popular order.
  const serverSort = sortBy === "newest" ? "newest" : "popular";

  // Fetch one page of ollama.com/search results. `reset` replaces the list
  // (new query/sort); otherwise it appends, de-duping by name across pages.
  const loadRegistryPage = async (page: number, reset: boolean) => {
    setRegLoading(true);
    setRegError(null);
    try {
      const rows = await invoke<RegistryModel[]>("search_ollama_registry", {
        query: regQueryLive.trim(),
        capability: "", // type filter is multi-select + client-side (see shownRegistry)
        sort: serverSort,
        page,
      });
      setRegPage(page);
      setRegDone(rows.length === 0);
      setRegModels((prev) => {
        if (reset) return rows;
        const seen = new Set(prev.map((m) => m.name));
        return [...prev, ...rows.filter((m) => !seen.has(m.name))];
      });
    } catch (e) {
      setRegError(String(e));
      setRegDone(true);
    } finally {
      setRegLoading(false);
    }
  };

  // Debounce the query box so we don't hit ollama.com on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setRegQueryLive(regQuery), 350);
    return () => window.clearTimeout(id);
  }, [regQuery]);

  // (Re)load page 1 whenever the query or the server-side sort changes. Type and
  // size filters and client sorts don't refetch — they reshape loaded rows.
  useEffect(() => {
    if (installed !== true) return;
    void loadRegistryPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regQueryLive, serverSort, installed]);

  // Keep the observer callback pointing at the latest state without re-observing.
  loadMoreRef.current = () => {
    if (!regLoading && !regDone) void loadRegistryPage(regPage + 1, false);
  };
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Toggle a value in a Set-valued filter (used by both Type and Params chips).
  const toggleInSet =
    (setter: (updater: (prev: Set<string>) => Set<string>) => void) => (key: string) =>
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
  const toggleType = toggleInSet(setRegTypes);
  const toggleSizeBucket = toggleInSet(setRegSizes);

  // Client-side filtering + sorting over the loaded rows. Type (any-of selected
  // capability) and size buckets narrow; the chosen sort then reorders. Ollama
  // offers no type/size/pulls query params, so this reshapes what's fetched.
  const shownRegistry = useMemo(() => {
    const out = regModels.filter(
      (m) =>
        (regTypes.size === 0 || m.capabilities.some((c) => regTypes.has(c))) &&
        matchesSizeBuckets(m.sizes, regSizes),
    );
    if (sortBy === "name") {
      out.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === "params-asc" || sortBy === "params-desc") {
      const dir = sortBy === "params-asc" ? 1 : -1;
      out.sort(
        (a, b) =>
          dir * (modelMaxParamsB(a.sizes) - modelMaxParamsB(b.sizes)) ||
          a.name.localeCompare(b.name),
      );
    } else if (sortBy === "pulls") {
      out.sort((a, b) => parsePulls(b.pulls) - parsePulls(a.pulls));
    }
    // "popular"/"newest": keep the server's fetch order.
    return out;
  }, [regModels, regTypes, regSizes, sortBy]);

  const runningModels = models.filter((m) => m.running);
  const loadedLabel =
    runningModels.length === 0
      ? serverRunning
        ? "No model loaded"
        : "No loaded model"
      : `Loaded: ${runningModels.map((m) => m.name).join(", ")}`;

  // Vibe runtime section — required to launch Local Model tabs. Shown in both
  // the install-Ollama and main panels; collapses to a one-line "ready" note
  // once Vibe is detected, and expands to an installer when it is missing.
  const vibeSection = (
    <div className="ollama-vibe-section">
      <div className="settings-section-title">Local model runtime (Vibe)</div>
      {vibeInstalled === null ? (
        <p className="settings-help">Checking for Vibe…</p>
      ) : vibeInstalled ? (
        <p className="settings-help">
          <span className="ollama-status-dot running" /> Vibe is installed — local
          models can launch as agent tabs.
        </p>
      ) : (
        <>
          <p className="settings-help">
            Local Ollama models run through Mistral's <code>vibe</code> CLI. It
            isn't installed yet, so a Local Model tab fails with{" "}
            <em>“unable to spawn vibe”</em>. Install it once (no administrator
            rights needed) and local models will launch.
          </p>
          <div className="ollama-install-cmd-row">
            <button
              type="button"
              className="ollama-action-btn primary"
              disabled={vibeInstalling}
              onClick={() => void installVibe()}
            >
              {vibeInstalling ? "Installing…" : "Install Vibe"}
            </button>
            {vibeInstalling && <span className="ollama-status-text">Running installer…</span>}
          </div>
          {vibeInstallLog !== null && (
            <pre className="ollama-install-log" ref={vibeInstallLogRef}>
              {vibeInstallLog || "Starting…"}
            </pre>
          )}
          <p className="settings-help">
            Or install it in a {vibeStrategy?.os === "windows" ? "PowerShell" : "terminal"} tab:
          </p>
          <div className="ollama-install-cmd-row">
            <code className="ollama-install-cmd">{vibeStrategy?.command ?? VIBE_INSTALL_CMD}</code>
            <button
              type="button"
              className="ollama-action-btn primary"
              onClick={() =>
                runInstallInTab(
                  "Install Vibe",
                  vibeStrategy?.command ?? VIBE_INSTALL_CMD,
                  vibeStrategy?.os === "windows" ? "powershell" : "bash",
                )
              }
            >
              Run in terminal
            </button>
            <button
              type="button"
              className="ollama-action-btn"
              disabled={vibeInstalling}
              onClick={() =>
                void invoke<boolean>("vibe_is_installed")
                  .then((ok) => {
                    setVibeInstalled(ok);
                    if (!ok)
                      setError(
                        vibeStrategy?.os === "windows"
                          ? "Vibe is still not detected (open a fresh terminal so the install location is on PATH)."
                          : "Vibe is still not detected (try a fresh terminal so ~/.local/bin is on PATH).",
                      );
                  })
                  .catch(() => {})
              }
            >
              Re-check
            </button>
          </div>
        </>
      )}
    </div>
  );

  // ── Not installed: show the (semi-)automated installer + manual steps ──────
  if (installed === false) {
    // OS-dependent install guidance from the backend (winget on Windows, the
    // install script on Linux/macOS); fall back to the script until it loads.
    const installCmd = strategy?.command ?? OLLAMA_INSTALL_CMD_FALLBACK;
    const downloadUrl = strategy?.download_url ?? OLLAMA_DOWNLOAD_URL;
    const isWindows = strategy?.os === "windows";
    return (
      <>
        <div className="settings-title-row">
          <h2>Install Ollama</h2>
          <button type="button" onClick={onBack}>Back</button>
        </div>

        <p className="settings-help">
          Ollama runs open-weight models locally on your machine. It isn't
          installed yet. Install it once and Eldrun will list the models you can
          download right here.
        </p>

        <div className="settings-section-title">Automatic install</div>
        <p className="settings-help">
          {isWindows ? (
            <>
              Installs Ollama with <code>winget</code> (silent, per-user). winget
              ships with Windows 10/11; if it's missing or the install fails,
              follow the manual steps below.
            </>
          ) : (
            <>
              Runs the official install script. It needs administrator rights to
              add the <code>ollama</code> service, so this works without prompting
              only when your account has passwordless <code>sudo</code>. If it
              fails, follow the manual steps below.
            </>
          )}
        </p>
        <div className="ollama-install-cmd-row">
          <button
            type="button"
            className="ollama-action-btn primary"
            disabled={installing}
            onClick={() => void installOllama()}
          >
            {installing ? "Installing…" : "Install Ollama"}
          </button>
          {installing && <span className="ollama-status-text">Running installer…</span>}
        </div>

        {error && <div className="project-dialog-error">{error}</div>}
        {installLog !== null && (
          <pre className="ollama-install-log" ref={installLogRef}>
            {installLog || "Starting…"}
          </pre>
        )}

        <div className="settings-section-title">Install in a terminal</div>
        <ol className="ollama-install-steps">
          <li>
            Run the installer for your system in a new{" "}
            {isWindows ? "PowerShell" : "terminal"} tab:
            <div className="ollama-install-cmd-row">
              <code className="ollama-install-cmd">{installCmd}</code>
              <button
                type="button"
                className="ollama-action-btn primary"
                onClick={() =>
                  runInstallInTab("Install Ollama", installCmd, isWindows ? "default" : "bash")
                }
              >
                Run in terminal
              </button>
            </div>
            <span className="settings-help">
              You can also download the installer directly from{" "}
              <code>{downloadUrl}</code>.
            </span>
          </li>
          <li>
            {isWindows
              ? "Approve the User Account Control prompt if Windows asks."
              : "Enter your password if the installer asks for sudo."}
          </li>
          <li>
            Once it finishes, click <strong>Re-check</strong> below — the
            installable models will appear automatically.
          </li>
        </ol>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={installing}
          onClick={() =>
            void (async () => {
              const ok = await invoke<boolean>("ollama_is_installed").catch(() => false);
              setInstalled(ok);
              if (ok) {
                loadAfterInstall();
                await startServer();
              } else {
                setError("Ollama is still not detected.");
              }
            })()
          }
        >
          Re-check
        </button>

        {vibeSection}
      </>
    );
  }

  return (
    <>
      <div className="settings-title-row">
        <h2>Ollama Models</h2>
        <button type="button" onClick={onBack}>Back</button>
      </div>

      <div className="ollama-status-bar">
        <span className={`ollama-status-dot ${serverRunning ? "running" : "stopped"}`} />
        <span className="ollama-status-text">
          {serverRunning === null
            ? "Checking..."
            : serverRunning
              ? `Server running · ${loadedLabel}`
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

      {vibeSection}

      {(() => {
        // Interrupted entries not currently being (re)pulled — these get a
        // "Continue" action; live pulls show their streaming progress bar.
        const resumable = interrupted.filter((m) => !(m in pullProgress) && !paused.has(m));
        if (
          Object.keys(pullProgress).length === 0 &&
          resumable.length === 0 &&
          paused.size === 0 &&
          orphans.length === 0
        )
          return null;
        return (
          <>
            <div className="settings-section-title">Downloading</div>
            <div className="settings-list">
              {Object.entries(pullProgress).map(([model, pr]) => (
                <div className="ollama-model-row" key={model}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">
                      {pr.pct != null ? `${pr.pct}%` : "…"}
                    </span>
                  </div>
                  <div className="ollama-download-bar">
                    <div
                      className={`ollama-download-bar-fill${pr.pct == null ? " indeterminate" : ""}`}
                      style={pr.pct != null ? { width: `${pr.pct}%` } : undefined}
                    />
                  </div>
                  {pr.status && <div className="ollama-download-status">{pr.status}</div>}
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn"
                      title="Pause this download (resume later)"
                      onClick={() => pausePull(model)}
                    >
                      Pause
                    </button>
                  </div>
                </div>
              ))}
              {[...paused].map((model) => (
                <div className="ollama-model-row" key={`paused:${model}`}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">paused</span>
                  </div>
                  <div className="ollama-download-status">
                    Download paused — resume to finish it, or delete the partial data.
                  </div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn"
                      onClick={() => resumePull(model)}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="ollama-action-btn danger"
                      title="Delete the partial download to reclaim disk space"
                      onClick={() => deletePausedPull(model)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {resumable.map((model) => (
                <div className="ollama-model-row" key={`int:${model}`}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">interrupted</span>
                  </div>
                  <div className="ollama-download-status">
                    Download was interrupted — resume to finish it.
                  </div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn"
                      onClick={() => continuePull(model)}
                    >
                      Continue download
                    </button>
                    <button
                      type="button"
                      className="ollama-action-btn"
                      title="Forget this interrupted download"
                      onClick={() => dismissPull(model)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
              {orphans.length > 0 && (
                <div className="ollama-download-status">
                  {orphans.length} orphaned partial layer{orphans.length > 1 ? "s" : ""} (
                  {fmtBytes(orphans.reduce((sum, o) => sum + o.size, 0))}) — interrupted downloads
                  with no recoverable model name. Re-pull the model to resume, or delete to reclaim
                  space.
                </div>
              )}
              {orphans.map((o) => (
                <div className="ollama-model-row" key={o.path}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">layer {o.digest}…</span>
                    <span className="ollama-model-size">{fmtBytes(o.size)}</span>
                  </div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn danger"
                      title="Delete this partial layer to reclaim disk space"
                      onClick={() => deleteOrphan(o.path)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        );
      })()}

      <div className="settings-section-title">Downloaded Models</div>
      {loading ? (
        <div className="ollama-empty">Loading...</div>
      ) : models.length === 0 ? (
        <div className="ollama-empty">No models downloaded</div>
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
                {m.running ? (
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
                ) : (
                  <button
                    type="button"
                    className="ollama-action-btn"
                    disabled={busy[`${m.name}:load`] || loadingMem[m.name]}
                    title="Load into memory now and keep it resident"
                    onClick={() =>
                      void withBusy(`${m.name}:load`, () =>
                        invoke("load_ollama_model", { model: m.name }),
                      )
                    }
                  >
                    {busy[`${m.name}:load`] || loadingMem[m.name] ? "Loading…" : "Load"}
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
                  {busy[`${m.name}:pull`] ? pullText(m.name, "Updating…") : "Update"}
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
              {(busy[`${m.name}:load`] || loadingMem[m.name]) && (
                <div className="ollama-load-progress" title="Loading into memory…">
                  <div className="ollama-download-bar">
                    <div className="ollama-download-bar-fill indeterminate" />
                  </div>
                  <span className="ollama-download-status">Loading into memory…</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="settings-section-title ollama-section-title-row">
        <span>Browse the Ollama registry</span>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={regLoading}
          onClick={() => void loadRegistryPage(1, true)}
        >
          {regLoading ? "..." : "Refresh"}
        </button>
      </div>

      <p className="settings-help">
        Pull any model from the Ollama registry. Type an exact ref to pull directly,
        or search and filter the full list below. Use a full ref like{" "}
        <code>llama3.1:8b</code> or <code>namespace/model:tag</code>.
      </p>
      <div className="ollama-install-cmd-row">
        <input
          type="text"
          className="ollama-pull-input"
          placeholder="model name or namespace/model:tag"
          value={pullName}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!!busy[`${pullName.trim()}:pull`]}
          onChange={(e) => setPullName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void pullTyped();
          }}
        />
        <button
          type="button"
          className="ollama-action-btn"
          disabled={!pullName.trim() || !!busy[`${pullName.trim()}:pull`]}
          onClick={() => void pullTyped()}
        >
          {busy[`${pullName.trim()}:pull`] ? pullText(pullName.trim(), "Pulling…") : "Pull"}
        </button>
      </div>

      <div className="ollama-catalog-controls">
        <input
          type="text"
          className="ollama-pull-input"
          placeholder="Search all models by name or description…"
          value={regQuery}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setRegQuery(e.target.value)}
        />
        <label className="ollama-sort-label" title="Sort the results">
          Sort by
          <Dropdown
            className="ollama-catalog-sort"
            value={sortBy}
            onChange={(v) => setSortBy(v as SortKey)}
            options={SORT_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
          />
        </label>
      </div>

      <div className="ollama-filter-row">
        <span className="ollama-filter-label">Type</span>
        <button
          type="button"
          className={`ollama-chip${regTypes.size === 0 ? " active" : ""}`}
          onClick={() => setRegTypes(new Set())}
        >
          Any
        </button>
        {REGISTRY_TYPES.map((cap) => (
          <button
            key={cap}
            type="button"
            className={`ollama-chip${regTypes.has(cap) ? " active" : ""}`}
            onClick={() => toggleType(cap)}
          >
            {cap}
          </button>
        ))}
      </div>

      <div className="ollama-filter-row">
        <span className="ollama-filter-label">Params</span>
        <button
          type="button"
          className={`ollama-chip${regSizes.size === 0 ? " active" : ""}`}
          onClick={() => setRegSizes(new Set())}
        >
          Any
        </button>
        {SIZE_BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`ollama-chip${regSizes.has(b.key) ? " active" : ""}`}
            onClick={() => toggleSizeBucket(b.key)}
          >
            {b.label}
          </button>
        ))}
      </div>

      {regError && <div className="project-dialog-error">{regError}</div>}

      <div className="settings-list">
        {shownRegistry.map((m) => (
          <div className="ollama-catalog-row" key={m.name}>
            <div className="ollama-catalog-header">
              <span className="ollama-model-name">{m.name}</span>
              <span className="ollama-catalog-hint">
                {m.pulls && `${m.pulls} pulls`}
                {m.pulls && m.updated ? " · " : ""}
                {m.updated}
              </span>
            </div>
            {m.description && <div className="ollama-catalog-desc">{m.description}</div>}
            {m.capabilities.length > 0 && (
              <div className="ollama-model-details">
                {m.capabilities.map((c) => (
                  <span className="ollama-badge" key={c}>
                    {c}
                  </span>
                ))}
              </div>
            )}
            <div className="ollama-catalog-tags">
              {m.sizes.length === 0 ? (
                (() => {
                  const isInstalled = installedNames.has(`${m.name}:latest`);
                  const sz = tagSizes[m.name];
                  const sizeLabel =
                    sz === undefined
                      ? ""
                      : sz === "loading"
                        ? " — size…"
                        : sz === "error"
                          ? ""
                          : ` — ${fmtBytes(sz)}`;
                  return (
                    <button
                      type="button"
                      className={`ollama-tag-btn${isInstalled ? " installed" : ""}`}
                      disabled={!!busy[`${m.name}:pull`]}
                      title={`${isInstalled ? "Update" : "Download"} ${m.name}${sizeLabel}`}
                      onMouseEnter={() => fetchTagSize(m.name)}
                      onFocus={() => fetchTagSize(m.name)}
                      onClick={() =>
                        void withBusy(`${m.name}:pull`, () =>
                          invoke("pull_ollama_model", { model: m.name }),
                        )
                      }
                    >
                      {busy[`${m.name}:pull`] ? pullText(m.name, "…") : "pull"}
                    </button>
                  );
                })()
              ) : (
                m.sizes.map((tag) => {
                  const fullName = `${m.name}:${tag}`;
                  const isInstalled = installedNames.has(fullName);
                  const isBusy = busy[`${fullName}:pull`];
                  const sz = tagSizes[fullName];
                  const sizeLabel =
                    sz === undefined
                      ? ""
                      : sz === "loading"
                        ? " — size…"
                        : sz === "error"
                          ? ""
                          : ` — ${fmtBytes(sz)}`;
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`ollama-tag-btn${isInstalled ? " installed" : ""}`}
                      disabled={!!isBusy}
                      title={`${isInstalled ? "Update" : "Download"} ${fullName}${sizeLabel}`}
                      onMouseEnter={() => fetchTagSize(fullName)}
                      onFocus={() => fetchTagSize(fullName)}
                      onClick={() =>
                        void withBusy(`${fullName}:pull`, () =>
                          invoke("pull_ollama_model", { model: fullName }),
                        )
                      }
                    >
                      {isBusy ? pullText(fullName, "…") : tag}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ))}

        {/* Lazy-load sentinel + status line. */}
        {regLoading && <div className="ollama-empty">Loading…</div>}
        {!regLoading && shownRegistry.length === 0 && (
          <div className="ollama-empty">
            {regModels.length === 0
              ? "No models found"
              : "No loaded models match the selected size — load more or clear the Params filter"}
          </div>
        )}
        <div ref={sentinelRef} aria-hidden="true" />
        {regDone && regModels.length > 0 && (
          <div className="ollama-empty">End of results</div>
        )}
      </div>
    </>
  );
}
