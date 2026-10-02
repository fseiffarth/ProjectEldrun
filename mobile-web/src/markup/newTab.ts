import { ApiError, api, TAB_CREATE_TIMEOUT, type AgentRow, type ProjectDetail, type TabRow } from "../api";

/**
 * Mark up where no agent tab is open to send to — the project screen's files
 * and gallery, a shell tab: Submit first opens a new tab of the desktop's
 * default agent (`default_agent_cmd`), hands it the prompt as a held prompt
 * (typed once the new CLI is ready), and shows that tab.
 */

/** The agent such a Submit starts: the one the desktop flags as its default,
 * else the first it offers (an older desktop flags none). */
export function markupAgent(agents: readonly AgentRow[]): AgentRow | undefined {
  return agents.find((agent) => agent.default) ?? agents[0];
}

/** Opens the new agent tab in the project folder. `idempotencyKey` is kept by
 * the caller across a retry, so a Submit that timed out after the desktop
 * created the tab gets that tab back rather than a second one. */
export async function openMarkupTab(projectId: string, idempotencyKey: string): Promise<TabRow> {
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  const agent = markupAgent((await api<ProjectDetail>(path)).agents);
  if (!agent) throw new ApiError(409, "no_agent");
  const body = await api<{ tab: TabRow }>(`${path}/tabs`, {
    method: "POST",
    body: JSON.stringify({ project_id: projectId, kind: "agent", agent_id: agent.id, idempotency_key: idempotencyKey }),
  }, TAB_CREATE_TIMEOUT);
  return body.tab;
}
