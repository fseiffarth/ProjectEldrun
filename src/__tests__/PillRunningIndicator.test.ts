/**
 * Tests for the running-task indicator data source (#9, Group D):
 * - sustained PTY output marks a scope/tab busy (onset debounce ignores blips)
 * - busy state clears once output goes stale
 * - only scopes whose tabs produced recent output are flagged
 * Plus the per-tab/-scope "needs attention" state an unwatched agent tab raises
 * once its output goes quiet — finished (done) vs blocked on a prompt (decision).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useActivityStore,
  notePtyOutput,
  _clearPtyActivityForTest,
} from "../stores/activity";
import { useTabsStore } from "../stores/tabs";

// PTY ids are composed `<scope>:<tabKey>` in production (what the backend emits
// and AppShell feeds into notePtyOutput), and every derived map is keyed the same
// way, so the tests feed and read the same form.
function seedTabs() {
  useTabsStore.setState({
    tabsByScope: {
      "proj-a": [
        { key: "agent-1", label: "a", cmd: "claude", cwd: "/a", kind: "agent" },
      ],
      "proj-b": [
        { key: "shell-1", label: "b", cmd: "", cwd: "/b", kind: "shell" },
      ],
    },
    // Viewing project B, so proj-a's agent-1 is a background tab: never looked at.
    scope: "proj-b",
    layoutByScope: {
      "proj-a": { type: "group", id: "g-a", tabKeys: ["agent-1"], activeKey: "agent-1" },
      "proj-b": { type: "group", id: "g-b", tabKeys: ["shell-1"], activeKey: "shell-1" },
    },
    detachedGroupsByScope: {},
  });
}

// Keep a PTY producing output (gaps < BUSY_WINDOW_MS) long enough to age past
// the onset debounce (WORK_ONSET_MS = 1500), so it registers as "working".
function sustainOutput(id: string, totalMs = 1600) {
  notePtyOutput(id, "working…\n");
  for (let elapsed = 0; elapsed < totalMs; elapsed += 400) {
    vi.advanceTimersByTime(400);
    notePtyOutput(id, "working…\n");
  }
}

// Same, but for several PTYs at once. They must be fed in lockstep: sustaining
// them one after the other would let the first go stale (its last output ages
// past BUSY_WINDOW_MS) while the second is still being fed.
function sustainAll(ids: string[], totalMs = 1600) {
  ids.forEach((id) => notePtyOutput(id, "working…\n"));
  for (let elapsed = 0; elapsed < totalMs; elapsed += 400) {
    vi.advanceTimersByTime(400);
    ids.forEach((id) => notePtyOutput(id, "working…\n"));
  }
}

// An agent turn that ends with an ordinary result on screen, then the silence
// that tells the store the turn is over (> DONE_QUIET_MS = 2500).
function runThenFinish(id: string) {
  sustainOutput(id);
  notePtyOutput(id, "\x1b[1mAll 12 tests pass.\x1b[0m\n");
  vi.advanceTimersByTime(2600);
}

// An agent turn that ends on a permission prompt — colour-coded, as it arrives
// off the wire — then the short silence a blocked agent sits in.
function runThenPrompt(id: string) {
  sustainOutput(id);
  notePtyOutput(
    id,
    "Do you want to make this edit?\n\x1b[32m❯ 1. Yes\x1b[0m\n  2. No, tell Claude what to do\n",
  );
  vi.advanceTimersByTime(700); // past DECISION_QUIET_MS (600), well under DONE_QUIET_MS
}

describe("activity store running indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    seedTabs();
    _clearPtyActivityForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags the scope of a PTY producing sustained output", () => {
    sustainOutput("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-a"]).toBe(true);
    expect(useActivityStore.getState().busyByScope["proj-b"]).toBeUndefined();
  });

  it("ignores a lone output blip (onset debounce)", () => {
    notePtyOutput("proj-a:agent-1");
    vi.advanceTimersByTime(300); // within the busy window, but well under onset
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-a"] ?? false).toBe(false);
    expect(useActivityStore.getState().busyByTab["proj-a:agent-1"] ?? false).toBe(false);
  });

  it("keeps a bursty stream working across a short quiet gap", () => {
    // Gaps under BUSY_WINDOW_MS belong to the SAME burst, so they must not reset
    // the onset — otherwise bursty agent output could never age past the debounce
    // and the working indicator would never appear at all.
    notePtyOutput("proj-a:agent-1"); // onset at t0
    vi.advanceTimersByTime(700); // < BUSY_WINDOW_MS (800) → still one burst
    notePtyOutput("proj-a:agent-1");
    vi.advanceTimersByTime(700);
    notePtyOutput("proj-a:agent-1");
    vi.advanceTimersByTime(200); // t=1600: past WORK_ONSET_MS, last output 200ms ago

    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab["proj-a:agent-1"]).toBe(true);
  });

  it("re-applies the onset debounce to a burst that starts after a long gap", () => {
    sustainOutput("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab["proj-a:agent-1"]).toBe(true);

    vi.advanceTimersByTime(900); // > BUSY_WINDOW_MS → the burst has ended
    notePtyOutput("proj-a:agent-1"); // a fresh burst: onset restarts from here
    useActivityStore.getState().recompute();
    // Recent output, but the new burst has not been sustained — not working yet.
    expect(useActivityStore.getState().busyByTab["proj-a:agent-1"] ?? false).toBe(false);
  });

  it("clears busy once output is older than the window", () => {
    sustainOutput("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-a"]).toBe(true);

    vi.advanceTimersByTime(1000); // > BUSY_WINDOW_MS (800)
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-a"] ?? false).toBe(false);
  });

  it("does not flag a scope whose PTYs have been silent", () => {
    sustainOutput("proj-b:shell-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByScope["proj-b"]).toBe(true);
    expect(useActivityStore.getState().busyByScope["proj-a"] ?? false).toBe(false);
  });

  it("flags the individual tab that produced output and clears when stale", () => {
    sustainOutput("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab["proj-a:agent-1"]).toBe(true);
    expect(useActivityStore.getState().busyByTab["proj-b:shell-1"]).toBeUndefined();

    vi.advanceTimersByTime(1000); // > BUSY_WINDOW_MS (800)
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().busyByTab["proj-a:agent-1"] ?? false).toBe(false);
  });
});

describe("activity store attention state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    seedTabs();
    _clearPtyActivityForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags an agent that went quiet with an unread result as done", () => {
    // The case that used to leave the tab plain white: the agent simply stops.
    // No terminal bell is involved — most agents never ring one.
    runThenFinish("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBe("done");
    expect(useActivityStore.getState().attentionByScope["proj-a"]).toBe("done");
  });

  it("flags an agent waiting on a choice prompt as a decision", () => {
    runThenPrompt("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBe("decision");
    expect(useActivityStore.getState().attentionByScope["proj-a"]).toBe("decision");
  });

  it("says nothing while the agent is still streaming", () => {
    sustainOutput("proj-a:agent-1");
    vi.advanceTimersByTime(300); // still mid-burst
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBeUndefined();
  });

  it("stops calling a prompt live once it has been answered", () => {
    // The tail is per output BURST. A prompt sits quiet while it waits on the
    // human, so the work that follows the answer necessarily arrives as a fresh
    // burst — which drops the answered menu from the tail instead of leaving the
    // tab stuck on orange for the rest of the turn.
    runThenPrompt("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBe("decision");

    vi.advanceTimersByTime(4000); // the human reads the prompt and answers
    runThenFinish("proj-a:agent-1"); // back to work, then a plain result
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBe("done");
  });

  it("rolls a decision up over a done when one scope holds both", () => {
    // The project pill shows a single kind for the whole scope, so a tab blocked
    // on a decision must outrank a sibling that merely finished.
    useTabsStore.setState({
      tabsByScope: {
        "proj-a": [
          { key: "agent-1", label: "a", cmd: "claude", cwd: "/a", kind: "agent" },
          { key: "agent-2", label: "a2", cmd: "claude", cwd: "/a", kind: "agent" },
        ],
      },
    });
    runThenFinish("proj-a:agent-1");
    runThenPrompt("proj-a:agent-2");
    useActivityStore.getState().recompute();

    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBe("done");
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-2"]).toBe("decision");
    expect(useActivityStore.getState().attentionByScope["proj-a"]).toBe("decision");
  });

  it("never flags a tab that lives in a detached popout (#42)", () => {
    // The popout has its own window and its own tab strip; this window can't tell
    // whether the user is watching it, and nothing here could ever clear a flag
    // raised for it — so it would have left the project pill glowing for good.
    useTabsStore.setState({
      layoutByScope: { "proj-a": null },
      detachedGroupsByScope: {
        "proj-a": [
          {
            id: "d-1",
            label: "detached-proj-a-g-a",
            subtree: {
              type: "group",
              id: "g-a",
              tabKeys: ["agent-1"],
              activeKey: "agent-1",
            },
          },
        ],
      },
    });
    runThenFinish("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBeUndefined();
    expect(useActivityStore.getState().attentionByScope["proj-a"]).toBeUndefined();
  });

  it("never flags a non-agent (shell) tab", () => {
    // A shell finishing a build is not an agent asking to be looked at.
    runThenFinish("proj-b:shell-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-b:shell-1"]).toBeUndefined();
  });

  it("does not flag the tab the user is looking at, and treats its output as read", () => {
    useTabsStore.setState({ scope: "proj-a" }); // agent-1 is now the visible tab
    runThenFinish("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBeUndefined();

    // Looking away afterwards must not raise a flag for output already seen.
    useTabsStore.setState({ scope: "proj-b" });
    vi.advanceTimersByTime(5000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBeUndefined();
  });

  it("clears the flag (and scope rollup) once the tab is viewed, for good", () => {
    runThenFinish("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBe("done");

    useActivityStore.getState().clearAttention("proj-a:agent-1");
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBeUndefined();
    expect(useActivityStore.getState().attentionByScope["proj-a"]).toBeUndefined();

    // And the next interval tick must not raise it again from the same output.
    vi.advanceTimersByTime(1000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBeUndefined();
  });

  it("lets a terminal bell shortcut the quiet window", () => {
    // An agent that rings the bell is asking for attention NOW, so it doesn't
    // have to sit out the full silence to count as finished.
    sustainOutput("proj-a:agent-1");
    notePtyOutput("proj-a:agent-1", "Done.\n");
    useActivityStore.getState().noteBell("proj-a:agent-1");
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBe("done");
  });

  it("ignores a bell from a bare (colon-less) pty id", () => {
    useActivityStore.getState().noteBell("agent-1");
    expect(useActivityStore.getState().attentionByTab["agent-1"]).toBeUndefined();
  });
});

describe("activity store per-scope status counts (pill status bars)", () => {
  // Three agent tabs in one project, so a scope can hold several states at once
  // — the whole point of the bars over the old single-state pill glow.
  function seedThreeAgents() {
    useTabsStore.setState({
      tabsByScope: {
        "proj-a": [
          { key: "agent-1", label: "a1", cmd: "claude", cwd: "/a", kind: "agent" },
          { key: "agent-2", label: "a2", cmd: "claude", cwd: "/a", kind: "agent" },
          { key: "agent-3", label: "a3", cmd: "claude", cwd: "/a", kind: "agent" },
        ],
      },
      scope: "proj-b", // none of proj-a's tabs are being looked at
      layoutByScope: {
        "proj-a": {
          type: "group",
          id: "g-a",
          tabKeys: ["agent-1", "agent-2", "agent-3"],
          activeKey: "agent-1",
        },
      },
      detachedGroupsByScope: {},
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    seedThreeAgents();
    _clearPtyActivityForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts one working bar per working tab", () => {
    sustainAll(["proj-a:agent-1", "proj-a:agent-2"]);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().statusCountsByScope["proj-a"]).toEqual({
      working: 2,
      decision: 0,
      done: 0,
    });
  });

  it("tallies decision and done bars separately", () => {
    runThenPrompt("proj-a:agent-1");
    runThenFinish("proj-a:agent-2");
    runThenFinish("proj-a:agent-3");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().statusCountsByScope["proj-a"]).toEqual({
      working: 0,
      decision: 1,
      done: 2,
    });
  });

  it("counts a working tab once — working outranks its own attention flag", () => {
    // Same precedence the tab bar uses for its glow, so the bars can't disagree
    // with the tabs they stand for (and the bar count never exceeds the tab count).
    runThenFinish("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().attentionByTab["proj-a:agent-1"]).toBe("done");

    sustainOutput("proj-a:agent-1"); // it's off again
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().statusCountsByScope["proj-a"]).toEqual({
      working: 1,
      decision: 0,
      done: 0,
    });
  });

  it("drops the scope entirely once its tabs go idle with nothing to report", () => {
    sustainOutput("proj-a:agent-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().statusCountsByScope["proj-a"]).toBeDefined();

    // Idle, but not yet long enough to call the turn done: no bars at all.
    vi.advanceTimersByTime(1000); // > BUSY_WINDOW_MS, < DONE_QUIET_MS
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().statusCountsByScope["proj-a"]).toBeUndefined();
  });

  it("drops a done bar once its tab is viewed", () => {
    runThenFinish("proj-a:agent-1");
    runThenFinish("proj-a:agent-2");
    useActivityStore.getState().recompute();
    useActivityStore.getState().clearAttention("proj-a:agent-1");
    expect(useActivityStore.getState().statusCountsByScope["proj-a"]).toEqual({
      working: 0,
      decision: 0,
      done: 1,
    });
  });

  it("keeps a scope's counts object identical when nothing changed", () => {
    // The pill selector reads this object by reference, so a recompute tick that
    // changes nothing must not hand it a fresh one — that would re-render every
    // pill on every interval.
    sustainOutput("proj-a:agent-1");
    useActivityStore.getState().recompute();
    const first = useActivityStore.getState().statusCountsByScope["proj-a"];
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().statusCountsByScope["proj-a"]).toBe(first);
  });
});
