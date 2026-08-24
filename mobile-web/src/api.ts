export interface ProjectRow { id: string; label: string; status: string; live_sessions: number; last_activity?: number }
export interface TabRow { id: string; label: string; kind: "shell" | "agent"; agent_label?: string; available: boolean; viewer_busy: boolean; last_activity?: number }
export interface AgentRow { id: string; label: string; modes: ("plan" | "auto")[] }
export interface ProjectDetail { project: ProjectRow; tabs: TabRow[]; desktop_available: boolean; agents: AgentRow[] }

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error ?? "request_failed");
  return body as T;
}

