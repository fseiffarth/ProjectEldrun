/**
 * Persistent remote sessions (TODO #85) — the frontend half.
 *
 * Covers the pure decision/derivation helpers (session-name derivation MUST
 * mirror the backend `ssh_exec::tmux_session_name`; the default-ON gate; the
 * shell-only/remote-only persistence rule) and the restore round-trip that proves
 * a Sessions-view **attach** tab reattaches to the same named session after a
 * restart (its `tmuxAttach` survives save→load).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  newTmuxSessionName,
  persistSessionsEnabled,
  shouldPersistTab,
  shouldPersistLocalTab,
} from "../lib/tmuxSession";
import { useTabsStore } from "../stores/tabs";
import type { RemoteSpec } from "../types";

const remote = (over: Partial<RemoteSpec> = {}): RemoteSpec => ({
  host: "gpu.example",
  remote_path: "/home/me/proj",
  ...over,
});

describe("newTmuxSessionName", () => {
  it("mints a tmux-safe (uuid-based) name — no `:`/`.` that tmux treats specially", () => {
    const name = newTmuxSessionName();
    expect(name.startsWith("eldrun-")).toBe(true);
    expect(name).not.toMatch(/[:.\s]/);
    // Distinct per call, so each shell tab owns its own host session.
    expect(newTmuxSessionName()).not.toBe(name);
  });
});

describe("persistSessionsEnabled — default ON", () => {
  it("is on for a remote project unless explicitly opted out", () => {
    expect(persistSessionsEnabled(remote())).toBe(true); // undefined ⇒ on
    expect(persistSessionsEnabled(remote({ persist_sessions: true }))).toBe(true);
    expect(persistSessionsEnabled(remote({ persist_sessions: false }))).toBe(false);
    // No remote project ⇒ nothing to persist.
    expect(persistSessionsEnabled(undefined)).toBe(false);
    expect(persistSessionsEnabled(null)).toBe(false);
  });
});

describe("shouldPersistTab — shell + remote host + enabled", () => {
  it("persists a remote shell tab, but never an agent, a local tab, or an opted-out project", () => {
    expect(shouldPersistTab("shell", "primary", remote())).toBe(true);
    expect(shouldPersistTab("shell", "h1", remote())).toBe(true); // a worker host too
    // Agent tabs resume via their own session — excluded.
    expect(shouldPersistTab("agent", "primary", remote())).toBe(false);
    expect(shouldPersistTab("local_agent", "primary", remote())).toBe(false);
    // A local-running tab (hostId null) has no host session.
    expect(shouldPersistTab("shell", null, remote())).toBe(false);
    // Opted out.
    expect(shouldPersistTab("shell", "primary", remote({ persist_sessions: false }))).toBe(false);
  });
});

describe("shouldPersistLocalTab — local shell tabs on Unix", () => {
  it("persists a local project shell tab (non-root) when enabled; excludes agents/root/disabled", () => {
    expect(shouldPersistLocalTab("shell", "p1", true, true)).toBe(true);
    // A remote project's local (mirror) tab counts too (localRunning=true).
    expect(shouldPersistLocalTab("shell", "p1", true, true)).toBe(true);
    // Agents never persist locally either.
    expect(shouldPersistLocalTab("agent", "p1", true, true)).toBe(false);
    // The root control terminal is excluded.
    expect(shouldPersistLocalTab("shell", "root", true, true)).toBe(false);
    // A tab actually running on a remote host is not a local session.
    expect(shouldPersistLocalTab("shell", "p1", false, true)).toBe(false);
    // Disabled (setting off, or Windows folded into localEnabled) → off.
    expect(shouldPersistLocalTab("shell", "p1", true, false)).toBe(false);
  });
});

describe("attach tab restore", () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      scope: "p",
    } as never);
  });

  it("preserves tmuxAttach onto the rebuilt shell tab so it reattaches to the same session", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "shell-7",
          label: "train",
          cmd: "",
          cwd: "/p",
          kind: "shell",
          location: "remote",
          tmuxAttach: "train",
        },
      ],
      "/p",
      "p",
    );
    const tabs = useTabsStore.getState().tabsByScope["p"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].tmuxAttach).toBe("train");
    expect(tabs[0].kind).toBe("shell");
  });

  it("keeps the SAME tmuxSession across a restart even though the key is regenerated (reattach, not fork)", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "shell-3", // saved key — regenerated on restore
          label: "run",
          cmd: "",
          cwd: "/p",
          kind: "shell",
          location: "remote",
          tmuxSession: "eldrun-fixed-uuid",
        },
      ],
      "/p",
      "p",
    );
    const tab = useTabsStore.getState().tabsByScope["p"][0];
    // The key changed (fresh mint) but the session name is stable → the tab
    // reattaches to the SAME host session rather than spawning a second one.
    expect(tab.key).not.toBe("shell-3");
    expect(tab.tmuxSession).toBe("eldrun-fixed-uuid");
  });

  it("mints a stable tmuxSession for a shell tab persisted before the feature existed", () => {
    useTabsStore.getState().loadFromLayout(
      [{ key: "shell-1", label: "sh", cmd: "", cwd: "/p", kind: "shell" }],
      "/p",
      "p",
    );
    const tab = useTabsStore.getState().tabsByScope["p"][0];
    expect(tab.tmuxSession).toMatch(/^eldrun-/);
  });
});
