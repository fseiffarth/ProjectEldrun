import { useState } from "react";
import { isAgentProposal, type ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";
import { useT } from "../../lib/i18n";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { UntestedTag } from "../common/UntestedTag";

/** Shared attribution and approval controls in the menu, Agents view and chart. */
export function AgentScheduleProposal({ projectId, targetId, schedule }: {
  projectId: string; targetId: string; schedule: ScheduledAgentPrompt;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!schedule.origin) return null;
  const proposal = isAgentProposal(schedule);
  const act = async (approve: boolean) => {
    setBusy(true);
    setError("");
    try {
      const store = useAgentSchedulesStore.getState();
      if (approve) await store.upsert(projectId, targetId, { ...schedule, enabled: true }, { expectExistingOn: targetId });
      else await store.remove(projectId, targetId, schedule.id, { expectUndelivered: true });
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="agent-schedule-attribution" onClick={(event) => event.stopPropagation()}>
    <span className="agent-schedule-pill" title={schedule.origin.session}>{t(proposal ? "scheduleMcp.proposed" : "scheduleMcp.authored")}</span>
    <UntestedTag id="scheduleMcp" />
    {schedule.origin.from_delivery && <small>{t("scheduleMcp.lineage", { id: schedule.origin.from_delivery })}</small>}
    {proposal && <>
      <button className="settings-btn sm primary" disabled={busy} onClick={() => void act(true)}>{t("scheduleMcp.approve")}</button>
      <button className="settings-btn sm" disabled={busy} onClick={() => void act(false)}>{t("scheduleMcp.dismiss")}</button>
    </>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
