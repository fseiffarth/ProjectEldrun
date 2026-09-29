import { useT } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The pane a restored **Host session** shows instead of its terminal: the
 * session ran unfenced with the user's full rights, so it never auto-resumes
 * after a restart — Resume is an explicit act (`docs/context/agent_authority.md`).
 * Same card as `RemotePaneHold`, the other pane that waits for the user.
 */
export function HostSessionHold({ scope, tabKey }: { scope: string; tabKey: string }) {
  const t = useT();
  const resume = useTabsStore((s) => s.resumeHostSession);
  return (
    <div className="center-placeholder" style={{ height: "100%" }}>
      <div className="center-placeholder-card">
        <div className="center-placeholder-title">
          {t("tab.hostSessionPausedTitle")} <UntestedTag id="tab.hostSession" />
        </div>
        <div className="center-placeholder-hint">{t("tab.hostSessionPausedHint")}</div>
        <div className="project-dialog-actions" style={{ justifyContent: "center" }}>
          <button type="button" className="btn-primary" onClick={() => resume(scope, tabKey)}>
            {t("tab.hostSessionResume")}
          </button>
        </div>
      </div>
    </div>
  );
}
