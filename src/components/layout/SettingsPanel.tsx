import { useEffect, useRef, useState } from "react";
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
import { DEFAULT_MAIL_CHECK_MIN } from "../../lib/mail";
import type {
  ArchivedProject,
  CalendarViewKind,
  GitProvider,
  KeyboardChord,
  ProjectEntry,
  Theme,
  UnsyncedReport,
} from "../../types";
import { THEMES } from "../../types";
import type { LinkOpenTarget } from "../../types/browser";
import { summarizeScaffoldRepair, type ProjectScaffoldRepair } from "../projects/scaffold";
import { providerName } from "../projects/projectTypeTags";
import { GitTokenScopes, tokenPageUrl } from "../common/GitTokenScopes";
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
import { useUse24h } from "../../lib/timeFormat";
import { IS_MAC, IS_WINDOWS } from "../../lib/platform";
import { useHintsStore } from "../../stores/hints";
import { canConnectVpnSilently } from "../../lib/vpnConnect";
import { setVpnAutoConnect, vpnUsernameFor } from "../../lib/vpnAutoConnect";
import type { StoredVpnConfig } from "../../types";
import { MobileSettings } from "../mobile/MobileSettings";
import { UpdatesPanel } from "./UpdatesPanel";
import {
  SettingRow,
  SettingsCard,
  SettingsHeader,
  SettingsList,
  SettingsSection,
  ToggleCard,
  ToggleRow,
} from "./settingsUi";

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

/** Every sub-panel takes the same two: `onBack` returns to the main panel,
 *  `onClose` dismisses the whole dialog. Optional because the panels are also
 *  rendered standalone in tests. */
interface SubPanelProps {
  onBack: () => void;
  onClose?: () => void;
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

/**
 * The Feature Guide's contents, in reading order: the window itself, then
 * projects, then what runs in a tab, then the surfaces that are their own
 * applications, then everything that leaves this machine, then the rest.
 * Terms and descriptions are i18n keys (`help.<section>.item<N>.term|desc`) —
 * add a row here and its two keys in every language block.
 */
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
      { termKey: "help.projects.item5.term", descKey: "help.projects.item5.desc" },
    ],
  },
  {
    titleKey: "help.aiTerminals.title",
    items: [
      { termKey: "help.aiTerminals.item1.term", descKey: "help.aiTerminals.item1.desc" },
      { termKey: "help.aiTerminals.item2.term", descKey: "help.aiTerminals.item2.desc" },
      { termKey: "help.aiTerminals.item3.term", descKey: "help.aiTerminals.item3.desc" },
      { termKey: "help.aiTerminals.item4.term", descKey: "help.aiTerminals.item4.desc" },
    ],
  },
  {
    titleKey: "help.filesViewers.title",
    items: [
      { termKey: "help.filesViewers.item1.term", descKey: "help.filesViewers.item1.desc" },
      { termKey: "help.filesViewers.item2.term", descKey: "help.filesViewers.item2.desc" },
      { termKey: "help.filesViewers.item3.term", descKey: "help.filesViewers.item3.desc" },
      { termKey: "help.filesViewers.item4.term", descKey: "help.filesViewers.item4.desc" },
      { termKey: "help.filesViewers.item5.term", descKey: "help.filesViewers.item5.desc" },
    ],
  },
  {
    titleKey: "help.mailCalendar.title",
    items: [
      { termKey: "help.mailCalendar.item1.term", descKey: "help.mailCalendar.item1.desc" },
      { termKey: "help.mailCalendar.item2.term", descKey: "help.mailCalendar.item2.desc" },
      { termKey: "help.mailCalendar.item3.term", descKey: "help.mailCalendar.item3.desc" },
      { termKey: "help.mailCalendar.item4.term", descKey: "help.mailCalendar.item4.desc" },
    ],
  },
  {
    titleKey: "help.remoteMachines.title",
    items: [
      { termKey: "help.remoteMachines.item1.term", descKey: "help.remoteMachines.item1.desc" },
      { termKey: "help.remoteMachines.item2.term", descKey: "help.remoteMachines.item2.desc" },
      { termKey: "help.remoteMachines.item3.term", descKey: "help.remoteMachines.item3.desc" },
      { termKey: "help.remoteMachines.item4.term", descKey: "help.remoteMachines.item4.desc" },
      { termKey: "help.remoteMachines.item5.term", descKey: "help.remoteMachines.item5.desc" },
    ],
  },
  {
    titleKey: "help.settingsExtras.title",
    items: [
      { termKey: "help.settingsExtras.item1.term", descKey: "help.settingsExtras.item1.desc" },
      { termKey: "help.settingsExtras.item2.term", descKey: "help.settingsExtras.item2.desc" },
      { termKey: "help.settingsExtras.item3.term", descKey: "help.settingsExtras.item3.desc" },
      { termKey: "help.settingsExtras.item4.term", descKey: "help.settingsExtras.item4.desc" },
    ],
  },
];

/**
 * Group L / #62 — let the user rebind the eight navigation chords. Click a
 * row's chord button to enter capture mode; the next non-modifier keydown is
 * stored as the override (persisted to `settings.keyboard_shortcuts`). "Reset"
 * clears an override back to its built-in default.
 */
function ShortcutsSettings({ onBack, onClose }: SubPanelProps) {
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
      <SettingsHeader title={t("nav.shortcuts.title")} onBack={onBack} onClose={onClose} />
      <p className="settings-help">{t("shortcuts.help")}</p>
      <SettingsList boxed>
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
                className="settings-btn sm"
                disabled={!isCustom}
                onClick={() => reset(def.action)}
                title={t("shortcuts.resetTitle")}
              >
                {t("common.reset")}
              </button>
            </div>
          );
        })}
      </SettingsList>
    </>
  );
}

/**
 * Git hosting profile + access token, broken out of the main settings panel
 * into its own sub-menu. Manages its own draft state (mirroring the saved
 * settings) and persists on blur / Enter, same as it did inline.
 */
function GitHostingSettings({ onBack, onClose }: SubPanelProps) {
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

  // Which provider the token hint and permission guide describe. Derived live
  // from the profile URL being typed (the only provider signal a global,
  // project-less setting has), defaulting to GitHub as everywhere else.
  const provider: GitProvider = gitProfileUrl.toLowerCase().includes("gitlab")
    ? "gitlab"
    : "github";

  return (
    <>
      <SettingsHeader title={t("nav.git.title")} onBack={onBack} onClose={onClose} />
      <p className="settings-help">{t("git.help")}</p>
      <SettingsCard>
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
      <span className="ssh-optional-hint">
        {t("pill.getTokenHint")}{" "}
        <button
          type="button"
          className="inline-link-btn"
          onClick={() =>
            void invoke("open_external_url", { url: tokenPageUrl(provider, gitProfileUrl) })
          }
        >
          {t("pill.getTokenCta", { provider: providerName(provider) })}
        </button>
      </span>
      </SettingsCard>
      <GitTokenScopes provider={provider} />
    </>
  );
}

/**
 * Same setting the header's VPN menu arms per config (`settings.vpn_auto_connect`,
 * see `lib/vpnAutoConnect.ts`) — surfaced here too since the header menu only shows
 * up once a tunnel exists, which makes this opt-in easy to miss.
 */
function VpnAutoConnectSettings({ onBack, onClose }: SubPanelProps) {
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
      <SettingsHeader title={t("nav.vpn.title")} onBack={onBack} onClose={onClose} />
      <p className="settings-help">{t("vpn.autoConnectHelp")}</p>
      {configs === null ? (
        <p className="settings-help">{t("common.loading")}</p>
      ) : configs.length === 0 ? (
        <div className="settings-empty">{t("vpn.noConfig")}</div>
      ) : (
        <SettingsList>
          {configs.map((c) => {
            const on = armed === c.path;
            const eligible = !headless || silent[c.path] === true;
            return (
              <SettingsCard key={c.path}>
                <ToggleRow
                  label={<span title={c.path}>{c.name}</span>}
                  checked={on}
                  disabled={!eligible && !on}
                  onChange={(e) => void setVpnAutoConnect(c.path, e.target.checked)}
                />
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
              </SettingsCard>
            );
          })}
        </SettingsList>
      )}
    </>
  );
}

function ArchivedProjectsPanel({ onBack, onClose }: SubPanelProps) {
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
      <SettingsHeader title={t("nav.archive.title")} onBack={onBack} onClose={onClose} />
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
                    <button type="button" className="settings-btn sm" onClick={resetConfirm} disabled={rowBusy}>{t("common.cancel")}</button>
                    <button
                      type="button"
                      className="settings-btn sm danger"
                      disabled={rowBusy || typed.trim() !== a.name.trim()}
                      onClick={() => void deleteForever(a)}
                    >
                      {rowBusy ? t("archive.deleting") : t("archive.deleteForever")}
                    </button>
                  </div>
                  </div>
                ) : (
                  <div className="archived-project-actions">
                    <button type="button" className="settings-btn sm" disabled={rowBusy} onClick={() => void restore(a)}>
                      {rowBusy ? t("archive.restoring") : t("archive.restore")}
                    </button>
                    <button
                      type="button"
                      className="settings-btn sm danger"
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
            <button type="button" className="settings-btn sm" onClick={() => { setClearing(false); setClearTyped(""); }}>{t("common.cancel")}</button>
            <button
              type="button"
              className="settings-btn sm danger"
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

function ScaffoldRepairPanel({ onBack, onClose }: SubPanelProps) {
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
      {/* The repair now *rewrites* untouched legacy agent stubs, not just fills
          gaps — new behavior, never run in a live window. */}
      <SettingsHeader
        title={<>{t("nav.scaffoldRepair.title")} <UntestedTag /></>}
        onBack={onBack}
        onClose={onClose}
      />
      <p className="settings-help">{t("scaffoldRepair.help")}</p>
      {error && <div className="project-dialog-error">{error}</div>}
      <div className="settings-link-row">
        <button type="button" className="settings-btn primary" disabled={busy} onClick={() => void run()}>
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

function HelpPanel({ onBack, onClose }: SubPanelProps) {
  const t = useT();
  return (
    <>
      <SettingsHeader title={t("help.title")} onBack={onBack} onClose={onClose} />

      <p className="settings-help">{t("help.intro")}</p>

      {HELP_SECTIONS.map((section) => (
        <div key={section.titleKey} className="help-section">
          <SettingsSection
            title={t(section.titleKey)}
            help={section.hasIntro ? workspaceLayoutIntro(t) : undefined}
          />
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

export type SettingsPanelKind = "main" | "global" | "filetypes" | "ollama" | "agents" | "shortcuts" | "git" | "vpn" | "remoteHosts" | "archive" | "scaffoldRepair" | "updates" | "help";

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
  "updates",
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
  // Through the hook, never off `settings`: unset means "not chosen", and only
  // `resolveUse24h` knows that it then follows the language. Reading the raw key
  // with a `?? false` would show the switch off for a German user whose clock is
  // in fact 24-hour — a control lying about the state it is controlling.
  const use24h = useUse24h();

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
            <SettingsHeader title={t("settings.title")} onClose={onClose} />

            <SettingRow
              label={t("settings.theme")}
              control={
                <Dropdown
                  value={currentTheme}
                  onChange={(v) => void setTheme(v as Theme)}
                  options={THEMES.map((theme) => ({ value: theme.value, label: theme.label }))}
                />
              }
            />

            <SettingRow
              label={<>{t("settings.language")} <UntestedTag /></>}
              help={t("settings.language.help")}
              control={
                <Dropdown
                  value={currentLang}
                  onChange={(v) => void setLanguage(v as Language)}
                  options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
                />
              }
            />

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

            {!IS_WINDOWS && (
              <>
                <SettingsSection title={t("settings.mobile")} />
                <MobileSettings />
                <ToggleCard
                  label={t("settings.mobileIndicator")}
                  checked={settings?.mobile_indicator ?? true}
                  onChange={(e) => void updateSettings({ mobile_indicator: e.target.checked })}
                  help={t("settings.mobileIndicatorHelp")}
                />
              </>
            )}

            <SettingsSection title={t("settings.remoteFeatures")} />
            <SettingsCard>
              <ToggleRow
                label={t("settings.vpnEnabled")}
                checked={settings?.vpn_enabled ?? false}
                onChange={(e) => void updateSettings({ vpn_enabled: e.target.checked })}
              />
              <ToggleRow
                label={t("settings.machinesEnabled")}
                checked={settings?.machines_enabled ?? false}
                onChange={(e) => void updateSettings({ machines_enabled: e.target.checked })}
              />
              <p className="settings-help">{t("settings.remoteFeaturesHelp")}</p>
            </SettingsCard>

            <SettingRow
              label={t("settings.energySaver")}
              help={<>{t("settings.energyHelp")} {energyStatus}</>}
              control={
                <Dropdown
                  value={energyMode}
                  onChange={(v) => void updateSettings({ energy_saver: v as "off" | "battery" | "always" })}
                  options={[
                    { value: "off", label: t("energy.off") },
                    { value: "battery", label: t("energy.battery") },
                    { value: "always", label: t("energy.always") },
                  ]}
                />
              }
            />

            {/* Beside Energy Saver rather than folded into it: that one widens
                timers off a live battery reading, this removes features off a
                standing preference, and "plugged in, still want it lean" is the
                case a merged control could not express. `lib/fastMode` holds the
                list of what goes — the help string above mirrors it. */}
            <ToggleCard
              label={
                <>
                  {t("settings.fastMode")} <UntestedTag />
                </>
              }
              checked={settings?.fast_mode === true}
              onChange={(e) => void updateSettings({ fast_mode: e.target.checked })}
              help={t("settings.fastModeHelp")}
            />

            <ToggleCard
              label={t("settings.debug")}
              checked={settings?.debug ?? false}
              onChange={(e) => void updateSettings({ debug: e.target.checked })}
            />

            <SettingsSection
              title={t("settings.experimental")}
              help={
                <>
                  {t("settings.experimentalHelp1")}{" "}
                  <b>{t("settings.experimentalHelpBold")}</b> {t("settings.experimentalHelp2")}{" "}
                  {t("settings.experimentalHelp3")}
                </>
              }
            />

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

            {/* An experiment rather than the default because WebGL rides the
                GPU/driver path the DMABUF re-test failed on (flicker, missing
                content, renderer crash — docs/typing_latency_plan.md Step 4):
                canvas is the safe renderer, and a terminal whose WebGL fails
                demotes itself back to it (TerminalView's renderer ladder). */}
            <ToggleCard
              label={<>{t("settings.terminalWebgl")} <UntestedTag /></>}
              checked={experimentalEnabled(settings, "terminal_webgl")}
              onChange={(e) => void updateSettings({ terminal_webgl: e.target.checked })}
              help={t("settings.terminalWebglHelp")}
            />

            <ToggleCard
              label={<>{t("settings.mdGraph")} <UntestedTag /></>}
              checked={experimentalEnabled(settings, "md_graph")}
              onChange={(e) => void updateSettings({ md_graph: e.target.checked })}
              help={t("settings.mdGraphHelp")}
            />

            <ToggleCard
              label={<>{t("settings.projectRemarks")} <UntestedTag /></>}
              checked={experimentalEnabled(settings, "project_remarks")}
              onChange={(e) => void updateSettings({ project_remarks: e.target.checked })}
              help={t("settings.projectRemarksHelp")}
            />

            {/* Mail is ONE switch. It used to be two — this gate plus a
                `mail_global_app` sub-toggle deciding whether the header button
                appeared *as well as* the mail tab — but the tab is retired, so
                the overlay is the only surface and a second switch could only
                ever mean "mail on, and unreachable". The interval check stays
                nested because it is genuinely a different question (how often to
                dial out), and it is the one part of the feature that reaches the
                network without a click. The browser below still owns a whole TAB,
                so switching *it* off closes what it opened — see
                lib/experimentalSweep. */}
            <SettingsCard>
              <ToggleRow
                label={<>{t("settings.mailClient")} <UntestedTag /></>}
                checked={experimentalEnabled(settings, "mail_client")}
                onChange={(e) => void updateSettings({ mail_client: e.target.checked })}
              />
              <p className="settings-help">{t("settings.mailClientHelp")}</p>
              {experimentalEnabled(settings, "mail_client") && (
                <>
                  <div className="settings-card-row">
                    <span>{t("settings.mailCheckInterval")}</span>
                    <Dropdown
                      value={String(
                        settings?.mail_check_interval_min ?? DEFAULT_MAIL_CHECK_MIN,
                      )}
                      onChange={(v) =>
                        void updateSettings({ mail_check_interval_min: Number(v) })
                      }
                      options={[
                        { value: "0", label: t("settings.mailCheckNever") },
                        { value: "5", label: t("settings.mailCheckMinutes", { count: 5 }) },
                        { value: "10", label: t("settings.mailCheckMinutes", { count: 10 }) },
                        { value: "15", label: t("settings.mailCheckMinutes", { count: 15 }) },
                        { value: "30", label: t("settings.mailCheckMinutes", { count: 30 }) },
                        { value: "60", label: t("settings.mailCheckMinutes", { count: 60 }) },
                      ]}
                    />
                  </div>
                  <p className="settings-help">{t("settings.mailCheckIntervalHelp")}</p>
                </>
              )}
            </SettingsCard>

            <ToggleCard
              label={t("settings.webBrowser")}
              checked={experimentalEnabled(settings, "web_browser")}
              onChange={(e) => void updateSettings({ web_browser: e.target.checked })}
              help={
                <>
                  {t("settings.webBrowserHelp1")} <b>{t("browser.readerMode")}</b>{" "}
                  {t("settings.webBrowserHelp2")}
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

            {/* Mail AI (local) — Group Q #203 — is configured **per account**
                now, from the mail toolbar (a bordered group with the global
                master switch and per-account quick-toggle tags), not here. There
                are deliberately no global per-feature toggles in this panel. */}

            <SettingsSection title={t("settings.resourceMonitor")} />
            <SettingsCard>
              <ToggleRow
                label={t("settings.showCpu")}
                checked={settings?.show_cpu_usage ?? true}
                onChange={(e) => void updateSettings({ show_cpu_usage: e.target.checked })}
              />
              <ToggleRow
                label={t("settings.showRam")}
                checked={settings?.show_ram_usage ?? true}
                onChange={(e) => void updateSettings({ show_ram_usage: e.target.checked })}
              />
              <ToggleRow
                label={t("settings.showGpu")}
                checked={settings?.show_gpu_usage ?? true}
                onChange={(e) => void updateSettings({ show_gpu_usage: e.target.checked })}
              />
              <p className="settings-help">{t("settings.resourceMonitorHelp")}</p>
            </SettingsCard>

            {/* The clock lives in its own section, not under Resource monitor:
                seconds and the 12/24-hour face are time, not CPU/RAM/GPU. */}
            <SettingsSection title={t("settings.clock")} />
            <SettingsCard>
              <ToggleRow
                label={t("settings.showClockSeconds")}
                checked={settings?.show_clock_seconds ?? false}
                onChange={(e) => void updateSettings({ show_clock_seconds: e.target.checked })}
              />
              {/* App-wide, and here rather than under Calendar (where it used to
                  live as a calendar-only switch): a clock is not a property of
                  one feature, and reading 17:00 in the calendar beside 5:00 PM
                  on a to-do card is one app disagreeing with itself. Unset
                  follows the UI language, which is why the help line says what
                  the default is rather than leaving the off position to imply
                  it — see `lib/timeFormat.ts`. */}
              <ToggleRow
                label={t("settings.clock24")}
                checked={use24h}
                onChange={(e) => void updateSettings({ time_format_24h: e.target.checked })}
              />
              <p className="settings-help">{t("settings.clock24Help")}</p>
            </SettingsCard>

            <SettingsSection title={t("settings.calendar")} />

            {/* The calendar's twin of "Mail in the header". Not nested under
                anything: the calendar is shipped, not experimental. */}
            <ToggleCard
              label={<>{t("settings.calendarGlobalApp")} <UntestedTag /></>}
              checked={settings?.calendar_global_app ?? false}
              onChange={(e) => void updateSettings({ calendar_global_app: e.target.checked })}
              help={t("settings.calendarGlobalAppHelp")}
            />

            {/* The to-do board sits under Calendar because that is literally
                where its cards live: they ARE this calendar's tasks, so the
                board is a second view of the store above, not a second store. */}
            <ToggleCard
              label={<>{t("settings.todoBoard")} <UntestedTag /></>}
              checked={settings?.todo_board ?? false}
              onChange={(e) => void updateSettings({ todo_board: e.target.checked })}
              help={t("settings.todoBoardHelp")}
            />

            {/* The four calendar defaults are one question ("how should the
                calendar open?"), so they share a card and read as a group. */}
            <SettingsCard>
              <div className="settings-card-row">
                <span>{t("settings.weekStartsOn")}</span>
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
              <div className="settings-card-row">
                <span>{t("settings.defaultView")}</span>
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
              <div className="settings-card-row">
                <span>{t("settings.dayGridStart")}</span>
                <Dropdown
                  value={String(settings?.calendar_day_start_hour ?? 8)}
                  onChange={(v) => void updateSettings({ calendar_day_start_hour: Number(v) })}
                  options={Array.from({ length: 24 }, (_, h) => ({
                    value: String(h),
                    label: `${String(h).padStart(2, "0")}:00`,
                  }))}
                />
              </div>
              <div className="settings-card-row">
                <span>{t("settings.defaultReminder")}</span>
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
            </SettingsCard>

            {/* The in-app browser (#61). Everything here is a *preference*; the
                navigation policy, the permission defaults and the download rule
                are the backend's and are not configurable — a "trusted sites"
                list or an "ignore certificate errors" switch is exactly the kind
                of relaxation that outlives the reason for it, so none exists. */}
            <SettingsSection title={<>{t("settings.browser")} <UntestedTag /></>} />
            <SettingRow
              htmlFor="browser-home-url"
              label={t("settings.browserHome")}
              help={t("settings.browserHomeHelp")}
              control={
                <input
                  id="browser-home-url"
                  type="text"
                  value={settings?.browser_home_url ?? ""}
                  placeholder={t("settings.browserHomePlaceholder")}
                  onChange={(e) => void updateSettings({ browser_home_url: e.target.value })}
                />
              }
            />
            <SettingRow
              htmlFor="browser-search-template"
              label={t("settings.browserSearch")}
              help={t("settings.browserSearchHelp")}
              control={
                <input
                  id="browser-search-template"
                  type="text"
                  value={settings?.browser_search_template ?? ""}
                  placeholder="https://duckduckgo.com/?q=%s"
                  onChange={(e) => void updateSettings({ browser_search_template: e.target.value })}
                />
              }
            />
            <SettingRow
              label={t("settings.browserLinkTarget")}
              help={t("settings.browserLinkTargetHelp")}
              control={
                <Dropdown
                  value={settings?.browser_link_target ?? "external"}
                  onChange={(v) =>
                    void updateSettings({ browser_link_target: v as LinkOpenTarget })
                  }
                  options={[
                    { value: "external", label: t("settings.browserLinkTargetExternal") },
                    { value: "in_app", label: t("settings.browserLinkTargetInApp") },
                    { value: "ask", label: t("settings.browserLinkTargetAsk") },
                  ]}
                />
              }
            />
            <ToggleCard
              label={t("settings.browserRestoreNavigate")}
              checked={settings?.browser_restore_navigate ?? false}
              onChange={(e) =>
                void updateSettings({ browser_restore_navigate: e.target.checked })
              }
              help={t("settings.browserRestoreNavigateHelp")}
            />
            {/* Deliberately `?? false` and NOT `useExperimental` — this is the one
                browser switch that must stay off in a debug build too. */}
            <ToggleCard
              label={t("settings.browserLivePages")}
              checked={settings?.browser_live_pages ?? false}
              onChange={(e) => void updateSettings({ browser_live_pages: e.target.checked })}
              help={t("settings.browserLivePagesHelp")}
            />

            <SettingsSection title={t("settings.hintsOnboarding")} />
            <ToggleCard
              label={t("settings.showHints")}
              checked={settings?.hints_enabled ?? true}
              onChange={(e) => void updateSettings({ hints_enabled: e.target.checked })}
            />
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:open-how-to-start"));
                }}
              >
                {t("settings.howToStart")}
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:start-tour"));
                }}
              >
                {t("settings.takeTour")}
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:start-advanced-tour"));
                }}
              >
                {t("settings.takeAdvancedTour")} <UntestedTag />
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new Event("eldrun:open-lessons"));
                }}
              >
                {t("settings.lessons")}
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => useHintsStore.getState().reset()}
              >
                {t("settings.resetHints")}
              </button>
            </div>

            <SettingsSection
              title={<>{t("settings.layout")} <UntestedTag /></>}
              help={
                <>
                  {t("settings.zoomHelp1")} <strong>{t("settings.zoomHelpBold")}</strong>
                  {t("settings.zoomHelp2")}
                </>
              }
            />
            <SettingRow
              label={t("settings.windowZoom")}
              control={
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
              }
            />
            {/* Both minimums answer one question, so one card holds them and
                the help line that explains the pair sits at its foot. */}
            <SettingsCard>
              <div className="settings-card-row">
                <label className="settings-card-label" htmlFor="min-subwindow-width">
                  {t("settings.minSubWidth")}
                </label>
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
              <div className="settings-card-row">
                <label className="settings-card-label" htmlFor="min-subwindow-height">
                  {t("settings.minSubHeight")}
                </label>
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
              <p className="settings-help">
                {t("settings.minSubwindowHelp", { px: DEFAULT_MIN_SUBWINDOW_PX })}
              </p>
            </SettingsCard>

            <SettingsSection
              title={t("settings.downloads")}
              help={t("settings.downloadsHelp")}
            />
            <SettingsList boxed>
              {(settings?.download_sources ?? []).length === 0 ? (
                <div className="settings-empty">
                  {t("settings.noDownloadFolders")}
                </div>
              ) : (
                (settings?.download_sources ?? []).map((dir) => (
                  <div key={dir} className="settings-row">
                    <span className="settings-list-label" title={dir}>
                      {dir}
                    </span>
                    <button
                      type="button"
                      className="settings-btn sm"
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
            </SettingsList>
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn"
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

            <SettingsSection title={t("settings.usageStats")} />
            <ToggleCard
              label={t("settings.dailyRecap")}
              checked={settings?.daily_stats_recap ?? true}
              onChange={(e) => void updateSettings({ daily_stats_recap: e.target.checked })}
              help={t("settings.dailyRecapHelp")}
            />
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn primary"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new CustomEvent(OPEN_STATS_EVENT));
                }}
              >
                {t("settings.openUsageStats")}
              </button>
            </div>

            <SettingsSection title={t("settings.moreSettings")} />
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
        {panel === "global" && <GlobalAppsSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "filetypes" && <FileTypeSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "ollama" && <OllamaPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "agents" && <AgentsPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "shortcuts" && <ShortcutsSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "git" && <GitHostingSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "vpn" && <VpnAutoConnectSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "remoteHosts" && <RemoteHostsSettings onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "archive" && <ArchivedProjectsPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "scaffoldRepair" && <ScaffoldRepairPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "updates" && <UpdatesPanel onBack={() => setPanel("main")} onClose={onClose} />}
        {panel === "help" && <HelpPanel onBack={() => setPanel("main")} onClose={onClose} />}
       </div>
      </div>
    </div>
  );
}
