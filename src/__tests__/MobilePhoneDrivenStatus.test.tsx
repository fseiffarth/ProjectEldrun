/**
 * The two ways an agent tab's working/done tags failed to reach the phone.
 *
 * The desktop is the only classifier — the sidecar never reads terminal output —
 * and it classifies output only for a session it saw COMMANDED (`noteUserInput`,
 * the guard that keeps a restored tab's resume banner from reading as a finished
 * turn). The phone types into a tmux client of the sidecar's own, so a tab driven
 * entirely from a phone was never commanded as far as this window knew: no
 * "working", no "done", on the very surface that asked for the work. The sidecar
 * now reports the typing (`tab_input`).
 *
 * The second gap is the other end of the same story: the `done` attention flag
 * means UNREAD output and is deliberately never raised for the tab being looked
 * at — but "looked at" is only "it is the visible tab of its group", which an
 * unattended desktop satisfies all night. What the phone is told is therefore
 * derived from the finished-turn reading (`lastDoneByTab`) against the last time
 * somebody actually ARRIVED at the tab, on either surface.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../components/mobile/MobileBridgeHost";
import { _clearPtyActivityForTest, notePtyOutput, useActivityStore } from "../stores/activity";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";
import type { TabEntry } from "../stores/tabs";
import type { ProjectEntry, Settings } from "../types";

const project: ProjectEntry = {
  id: "p-mobile",
  name: "Alpha",
  status: "active",
  position: 1,
  local_file: "/projects/alpha/project.json",
  eldrun_mobile_access: true,
};

const TMUX = "eldrun-p-mobile--agent-123456789";
const PTY = "p-mobile:agent-1";

interface Status { status: string; working_at?: number; done_at?: number }

/** Hand the bridge one desktop request and give back what it answered. */
async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === "eldrun-mobile-desktop-request");
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(
    ([command]) => command === "mobile_desktop_respond",
  )).toBe(true));
  const call = invokeMock.mock.calls.find(([command]) => command === "mobile_desktop_respond");
  return (call?.[1] as { response: { status: string; statuses?: Status[] } }).response;
}

/** What the phone's project screen would show for the one agent tab. */
async function tabStatus(requestId: string): Promise<Status | undefined> {
  useActivityStore.getState().recompute();
  const catalog = await ask({ type: "catalog", request_id: requestId, project_id: project.id });
  return catalog.statuses?.[0];
}

/** A burst of agent output long enough to count as work (past the onset
 * debounce), the way `AgentActivityTurns` sustains one. */
function sustain(totalMs = 1600) {
  notePtyOutput(PTY, "thinking…\n");
  for (let elapsed = 0; elapsed < totalMs; elapsed += 400) {
    vi.advanceTimersByTime(400);
    notePtyOutput(PTY, "thinking…\n");
  }
}

/** The tab is the visible one of its group in the current scope — an ordinary
 * desktop with an agent tab open, whether or not anybody is in front of it. */
function seedTabs(looked: boolean) {
  useTabsStore.setState({
    scope: project.id,
    tabsByScope: {
      [project.id]: [
        { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/alpha", tmuxSession: TMUX },
      ] satisfies TabEntry[],
    },
    layoutByScope: looked
      ? { [project.id]: { type: "group", id: "g-a", tabKeys: ["agent-1"], activeKey: "agent-1" } }
      : {},
    detachedGroupsByScope: {},
  });
}

describe("Mobile bridge — the status of a tab the phone is driving", () => {
  beforeEach(async () => {
    // `shouldAdvanceTime` so the bridge's own awaits still settle while the
    // clock is ours to move.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    _clearPtyActivityForTest();
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    seedTabs(false);
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    _clearPtyActivityForTest();
    vi.useRealTimers();
  });

  it("goes working, then done, once the phone's typing is relayed", async () => {
    expect(await ask({ type: "tab_input", request_id: "i1", project_id: project.id, tmux_session: TMUX }))
      .toEqual({ status: "seen" });

    sustain();
    expect((await tabStatus("c1"))?.status).toBe("working");

    // Quiet past the done window: the turn finished, and the phone is told when
    // — the last output of the burst, not the moment the silence was noticed.
    const quietFrom = Date.now();
    vi.advanceTimersByTime(3000);
    const done = await tabStatus("c2");
    expect(done?.status).toBe("done");
    expect(done?.done_at).toBeLessThanOrEqual(quietFrom);
    expect(done?.done_at).toBe(useActivityStore.getState().lastDoneByTab[PTY]);
  });

  it("reports nothing at all when the typing is never relayed", async () => {
    // The regression: output alone is not evidence that anybody asked for it.
    sustain();
    expect(await tabStatus("c3")).toBeUndefined();
    vi.advanceTimersByTime(3000);
    expect(await tabStatus("c4")).toBeUndefined();
  });

  it("reports a finished turn on the tab the desktop is displaying, and retires it when the phone opens it", async () => {
    seedTabs(true);
    await ask({ type: "tab_input", request_id: "i2", project_id: project.id, tmux_session: TMUX });
    sustain();
    vi.advanceTimersByTime(3000);

    // The desktop raises no `done` flag for a tab on its own screen…
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab[PTY]).toBeUndefined();
    // …and the phone is told about it anyway.
    expect((await tabStatus("c5"))?.status).toBe("done");

    // Opening it on the phone is what reads it.
    await ask({ type: "tab_seen", request_id: "s1", project_id: project.id, tmux_session: TMUX });
    expect(await tabStatus("c6")).toBeUndefined();
  });

  it("says nothing about a project the Mobile switch is off for", async () => {
    useProjectsStore.setState({ projects: [{ ...project, eldrun_mobile_access: false }] });
    const response = await ask({ type: "tab_input", request_id: "i3", project_id: project.id, tmux_session: TMUX });
    expect(response.status).toBe("error");
  });
});
