import { useState } from "react";
import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import {
  mailAiClassifyApply,
  mailAiErrorKey,
  mailAiResolvable,
  type MailAiFeature,
} from "../../lib/mail";
import type { MailAiClassifyReport } from "../../types/mail";

/**
 * The **Mail AI (local)** settings section (Group Q #203).
 *
 * Six toggles, all **default off**, each additionally gated by a resolvable
 * loopback mail-role model — the section is only rendered when `mail_client` is
 * on (its caller checks that), and the toggles are disabled with a stated reason
 * when no loopback model is assigned, because a switch that turns on a feature
 * that cannot run is a switch that lies.
 *
 * It also hosts the manual **"what would the model catch"** preview (#205), the
 * counterpart to the sync-time classifier, rendered distinctly from the keyword
 * filter report — its own title and a line saying these are the model's
 * suggestions, not the user's rules.
 */
/** The `Settings` boolean keys this section writes. */
type MailAiToggleKey = MailAiFeature | "mail_ai_auto_create";

function AiToggle({
  featureKey,
  label,
  help,
  disabled,
}: {
  featureKey: MailAiToggleKey;
  label: string;
  help: string;
  disabled: boolean;
}) {
  const { settings, updateSettings } = useSettingsStore();
  const checked = settings?.[featureKey] === true;
  return (
    <div className="settings-toggle-card">
      <label className="settings-toggle-card-row">
        <span>{label}</span>
        <Toggle
          checked={checked}
          disabled={disabled}
          onChange={(e) => void updateSettings({ [featureKey]: e.target.checked })}
        />
      </label>
      <p className="settings-help">{help}</p>
    </div>
  );
}

export function MailAiSettings() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const resolvable = mailAiResolvable(settings);
  const disabled = !resolvable;

  const [report, setReport] = useState<MailAiClassifyReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const runPreview = async () => {
    setRunning(true);
    setError("");
    setReport(null);
    try {
      const r = await mailAiClassifyApply(true, {});
      setReport(r);
    } catch (err) {
      const key = mailAiErrorKey(err);
      setError(key ? t(key) : typeof err === "string" ? err : String(err));
    } finally {
      setRunning(false);
    }
  };

  const priorityLabel = (p: string) =>
    p === "urgent" ? t("mailAi.priorityUrgent") : t("mailAi.priorityImportant");

  return (
    <>
      <div className="settings-section-title">
        {t("mailAi.settingsTitle")} <UntestedTag />
      </div>
      <p className="settings-help">{t("mailAi.settingsHelp")}</p>
      {!resolvable && <p className="settings-help mail-ai-unavailable">{t("mailAi.unavailable")}</p>}

      <AiToggle
        featureKey="mail_ai_summarize"
        label={t("mailAi.toggleSummarize")}
        help={t("mailAi.toggleSummarizeHelp")}
        disabled={disabled}
      />
      <AiToggle
        featureKey="mail_ai_autoclassify"
        label={t("mailAi.toggleAutoclassify")}
        help={t("mailAi.toggleAutoclassifyHelp")}
        disabled={disabled}
      />

      {/* The manual "what would this catch" preview — a dry run of the same
          classifier the sync uses, rendered distinctly from the keyword-filter
          report so the model's suggestions never pass for the user's rules. */}
      <div className="mail-ai-preview">
        <button
          type="button"
          className="mail-btn"
          disabled={disabled || running}
          onClick={() => void runPreview()}
        >
          {running ? t("mailAi.classifyRunning") : t("mailAi.classifyPreview")}
        </button>
        {error && <div className="project-dialog-error">{error}</div>}
        {report && (
          <div className="mail-ai-report">
            <div className="mail-ai-report-head">
              <strong>{t("mailAi.classifyReportTitle")}</strong>
              <UntestedTag />
            </div>
            <p className="settings-help">{t("mailAi.classifyDistinct")}</p>
            <p className="settings-help">
              {t("mailAi.classifyScanned", { count: report.scanned })}
            </p>
            {report.matched.length === 0 ? (
              <p className="settings-help">{t("mailAi.classifyNone")}</p>
            ) : (
              <>
                <p className="settings-help">
                  {t("mailAi.classifyMatched", { count: report.matched.length })}
                </p>
                <ul className="mail-ai-report-list">
                  {report.matched.map((m) => (
                    <li key={m.message_id} className="mail-ai-report-row">
                      <span className={`mail-ai-report-mark ${m.priority}`}>
                        {priorityLabel(m.priority)}
                      </span>
                      <span className="mail-ai-report-reason">{m.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      <AiToggle
        featureKey="mail_ai_formalize"
        label={t("mailAi.toggleFormalize")}
        help={t("mailAi.toggleFormalizeHelp")}
        disabled={disabled}
      />
      <AiToggle
        featureKey="mail_ai_calendar"
        label={t("mailAi.toggleCalendar")}
        help={t("mailAi.toggleCalendarHelp")}
        disabled={disabled}
      />
      <AiToggle
        featureKey="mail_ai_todo"
        label={t("mailAi.toggleTodo")}
        help={t("mailAi.toggleTodoHelp")}
        disabled={disabled}
      />
      {/* The one flag that removes the review step from #207/#208 — off by
          default, so extraction otherwise prefills a dialog for one click. */}
      <AiToggle
        featureKey="mail_ai_auto_create"
        label={t("mailAi.toggleAutoCreate")}
        help={t("mailAi.toggleAutoCreateHelp")}
        disabled={disabled}
      />
    </>
  );
}
