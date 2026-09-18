import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { runInstallInTab } from "../../lib/installCommand";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { Toggle } from "../common/Toggle";
import { SettingsCard } from "./settingsUi";

/** Backend `copilot_setup`. */
interface CopilotSetup { supported: boolean; installed: boolean; installCommand: string | null }
/** Backend `copilot_account`: never starts a server, so `running` may be false. */
interface CopilotAccount {
  running: boolean;
  status?: { kind: string; message: string | null };
  account?: { status?: string | null; user?: string | null } | null;
}

/** #45a: provider choice, install, the active project's consent and the
 *  device sign-in. Consent is written by the backend, which binds it to the
 *  directory it resolves itself; this card never sends a path. */
export function CopilotCompletionCard() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === s.activeId));
  const [setup, setSetup] = useState<CopilotSetup | null>(null);
  const [account, setAccount] = useState<CopilotAccount | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const provider = settings?.code_completion_provider ?? "ollama";
  const policy = project ? settings?.completion_project_policies?.[project.id] : undefined;
  const remote = !!project?.remote;
  const consented = policy?.copilot === true && policy.local_only !== true && !remote;
  const projectId = project?.id;

  const recheck = useCallback(() => {
    void invoke<CopilotSetup>("copilot_setup").then(setSetup).catch(() => setSetup(null));
  }, []);
  useEffect(recheck, [recheck]);

  const refreshAccount = useCallback(() => {
    if (!projectId) { setAccount(null); return; }
    void invoke<CopilotAccount>("copilot_account", { projectId }).then(setAccount).catch(() => setAccount(null));
  }, [projectId]);
  useEffect(refreshAccount, [refreshAccount, consented, provider]);

  const setPolicy = async (copilot: boolean, localOnly: boolean) => {
    if (!projectId) return;
    setError(null);
    try {
      const saved = await invoke<Settings>("copilot_set_project_policy", { projectId, copilot, localOnly });
      // Through the ordinary path so every window hears about it.
      await updateSettings({ completion_project_policies: saved.completion_project_policies });
      if (!copilot || localOnly) { setCode(null); refreshAccount(); }
    } catch (e) {
      setError(String(e));
    }
  };

  const signIn = async () => {
    if (!projectId) return;
    setError(null);
    try {
      const device = await invoke<{ userCode: string; verificationUri: string } | null>("copilot_sign_in", { projectId });
      if (device) {
        setCode(device.userCode);
        void invoke("open_external_url", { url: device.verificationUri }).catch(() => {});
        await invoke("copilot_finish_sign_in", { projectId });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setCode(null);
      refreshAccount();
    }
  };

  const signOut = async () => {
    if (!projectId) return;
    await invoke("copilot_sign_out", { projectId }).catch((e) => setError(String(e)));
    refreshAccount();
  };

  const signedIn = account?.running && !!account.account?.user;
  return (
    <SettingsCard>
      <p className="settings-help">{t("settings.copilotCloudNotice")}</p>
      <label className="settings-toggle-card-row">
        <span>{t("settings.copilotProvider")}</span>
        <select
          className="ollama-pull-input"
          value={provider}
          onChange={(e) => void updateSettings({ code_completion_provider: e.target.value as "ollama" | "copilot" })}
        >
          <option value="ollama">{t("settings.copilotProviderOllama")}</option>
          <option value="copilot">{t("settings.copilotProviderCopilot")}</option>
        </select>
      </label>

      {setup && !setup.supported && <p className="settings-help">{t("settings.copilotUnsupported")}</p>}
      {setup?.supported && !setup.installed && setup.installCommand && (
        <div className="ollama-install-cmd-row">
          <span className="settings-help">{t("settings.copilotNotInstalled")}</span>
          <button
            type="button"
            className="ollama-action-btn primary"
            onClick={() => runInstallInTab(t("settings.copilotInstallTabLabel"), setup.installCommand!, "bash")}
          >
            {t("agents.runInTerminal")}
          </button>
          <button type="button" className="ollama-action-btn" onClick={recheck}>{t("common.recheck")}</button>
        </div>
      )}
      {setup?.installed && <p className="settings-help">{t("settings.copilotInstalled")}</p>}

      {project ? (
        <>
          <label className="settings-toggle-card-row">
            <span>{t("settings.copilotProjectConsent", { project: project.name })}</span>
            <Toggle
              checked={policy?.copilot === true && !remote}
              disabled={remote || policy?.local_only === true}
              onChange={(e) => void setPolicy(e.target.checked, false)}
            />
          </label>
          <label className="settings-toggle-card-row">
            <span>{t("settings.copilotProjectLocalOnly")}</span>
            <Toggle
              checked={policy?.local_only === true}
              onChange={(e) => void setPolicy(false, e.target.checked)}
            />
          </label>
          <p className="settings-help">
            {remote ? t("settings.copilotRemoteProject") : t("settings.copilotProjectConsentHelp")}
          </p>
        </>
      ) : (
        <p className="settings-help">{t("settings.copilotNoProject")}</p>
      )}

      {provider === "copilot" && consented && setup?.installed && (
        <div className="ollama-install-cmd-row">
          <span className="settings-help">
            {code ? t("settings.copilotEnterCode", { code })
              : signedIn ? t("settings.copilotSignedIn", { user: account?.account?.user ?? "" })
              : t("settings.copilotSignedOut")}
          </span>
          {signedIn ? (
            <button type="button" className="ollama-action-btn" onClick={() => void signOut()}>
              {t("settings.copilotSignOut")}
            </button>
          ) : (
            <button type="button" className="ollama-action-btn primary" disabled={!!code} onClick={() => void signIn()}>
              {t("settings.copilotSignIn")}
            </button>
          )}
        </div>
      )}
      {account?.status?.message && <p className="settings-help">{account.status.message}</p>}
      {error && <p className="settings-help">{t("settings.copilotError", { error })}</p>}
      <p className="settings-help">{t("settings.copilotSessionOnly")}</p>
    </SettingsCard>
  );
}
