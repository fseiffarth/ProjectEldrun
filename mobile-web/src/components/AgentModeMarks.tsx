import type { TabRow } from "../api";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/** The desktop tab strip's PLAN and GOAL pills (`TabAgentModeMarks`): the
 *  session's own status line reads plan mode, or a `/goal` is running. The
 *  desktop reads them off the pane and sends them on; the phone only shows
 *  them, with the desktop's own words. Nothing while neither is on. */
export function AgentModeMarks({ tab }: { tab: Pick<TabRow, "agent_plan" | "agent_goal"> }) {
  const t = useT();
  if (!tab.agent_plan && !tab.agent_goal) return null;
  return <>
    {tab.agent_plan && <small className="agent-mode-mark plan" title={t("tabBar.modePlanTitle")}>{t("tabBar.modePlan")}</small>}
    {tab.agent_goal && <small className="agent-mode-mark goal" title={t("tabBar.modeGoalTitle")}>{t("tabBar.modeGoal")}</small>}
    {isUntested("mobile.project.modeMarks") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </>;
}

/** The card class that tints a tab's border for the mode it is in — plan
 *  first, as the rarer and the one that changes nothing. */
export function agentModeClass(tab: Pick<TabRow, "agent_plan" | "agent_goal">): string {
  return tab.agent_plan ? " in-plan" : tab.agent_goal ? " in-goal" : "";
}
