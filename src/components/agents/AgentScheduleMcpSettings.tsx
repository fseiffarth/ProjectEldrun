import { useState } from "react";
import { useT } from "../../lib/i18n";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { SettingRow, ToggleRow } from "../layout/settingsUi";

export function AgentScheduleMcpLevel({ projectId }: { projectId: string }) {
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <>
    <Dropdown value={project?.schedule_mcp ?? "propose"} disabled={busy}
      title={t("scheduleMcp.level")}
      options={(["off", "propose", "apply"] as const).map((value) => ({ value, label: t(`scheduleMcp.${value}`) }))}
      onChange={(value) => {
        setBusy(true);
        void useProjectsStore.getState().setProjectScheduleMcp(projectId, value as "off" | "propose" | "apply")
          .then(() => setError("")).catch((e) => setError(String(e))).finally(() => setBusy(false));
      }} />
    {error && <small role="alert">{error}</small>}
  </>;
}

export function AgentScheduleMcpSettings() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.schedule_mcp ?? false);
  const projects = useProjectsStore((s) => s.projects);
  return <>
    <ToggleRow label={<>{t("scheduleMcp.title")} <UntestedTag id="scheduleMcp" /></>} checked={enabled}
      onChange={(e) => void useSettingsStore.getState().updateSettings({ schedule_mcp: e.target.checked })} />
    <p className="settings-help">{t("scheduleMcp.help")}</p>
    {enabled && projects.map((p) => <SettingRow key={p.id} label={p.name} control={<AgentScheduleMcpLevel projectId={p.id} />} />)}
  </>;
}
