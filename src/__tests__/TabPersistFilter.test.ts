/**
 * Save-side tab persistence filtering. Shell/files tabs always survive a
 * restart. Resumable agent tabs (Claude, Codex, Gemini, Mistral/vibe and the
 * other continue-last agents, each with a sessionId) now survive too and carry
 * their sessionId; an agent tab without a sessionId, or an agent with no wired
 * resume (Aider), is still dropped. These tests lock in
 * saveLayout's keep-filter and the shared pruneSavedTree / isRestorableKind /
 * isResumableAgentTab / isRestorableTab helpers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  BROWSER_TAB_CMD,
  cmdToKind,
  isPtyTabKind,
  isRestorableKind,
  isResumableAgentTab,
  isRestorableTab,
  pruneSavedTree,
  useTabsStore,
  type SavedLayoutTree,
} from "../stores/tabs";

const invokeMock = vi.mocked(invoke);

describe("isRestorableKind", () => {
  it("keeps shell, files, and network; drops agent and local_agent", () => {
    expect(isRestorableKind("shell")).toBe(true);
    expect(isRestorableKind("files")).toBe(true);
    expect(isRestorableKind("network")).toBe(true);
    expect(isRestorableKind("agent")).toBe(false);
    expect(isRestorableKind("local_agent")).toBe(false);
  });

  it("keeps browser — the tab comes back, on its resume card", () => {
    // A browser tab has no live process and one persisted field (its URL). What
    // it must NOT do is navigate on restore: it comes back holding the address
    // behind a Load button, because reopening a window is not consent to dial
    // out (BROWSER_TAB_CMD). This is the only automated proof the tab survives.
    expect(isRestorableKind("browser")).toBe(true);
  });
});

describe("a browser tab round-trips its URL and nothing else", () => {
  it("carries `url` through save → load, and never gains a PTY", () => {
    // The whole of a browser tab's persistence: no history, no scroll, no form
    // state, no cookies. A URL string is inert and reviewable in a diff; a
    // serialized session blob written into project.json would be neither.
    useTabsStore.setState({
      scope: "p",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      detachedGroupsByScope: {},
      hiddenGroupsByScope: {},
    });
    const store = useTabsStore.getState();
    const tab = store.addTab({
      label: "Browser",
      cmd: BROWSER_TAB_CMD,
      cwd: "/tmp",
      kind: "browser",
      url: "https://example.com/docs",
    });
    expect(tab.kind).toBe("browser");
    expect(isPtyTabKind(tab.kind)).toBe(false);

    const saved = useTabsStore.getState().snapshotScopeForSwitch("p");
    const savedTab = saved.tabs.find((t) => t.key === tab.key);
    expect(savedTab?.url).toBe("https://example.com/docs");

    useTabsStore.getState().loadFromLayout(saved.tabs, "/tmp", "p", saved.tabGroups ?? undefined);
    const restored = useTabsStore.getState().tabs.find((t) => t.kind === "browser");
    expect(restored?.url).toBe("https://example.com/docs");
    // Recovered from a bare persisted cmd, too — a layout written before the
    // `kind` field existed still comes back as a browser tab.
    expect(cmdToKind(BROWSER_TAB_CMD)).toBe("browser");
  });
});

describe("isResumableAgentTab / isRestorableTab", () => {
  it("treats a resumable agent tab (Claude, Codex, Gemini, vibe) with a sessionId as resumable", () => {
    for (const cmd of ["claude", "codex", "gemini", "vibe"]) {
      const tab = { kind: "agent" as const, cmd, sessionId: "abc-123" };
      expect(isResumableAgentTab(tab)).toBe(true);
      expect(isRestorableTab(tab)).toBe(true);
    }
  });

  it("drops a resumable-agent tab without a sessionId", () => {
    for (const cmd of ["claude", "codex", "gemini", "vibe"]) {
      const tab = { kind: "agent" as const, cmd };
      expect(isResumableAgentTab(tab)).toBe(false);
      expect(isRestorableTab(tab)).toBe(false);
    }
  });

  it("drops an agent with no wired resume even with a sessionId", () => {
    for (const cmd of ["aider"]) {
      const tab = { kind: "agent" as const, cmd, sessionId: "abc-123" };
      expect(isResumableAgentTab(tab)).toBe(false);
      expect(isRestorableTab(tab)).toBe(false);
    }
  });

  it("treats a custom agent with resumeArgs + a sessionId as resumable", () => {
    const tab = {
      kind: "agent" as const,
      cmd: "my-agent",
      sessionId: "abc-123",
      resumeArgs: ["--continue"],
    };
    expect(isResumableAgentTab(tab)).toBe(true);
    expect(isRestorableTab(tab)).toBe(true);
  });

  it("drops a launch-only custom agent (unknown cmd, no resumeArgs)", () => {
    const tab = { kind: "agent" as const, cmd: "my-agent", sessionId: "abc-123" };
    expect(isResumableAgentTab(tab)).toBe(false);
    expect(isRestorableTab(tab)).toBe(false);
  });

  it("keeps shell/files tabs via kind regardless of sessionId", () => {
    expect(isRestorableTab({ kind: "shell", cmd: "bash" })).toBe(true);
    expect(isRestorableTab({ kind: "files", cmd: "__eldrun_files__" })).toBe(true);
  });
});

describe("pruneSavedTree", () => {
  it("drops keys not in the keep set and collapses emptied groups", () => {
    const tree: SavedLayoutTree = {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "group", tabKeys: ["agent-1"], activeKey: "agent-1" },
        { type: "group", tabKeys: ["shell-1", "agent-2"], activeKey: "agent-2" },
      ],
    };
    const pruned = pruneSavedTree(tree, new Set(["shell-1"]));
    // The agent-only group collapses; the split with one survivor collapses too.
    expect(pruned).toEqual({ type: "group", tabKeys: ["shell-1"], activeKey: "shell-1" });
  });

  it("returns null when nothing survives", () => {
    const tree: SavedLayoutTree = { type: "group", tabKeys: ["agent-1"], activeKey: "agent-1" };
    expect(pruneSavedTree(tree, new Set())).toBeNull();
  });
});

describe("saveLayout — persists restorable tabs (incl. resumable agents)", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useTabsStore.setState({
      scope: "p",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("keeps a Claude agent tab with a sessionId (with its sessionId) and shell/files", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "claude",
      cmd: "claude",
      cwd: "/p",
      kind: "agent",
      sessionId: "abc-123",
    });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "Files", cmd: "__eldrun_files__", cwd: "/p", kind: "files" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    expect(call).toBeTruthy();
    const arg = call![1] as {
      tabs: { kind: string; cmd: string; sessionId?: string }[];
      groups: SavedLayoutTree | null;
    };
    expect(arg.tabs.map((t) => t.kind).sort()).toEqual(["agent", "files", "shell"]);
    const claude = arg.tabs.find((t) => t.cmd === "claude");
    expect(claude?.sessionId).toBe("abc-123");
    // The resumable agent key survives in the persisted tree.
    expect(JSON.stringify(arg.groups)).toContain("agent");
  });

  it("drops a Claude agent tab without a sessionId and prunes the tree", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({ label: "claude", cmd: "claude", cwd: "/p", kind: "agent" });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    const arg = call![1] as { tabs: { kind: string }[]; groups: SavedLayoutTree | null };
    expect(arg.tabs.map((t) => t.kind)).toEqual(["shell"]);
    expect(JSON.stringify(arg.groups)).not.toContain("agent");
  });

  it("writes a browser tab's committed URL to disk", async () => {
    // The bug this locks: `loadFromLayout` read `url`, and the in-memory
    // project-switch snapshot carried live TabEntries through unchanged — so a
    // scope switch looked right — but `saveLayout` is the ONLY path to
    // `project.json`, and it did not include the field. A real relaunch brought
    // the tab back with no address, i.e. an empty start page instead of the
    // resume card that is the whole of this tab's restore behaviour.
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "Browser",
      cmd: BROWSER_TAB_CMD,
      cwd: "/p",
      kind: "browser",
      url: "https://example.com/docs",
    });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    const arg = call![1] as { tabs: { kind: string; url?: string }[] };
    const browser = arg.tabs.find((t) => t.kind === "browser");
    expect(browser?.url).toBe("https://example.com/docs");
  });

  it("keeps a Codex agent tab with a sessionId", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "codex",
      cmd: "codex",
      cwd: "/p",
      kind: "agent",
      sessionId: "codex-key-1",
    });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    const arg = call![1] as { tabs: { kind: string; cmd: string; sessionId?: string }[] };
    const codex = arg.tabs.find((t) => t.cmd === "codex");
    expect(codex?.sessionId).toBe("codex-key-1");
  });

  it("persists a continue-last agent (gemini) with its sessionId", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "gemini",
      cmd: "gemini",
      cwd: "/p",
      kind: "agent",
      sessionId: "abc-123",
    });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    const arg = call![1] as {
      tabs: { kind: string; cmd: string; sessionId?: string }[];
    };
    const gemini = arg.tabs.find((t) => t.cmd === "gemini");
    expect(gemini?.sessionId).toBe("abc-123");
  });

  it("drops an agent with no wired resume (aider) even with a sessionId", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({
      label: "aider",
      cmd: "aider",
      cwd: "/p",
      kind: "agent",
      sessionId: "abc-123",
    });
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_tab_layout");
    const arg = call![1] as { tabs: { kind: string }[]; groups: SavedLayoutTree | null };
    expect(arg.tabs.map((t) => t.kind)).toEqual(["shell"]);
    expect(JSON.stringify(arg.groups)).not.toContain("agent");
  });
});
