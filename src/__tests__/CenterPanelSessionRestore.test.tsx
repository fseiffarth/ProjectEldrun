/**
 * Regression test for: tabs restore/resume last global agent session
 * instead of the one tied to the tab.
 *
 * Root cause: loadFromLayout was overriding a saved sessionId whenever
 * detect_agent_session_id returned a *different* value (i.e. a newer session
 * from the same project).  All agent tabs therefore ended up pointing at the
 * same most-recently-modified session file.
 *
 * Fix: only fill sessionId via detection when the tab has no saved sessionId.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

// ── shared state (must be hoisted so mock factories can reference it) ─────────
const shared = vi.hoisted(() => {
  const loadFromLayoutSpy = vi.fn();
  const setScope = vi.fn();
  const ensureTab = vi.fn();
  const updateTabSessionId = vi.fn();
  const updateTabEnv = vi.fn();
  const saveLayout = vi.fn().mockResolvedValue(undefined);

  const tabsState = {
    scope: "proj-1",
    tabsByScope: {} as Record<string, unknown[]>,
    activeKey: null as string | null,
    tabs: [] as unknown[],
    setScope,
    ensureTab,
    loadFromLayout: loadFromLayoutSpy,
    saveLayout,
    updateTabSessionId,
    updateTabEnv,
  };

  return {
    tabsState,
    loadFromLayoutSpy,
    invokeResponses: {} as Record<string, unknown>,
    projectDirectory: "/home/user/eldrun/projects/foo",
    localFile: "/home/user/eldrun/projects/foo/project.json",
    activeId: "proj-1",
    switchGeneration: 1,
  };
});

// ── Tauri core mock ───────────────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(
      cmd in shared.invokeResponses ? shared.invokeResponses[cmd] : null,
    ),
  ),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// ── Store mocks ───────────────────────────────────────────────────────────────
vi.mock("../stores/tabs", () => {
  const useTabsStore = vi.fn(
    (sel?: (s: typeof shared.tabsState) => unknown) =>
      sel ? sel(shared.tabsState) : shared.tabsState,
  ) as unknown as ReturnType<typeof vi.fn> & { getState: () => typeof shared.tabsState };
  useTabsStore.getState = () => shared.tabsState;
  return {
    useTabsStore,
    FILES_TAB_CMD: "__eldrun_files__",
    cmdToKind: (cmd: string) => (cmd === "claude" ? "agent" : "shell"),
  };
});

vi.mock("../stores/projects", () => ({
  useProjectsStore: vi.fn(
    (sel?: (s: unknown) => unknown) => {
      const state = {
        projects: [
          {
            id: shared.activeId,
            name: "foo",
            local_file: shared.localFile,
            directory: shared.projectDirectory,
          },
        ],
        activeId: shared.activeId,
        switchGeneration: shared.switchGeneration,
      };
      return sel ? sel(state) : state;
    },
  ),
}));

vi.mock("../stores/settings", () => ({
  useSettingsStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ settings: { default_agent_cmd: "claude", color_scheme: "dark" } }),
  ),
}));

// ── Stub heavy children ───────────────────────────────────────────────────────
vi.mock("../components/terminal/TerminalView", () => ({
  TerminalView: () => null,
}));
vi.mock("../components/files/FileBrowser", () => ({
  FileBrowser: () => null,
}));

// ── resolveProjectDirectory helper ───────────────────────────────────────────
vi.mock("../types", () => ({
  resolveProjectDirectory: (
    proj: { directory?: string; local_file?: string } | null | undefined,
  ) => {
    if (!proj) return "";
    if (proj.directory) return proj.directory;
    return proj.local_file?.endsWith("/project.json")
      ? proj.local_file.slice(0, -"/project.json".length)
      : "";
  },
}));

import { CenterPanel } from "../components/layout/CenterPanel";

describe("CenterPanel — session ID restoration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.tabsState.tabsByScope = {};
    shared.tabsState.tabs = [];
    shared.invokeResponses = {};
    // Reset the getState reference after clearAllMocks re-creates the mock
    // (useTabsStore.getState is set in the mock factory so it persists).
  });

  it("preserves a tab's saved sessionId when detection returns a newer session", async () => {
    shared.invokeResponses = {
      load_project: {
        tab_layout: [
          {
            key: "agent-1",
            label: "claude",
            cmd: "claude",
            cwd: shared.projectDirectory,
            kind: "agent",
            sessionId: "saved-session-abc",
          },
        ],
      },
      detect_agent_session_id: "detected-session-xyz",
    };

    render(<CenterPanel />);

    await waitFor(() =>
      expect(shared.loadFromLayoutSpy).toHaveBeenCalled(),
    );

    const [layout] = shared.loadFromLayoutSpy.mock.calls[0] as [
      Array<{ key: string; sessionId?: string }>,
    ];
    expect(layout[0].sessionId).toBe("saved-session-abc");
  });

  it("fills sessionId via detection when the tab has no saved sessionId", async () => {
    shared.invokeResponses = {
      load_project: {
        tab_layout: [
          {
            key: "agent-2",
            label: "claude",
            cmd: "claude",
            cwd: shared.projectDirectory,
            kind: "agent",
            // intentionally no sessionId
          },
        ],
      },
      detect_agent_session_id: "detected-session-xyz",
    };

    render(<CenterPanel />);

    await waitFor(() =>
      expect(shared.loadFromLayoutSpy).toHaveBeenCalled(),
    );

    const [layout] = shared.loadFromLayoutSpy.mock.calls[0] as [
      Array<{ key: string; sessionId?: string }>,
    ];
    expect(layout[0].sessionId).toBe("detected-session-xyz");
  });

  it("leaves sessionId undefined when detection returns null and tab has no saved sessionId", async () => {
    shared.invokeResponses = {
      load_project: {
        tab_layout: [
          {
            key: "agent-3",
            label: "claude",
            cmd: "claude",
            cwd: shared.projectDirectory,
            kind: "agent",
          },
        ],
      },
      detect_agent_session_id: null,
    };

    render(<CenterPanel />);

    await waitFor(() =>
      expect(shared.loadFromLayoutSpy).toHaveBeenCalled(),
    );

    const [layout] = shared.loadFromLayoutSpy.mock.calls[0] as [
      Array<{ key: string; sessionId?: string }>,
    ];
    expect(layout[0].sessionId).toBeUndefined();
  });

  it("preserves distinct session IDs across multiple agent tabs in the same project", async () => {
    // detect_agent_session_id returns one project-level "most recent" ID.
    // Before the fix this would clobber *both* tabs — both would end up as
    // "session-beta" instead of keeping their own saved IDs.
    shared.invokeResponses = {
      load_project: {
        tab_layout: [
          {
            key: "agent-a",
            label: "claude",
            cmd: "claude",
            cwd: shared.projectDirectory,
            kind: "agent",
            sessionId: "session-alpha",
          },
          {
            key: "agent-b",
            label: "claude",
            cmd: "claude",
            cwd: shared.projectDirectory,
            kind: "agent",
            sessionId: "session-beta",
          },
        ],
      },
      detect_agent_session_id: "session-beta",
    };

    render(<CenterPanel />);

    await waitFor(() =>
      expect(shared.loadFromLayoutSpy).toHaveBeenCalled(),
    );

    const [layout] = shared.loadFromLayoutSpy.mock.calls[0] as [
      Array<{ key: string; sessionId?: string }>,
    ];
    const alpha = layout.find((t) => t.key === "agent-a");
    const beta = layout.find((t) => t.key === "agent-b");
    expect(alpha?.sessionId).toBe("session-alpha");
    expect(beta?.sessionId).toBe("session-beta");
  });
});
