/**
 * Closing a tab from the phone — agent or shell.
 *
 * Three things have to hold at once. The close must land in the project the
 * PHONE is looking at, which need not be the one the desktop window is showing
 * (`removeTab` writes to the active scope, so a phone close would otherwise
 * drop a tab out of the project on the user's screen). It must reach disk:
 * CenterPanel persists the active scope alone, and the phone's own catalog is
 * read back out of that session file, so an unpersisted close comes back on the
 * next poll. And it must serve a shell tab, which the neighbouring rename and
 * schedule routes deliberately refuse.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../components/mobile/MobileBridgeHost";
import { Project } from "../../mobile-web/src/screens/Project";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore, type TabEntry } from "../stores/tabs";
import type { ProjectEntry, Settings } from "../types";

const project: ProjectEntry = {
  id: "p-mobile",
  name: "Alpha",
  status: "active",
  position: 1,
  local_file: "/projects/alpha/project.json",
  eldrun_mobile_access: true,
};

const AGENT_TMUX = "eldrun-p-mobile--agent-123456789";
const SHELL_TMUX = "eldrun-p-mobile--shell-123456789";

const TABS: TabEntry[] = [
  { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/alpha", tmuxSession: AGENT_TMUX },
  { key: "shell-1", label: "Shell", kind: "shell", cmd: "bash", cwd: "/projects/alpha", tmuxSession: SHELL_TMUX },
];

/** Hand the bridge one desktop request and give back what it answered. Matched
 *  by request id rather than "the last answer", because these tests read the
 *  invoke log across several asks (the persist below) instead of clearing it. */
async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === "eldrun-mobile-desktop-request");
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const answer = () => vi.mocked(invoke).mock.calls.find(([command, args]) =>
    command === "mobile_desktop_respond"
    && (args as { requestId: string }).requestId === request.request_id);
  deliver({ payload: request });
  await vi.waitFor(() => expect(answer()).toBeTruthy());
  return (answer()![1] as { response: { status: string } }).response;
}

function seed(activeScope: string) {
  useTabsStore.setState({
    scope: activeScope,
    tabsByScope: { [project.id]: [...TABS] },
    layoutByScope: {
      [project.id]: { type: "group", id: "g1", tabKeys: ["agent-1", "shell-1"], activeKey: "agent-1" },
    },
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: activeScope === project.id ? [...TABS] : [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

describe("removeTabInScope", () => {
  it("closes a tab in a scope that is not the active one, leaving the active scope alone", () => {
    seed("other-scope");
    useTabsStore.getState().removeTabInScope(project.id, "shell-1");
    expect(useTabsStore.getState().tabsByScope[project.id]?.map((t) => t.key)).toEqual(["agent-1"]);
    // The old `removeTab` would have written to whatever was on screen.
    expect(useTabsStore.getState().tabsByScope["other-scope"]).toBeUndefined();
    // The layout follows the payload, so nothing is left naming a dropped tab.
    expect(useTabsStore.getState().layoutByScope[project.id]).toMatchObject({
      tabKeys: ["agent-1"],
      activeKey: "agent-1",
    });
  });

  it("ignores a key the scope does not hold", () => {
    seed("other-scope");
    useTabsStore.getState().removeTabInScope(project.id, "nope");
    expect(useTabsStore.getState().tabsByScope[project.id]).toHaveLength(2);
  });
});

describe("Mobile bridge — closing a tab", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    // The desktop is showing a different scope: the phone's project is one the
    // user is not looking at, which is the case the scope argument exists for.
    seed("root");
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("closes an agent tab and writes the scope's layout back to disk", async () => {
    expect(await ask({ type: "close_tab", request_id: "r1", project_id: project.id, tmux_session: AGENT_TMUX }))
      .toEqual({ status: "closed" });
    expect(useTabsStore.getState().tabsByScope[project.id]?.map((t) => t.key)).toEqual(["shell-1"]);

    const saves = vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_tab_layout");
    const saved = saves[saves.length - 1];
    expect(saved).toBeTruthy();
    const payload = saved![1] as { projectId: string; tabs: { label: string }[] };
    expect(payload.projectId).toBe(project.id);
    expect(payload.tabs.map((tab) => tab.label)).toEqual(["Shell"]);
  });

  it("closes a shell tab too — the kind the rename and schedule routes refuse", async () => {
    expect(await ask({ type: "close_tab", request_id: "r2", project_id: project.id, tmux_session: SHELL_TMUX }))
      .toEqual({ status: "closed" });
    expect(useTabsStore.getState().tabsByScope[project.id]?.map((t) => t.key)).toEqual(["agent-1"]);
  });

  it("refuses a tmux name this scope does not hold, and a project with Mobile off", async () => {
    expect(await ask({ type: "close_tab", request_id: "r3", project_id: project.id, tmux_session: "eldrun-elsewhere--agent-9" }))
      .toMatchObject({ status: "error", code: "tab_not_found" });

    useProjectsStore.setState({ projects: [{ ...project, eldrun_mobile_access: false }] });
    expect(await ask({ type: "close_tab", request_id: "r4", project_id: project.id, tmux_session: AGENT_TMUX }))
      .toMatchObject({ status: "error", code: "project_ineligible" });
    expect(useTabsStore.getState().tabsByScope[project.id]).toHaveLength(2);
  });
});

describe("Mobile project screen — the row's ✕", () => {
  const rows = [
    { id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false },
    { id: "t-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false },
  ];
  let closed: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      closed.push(url);
      return new Response(JSON.stringify({ closed: true }), { status: 200 });
    }
    if (url.endsWith("/prompts") || url.endsWith("/schedules")) {
      return new Response(JSON.stringify({ prompts: [], schedules: [], time_zone: "", next_runs: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      // The desktop persists asynchronously, so the poll deliberately keeps
      // answering with the tab that was just closed.
      tabs: rows,
    }), { status: 200 });
  });

  beforeEach(() => {
    closed = [];
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("closes either kind of tab through its opaque id and drops the row", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Close Shell" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(closed).toEqual(["/api/v1/tabs/t-shell"]));
    // Dropped locally rather than re-read: the next poll still lists it.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close Shell" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Claude" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(closed).toEqual(["/api/v1/tabs/t-shell", "/api/v1/tabs/t-agent"]));
  });

  it("asks first, and closes nothing when the sheet is cancelled", async () => {
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close Claude" }));
    // The sheet names the tab and says what closing does not do.
    expect(screen.getByRole("dialog", { name: "Close Claude" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closed).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Close Claude" })).toBeTruthy();
  });

  it("says the desktop is needed rather than 'request failed'", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true, agents: [], tabs: rows,
    }), { status: 200 }));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close Claude" }));
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Open desktop Eldrun to close a tab.");
    // The sheet stays up with the tab still listed behind it.
    expect(screen.getByRole("dialog", { name: "Close Claude" })).toBeTruthy();
  });
});
