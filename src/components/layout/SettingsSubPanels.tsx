import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { SettingsCard, SettingsHeader, SettingsList, SettingsSection, ToggleRow } from "./settingsUi";
import { formatBytes as fmtBytes } from "../../lib/formatBytes";
import { UntestedTag } from "../common/UntestedTag";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { GLOBAL_APP_ROLES } from "./GlobalAppBar";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { PLATFORM } from "../../lib/platform";
import { runInstallInTab, type InstallShellKind } from "../../lib/installCommand";
import {
  codexHookNeedsTrust,
  openCodexHooksTab,
  type CodexHookState,
} from "../../lib/codexHooks";
import type { GlobalAppEntry } from "../../types";
import { parseSshAddress } from "../projects/scaffold";
import { useProjectsStore } from "../../stores/projects";
import { useGlobalMachinesStore } from "../../stores/globalMachines";
import { useT, type TranslationKey } from "../../lib/i18n";
import { notifyAgentRegistryChanged } from "../../lib/agentRegistry";
import {
  AGENT_CRON_MESSAGE,
  addTime,
  agentCronTimes,
  allAgentsEnabled,
  nextAgentCronRun,
  normalizeTimes,
  removeTime,
  withAgentCronEnabled,
  withAgentCronTimes,
  withAllAgentsEnabled,
  withCronEnabled,
  withGlobalTimes,
  type AgentCron,
} from "../../lib/agentCron";
import { formatTime } from "../../lib/calendarTime";
import { useUse24h } from "../../lib/timeFormat";
import { AGENT_FENCE_DEFAULT_PATHS, parseAgentFencePaths } from "../../lib/agentFence";

interface OllamaModelInfo {
  name: string;
  size: number;
  parameter_size: string | null;
  quantization: string | null;
  family: string | null;
  running: boolean;
  size_vram: number;
}

/** How a chosen models-download location would be applied (mirrors backend
 *  `OllamaModelsDirPlan`). `service_cmd` is empty unless the running server is a
 *  systemd unit *and* the path is safe to embed in a drop-in. */
interface OllamaModelsDirPlan {
  default_dir: string;
  systemd_service: boolean;
  service_cmd: string;
  shell_kind: string;
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

/** A tag's headline facts (mirrors backend RegistryDetails), fetched lazily so a
 *  row that carries no size badge on the search card can still show its
 *  parameters and download size. */
interface RegistryDetails {
  size_bytes: number;
  params: string | null;
  quant: string | null;
  cloud: boolean;
}
/** Cached per-tag details, "loading" while the two registry reads are in flight,
 *  "error" when they could not be reached. */
type TagInfo = RegistryDetails | "loading" | "error";

/** Approximate age in days from a registry row's relative "updated" label
 *  ("yesterday", "3 weeks ago", …), for the client-side "newest" reorder that
 *  stands in when a text query is present — ollama.com returns nothing for a
 *  query combined with its own `o=newest` sort. Unrecognized → Infinity, so a
 *  row with no readable label sorts last rather than first. */
function updatedAgeDays(updated: string): number {
  const s = updated.trim().toLowerCase();
  if (!s) return Infinity;
  if (s === "today" || s === "just now") return 0;
  if (s === "yesterday") return 1;
  if (s === "last week") return 7;
  if (s === "last month") return 30;
  if (s === "last year") return 365;
  const m = /(\d+)\s*(hour|day|week|month|year)/.exec(s);
  if (!m) return Infinity;
  const n = parseInt(m[1], 10);
  const per: Record<string, number> = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
  return n * (per[m[2]] ?? 1);
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
  { key: "popular", labelKey: "ollama.sort.popular" },
  { key: "newest", labelKey: "ollama.sort.newest" },
  { key: "pulls", labelKey: "ollama.sort.pulls" },
  { key: "name", labelKey: "ollama.sort.name" },
  { key: "params-asc", labelKey: "ollama.sort.sizeAsc" },
  { key: "params-desc", labelKey: "ollama.sort.sizeDesc" },
] as const satisfies { key: string; labelKey: TranslationKey }[];
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

/** Every sub-panel takes the same two: `onBack` returns to the main settings
 *  panel, `onClose` dismisses the whole dialog. Optional because the panels are
 *  also rendered standalone in tests. */
export interface SubPanelProps {
  onBack: () => void;
  onClose?: () => void;
}

export function GlobalAppsSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
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
      <SettingsHeader title={t("globalApps.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("globalApps.help")}</p>
      <SettingsList boxed>
        {GLOBAL_APP_ROLES.map((role) => {
          const entry = apps[role.key] ?? { exec: "", visible: true };
          const roleLabel = t(role.labelKey);
          return (
            <div className="global-app-settings-row" key={role.key}>
              <Toggle
                size="sm"
                checked={entry.visible !== false}
                onChange={(e) => updateRole(role.key, { visible: e.target.checked })}
                title={t("globalApps.showRole", { role: roleLabel })}
              />
              <span className="settings-role-icon" aria-hidden>{role.fallback}</span>
              <span className="settings-role-label">{roleLabel}</span>
              <input
                value={entry.exec}
                placeholder={t("globalApps.notFoundPlaceholder")}
                onChange={(e) => setApps({ ...apps, [role.key]: { ...entry, exec: e.target.value } })}
                onBlur={(e) => updateRole(role.key, { exec: e.target.value.trim() })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") updateRole(role.key, { exec: e.currentTarget.value.trim() });
                }}
              />
              <button
                type="button"
                className="settings-btn sm icon"
                title={t("globalApps.browseTitle", { role: roleLabel })}
                onClick={() => void chooseExecutable(role.key)}
              >
                …
              </button>
            </div>
          );
        })}
      </SettingsList>
      </div>
    </>
  );
}

export function FileTypeSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
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
      <SettingsHeader title={t("filetypes.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("filetypes.help")}</p>
      {error && <div className="project-dialog-error">{error}</div>}
      <SettingsList boxed>
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
            <button
              type="button"
              className="settings-btn sm icon"
              title={t("filetypes.browseTitle")}
              onClick={() => void chooseExecutable(ext)}
            >
              …
            </button>
            <button
              type="button"
              className="settings-btn sm icon danger"
              onClick={() => {
                const { [ext]: _removed, ...rest } = apps;
                saveApps(rest);
              }}
              title={t("common.remove")}
            >
              ×
            </button>
          </div>
        ))}
        <div className="filetype-settings-row">
          <input
            value={draft.ext}
            placeholder={t("filetypes.extPlaceholder")}
            onChange={(e) => setDraft({ ...draft, ext: e.target.value })}
          />
          <input
            value={draft.app}
            placeholder={t("filetypes.appPlaceholder")}
            onChange={(e) => setDraft({ ...draft, app: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") addEntry();
            }}
          />
          <button type="button" className="settings-btn sm primary" onClick={addEntry}>
            {t("common.add")}
          </button>
        </div>
      </SettingsList>
      </div>
    </>
  );
}

/**
 * "Remote Connections" settings panel: a standard/default remote path per SSH
 * host, set once here instead of re-browsing it every time. Consulted by
 * `useRemoteSession`'s `resolveStartDir` whenever a connect/browse flow would
 * otherwise fall back to the SSH-reported home directory — so a host with a
 * preferred working directory (e.g. a projects folder that isn't `$HOME`)
 * opens there every time, for both new remote projects and reconnects.
 *
 * Distinct from the auto-remembered "recently used paths" dropdown in the New
 * Project dialog (`remote_paths.json`): that list grows on its own from every
 * folder you browse to, while this is one explicit choice per host, edited
 * only here.
 */
export function RemoteHostsSettings({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const [defaults, setDefaults] = useState<Record<string, string> | null>(null);
  const [draftHost, setDraftHost] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [error, setError] = useState("");

  const refresh = () => {
    invoke<Record<string, string>>("remote_list_default_paths")
      .then(setDefaults)
      .catch((e) => setError(String(e)));
  };
  useEffect(refresh, []);

  // Hosts seen before (recent SSH addresses + any active remote project),
  // offered as suggestions when adding a new entry — typing the exact host is
  // still required (paths are host-specific and a typo would silently do
  // nothing), this just saves re-typing one you've already connected to.
  const knownHosts = useProjectsStore((s) => s.projects);
  const [hostSuggestions, setHostSuggestions] = useState<string[]>([]);
  useEffect(() => {
    invoke<string[]>("ssh_list_addresses")
      .then((addrs) => {
        const fromAddrs = addrs.map((a) => parseSshAddress(a)?.host).filter((h): h is string => !!h);
        const fromProjects = knownHosts.map((p) => p.remote?.host).filter((h): h is string => !!h);
        const seen = new Set<string>();
        const out: string[] = [];
        for (const h of [...fromAddrs, ...fromProjects]) {
          const key = h.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(h);
        }
        setHostSuggestions(out);
      })
      .catch(() => setHostSuggestions([]));
  }, [knownHosts]);

  const savePath = (host: string, path: string) => {
    setError("");
    invoke<void>("remote_set_default_path", { host, path })
      .then(refresh)
      .catch((e) => setError(String(e)));
  };

  const removeHost = (host: string) => savePath(host, "");

  const addEntry = () => {
    const host = draftHost.trim();
    const path = draftPath.trim();
    if (!host || !path) return;
    savePath(host, path);
    setDraftHost("");
    setDraftPath("");
  };

  const entries = defaults ? Object.entries(defaults).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <>
      <SettingsHeader title={t("nav.remoteHosts.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">{t("remoteHosts.help")}</p>
      {error && <div className="project-dialog-error">{error}</div>}
      {/* One framed list holds the saved hosts, the empty state AND the add
          row — the same shape the File Type Apps panel uses. Before, the add
          row sat outside the frame and read as a stray strip below it. */}
      {defaults === null ? (
        <p className="settings-help">{t("common.loading")}</p>
      ) : (
        <SettingsList boxed>
          {entries.length === 0 && (
            <div className="settings-empty">{t("remoteHosts.empty")}</div>
          )}
          {entries.map(([host, path]) => (
            <div className="remote-host-settings-row" key={host}>
              <span className="settings-list-label" title={host}>{host}</span>
              <input
                value={path}
                onChange={(e) => setDefaults((d) => (d ? { ...d, [host]: e.target.value } : d))}
                onBlur={(e) => savePath(host, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") savePath(host, e.currentTarget.value);
                }}
              />
              <button
                type="button"
                className="settings-btn sm icon danger"
                onClick={() => removeHost(host)}
                title={t("common.remove")}
              >
                ×
              </button>
            </div>
          ))}
          <div className="remote-host-settings-row remote-host-settings-add">
            <input
              list="remote-host-suggestions"
              value={draftHost}
              placeholder={t("remoteHosts.hostPlaceholder")}
              onChange={(e) => setDraftHost(e.target.value)}
            />
            <datalist id="remote-host-suggestions">
              {hostSuggestions.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <input
              value={draftPath}
              placeholder={t("remoteHosts.pathPlaceholder")}
              onChange={(e) => setDraftPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addEntry();
              }}
            />
            <button type="button" className="settings-btn sm primary" onClick={addEntry}>
              {t("common.add")}
            </button>
          </div>
        </SettingsList>
      )}
      </div>
    </>
  );
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
  /** `npm uninstall -g <pkg>` for an npm-installed agent; empty otherwise. */
  uninstall_cmd: string;
  /** `install_cmd` prefixed with `sudo`; empty when that wouldn't apply
   *  (Windows, or a non-npm installer). See backend `sudo_variant`. */
  install_cmd_sudo: string;
  /** `uninstall_cmd` prefixed with `sudo`; same emptiness rule. */
  uninstall_cmd_sudo: string;
  docs: string;
  installed: boolean;
  /** Whether the scheduled warm-up can drive this CLI (it has a known one-shot
   *  print mode — backend `WARMUPS`). False greys the schedule toggle. */
  warmup: boolean;
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
 * "Codex won't run our session hook" notice for the Manage Agents panel.
 *
 * Codex gates user-level hooks behind a one-time trust approval, and an
 * untrusted one silently never fires — which is why Codex tabs used to restore
 * into a blank conversation. Eldrun resumes them anyway now (it reconstructs the
 * session from Codex's rollout logs), but that is a heuristic: it can mix up two
 * Codex tabs open in the same directory. Enabling the hook makes it exact.
 *
 * The contextual hint says the same thing, but it is dismissible for good and is
 * suppressed outright when hints are off — so this is where a user who waved it
 * away can still find the fix.
 *
 * Rendered nested inside the Codex row of Manage Agents (not as a free-floating
 * top-of-panel notice) — the hook is Codex-specific, so it belongs with the
 * agent it's about, same as the Remove/Reinstall actions.
 */
function CodexHookNotice() {
  const t = useT();
  // null = still probing.
  const [state, setState] = useState<CodexHookState | null>(null);
  const recheck = () =>
    invoke<CodexHookState>("codex_hook_status").then(setState).catch(() => setState(null));
  useEffect(() => void recheck(), []);

  // Healthy, absent, or still probing → nothing to say.
  if (!codexHookNeedsTrust(state)) return null;

  // The two states need two different instructions, and conflating them is what
  // made this notice useless: `disabled` means Codex ALREADY recorded a trust
  // verdict for the hook (its `trusted_hash` is in `config.toml`) and the row is
  // merely switched off, so telling that user to "trust it" sends them looking
  // for an action they already took. Only `untrusted` — no verdict at all — is
  // the review-and-approve case.
  const off = state === "disabled";

  return (
    <div className="agent-codex-hook">
      <div className="settings-subheader">
        {t("agents.codexHookLabel")}{" "}
        <span className="ollama-status-text">
          {off ? t("agents.codexHookDisabled") : t("agents.codexHookNotTrusted")}
        </span>
      </div>
      <p className="settings-help">
        {off ? t("agents.codexHookCauseDisabled") : t("agents.codexHookCauseUntrusted")}{" "}
        {t("agents.codexHookFallback")}
      </p>
      <p className="settings-help">
        {t("agents.codexHookFindPre")} <code>/hooks</code>{" "}
        {t("agents.codexHookFindMid")} <strong>eldrun_session_start</strong>
        {off ? t("agents.codexHookActionDisabled") : t("agents.codexHookActionUntrusted")}
      </p>
      <div className="ollama-install-cmd-row">
        <code className="ollama-install-cmd">/hooks</code>
        <button
          type="button"
          className="ollama-action-btn primary"
          onClick={openCodexHooksTab}
        >
          {t("agents.openInCodex")}
        </button>
        <button type="button" className="ollama-action-btn" onClick={() => void recheck()}>
          {t("common.recheck")}
        </button>
      </div>
    </div>
  );
}

/**
 * Claude's `--remote-control` toggle, moved here from the main Settings panel
 * (Group: nav "Manage Agents") since the flag only affects `claude` agent
 * tabs — it belongs with the agent it's about, same reasoning as
 * `CodexHookNotice`. Rendered nested inside the Claude row.
 */
function ClaudeRemoteControlNotice() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  return (
    <div className="settings-toggle-card agent-claude-remote-control">
      <label className="settings-toggle-card-row">
        <span>{t("settings.claudeRemote")}</span>
        <Toggle
          checked={settings?.agent_remote_control ?? true}
          onChange={(e) => void updateSettings({ agent_remote_control: e.target.checked })}
        />
      </label>
      <p className="settings-help">
        {t("settings.claudeRemoteHelp1")} <code>--remote-control</code>{" "}
        {t("settings.claudeRemoteHelp2")}
      </p>
    </div>
  );
}

function AgentFenceCard() {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const stored = settings?.agent_fence_paths;
  const effective = stored ?? [...AGENT_FENCE_DEFAULT_PATHS];
  const [paths, setPaths] = useState(effective.join("\n"));
  useEffect(() => {
    setPaths((stored ?? [...AGENT_FENCE_DEFAULT_PATHS]).join("\n"));
  }, [stored]);

  const savePaths = () => {
    const next = parseAgentFencePaths(paths);
    setPaths(next.join("\n"));
    void updateSettings({ agent_fence_paths: next });
  };

  return (
    <SettingsCard className="agent-fence-card">
      <div className="settings-subheader">
        {t("settings.agentFenceTitle")} <UntestedTag />
      </div>
      <label className="settings-toggle-card-row">
        <span>{t("settings.agentFenceEnabled")}</span>
        <Toggle
          checked={settings?.agent_fence ?? true}
          onChange={(e) => void updateSettings({ agent_fence: e.target.checked })}
        />
      </label>
      <p className="settings-help">{t("settings.agentFenceHelp")}</p>
      <p className="settings-help">{t("settings.agentFenceLimits")}</p>
      <label className="settings-help" htmlFor="agent-fence-paths">
        {t("settings.agentFencePaths")}
      </label>
      <textarea
        id="agent-fence-paths"
        className="ollama-pull-input"
        rows={8}
        value={paths}
        spellCheck={false}
        onChange={(event) => setPaths(event.target.value)}
        onBlur={savePaths}
        aria-label={t("settings.agentFencePaths")}
      />
      <div className="ollama-install-cmd-row">
        <button
          type="button"
          className="ollama-action-btn"
          onClick={() => {
            setPaths(AGENT_FENCE_DEFAULT_PATHS.join("\n"));
            void updateSettings({ agent_fence_paths: undefined });
          }}
        >
          {t("settings.agentFenceReset")}
        </button>
      </div>
      <p className="settings-help">{t("settings.agentFencePathsHelp")}</p>
    </SettingsCard>
  );
}

/**
 * "Install Node/npm first" helper for the Manage Agents panel. Most agent CLIs
 * install through `npm`, so when `npm` isn't on the host's PATH this points the
 * user at the one-click, no-admin Node install for their OS (and stays hidden
 * once npm is detected). Follows Eldrun's install-via-terminal-tab policy.
 */
function NodeRuntimeNotice() {
  const t = useT();
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
      <div className="settings-subheader">
        Node.js / npm{" "}
        <span className="ollama-status-text">{t("agents.nodeNotDetected")}</span>
      </div>
      <p className="settings-help">
        {t("agents.nodeHelpPre")} <code>npm</code> {t("agents.nodeHelpMid")}{" "}
        <strong>{shell}</strong> {t("agents.nodeHelpPost")}
      </p>
      <div className="ollama-install-cmd-row">
        <code className="ollama-install-cmd">{command}</code>
        <button
          type="button"
          className="ollama-action-btn primary"
          onClick={() => runInstallInTab("Install Node.js (npm)", command, shellKind)}
        >
          {t("agents.runInTerminal")}
        </button>
        <button type="button" className="ollama-action-btn" onClick={() => void recheck()}>
          {t("common.recheck")}
        </button>
      </div>
      <p className="settings-help">
        {t("agents.nodeManualPre")}{" "}
        <a href={NODE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
          {t("agents.nodeDownloads")}
        </a>
        .
      </p>
    </div>
  );
}

/**
 * A list of local times ("HH:MM"), edited as chips plus an hour/minute picker.
 *
 * The app's own {@link Dropdown} rather than a native `<select>` (WebKitGTK
 * draws that as an unthemed OS menu — the note on the remote-machine picker
 * above) and rather than an `<input type="time">`, which takes its 12-vs-24-hour
 * face from the process locale and ignores both the element's `lang` and
 * `Settings.time_format_24h` (`common/TimeField`'s header documents the probe).
 * Two lists of numbers have neither problem and nothing to mistype.
 *
 * Stored values are always 24-hour; only the chips are printed through the
 * user's clock setting, so the picker says the same thing the board and the
 * calendar do.
 */
function TimeListEditor({
  times,
  onChange,
  disabled,
  emptyLabel,
}: {
  times: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** What to show in place of the chips when the list is empty — "no times yet"
   *  for the global list, "follows the global times" for an agent's own. */
  emptyLabel: string;
}) {
  const t = useT();
  const use24h = useUse24h();
  const [hour, setHour] = useState("09");
  const [minute, setMinute] = useState("00");

  const hours = useMemo(
    () => Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((v) => ({ value: v, label: v })),
    [],
  );
  const minutes = useMemo(
    () => Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((v) => ({ value: v, label: v })),
    [],
  );
  const pending = `${hour}:${minute}`;

  return (
    <div className="agent-cron-times">
      <div className="agent-cron-chips">
        {times.length === 0 ? (
          <span className="agent-cron-empty">{emptyLabel}</span>
        ) : (
          times.map((time) => (
            <span key={time} className="agent-cron-chip">
              {formatTime(time, use24h)}
              <button
                type="button"
                className="agent-cron-chip-remove"
                title={t("agentCron.removeTime", { time })}
                aria-label={t("agentCron.removeTime", { time })}
                disabled={disabled}
                onClick={() => onChange(removeTime(times, time))}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <div className="agent-cron-add">
        <Dropdown
          className="agent-cron-unit"
          title={t("agentCron.hourAria")}
          value={hour}
          options={hours}
          disabled={disabled}
          onChange={setHour}
        />
        <span className="agent-cron-colon">:</span>
        <Dropdown
          className="agent-cron-unit"
          title={t("agentCron.minuteAria")}
          value={minute}
          options={minutes}
          disabled={disabled}
          onChange={setMinute}
        />
        <button
          type="button"
          className="ollama-action-btn"
          disabled={disabled || times.includes(pending)}
          onClick={() => onChange(addTime(times, pending))}
        >
          {t("agentCron.addTime")}
        </button>
      </div>
    </div>
  );
}

/** "Next: 06:00 tomorrow", or nothing when this agent is not scheduled. */
function NextRunLabel({ cron, cmd }: { cron: AgentCron | undefined; cmd: string }) {
  const t = useT();
  const use24h = useUse24h();
  // Read once per render rather than on a ticking clock: this is a settings
  // panel, and a readout that only refreshes when something is edited is the
  // honest cost of not running a timer behind a screen nobody is watching.
  const now = new Date();
  const next = nextAgentCronRun(cron, cmd, now);
  if (!next) return null;
  const time = formatTime(
    `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`,
    use24h,
  );
  const tomorrow = next.getDate() !== now.getDate();
  return (
    <span className="agent-cron-next">
      {t(tomorrow ? "agentCron.nextTomorrow" : "agentCron.nextToday", { time })}
    </span>
  );
}

/**
 * The scheduled warm-up's global half: the master switch and the time list every
 * participating agent follows unless it names its own.
 *
 * It sits at the top of this panel rather than in a settings section of its own
 * because the thing it schedules is *these* rows — participation is per agent,
 * ticked on the agent's own card a few lines below, and a global switch two
 * panels away from the per-agent one is how half a schedule ends up armed.
 */
function AgentCronSection({ agents }: { agents: AgentInfo[] | null }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const cron = settings?.agent_cron;
  const enabled = cron?.enabled === true;
  const times = normalizeTimes(cron?.times);
  // Only an installed agent can be scheduled — a missing CLI would fail once a
  // day, silently, at six in the morning — and only one the backend has a
  // one-shot recipe for can be driven at all. The rest are still listed, greyed
  // with the reason, so "why isn't X here?" never has to be asked.
  const installed = (agents ?? []).filter((a) => a.installed);
  const capable = installed.filter((a) => a.warmup === true).map((a) => a.id);
  const all = allAgentsEnabled(cron, capable);

  return (
    <SettingsCard>
      <div className="settings-subheader">
        {t("agentCron.title")} <UntestedTag />
      </div>
      <p className="settings-help">{t("agentCron.help", { message: AGENT_CRON_MESSAGE })}</p>
      <p className="settings-help">{t("agentCron.runningNote")}</p>
      <ToggleRow
        label={t("agentCron.enable")}
        checked={enabled}
        onChange={(e) => void updateSettings({ agent_cron: withCronEnabled(cron, e.target.checked) })}
      />
      <div className="agent-cron-block">
        <span className="agent-cron-label">{t("agentCron.globalTimes")}</span>
        <TimeListEditor
          times={times}
          disabled={!enabled}
          emptyLabel={t("agentCron.noTimes")}
          onChange={(next) => void updateSettings({ agent_cron: withGlobalTimes(cron, next) })}
        />
      </div>
      <p className="settings-help">{t("agentCron.globalTimesHelp")}</p>
      <div className="agent-cron-agents">
        <span className="agent-cron-label">{t("agentCron.agentsTitle")}</span>
        {/* One switch for everyone, default off: a bulk flip of the same
            per-agent flags the rows below write, so it reads as "all on" only
            when every capable agent is on, and turning one row off turns it
            back off — never a separate mode the rows would have to argue with. */}
        <ToggleRow
          label={t("agentCron.allAgents")}
          checked={all}
          disabled={!enabled || capable.length === 0}
          title={t("agentCron.allAgentsTitle")}
          onChange={(e) => void updateSettings({ agent_cron: withAllAgentsEnabled(cron, capable, e.target.checked) })}
        />
        {agents === null ? (
          <span className="agent-cron-empty">{t("agents.checkingInstalled")}</span>
        ) : installed.length === 0 ? (
          <span className="agent-cron-empty">{t("agentCron.noAgents")}</span>
        ) : (
          <>
            {/* The same button grid as Project Settings' file-hiding endings —
                one pressed/unpressed button per agent, so twenty CLIs read at
                a glance instead of twenty toggle rows. Muted is off. A CLI the
                backend cannot drive is disabled with the reason in its tip. */}
            <div className="settings-list project-ending-list agent-cron-grid">
              {installed.map((a) => {
                const headless = a.warmup === true;
                const on = headless && cron?.agents?.[a.id]?.enabled === true;
                return (
                  <button
                    type="button"
                    key={a.id}
                    className={`project-ending-toggle${on ? "" : " is-hidden"}`}
                    aria-pressed={on}
                    disabled={!enabled || !headless}
                    onClick={() => void updateSettings({ agent_cron: withAgentCronEnabled(cron, a.id, !on) })}
                    title={
                      !headless
                        ? t("agentCron.noHeadless", { label: a.label })
                        : t(on ? "agentCron.gridOff" : "agentCron.gridOn", { label: a.label, message: AGENT_CRON_MESSAGE })
                    }
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
            {/* Own times only for the agents that are on: the grid is the
                overview, and a time editor per switched-off agent would bury it. */}
            {installed
              .filter((a) => a.warmup === true && cron?.agents?.[a.id]?.enabled === true)
              .map((a) => (
                <AgentCronRow key={a.id} cmd={a.id} label={a.label} />
              ))}
          </>
        )}
      </div>
    </SettingsCard>
  );
}

/** One switched-on agent's own times: the list it runs on when the global one
 *  is not what it wants, and when it fires next. Rendered under the grid only
 *  for agents that are on — participation itself is the grid button. */
function AgentCronRow({ cmd, label }: { cmd: string; label: string }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const cron = settings?.agent_cron;
  const master = cron?.enabled === true;
  const own = normalizeTimes(cron?.agents?.[cmd]?.times);
  const effective = agentCronTimes(cron, cmd);

  return (
    <div className="agent-cron-row">
      <span className="agent-cron-name">{label}</span>
      <TimeListEditor
        times={own}
        disabled={!master}
        emptyLabel={t("agentCron.followsGlobal")}
        onChange={(next) => void updateSettings({ agent_cron: withAgentCronTimes(cron, cmd, next) })}
      />
      {/* An agent ticked on with no times anywhere is armed and can never
          fire — the one state the schedule cannot express as a "next run",
          and therefore the one that has to be said out loud. */}
      {effective.length === 0 ? (
        <span className="agent-cron-warn">{t("agentCron.needsTimes")}</span>
      ) : (
        <NextRunLabel cron={cron} cmd={cmd} />
      )}
    </div>
  );
}

/**
 * "Manage Agents" panel: detect and one-click-install the AI coding-agent CLIs
 * Eldrun can launch as agent tabs (Claude, Codex, Google Antigravity, Google
 * Gemini, Mistral/vibe, Aider, OpenCode, Cursor, Copilot, Grok, Qwen, OpenClaw).
 * The
 * registry lives in the backend (`commands::agents`); this just renders each
 * entry with an install button, a live install log, and a manual fallback.
 */
export function AgentsPanel({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const remoteMachines = useGlobalMachinesStore((s) => s.machines);
  const remoteMachinesLoaded = useGlobalMachinesStore((s) => s.loaded);
  const loadRemoteMachines = useGlobalMachinesStore((s) => s.load);
  const disabledAgents = settings?.disabled_agents ?? [];
  const setAgentDisabled = (id: string, disabled: boolean) => {
    const next = disabled
      ? [...disabledAgents, id]
      : disabledAgents.filter((a) => a !== id);
    void updateSettings({ disabled_agents: next });
  };
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  // The agent id whose installer is currently running (only one at a time).
  const [installing, setInstalling] = useState<string | null>(null);
  // The agent id currently being removed (Remove, or the first half of
  // Reinstall) — disjoint from `installing` so the two actions never overlap.
  const [removing, setRemoving] = useState<string | null>(null);
  // Per-agent live install log, keyed by agent id.
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Per-agent target selection and outcome for explicit installs on a global
  // remote machine. This is independent of local `installed`: each machine has
  // its own CLI state.
  const [remoteTargets, setRemoteTargets] = useState<Record<string, string>>({});
  const [remoteInstalling, setRemoteInstalling] = useState<string | null>(null);
  const [remoteResults, setRemoteResults] = useState<Record<string, string>>({});
  const [remoteErrors, setRemoteErrors] = useState<Record<string, string>>({});
  // Filter over the *not installed* half only (see the two sections below).
  const [search, setSearch] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = () => {
    invoke<AgentInfo[]>("list_agents").then(setAgents).catch(() => setAgents([]));
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (!remoteMachinesLoaded) void loadRemoteMachines();
  }, [loadRemoteMachines, remoteMachinesLoaded]);

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
      notifyAgentRegistryChanged();
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err) }));
    } finally {
      unlisten();
      setInstalling(null);
    }
  };

  // Removes the detected binary (an npm-based agent goes through `npm
  // uninstall -g` instead, so the package doesn't linger — see `uninstall_agent`).
  // Returns whether it succeeded, so `reinstallAgent` knows whether to proceed.
  const removeAgent = async (id: string): Promise<boolean> => {
    setRemoving(id);
    setErrors(({ [id]: _drop, ...rest }) => rest);
    try {
      await invoke<string>("uninstall_agent", { id });
      refresh();
      notifyAgentRegistryChanged();
      return true;
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err) }));
      return false;
    } finally {
      setRemoving(null);
    }
  };

  // Remove then immediately re-run the official installer — the one-click fix
  // for an install that half-succeeded (binary present but broken) or that
  // Eldrun's stale detection missed (see paths.rs's Windows install-dir list).
  const reinstallAgent = async (id: string) => {
    if (await removeAgent(id)) await installAgent(id);
  };

  const recheck = (id: string) => {
    void invoke<boolean>("agent_is_installed", { id })
      .then((ok) => {
        setAgents((prev) =>
          prev?.map((a) => (a.id === id ? { ...a, installed: ok } : a)) ?? prev,
        );
        notifyAgentRegistryChanged();
        if (!ok) {
          setErrors((e) => ({
            ...e,
            [id]: t("agents.stillNotDetected"),
          }));
        }
      })
      .catch(() => {});
  };

  const installAgentRemote = async (agent: AgentInfo) => {
    const machineId = remoteTargets[agent.id];
    const machine = remoteMachines.find((m) => m.id === machineId);
    if (!machine) return;
    const key = `${agent.id}:${machine.id}`;
    setRemoteInstalling(key);
    setRemoteResults(({ [agent.id]: _drop, ...rest }) => rest);
    setRemoteErrors(({ [agent.id]: _drop, ...rest }) => rest);
    try {
      await invoke<string>("install_agent_remote", {
        agentId: agent.id,
        machineId: machine.id,
      });
      setRemoteResults((prev) => ({
        ...prev,
        [agent.id]: t("agents.remoteInstalled", {
          label: agent.label,
          machine: machine.label || machine.host,
        }),
      }));
    } catch (err) {
      setRemoteErrors((prev) => ({ ...prev, [agent.id]: String(err) }));
    } finally {
      setRemoteInstalling(null);
    }
  };

  // The same install, watched. `install_agent_remote` reports one string when it
  // is over and nothing while it runs — which hides exactly what goes wrong on
  // someone else's machine: an npm install that takes minutes, an nvm PATH that
  // isn't there, or a prompt (sudo, a host key) nobody can answer headlessly. The
  // backend hands back an `ssh -t` command line for the *same* registry-owned
  // script, and `runInstallInTab` types it into a root-terminal tab, where the
  // output is readable and the prompts are answerable. No `remoteInstalling`
  // spinner: the tab is the progress, and this call is over the moment it opens.
  const installAgentRemoteInTerminal = async (agent: AgentInfo) => {
    const machineId = remoteTargets[agent.id];
    const machine = remoteMachines.find((m) => m.id === machineId);
    if (!machine) return;
    setRemoteResults(({ [agent.id]: _drop, ...rest }) => rest);
    setRemoteErrors(({ [agent.id]: _drop, ...rest }) => rest);
    try {
      const command = await invoke<string>("install_agent_remote_command", {
        agentId: agent.id,
        machineId: machine.id,
      });
      runInstallInTab(
        t("agents.installRemoteTabLabel", {
          label: agent.label,
          machine: machine.label || machine.host,
        }),
        command,
        "default",
      );
    } catch (err) {
      setRemoteErrors((prev) => ({ ...prev, [agent.id]: String(err) }));
    }
  };

  // The card for one CLI. One renderer for both sections below, so an
  // installed entry and one still to be installed cannot drift into two
  // designs — the only thing that differs is which list a card lands in.
  const agentCard = (a: AgentInfo) => (
    <SettingsCard key={a.id} className="agent-list-entry">
      <div className="agent-list-entry-head">
        <div className="settings-subheader">
          {a.label}{" "}
          {a.installed ? (
            <span className="ollama-status-text">
              <span className="ollama-status-dot running" /> {t("agents.installed")}
            </span>
          ) : (
            <span className="ollama-status-text">{t("agents.notInstalled")}</span>
          )}
        </div>
        {a.installed && (
          <label
            className="agent-disable-toggle"
            title={t("agents.disableToggleTitle")}
          >
            <Toggle
              checked={!disabledAgents.includes(a.id)}
              onChange={(e) => setAgentDisabled(a.id, !e.target.checked)}
              size="sm"
              aria-label={t(
                disabledAgents.includes(a.id) ? "agents.disableAriaEnable" : "agents.disableAriaDisable",
                { label: a.label },
              )}
            />
            {disabledAgents.includes(a.id) ? t("agents.disabled") : t("agents.enabled")}
          </label>
        )}
      </div>
      <div className="agent-remote-install-row">
        {/* The app's own `Dropdown`, never a native <select>: WebKitGTK
            renders a <select> popup as a light OS menu that ignores the
            theme entirely — the reason every other picker in the app
            (the file-browser sort, the LaTeX engine, the catalog sort a
            few hundred lines below) already uses this one. */}
        <Dropdown
          className="agent-remote-machine-picker"
          title={t("agents.remoteMachineAria", { label: a.label })}
          value={remoteTargets[a.id] ?? ""}
          placeholder={
            !remoteMachinesLoaded
              ? t("agents.remoteMachinesLoading")
              : remoteMachines.length === 0
                ? t("agents.noRemoteMachines")
                : t("agents.chooseRemoteMachine")
          }
          disabled={!remoteMachinesLoaded || remoteMachines.length === 0 || remoteInstalling !== null}
          options={remoteMachines.map((machine) => ({
            value: machine.id,
            label: machine.label || machine.host,
          }))}
          onChange={(v) => setRemoteTargets((prev) => ({ ...prev, [a.id]: v }))}
        />
        <button
          type="button"
          className="ollama-action-btn"
          disabled={!remoteTargets[a.id] || remoteInstalling !== null}
          onClick={() => void installAgentRemote(a)}
        >
          {remoteInstalling === `${a.id}:${remoteTargets[a.id]}`
            ? t("agents.installingRemote")
            : t("agents.installOnRemote")}
        </button>
        <button
          type="button"
          className="ollama-action-btn"
          title={t("agents.installOnRemoteTerminalTitle")}
          disabled={!remoteTargets[a.id] || remoteInstalling !== null}
          onClick={() => void installAgentRemoteInTerminal(a)}
        >
          {t("agents.installOnRemoteTerminal")}
        </button>
        <UntestedTag />
      </div>
      {remoteResults[a.id] && (
        <div className="agent-remote-result">{remoteResults[a.id]}</div>
      )}
      {remoteErrors[a.id] && (
        <div className="project-dialog-error">{remoteErrors[a.id]}</div>
      )}
      {a.installed && (
        <>
          <div className="ollama-install-cmd-row">
            <button
              type="button"
              className="ollama-action-btn"
              disabled={installing !== null || removing !== null}
              title={t("agents.removeTitle")}
              onClick={() => void removeAgent(a.id)}
            >
              {removing === a.id ? t("agents.removing") : t("agents.remove")}
            </button>
            <button
              type="button"
              className="ollama-action-btn"
              disabled={installing !== null || removing !== null}
              title={t("agents.reinstallTitle")}
              onClick={() => void reinstallAgent(a.id)}
            >
              {removing === a.id || installing === a.id ? t("agents.reinstalling") : t("agents.reinstall")}
            </button>
          </div>
          {errors[a.id] && (
            <div className="project-dialog-error">{errors[a.id]}</div>
          )}
          {/* npm-installed agents only (uninstall_cmd empty otherwise):
              npm's global dir is root-owned on a system-wide Linux
              Node install, so Remove can fail with EACCES — the same
              run-in-a-terminal escape hatch the install flow offers,
              plus a one-click sudo-prefixed variant for that exact
              case (uninstall_cmd_sudo, empty on Windows). */}
          {a.uninstall_cmd !== "" && (
            <>
              <p className="settings-help">
                {t("agents.permissionHelpPre")}{" "}
                <strong>{a.shell}</strong> {t("agents.permissionHelpPost")}{" "}
                <code>sudo</code> {t("agents.permissionHelpPost2")}
              </p>
              <div className="ollama-install-cmd-row">
                <code className="ollama-install-cmd">{a.uninstall_cmd}</code>
                <button
                  type="button"
                  className="ollama-action-btn"
                  onClick={() =>
                    runInstallInTab(`Remove ${a.label}`, a.uninstall_cmd, a.shell_kind)
                  }
                >
                  {t("agents.runInTerminal")}
                </button>
                {a.uninstall_cmd_sudo !== "" && (
                  <button
                    type="button"
                    className="ollama-action-btn"
                    title={t("agents.runWithSudoTitle")}
                    onClick={() =>
                      runInstallInTab(`Remove ${a.label}`, a.uninstall_cmd_sudo, a.shell_kind)
                    }
                  >
                    {t("agents.runWithSudo")}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      {!a.installed && (
        <>
          {/* Auto-install runs the official installer via `sh` on
              Linux/macOS and via PowerShell/cmd on Windows. It is only
              hidden when this platform has no one-line installer at all
              (install_cmd empty — Windows-only case, see AgentInfo);
              the docs-link fallback below covers that. */}
          {a.install_cmd !== "" && (
            <>
              <div className="ollama-install-cmd-row">
                <button
                  type="button"
                  className="ollama-action-btn primary"
                  disabled={installing !== null}
                  onClick={() => void installAgent(a.id)}
                >
                  {installing === a.id ? t("agents.installing") : t("agents.installLabel", { label: a.label })}
                </button>
                {installing === a.id && (
                  <span className="ollama-status-text">{t("agents.runningInstaller")}</span>
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
              {/* Whenever install_cmd is non-empty the one-click button
                  above is also shown, so this is always the "or". */}
              <p className="settings-help">
                {t("agents.orInstallInShellPre")} <strong>{a.shell}</strong>{" "}
                {t("agents.orInstallInShellPost")}
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
                  {t("agents.runInTerminal")}
                </button>
                {/* npm-based installers only (install_cmd_sudo empty
                    otherwise — Windows, or a curl/pip installer that
                    targets the user's own home directory): the actual
                    EACCES fix when npm's global directory is root-owned,
                    the default on a non-nvm Linux/macOS Node install. */}
                {a.install_cmd_sudo !== "" && (
                  <button
                    type="button"
                    className="ollama-action-btn"
                    title={t("agents.runWithSudoTitle")}
                    onClick={() =>
                      runInstallInTab(`Install ${a.label}`, a.install_cmd_sudo, a.shell_kind)
                    }
                  >
                    {t("agents.runWithSudo")}
                  </button>
                )}
                <button
                  type="button"
                  className="ollama-action-btn"
                  disabled={installing !== null}
                  onClick={() => recheck(a.id)}
                >
                  {t("common.recheck")}
                </button>
              </div>
            </>
          ) : (
            <p className="settings-help">
              {t("agents.noWindowsInstallerPre")}{" "}
              <a href={a.docs} target="_blank" rel="noreferrer">
                {t("agents.installDocs")}
              </a>
              {t("agents.noWindowsInstallerPost")}{" "}
              <button
                type="button"
                className="ollama-action-btn"
                disabled={installing !== null}
                onClick={() => recheck(a.id)}
              >
                {t("common.recheck")}
              </button>
              .
            </p>
          )}
        </>
      )}
      {a.id === "codex" && <CodexHookNotice />}
      {a.id === "claude" && <ClaudeRemoteControlNotice />}
    </SettingsCard>
  );

  const installedAgents = (agents ?? []).filter((a) => a.installed);
  const availableAgents = (agents ?? []).filter((a) => !a.installed);
  const query = search.trim().toLowerCase();
  // Matched on the label, the id and the binary name, because a CLI is looked
  // for by whichever of the three the user happens to know ("gemini", "vibe").
  const matches = query
    ? availableAgents.filter((a) =>
        [a.label, a.id, a.bin].some((s) => s.toLowerCase().includes(query)),
      )
    : [];

  return (
    <>
      <SettingsHeader title={t("nav.agents.title")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">
      <p className="settings-help">
        {t("agents.help1")} <strong>+</strong> {t("agents.help2")} <code>npm</code>{" "}
        {t("agents.help3")} <code>PATH</code> {t("agents.help4")}
      </p>
      <p className="settings-help">{t("agents.googleCliChoice")}</p>
      <NodeRuntimeNotice />
      <AgentFenceCard />
      <AgentCronSection agents={agents} />
      {agents === null ? (
        <p className="settings-help">{t("agents.checkingInstalled")}</p>
      ) : (
        <>
          {/* Two sections, and the asymmetry between them is the point: the
              installed CLIs are a short list you manage (enable, remove,
              reinstall, schedule), while everything else is a catalog that only
              grows. Rendering the catalog in full buried the handful of entries
              that matter under a dozen install cards, so it is behind a search
              box instead and shows nothing until something is typed. */}
          <SettingsSection title={t("agents.installedGroup")}>
            {installedAgents.length === 0 ? (
              <p className="settings-help">{t("agents.noneInstalled")}</p>
            ) : (
              <SettingsList>{installedAgents.map(agentCard)}</SettingsList>
            )}
          </SettingsSection>
          <SettingsSection title={t("agents.availableGroup")}>
            {availableAgents.length === 0 ? (
              <p className="settings-help">{t("agents.allInstalled")}</p>
            ) : (
              <>
                <div className="ollama-catalog-controls">
                  <input
                    type="text"
                    className="ollama-pull-input"
                    placeholder={t("agents.searchPlaceholder")}
                    value={search}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-label={t("agents.searchPlaceholder")}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {query === "" ? (
                  <p className="settings-help">
                    {t("agents.searchHint", { count: String(availableAgents.length) })}
                  </p>
                ) : matches.length === 0 ? (
                  <p className="settings-help">
                    {t("agents.noSearchMatch", { query: search.trim() })}
                  </p>
                ) : (
                  <SettingsList>{matches.map(agentCard)}</SettingsList>
                )}
              </>
            )}
          </SettingsSection>
        </>
      )}
      </div>
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

export function OllamaPanel({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
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
  // Where Ollama downloads models (`settings.ollama_models_path`) and how the
  // chosen path would reach the running server. The plan is re-read whenever the
  // path changes — an empty path asks only for the default + systemd facts.
  const modelsPath = settings?.ollama_models_path ?? "";
  const [modelsDirPlan, setModelsDirPlan] = useState<OllamaModelsDirPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // Models currently being loaded into memory, keyed by name. Driven by the
  // global `ollama-load-progress` events so a load started from the brain menu
  // shows here too; Ollama streams no load percentage, so it's indeterminate.
  const [loadingMem, setLoadingMem] = useState<Record<string, boolean>>({});
  // Per-tag registry facts (size, parameters, quantization, cloud), fetched
  // lazily and cached. The parameter count and size are what the search card
  // omits for a model with no size badge, so it is fetched from the manifest.
  const [tagInfo, setTagInfo] = useState<Record<string, TagInfo>>({});
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

  // Fetch a tag's registry facts (size + parameters + quantization) once. Called
  // on hover for a tag button, and eagerly for a row with no size badge (below),
  // where the parameters and size would otherwise be invisible.
  const fetchTagInfo = (fullName: string) => {
    if (fullName in tagInfo) return;
    setTagInfo((p) => ({ ...p, [fullName]: "loading" }));
    invoke<RegistryDetails>("ollama_registry_details", { model: fullName })
      .then((d) => setTagInfo((p) => ({ ...p, [fullName]: d })))
      .catch(() => setTagInfo((p) => ({ ...p, [fullName]: "error" })));
  };

  // The " — 4.7 GB" suffix a tag button's tooltip carries once its size is known
  // (empty for a cloud model, which downloads nothing, and while still loading).
  const tagSizeSuffix = (info: TagInfo | undefined): string => {
    if (info === undefined) return "";
    if (info === "loading") return t("ollama.sizeLoadingSuffix");
    if (info === "error" || info.size_bytes <= 0) return "";
    return ` — ${fmtBytes(info.size_bytes)}`;
  };

  // The visible parameter/quantization/size chips for a registry row that has no
  // size badge on its search card — so a bare "pull"/cloud model still shows what
  // it is and whether it fits. Cloud-ness is already shown by the capability row,
  // so a cloud model shows its parameter count (e.g. 756B) and no size.
  const tagFactChips = (info: TagInfo | undefined) => {
    if (info === "loading") return <span className="ollama-catalog-hint">…</span>;
    if (!info || info === "error") return null;
    return (
      <>
        {info.params && <span className="ollama-badge">{info.params}</span>}
        {info.quant && <span className="ollama-badge">{info.quant}</span>}
        {info.size_bytes > 0 && <span className="ollama-badge">{fmtBytes(info.size_bytes)}</span>}
      </>
    );
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

  // Read the download-location plan on mount and whenever the chosen path
  // changes, so the default placeholder and the systemd apply-to-service command
  // (which depends on the exact path) stay in step with the setting.
  useEffect(() => {
    let cancelled = false;
    invoke<OllamaModelsDirPlan>("ollama_models_dir_plan", { path: modelsPath || null })
      .then((p) => {
        if (!cancelled) setModelsDirPlan(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelsPath]);

  const chooseModelsDir = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: modelsPath || undefined,
    });
    if (typeof picked === "string") {
      // Trailing slashes off so the stored value matches what the drop-in and
      // the placeholder show (mirrors the project-location picker).
      await updateSettings({ ollama_models_path: picked.replace(/\/+$/, "") });
    }
  };

  // Back to Ollama's own default — `null`, never `""`: the backend field is
  // skipped when absent, and a stored empty string would be a second spelling of
  // "unset" for every reader to special-case.
  const clearModelsDir = () => {
    void updateSettings({ ollama_models_path: null });
  };

  // Point the *running* server at the chosen folder (systemd drop-in), in a
  // visible terminal — it needs a root password and rewrites a service the user
  // is entitled to read first. The setting alone already covers a server Eldrun
  // starts itself.
  const applyModelsDirToService = () => {
    if (!modelsDirPlan?.service_cmd) return;
    runInstallInTab(
      t("ollama.modelLocationApplyTabLabel"),
      modelsDirPlan.service_cmd,
      (modelsDirPlan.shell_kind || "bash") as InstallShellKind,
    );
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
  // "newest" is server-side ONLY when there is no text query: ollama.com returns
  // an empty result set for `q=…&o=newest`, so a searched "newest" fetches the
  // query's relevance results and is reordered by recency client-side (below).
  const hasRegQuery = regQueryLive.trim().length > 0;
  const serverSort = sortBy === "newest" && !hasRegQuery ? "newest" : "popular";

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
    } else if (sortBy === "newest" && hasRegQuery) {
      // A searched "newest" cannot be honoured server-side (see `serverSort`),
      // so reorder the query's results by their relative "updated" label.
      out.sort((a, b) => updatedAgeDays(a.updated) - updatedAgeDays(b.updated) || a.name.localeCompare(b.name));
    }
    // "popular"/"newest" without a query: keep the server's fetch order.
    return out;
  }, [regModels, regTypes, regSizes, sortBy, hasRegQuery]);

  // Rows with no size badge on their search card (cloud models, single-variant
  // models) carry their parameter count and size only in the registry manifest,
  // not the search HTML — so fetch those few eagerly, or the card would show a
  // bare "pull"/"cloud" button with no parameters and no size to judge fit by.
  useEffect(() => {
    for (const m of shownRegistry) {
      if (m.sizes.length === 0) {
        fetchTagInfo(`${m.name}:${m.capabilities.includes("cloud") ? "cloud" : "latest"}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownRegistry]);

  // "Load on Eldrun start" — which models `stores/ollamaAutoload` warms into
  // memory at launch. The per-model switches write straight through (the same
  // setting the 🧠 menu's chip toggles, so the two surfaces cannot disagree);
  // the Energy Saver opt-out is *staged* behind a Save button, because it is the
  // one control here that changes whether the app spends power unattended.
  const autoloadModels = settings?.ollama_autoload_models ?? [];
  const saverPref = settings?.ollama_autoload_in_energy_saver === true;
  const [saverDraft, setSaverDraft] = useState(saverPref);
  const [saverSaved, setSaverSaved] = useState(false);
  // Re-seat the draft when the *stored* value actually moves — settings arrive
  // asynchronously, so the first render of this panel can precede them, and this
  // panel's own save lands here too. Guarded on a change (not on every render)
  // so a staged edit survives unrelated settings writes.
  const lastStoredSaver = useRef(saverPref);
  useEffect(() => {
    if (lastStoredSaver.current === saverPref) return;
    lastStoredSaver.current = saverPref;
    setSaverDraft(saverPref);
  }, [saverPref]);
  const toggleAutoload = (name: string) => {
    const next = autoloadModels.includes(name)
      ? autoloadModels.filter((m) => m !== name)
      : [...autoloadModels, name];
    void updateSettings({ ollama_autoload_models: next });
  };
  const saveSaverPref = () => {
    void updateSettings({ ollama_autoload_in_energy_saver: saverDraft }).then(() => {
      setSaverSaved(true);
      window.setTimeout(() => setSaverSaved(false), 2000);
    });
  };

  const runningModels = models.filter((m) => m.running);
  const loadedLabel =
    runningModels.length === 0
      ? serverRunning
        ? t("ollama.noModelLoaded")
        : t("ollama.noLoadedModel")
      : t("ollama.loadedModels", { names: runningModels.map((m) => m.name).join(", ") });

  // Vibe runtime section — required to launch Local Model tabs. Shown in both
  // the install-Ollama and main panels; collapses to a one-line "ready" note
  // once Vibe is detected, and expands to an installer when it is missing.
  const vibeSection = (
    <SettingsCard className="ollama-vibe-section">
      <div className="settings-subheader">{t("ollama.vibeTitle")}</div>
      {vibeInstalled === null ? (
        <p className="settings-help">{t("ollama.vibeChecking")}</p>
      ) : vibeInstalled ? (
        <p className="settings-help">
          <span className="ollama-status-dot running" /> {t("ollama.vibeInstalled")}
        </p>
      ) : (
        <>
          <p className="settings-help">
            {t("ollama.vibeMissing1")} <code>vibe</code> {t("ollama.vibeMissing2")}
          </p>
          <div className="ollama-install-cmd-row">
            <button
              type="button"
              className="ollama-action-btn primary"
              disabled={vibeInstalling}
              onClick={() => void installVibe()}
            >
              {vibeInstalling ? t("ollama.installingEllipsis") : t("ollama.installVibe")}
            </button>
            {vibeInstalling && <span className="ollama-status-text">{t("ollama.runningInstaller")}</span>}
          </div>
          {vibeInstallLog !== null && (
            <pre className="ollama-install-log" ref={vibeInstallLogRef}>
              {vibeInstallLog || t("ollama.startingEllipsis")}
            </pre>
          )}
          <p className="settings-help">
            {t("ollama.orInstallInShellPre")} {vibeStrategy?.os === "windows" ? "PowerShell" : "terminal"}{" "}
            {t("ollama.orInstallInShellPost")}
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
              {t("ollama.runInTerminal")}
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
                          ? t("ollama.vibeStillNotDetectedWindows")
                          : t("ollama.vibeStillNotDetectedOther"),
                      );
                  })
                  .catch(() => {})
              }
            >
              {t("common.recheck")}
            </button>
          </div>
        </>
      )}
    </SettingsCard>
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
        <SettingsHeader title={t("ollama.installTitle")} onBack={onBack} onClose={onClose} />
        <div className="dialog-scroll">

        <p className="settings-help">{t("ollama.notInstalledHelp")}</p>

        <SettingsSection
          title={t("ollama.automaticInstall")}
          help={isWindows ? t("ollama.autoInstallHelpWindows") : t("ollama.autoInstallHelpOther")}
        />
        <div className="ollama-install-cmd-row">
          <button
            type="button"
            className="ollama-action-btn primary"
            disabled={installing}
            onClick={() => void installOllama()}
          >
            {installing ? t("ollama.installingEllipsis") : t("ollama.installBtn")}
          </button>
          {installing && <span className="ollama-status-text">{t("ollama.runningInstaller")}</span>}
        </div>

        {error && <div className="project-dialog-error">{error}</div>}
        {installLog !== null && (
          <pre className="ollama-install-log" ref={installLogRef}>
            {installLog || t("ollama.startingEllipsis")}
          </pre>
        )}

        <div className="settings-section-title">{t("ollama.installInTerminalTitle")}</div>
        <ol className="ollama-install-steps">
          <li>
            {t("ollama.runInstallerNewPre")}{" "}
            {isWindows ? "PowerShell" : "terminal"} {t("ollama.runInstallerNewPost")}
            <div className="ollama-install-cmd-row">
              <code className="ollama-install-cmd">{installCmd}</code>
              <button
                type="button"
                className="ollama-action-btn primary"
                onClick={() =>
                  runInstallInTab("Install Ollama", installCmd, isWindows ? "default" : "bash")
                }
              >
                {t("ollama.runInTerminal")}
              </button>
            </div>
            <span className="settings-help">
              {t("ollama.alsoDownloadFrom")}{" "}
              <code>{downloadUrl}</code>.
            </span>
          </li>
          <li>
            {isWindows ? t("ollama.approveUacPrompt") : t("ollama.enterPasswordSudo")}
          </li>
          <li>
            {t("ollama.onceFinishedClickPre")} <strong>{t("common.recheck")}</strong>{" "}
            {t("ollama.onceFinishedClickPost")}
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
                setError(t("ollama.stillNotDetected"));
              }
            })()
          }
        >
          {t("common.recheck")}
        </button>

        {vibeSection}
        </div>
      </>
    );
  }

  return (
    <>
      <SettingsHeader title={t("ollama.modelsTitle")} onBack={onBack} onClose={onClose} />
      <div className="dialog-scroll">

      <div className="ollama-status-bar">
        <span className={`ollama-status-dot ${serverRunning ? "running" : "stopped"}`} />
        <span className="ollama-status-text">
          {serverRunning === null
            ? t("ollama.checkingEllipsis")
            : serverRunning
              ? t("ollama.serverRunningLabel", { label: loadedLabel })
              : t("ollama.serverNotRunning")}
        </span>
        {serverRunning === false && (
          <button type="button" className="ollama-action-btn" onClick={() => void startServer()}>
            {t("ollama.start")}
          </button>
        )}
        {serverRunning === true && (
          <button
            type="button"
            className="ollama-action-btn"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "..." : t("ollama.refresh")}
          </button>
        )}
      </div>

      {error && <div className="project-dialog-error">{error}</div>}

      <div className="settings-section-title">
        {t("ollama.modelLocationTitle")} <UntestedTag />
      </div>
      <p className="settings-help">{t("ollama.modelLocationHelp")}</p>
      <div className="ollama-install-cmd-row">
        <code className="ollama-install-cmd">
          {modelsPath ||
            (modelsDirPlan
              ? t("ollama.modelLocationDefaultHint", { path: modelsDirPlan.default_dir })
              : "…")}
        </code>
        <button
          type="button"
          className="ollama-action-btn"
          onClick={() => void chooseModelsDir()}
        >
          {t("ollama.modelLocationBrowse")}
        </button>
        {modelsPath && (
          <button type="button" className="ollama-action-btn" onClick={clearModelsDir}>
            {t("ollama.modelLocationReset")}
          </button>
        )}
      </div>
      {modelsDirPlan?.systemd_service && (
        <>
          <p className="settings-help">{t("ollama.modelLocationSystemdHelp")}</p>
          {modelsDirPlan.service_cmd && (
            <div className="ollama-install-cmd-row">
              <button
                type="button"
                className="ollama-action-btn primary"
                title={modelsDirPlan.service_cmd}
                onClick={applyModelsDirToService}
              >
                {t("ollama.modelLocationApply")}
              </button>
            </div>
          )}
        </>
      )}

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
            <div className="settings-section-title">{t("ollama.downloadingTitle")}</div>
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
                      title={t("ollama.pauseTitle")}
                      onClick={() => pausePull(model)}
                    >
                      {t("ollama.pause")}
                    </button>
                  </div>
                </div>
              ))}
              {[...paused].map((model) => (
                <div className="ollama-model-row" key={`paused:${model}`}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">{t("ollama.pausedBadge")}</span>
                  </div>
                  <div className="ollama-download-status">{t("ollama.downloadPaused")}</div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn"
                      onClick={() => resumePull(model)}
                    >
                      {t("ollama.resume")}
                    </button>
                    <button
                      type="button"
                      className="ollama-action-btn danger"
                      title={t("ollama.deletePartialTitle")}
                      onClick={() => deletePausedPull(model)}
                    >
                      {t("ollama.delete")}
                    </button>
                  </div>
                </div>
              ))}
              {resumable.map((model) => (
                <div className="ollama-model-row" key={`int:${model}`}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{model}</span>
                    <span className="ollama-model-size">{t("ollama.interruptedBadge")}</span>
                  </div>
                  <div className="ollama-download-status">{t("ollama.downloadInterrupted")}</div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn"
                      onClick={() => continuePull(model)}
                    >
                      {t("ollama.continueDownload")}
                    </button>
                    <button
                      type="button"
                      className="ollama-action-btn"
                      title={t("ollama.dismissTitle")}
                      onClick={() => dismissPull(model)}
                    >
                      {t("ollama.dismiss")}
                    </button>
                  </div>
                </div>
              ))}
              {orphans.length > 0 && (
                <div className="ollama-download-status">
                  {t(orphans.length === 1 ? "ollama.orphansSummaryOne" : "ollama.orphansSummaryMany", {
                    count: orphans.length,
                    size: fmtBytes(orphans.reduce((sum, o) => sum + o.size, 0)),
                  })}
                </div>
              )}
              {orphans.map((o) => (
                <div className="ollama-model-row" key={o.path}>
                  <div className="ollama-model-header">
                    <span className="ollama-model-name">{t("ollama.orphanLayer", { digest: o.digest })}</span>
                    <span className="ollama-model-size">{fmtBytes(o.size)}</span>
                  </div>
                  <div className="ollama-model-actions">
                    <button
                      type="button"
                      className="ollama-action-btn danger"
                      title={t("ollama.deleteLayerTitle")}
                      onClick={() => deleteOrphan(o.path)}
                    >
                      {t("ollama.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        );
      })()}

      <div className="settings-section-title">{t("ollama.downloadedModelsTitle")}</div>
      {loading ? (
        <div className="ollama-empty">{t("common.loading")}</div>
      ) : models.length === 0 ? (
        <div className="ollama-empty">{t("ollama.noModelsDownloaded")}</div>
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
                    title={t("ollama.unloadTitle")}
                    onClick={() =>
                      void withBusy(`${m.name}:stop`, () =>
                        invoke("stop_ollama_model", { model: m.name }),
                      )
                    }
                  >
                    {busy[`${m.name}:stop`] ? "..." : t("ollama.unload")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ollama-action-btn"
                    disabled={busy[`${m.name}:load`] || loadingMem[m.name]}
                    title={t("ollama.loadTitle")}
                    onClick={() =>
                      void withBusy(`${m.name}:load`, () =>
                        invoke("load_ollama_model", { model: m.name }),
                      )
                    }
                  >
                    {busy[`${m.name}:load`] || loadingMem[m.name] ? t("ollama.loading") : t("ollama.load")}
                  </button>
                )}
                <button
                  type="button"
                  className="ollama-action-btn"
                  disabled={busy[`${m.name}:pull`]}
                  title={t("ollama.updateTitle")}
                  onClick={() =>
                    void withBusy(`${m.name}:pull`, () =>
                      invoke("pull_ollama_model", { model: m.name }),
                    )
                  }
                >
                  {busy[`${m.name}:pull`] ? pullText(m.name, t("ollama.updating")) : t("ollama.update")}
                </button>
                <button
                  type="button"
                  className="ollama-action-btn danger"
                  disabled={busy[`${m.name}:del`]}
                  title={t("ollama.deleteModelTitle")}
                  onClick={() =>
                    void withBusy(`${m.name}:del`, () =>
                      invoke("delete_ollama_model", { model: m.name }),
                    )
                  }
                >
                  {busy[`${m.name}:del`] ? "..." : t("ollama.delete")}
                </button>
              </div>
              {(busy[`${m.name}:load`] || loadingMem[m.name]) && (
                <div className="ollama-load-progress" title={t("ollama.loadingIntoMemoryTitle")}>
                  <div className="ollama-download-bar">
                    <div className="ollama-download-bar-fill indeterminate" />
                  </div>
                  <span className="ollama-download-status">{t("ollama.loadingIntoMemory")}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Load-on-start: the models Eldrun warms into memory at launch, plus the
          Energy Saver opt-out. See `stores/ollamaAutoload` for the rules. */}
      <div className="settings-section-title">
        {t("ollama.autostartTitle")} <UntestedTag />
      </div>
      <p className="settings-help">{t("ollama.autostartHelp")}</p>
      {models.length === 0 ? (
        <div className="ollama-empty">{t("ollama.noModelsDownloaded")}</div>
      ) : (
        <div className="settings-list ollama-autostart-list">
          {models.map((m) => (
            <label
              className={`ollama-autostart-row${autoloadModels.includes(m.name) ? " on" : ""}`}
              key={`autostart:${m.name}`}
            >
              <Toggle
                size="sm"
                checked={autoloadModels.includes(m.name)}
                onChange={() => toggleAutoload(m.name)}
                title={t("ollama.autostartToggleTitle", { name: m.name })}
              />
              <span className="ollama-model-name">{m.name}</span>
              {m.parameter_size && <span className="ollama-badge">{m.parameter_size}</span>}
            </label>
          ))}
        </div>
      )}
      <div className="settings-toggle-card">
        <label className="settings-toggle-card-row">
          <span>{t("ollama.autostartInSaver")}</span>
          <Toggle checked={saverDraft} onChange={(e) => setSaverDraft(e.target.checked)} />
        </label>
        <p className="settings-help">{t("ollama.autostartInSaverHelp")}</p>
        <div className="ollama-autostart-saver-actions">
          {saverSaved && <span className="ollama-status-text">{t("ollama.autostartSaved")}</span>}
          <button
            type="button"
            className="ollama-action-btn primary"
            disabled={saverDraft === saverPref}
            onClick={saveSaverPref}
          >
            {t("common.save")}
          </button>
        </div>
      </div>

      <div className="settings-section-title ollama-section-title-row">
        <span>{t("ollama.browseRegistry")}</span>
        <button
          type="button"
          className="ollama-action-btn"
          disabled={regLoading}
          onClick={() => void loadRegistryPage(1, true)}
        >
          {regLoading ? "..." : t("ollama.refresh")}
        </button>
      </div>

      <p className="settings-help">
        {t("ollama.pullHelp1")}{" "}
        <code>llama3.1:8b</code> {t("ollama.pullHelp2")} <code>namespace/model:tag</code>.
      </p>
      <div className="ollama-install-cmd-row">
        <input
          type="text"
          className="ollama-pull-input"
          placeholder={t("ollama.pullPlaceholder")}
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
          {busy[`${pullName.trim()}:pull`] ? pullText(pullName.trim(), t("ollama.pulling")) : t("ollama.pull")}
        </button>
      </div>

      <div className="ollama-catalog-controls">
        <input
          type="text"
          className="ollama-pull-input"
          placeholder={t("ollama.searchPlaceholder")}
          value={regQuery}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setRegQuery(e.target.value)}
        />
        <label className="ollama-sort-label" title={t("ollama.sortBy")}>
          {t("ollama.sortBy")}
          <Dropdown
            className="ollama-catalog-sort"
            value={sortBy}
            onChange={(v) => setSortBy(v as SortKey)}
            options={SORT_OPTIONS.map((o) => ({ value: o.key, label: t(o.labelKey) }))}
          />
        </label>
      </div>

      <div className="ollama-filter-row">
        <span className="ollama-filter-label">{t("ollama.filterType")}</span>
        <button
          type="button"
          className={`ollama-chip${regTypes.size === 0 ? " active" : ""}`}
          onClick={() => setRegTypes(new Set())}
        >
          {t("ollama.any")}
        </button>
        {REGISTRY_TYPES.map((cap) => (
          <button
            key={cap}
            type="button"
            className={`ollama-chip${regTypes.has(cap) ? " active" : ""}`}
            onClick={() => toggleType(cap)}
          >
            {t(`ollama.cap.${cap}` as TranslationKey)}
          </button>
        ))}
      </div>

      <div className="ollama-filter-row">
        <span className="ollama-filter-label">{t("ollama.filterParams")}</span>
        <button
          type="button"
          className={`ollama-chip${regSizes.size === 0 ? " active" : ""}`}
          onClick={() => setRegSizes(new Set())}
        >
          {t("ollama.any")}
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
                {m.pulls && t("ollama.pullsSuffix", { pulls: m.pulls })}
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
                  // No size badge on the search card: a cloud model (its tag is
                  // `:cloud`) or a single-variant model (`:latest`). Either way the
                  // parameters + size come from the manifest, fetched eagerly above
                  // and shown as chips beside the pull button.
                  const isCloud = m.capabilities.includes("cloud");
                  const fullName = `${m.name}:${isCloud ? "cloud" : "latest"}`;
                  const isInstalled = installedNames.has(fullName);
                  const busyKey = `${fullName}:pull`;
                  const info = tagInfo[fullName];
                  return (
                    <>
                      <button
                        type="button"
                        className={`ollama-tag-btn${isInstalled ? " installed" : ""}`}
                        disabled={!!busy[busyKey]}
                        title={t(isInstalled ? "ollama.tagUpdateTitle" : "ollama.tagDownloadTitle", { name: fullName, size: tagSizeSuffix(info) })}
                        onMouseEnter={() => fetchTagInfo(fullName)}
                        onFocus={() => fetchTagInfo(fullName)}
                        onClick={() =>
                          void withBusy(busyKey, () =>
                            invoke("pull_ollama_model", { model: fullName }),
                          )
                        }
                      >
                        {busy[busyKey] ? pullText(fullName, "…") : t("ollama.pullLower")}
                      </button>
                      {tagFactChips(info)}
                    </>
                  );
                })()
              ) : (
                m.sizes.map((tag) => {
                  const fullName = `${m.name}:${tag}`;
                  const isInstalled = installedNames.has(fullName);
                  const isBusy = busy[`${fullName}:pull`];
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`ollama-tag-btn${isInstalled ? " installed" : ""}`}
                      disabled={!!isBusy}
                      title={t(isInstalled ? "ollama.tagUpdateTitle" : "ollama.tagDownloadTitle", { name: fullName, size: tagSizeSuffix(tagInfo[fullName]) })}
                      onMouseEnter={() => fetchTagInfo(fullName)}
                      onFocus={() => fetchTagInfo(fullName)}
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
        {regLoading && <div className="ollama-empty">{t("common.loading")}</div>}
        {!regLoading && shownRegistry.length === 0 && (
          <div className="ollama-empty">
            {regModels.length === 0
              ? t("ollama.noModelsFound")
              : t("ollama.noMatchSizeFilter")}
          </div>
        )}
        <div ref={sentinelRef} aria-hidden="true" />
        {regDone && regModels.length > 0 && (
          <div className="ollama-empty">{t("ollama.endOfResults")}</div>
        )}
      </div>
      </div>
    </>
  );
}
