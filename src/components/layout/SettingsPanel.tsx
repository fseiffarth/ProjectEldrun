import { useEffect, useRef, useState, type ChangeEventHandler, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  useSettingsStore,
  clampZoom,
  MIN_UI_ZOOM,
  MAX_UI_ZOOM,
  ZOOM_STEPS,
} from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { experimentalEnabled } from "../../lib/experimental";
import { usePowerStore, useEnergySaver } from "../../stores/power";
import { useProjectsStore } from "../../stores/projects";
import { DEFAULT_MIN_SUBWINDOW_PX } from "../../stores/tabs";
import type {
  ArchivedProject,
  CalendarViewKind,
  KeyboardChord,
  ProjectEntry,
  Theme,
  UnsyncedReport,
} from "../../types";
import { THEMES } from "../../types";
import { summarizeScaffoldRepair, type ProjectScaffoldRepair } from "../projects/scaffold";
import { Toggle } from "../common/Toggle";
import { OPEN_STATS_EVENT } from "../stats/StatsRecapHost";
import {
  SHORTCUT_DEFS,
  chordFromEvent,
  chordLabel,
  resolveChord,
  type ShortcutAction,
  type ShortcutMap,
} from "../../lib/shortcuts";
import {
  AgentsPanel,
  FileTypeSettings,
  GlobalAppsSettings,
  OllamaPanel,
  RemoteHostsSettings,
} from "./SettingsSubPanels";
import { Dropdown } from "../common/Dropdown";
import { PasswordInput } from "../common/PasswordInput";
import { useT, LANGUAGES, type Language, type TranslationKey } from "../../lib/i18n";
import { IS_MAC, IS_WINDOWS } from "../../lib/platform";
import { useHintsStore } from "../../stores/hints";
import { canConnectVpnSilently } from "../../lib/vpnConnect";
import { setVpnAutoConnect, vpnUsernameFor } from "../../lib/vpnAutoConnect";
import type { StoredVpnConfig } from "../../types";

// The workspace-layout help text. On Linux a lone Super toggles the panels; on
// Windows it's F9 (the lone Win key is OS-reserved — Start opens on release, see
// useKeyboard); on macOS the Meta key is reserved for Cmd shortcuts, so the
// lone-key toggle is disabled — there the panels stay reachable via the
// cursor-to-edge reveal. Keep the copy honest per OS.
function workspaceLayoutIntro(t: ReturnType<typeof useT>): string {
  return IS_MAC
    ? t("help.workspaceLayout.introMac")
    : t("help.workspaceLayout.introOther", { key: IS_WINDOWS ? "F9" : "Super" });
}

/** A toggle with an explanatory paragraph, as one card (matches .settings-nav-item
 *  / .lesson-item) instead of a bare switch-row bleeding into a trailing paragraph. */
function ToggleCard({
  label,
  checked,
  onChange,
  help,
}: {
  label: string;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  help?: ReactNode;
}) {
  return (
    <div className="settings-toggle-card">
      <label className="settings-toggle-card-row">
        <span>{label}</span>
        <Toggle checked={checked} onChange={onChange} />
      </label>
      {help && <p className="settings-help">{help}</p>}
    </div>
  );
}

interface HelpItem {
  termKey: TranslationKey;
  descKey: TranslationKey;
}

interface HelpSection {
  titleKey: TranslationKey;
  hasIntro?: boolean;
  items: HelpItem[];
}

const HELP_SECTIONS: HelpSection[] = [
  {
    titleKey: "help.workspaceLayout.title",
    hasIntro: true,
    items: [
      { termKey: "help.workspaceLayout.item1.term", descKey: "help.workspaceLayout.item1.desc" },
      { termKey: "help.workspaceLayout.item2.term", descKey: "help.workspaceLayout.item2.desc" },
      { termKey: "help.workspaceLayout.item3.term", descKey: "help.workspaceLayout.item3.desc" },
      { termKey: "help.workspaceLayout.item4.term", descKey: "help.workspaceLayout.item4.desc" },
    ],
  },
  {
    titleKey: "help.projects.title",
    items: [
      { termKey: "help.projects.item1.term", descKey: "help.projects.item1.desc" },
      { termKey: "help.projects.item2.term", descKey: "help.projects.item2.desc" },
      { termKey: "help.projects.item3.term", descKey: "help.projects.item3.desc" },
      { termKey: "help.projects.item4.term", descKey: "help.projects.item4.desc" },
    ],
  },
  {
    titleKey: "help.aiTerminals.title",
    items: [
      { termKey: "help.aiTerminals.item1.term", descKey: "help.aiTerminals.item1.desc" },
      { termKey: "help.aiTerminals.item2.term", descKey: "help.aiTerminals.item2.desc" },
    ],
  },
  {
    titleKey: "help.settingsExtras.title",
    items: [
      { termKey: "help.settingsExtras.item1.term", descKey: "help.settingsExtras.item1.desc" },
      { termKey: "help.settingsExtras.item2.term", descKey: "help.settingsExtras.item2.desc" },
      { termKey: "help.settingsExtras.item3.term", descKey: "help.settingsExtras.item3.desc" },
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
  const t = useT();
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
        <h2>{t("nav.shortcuts.title")}</h2>
        <button type="button" onClick={onBack}>{t("common.back")}</button>
      </div>
      <p className="settings-help">{t("shortcuts.help")}</p>
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
                title={t("shortcuts.captureTitle")}
              >
                {active ? t("shortcuts.pressKeys") : chordLabel(effective)}
              </button>
              <button
                type="button"
                className="settings-back-btn"
                disabled={!isCustom}
                onClick={() => reset(def.action)}
                title={t("shortcuts.resetTitle")}
              >
                {t("common.reset")}
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
  const t = useT();
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
        <h2>{t("nav.git.title")}</h2>
        <button type="button" onClick={onBack}>{t("common.back")}</button>
      </div>
      <p className="settings-help">{t("git.help")}</p>
      <label className="settings-field">
        {t("git.profileUrl")}
        <input
          value={gitProfileUrl}
          placeholder={t("git.profileUrlPlaceholder")}
          onChange={(e) => setGitProfileUrl(e.target.value)}
          onBlur={saveGitProfileUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveGitProfileUrl();
          }}
        />
      </label>
      <label className="settings-field">
        {t("git.accessToken")}
        <PasswordInput
          value={gitToken}
          placeholder={t("git.tokenPlaceholder")}
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

/**
 * Same setting the header's VPN menu arms per config (`settings.vpn_auto_connect`,
 * see `lib/vpnAutoConnect.ts`) — surfaced here too since the header menu only shows
 * up once a tunnel exists, which makes this opt-in easy to miss.
 */
function VpnAutoConnectSettings({ onBack }: { onBack: () => void }) {
  const t = useT();
  const { settings } = useSettingsStore();
  const armed = settings?.vpn_auto_connect ?? null;
  const headless = settings?.connections_headless ?? true;
  const [configs, setConfigs] = useState<StoredVpnConfig[] | null>(null);
  const [silent, setSilent] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    void invoke<StoredVpnConfig[]>("openvpn_list_configs")
      .then(async (list) => {
        const stored = Array.isArray(list) ? list : [];
        if (cancelled) return;
        setConfigs(stored);
        const checks = await Promise.all(
          stored.map(async (c) => [c.path, await canConnectVpnSilently(c.path, vpnUsernameFor(c.path))] as const),
        );
        if (!cancelled) setSilent(Object.fromEntries(checks));
      })
      .catch(() => {
        if (!cancelled) setConfigs([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="settings-title-row">
        <h2>{t("nav.vpn.title")}</h2>
        <button type="button" onClick={onBack}>{t("common.back")}</button>
      </div>
      <p className="settings-help">{t("vpn.autoConnectHelp")}</p>
      {configs === null ? (
        <p className="settings-help">{t("common.loading")}</p>
      ) : configs.length === 0 ? (
        <div className="settings-empty">{t("vpn.noConfig")}</div>
      ) : (
        <div className="settings-list">
          {configs.map((c) => {
            const on = armed === c.path;
            const eligible = !headless || silent[c.path] === true;
            return (
              <div key={c.path} className="settings-toggle-card">
                <label className="settings-toggle-card-row">
                  <span title={c.path}>{c.name}</span>
                  <Toggle
                    checked={on}
                    disabled={!eligible && !on}
                    onChange={(e) => void setVpnAutoConnect(c.path, e.target.checked)}
                  />
                </label>
                {!eligible && !on && (
                  <p className="settings-help">
                    {t("vpn.needsSavedPre")} <b>{t("vpn.needsSavedBold")}</b>{" "}
                    {t("vpn.needsSavedPost")}
                  </p>
                )}
                {on && (
                  <p className="settings-help">
                    {t("vpn.startsWithEldrun")}
                    {headless ? "" : ` ${t("vpn.waitsInRootTerminal")}`}.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function ArchivedProjectsPanel({ onBack }: { onBack: () => void }) {
  const t = useT();
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
        <h2>{t("nav.archive.title")}</h2>
        <button type="button" onClick={onBack}>{t("common.back")}</button>
      </div>
      <p className="settings-help">{t("archive.help")}</p>
      {error && <div className="project-dialog-error">{error}</div>}
      {items === null ? (
        <p className="settings-help">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="settings-help">{t("archive.empty")}</p>
      ) : (
        <ul className="archived-projects-list">
          {items.map((a) => {
            const armed = confirmId === a.id;
            const rowBusy = busyId === a.id;
            return (
              <li key={a.id} className="archived-project-row">
                <div className="archived-project-info">
                  <span className="archived-project-name">{a.name}</span>
                  {a.remote && <span className="archived-project-tag">{t("archive.remoteTag")}</span>}
                  <span className="archived-project-date">{a.archived_at.slice(0, 10)}</span>
                </div>
                {armed ? (
                  <div className="archived-project-confirm-group">
                    {unsynced && unsynced.total > 0 && (
                      <p className="archived-project-warn">
                        ⚠ {unsynced.verified
                          ? t(unsynced.total === 1 ? "archive.unsyncedVerifiedOne" : "archive.unsyncedVerifiedMany", {
                              count: unsynced.total,
                              branches: unsynced.branches.map((b) => b.name).join(", "),
                            })
                          : t(unsynced.total === 1 ? "archive.unsyncedUnverifiedOne" : "archive.unsyncedUnverifiedMany", {
                              count: unsynced.total,
                            })}
                      </p>
                    )}
                  <div className="archived-project-confirm">
                    <input
                      type="text"
                      autoFocus
                      placeholder={t("archive.typeToDelete", { name: a.name })}
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") resetConfirm();
                      }}
                    />
                    <button type="button" onClick={resetConfirm} disabled={rowBusy}>{t("common.cancel")}</button>
                    <button
                      type="button"
                      className="danger"
                      disabled={rowBusy || typed.trim() !== a.name.trim()}
                      onClick={() => void deleteForever(a)}
                    >
                      {rowBusy ? t("archive.deleting") : t("archive.deleteForever")}
                    </button>
                  </div>
                  </div>
                ) : (
                  <div className="archived-project-actions">
                    <button type="button" disabled={rowBusy} onClick={() => void restore(a)}>
                      {rowBusy ? t("archive.restoring") : t("archive.restore")}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={rowBusy}
                      onClick={() => armDelete(a)}
                    >
                      {t("archive.deletePermanently")}
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
              placeholder={t("archive.typeDeleteAll")}
              value={clearTyped}
              onChange={(e) => setClearTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setClearing(false); setClearTyped(""); }
              }}
            />
            <button type="button" onClick={() => { setClearing(false); setClearTyped(""); }}>{t("common.cancel")}</button>
            <button
              type="button"
              className="danger"
              disabled={busyId === "__all__" || clearTyped.trim().toLowerCase() !== "delete"}
              onClick={() => void clearAll()}
            >
              {busyId === "__all__" ? t("archive.clearing") : t("archive.clearArchive")}
            </button>
          </div>
        ) : (
          <div className="settings-link-row">
            <button type="button" className="danger" onClick={() => setClearing(true)}>
              {t("archive.clearArchiveEllipsis")}
            </button>
          </div>
        )
      )}
    </>
  );
}

function ScaffoldRepairPanel({ onBack }: { onBack: () => void }) {
  const t = useT();
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
        <h2>{t("nav.scaffoldRepair.title")}</h2>
        <button type="button" onClick={onBack}>{t("common.back")}</button>
      </div>
      <p className="settings-help">{t("scaffoldRepair.help")}</p>
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="settings-link-row">
        <button type="button" disabled={busy} onClick={() => void run()}>
          {busy ? t("scaffoldRepair.running") : t("scaffoldRepair.runNow")}
        </button>
      </div>
      {results !== null && (
        results.length === 0 ? (
          <p className="settings-help">{t("scaffoldRepair.upToDate")}</p>
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
  const t = useT();
  return (
    <>
      <div className="settings-title-row">
        <h2>{t("help.title")}</h2>
        <button type="button" onClick={onBack}>{t("common.back")}</button>
      </div>

      <p className="settings-help">{t("help.intro")}</p>

      {HELP_SECTIONS.map((section) => (
        <div key={section.titleKey} className="help-section">
          <div className="settings-section-title">{t(section.titleKey)}</div>
          {section.hasIntro && <p className="settings-help">{workspaceLayoutIntro(t)}</p>}
          <dl className="help-list">
            {section.items.map((item) => (
              <div key={item.termKey} className="help-row">
                <dt>{t(item.termKey)}</dt>
                <dd>{t(item.descKey)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  );
}

export type SettingsPanelKind = "main" | "global" | "filetypes" | "ollama" | "agents" | "shortcuts" | "git" | "vpn" | "remoteHosts" | "archive" | "scaffoldRepair" | "help";

/** Sub-panel navigation shown as a card menu at the foot of the main settings
 *  panel (styled like the Lessons / How-to-start menus). Titles/blurbs are
 *  resolved at render via i18n (`nav.<panel>.title` / `.blurb`). */
const SETTINGS_NAV: Exclude<SettingsPanelKind, "main" | "ollama">[] = [
  "git",
  "vpn",
  "remoteHosts",
  "global",
  "filetypes",
  "agents",
  "shortcuts",
  "archive",
  "scaffoldRepair",
  "help",
];

export function SettingsDialog({
  onClose,
  initialPanel = "main",
}: {
  onClose: () => void;
  initialPanel?: SettingsPanelKind;
}) {
  const { settings, setTheme, setLanguage, updateSettings } = useSettingsStore();
  const [panel, setPanel] = useState<SettingsPanelKind>(initialPanel);
  const t = useT();

  const currentTheme = (settings?.color_scheme ?? "fancy_dark") as Theme;
  const currentLang = (settings?.language ?? "en") as Language;

  // Live power state for the Energy Saver help line.
  const energyMode = settings?.energy_saver ?? "battery";
  const energyActive = useEnergySaver();
  const powerReady = usePowerStore((s) => s.ready);
  const powerSupported = usePowerStore((s) => s.supported);
  const energyStatus = (() => {
    if (energyMode === "battery" && powerReady && !powerSupported) {
      return t("settings.energyUnavailable");
    }
    if (energyActive) {
      return energyMode === "always"
        ? t("settings.energyActiveAlways")
        : t("settings.energyActiveBattery");
    }
    return energyMode === "off" ? t("settings.energyOff") : t("settings.energyInactive");
  })();

  return (
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
       <div className="dialog-scroll">
        {panel === "main" && (
          <>
            <div className="settings-title-row">
              <h2>{t("settings.title")}</h2>
              <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
            </div>

            <div className="settings-row">
              <label>{t("settings.theme")}</label>
              <Dropdown
                value={currentTheme}
                onChange={(v) => void setTheme(v as Theme)}
                options={THEMES.map((theme) => ({ value: theme.value, label: theme.label }))}
              />
            </div>

            <div className="settings-row">
              <label>
                {t("settings.language")} <UntestedTag />
              </label>
              <Dropdown
                value={currentLang}
                onChange={(v) => void setLanguage(v as Language)}
                options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
              />
            </div>
            <p className="settings-help">{t("settings.language.help")}</p>

            <ToggleCard
              label={t("settings.runScriptsBg")}
              checked={settings?.run_scripts_in_background ?? true}
              onChange={(e) => void updateSettings({ run_scripts_in_background: e.target.checked })}
            />

            <ToggleCard
              label={t("settings.headlessRemote")}
              checked={settings?.connections_headless ?? true}
              onChange={(e) => void updateSettings({ connections_headless: e.target.checked })}
              help={t("settings.headlessRemoteHelp")}
            />

            {!IS_WINDOWS && (
              <ToggleCard
                label={t("settings.persistLocal")}
                checked={settings?.persist_local_sessions ?? true}
                onChange={(e) => void updateSettings({ persist_local_sessions: e.target.checked })}
                help={
                  <>
                    {t("settings.persistLocalHelp1")} <code>tmux</code>
                    {t("settings.persistLocalHelp2")}
                  </>
                }
              />
            )}

            <div className="settings-section-title">{t("settings.remoteFeatures")}</div>
            <div className="settings-toggle-card">
              <label className="settings-toggle-card-row">
                <span>{t("settings.vpnEnabled")}</span>
                <Toggle
                  checked={settings?.vpn_enabled ?? false}
                  onChange={(e) => void updateSettings({ vpn_enabled: e.target.checked })}
                />
              </label>
              <label className="settings-toggle-card-row">
                <span>{t("settings.machinesEnabled")}</span>
                <Toggle
                  checked={settings?.machines_enabled ?? false}
                  onChange={(e) => void updateSettings({ machines_enabled: e.target.checked })}
                />
              </label>
              <p className="settings-help">{t("settings.remoteFeaturesHelp")}</p>
            </div>

            <div className="settings-row">
              <label>{t("settings.energySaver")}</label>
              <Dropdown
                value={energyMode}
                onChange={(v) => void updateSettings({ energy_saver: v as "off" | "battery" | "always" })}
                options={[
                  { value: "off", label: t("energy.off") },
                  { value: "battery", label: t("energy.battery") },
                  { value: "always", label: t("energy.always") },
                ]}
              />
            </div>
            <p className="settings-help">
              {t("settings.energyHelp")}
              {" "}{energyStatus}
            </p>

            <ToggleCard
              label={t("settings.debug")}
              checked={settings?.debug ?? false}
              onChange={(e) => void updateSettings({ debug: e.target.checked })}
            />

            <div className="settings-section-title">{t("settings.experimental")}</div>
            <p className="settings-help">
              {t("settings.experimentalHelp1")}{" "}
              <b>{t("settings.experimentalHelpBold")}</b> {t("settings.experimentalHelp2")}
            </p>

            <ToggleCard
              label={t("settings.agentModeToggle")}
              checked={experimentalEnabled(settings, "agent_mode_toggle")}
              onChange={(e) => void updateSettings({ agent_mode_toggle: e.target.checked })}
              help={
                <>
                  {t("settings.agentModeHelp1")} <b>Plan</b> {t("settings.agentModeHelp2")}{" "}
                  <b>Auto</b> {t("settings.agentModeHelp3")}
                </>
              }
            />

            <ToggleCard
              label={t("settings.pythonRunDebug")}
              checked={experimentalEnabled(settings, "python_run_debug")}
              onChange={(e) => void updateSettings({ python_run_debug: e.target.checked })}
              help={
                <>
                  {t("settings.pythonRunHelp1")} <code>.py</code> {t("settings.pythonRunHelp2")}{" "}
                  <b>▶ Run</b> {t("settings.pythonRunHelp3")} <b>🐞 Debug</b>{" "}
                  {t("settings.pythonRunHelp4")} <code>pdb</code>
                  {t("settings.pythonRunHelp5")}
                </>
              }
            />

            <div className="settings-section-title">{t("settings.resourceMonitor")}</div>
            <div className="settings-toggle-card">
              <label className="settings-toggle-card-row">
                <span>{t("settings.showCpu")}</span>
                <Toggle
                  checked={settings?.show_cpu_usage ?? true}
                  onChange={(e) => void updateSettings({ show_cpu_usage: e.target.checked })}
                />
              </label>
              <label className="settings-toggle-card-row">
                <span>{t("settings.showRam")}</span>
                <Toggle
                  checked={settings?.show_ram_usage ?? true}
                  onChange={(e) => void updateSettings({ show_ram_usage: e.target.checked })}
                />
              </label>
              <label className="settings-toggle-card-row">
                <span>{t("settings.showGpu")}</span>
                <Toggle
                  checked={settings?.show_gpu_usage ?? true}
                  onChange={(e) => void updateSettings({ show_gpu_usage: e.target.checked })}
                />
              </label>
              <p className="settings-help">{t("settings.resourceMonitorHelp")}</p>
              <label className="settings-toggle-card-row">
                <span>{t("settings.showClockSeconds")}</span>
                <Toggle
                  checked={settings?.show_clock_seconds ?? false}
                  onChange={(e) => void updateSettings({ show_clock_seconds: e.target.checked })}
                />
              </label>
            </div>

            <div className="settings-section-title">{t("settings.calendar")}</div>
            <div className="settings-row">
              <label>{t("settings.weekStartsOn")}</label>
              <Dropdown
                value={String(settings?.calendar_week_start ?? 0)}
                onChange={(v) =>
                  void updateSettings({ calendar_week_start: Number(v) === 1 ? 1 : 0 })
                }
                options={[
                  { value: "0", label: t("day.sunday") },
                  { value: "1", label: t("day.monday") },
                ]}
              />
            </div>
            <div className="settings-row">
              <label>{t("settings.defaultView")}</label>
              <Dropdown
                value={settings?.calendar_default_view ?? "month"}
                onChange={(v) =>
                  void updateSettings({ calendar_default_view: v as CalendarViewKind })
                }
                options={[
                  { value: "day", label: t("view.day") },
                  { value: "week", label: t("view.week") },
                  { value: "multiweek", label: t("view.multiweek") },
                  { value: "month", label: t("view.month") },
                  { value: "agenda", label: t("view.agenda") },
                  { value: "tasks", label: t("view.tasks") },
                ]}
              />
            </div>
            <ToggleCard
              label={t("settings.clock24")}
              checked={settings?.calendar_time_format_24h ?? false}
              onChange={(e) => void updateSettings({ calendar_time_format_24h: e.target.checked })}
            />
            <div className="settings-row">
              <label>{t("settings.dayGridStart")}</label>
              <Dropdown
                value={String(settings?.calendar_day_start_hour ?? 8)}
                onChange={(v) => void updateSettings({ calendar_day_start_hour: Number(v) })}
                options={Array.from({ length: 24 }, (_, h) => ({
                  value: String(h),
                  label: `${String(h).padStart(2, "0")}:00`,
                }))}
              />
            </div>
            <div className="settings-row">
              <label>{t("settings.defaultReminder")}</label>
              <Dropdown
                value={String(settings?.calendar_default_reminder_minutes ?? 0)}
                onChange={(v) =>
                  void updateSettings({ calendar_default_reminder_minutes: Number(v) })
                }
                options={[
                  { value: "0", label: t("reminder.none") },
                  { value: "5", label: t("reminder.5") },
                  { value: "15", label: t("reminder.15") },
                  { value: "30", label: t("reminder.30") },
                  { value: "60", label: t("reminder.60") },
                  { value: "1440", label: t("reminder.1440") },
                ]}
              />
            </div>
            <p className="settings-help">{t("settings.reminderHelp")}</p>

            <div className="settings-section-title">{t("settings.hintsOnboarding")}</div>
            <ToggleCard
              label={t("settings.showHints")}
              checked={settings?.hints_enabled ?? true}
              onChange={(e) => void updateSettings({ hints_enabled: e.target.checked })}
            />
            <div className="settings-link-row">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:open-how-to-start"));
                }}
              >
                {t("settings.howToStart")}
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:start-tour"));
                }}
              >
                {t("settings.takeTour")}
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:open-lessons"));
                }}
              >
                {t("settings.lessons")}
              </button>
              <button type="button" onClick={() => useHintsStore.getState().reset()}>
                {t("settings.resetHints")}
              </button>
            </div>

            <div className="settings-section-title">{t("settings.layout")}</div>
            <p className="settings-help">
              {t("settings.zoomHelp1")} <strong>{t("settings.zoomHelpBold")}</strong>
              {t("settings.zoomHelp2")} <UntestedTag />
            </p>
            <div className="settings-row">
              <label>{t("settings.windowZoom")}</label>
              <Dropdown
                value={String(clampZoom(settings?.ui_zoom))}
                onChange={(v) => {
                  const z = parseFloat(v);
                  void updateSettings({
                    ui_zoom: z === 1 ? undefined : clampZoom(z),
                  });
                }}
                options={ZOOM_STEPS.filter(
                  (z) => z >= MIN_UI_ZOOM && z <= MAX_UI_ZOOM,
                ).map((z) => ({
                  value: String(z),
                  label: `${Math.round(z * 100)}%${z === 1 ? ` (${t("common.default")})` : ""}`,
                }))}
              />
            </div>
            <p className="settings-help">
              {t("settings.minSubwindowHelp", { px: DEFAULT_MIN_SUBWINDOW_PX })}
            </p>
            <div className="settings-row">
              <label htmlFor="min-subwindow-width">{t("settings.minSubWidth")}</label>
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
              <label htmlFor="min-subwindow-height">{t("settings.minSubHeight")}</label>
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

            <div className="settings-section-title">{t("settings.downloads")}</div>
            <p className="settings-help">{t("settings.downloadsHelp")}</p>
            <div className="settings-list">
              {(settings?.download_sources ?? []).length === 0 ? (
                <div className="settings-empty">
                  {t("settings.noDownloadFolders")}
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
                      title={t("settings.removeFolderTitle")}
                    >
                      {t("common.remove")}
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
                {t("settings.addDownloadFolder")}
              </button>
            </div>

            <div className="settings-section-title">{t("settings.usageStats")}</div>
            <ToggleCard
              label={t("settings.dailyRecap")}
              checked={settings?.daily_stats_recap ?? true}
              onChange={(e) => void updateSettings({ daily_stats_recap: e.target.checked })}
              help={t("settings.dailyRecapHelp")}
            />
            <button
              type="button"
              className="btn-primary btn-block"
              onClick={() => {
                onClose();
                window.dispatchEvent(new CustomEvent(OPEN_STATS_EVENT));
              }}
            >
              {t("settings.openUsageStats")}
            </button>

            <div className="settings-section-title">{t("settings.moreSettings")}</div>
            <div className="settings-nav-list">
              {SETTINGS_NAV.map((panelKind) => (
                <button
                  key={panelKind}
                  type="button"
                  className="settings-nav-item"
                  onClick={() => setPanel(panelKind)}
                >
                  <span className="settings-nav-item-title">
                    {t(`nav.${panelKind}.title` as TranslationKey)}
                  </span>
                  <span className="settings-nav-item-blurb">
                    {t(`nav.${panelKind}.blurb` as TranslationKey)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {panel === "global" && <GlobalAppsSettings onBack={() => setPanel("main")} />}
        {panel === "filetypes" && <FileTypeSettings onBack={() => setPanel("main")} />}
        {panel === "ollama" && <OllamaPanel onBack={() => setPanel("main")} />}
        {panel === "agents" && <AgentsPanel onBack={() => setPanel("main")} />}
        {panel === "shortcuts" && <ShortcutsSettings onBack={() => setPanel("main")} />}
        {panel === "git" && <GitHostingSettings onBack={() => setPanel("main")} />}
        {panel === "vpn" && <VpnAutoConnectSettings onBack={() => setPanel("main")} />}
        {panel === "remoteHosts" && <RemoteHostsSettings onBack={() => setPanel("main")} />}
        {panel === "archive" && <ArchivedProjectsPanel onBack={() => setPanel("main")} />}
        {panel === "scaffoldRepair" && <ScaffoldRepairPanel onBack={() => setPanel("main")} />}
        {panel === "help" && <HelpPanel onBack={() => setPanel("main")} />}
       </div>
      </div>
    </div>
  );
}
