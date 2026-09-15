/**
 * The agent's own hooks as the authority for a tab's working / decision /
 * finished marks (`noteAgentTurn`, fed by the backend's `agent-turn` event),
 * and the byte heuristic that stays underneath them: for agents with no hooks,
 * and as the net under a verdict that outlived its turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearPtyActivityForTest,
  agentDeliveryReady,
  agentDeliveryTurn,
  isInterruptInput,
  noteAgentTurn,
  notePtyOutput,
  notePtySpawn,
  noteUserInput,
  useActivityStore,
} from "../stores/activity";
import { useTabsStore } from "../stores/tabs";

const PTY = "proj-a:agent-1";

function seedAgentTab(looked: boolean) {
  useTabsStore.setState({
    tabsByScope: { "proj-a": [{ key: "agent-1", label: "Codex", cmd: "codex", cwd: "/proj", kind: "agent" }] },
    scope: "proj-a",
    layoutByScope: looked
      ? { "proj-a": { type: "group", id: "g-a", tabKeys: ["agent-1"], activeKey: "agent-1" } }
      : {},
    detachedGroupsByScope: {},
  });
}

const state = () => useActivityStore.getState();
const busy = () => state().busyByTab[PTY] ?? false;
const attention = () => state().attentionByTab[PTY];

/** Codex 0.154 at work: a braille spinner cell every 150 ms, the terminal
 *  title on the same timer, and ONE digit of its "Working (12s)" timer once a
 *  second — the only visible text that changes while the model thinks. */
function codexWorks(ms: number) {
  for (let t = 0; t < ms; t += 150) {
    vi.advanceTimersByTime(150);
    notePtyOutput(PTY, "\x1b]0;⠋ Codex\x07\x1b[16;10H\x1b[38;2;90;90;90m⠉\x1b[0m");
    if (Math.round(t / 150) % 7 === 0) notePtyOutput(PTY, `\x1b[12;13H${Math.floor(t / 1000)}`);
  }
}

describe("activity store — hook verdicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    seedAgentTab(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps automation blocked when the display falls back from a silent working hook", () => {
    expect(agentDeliveryReady(PTY, 3000)).toBe(true);
    noteUserInput(PTY);
    noteAgentTurn(PTY, "working");
    vi.advanceTimersByTime(11 * 60_000);
    state().recompute();
    expect(agentDeliveryTurn(PTY)?.state).toBe("working");
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    noteAgentTurn(PTY, "done");
    vi.advanceTimersByTime(2999);
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(agentDeliveryReady(PTY, 3000)).toBe(true);
    // Focus/read state cannot undo completion, but fresh human input must.
    noteUserInput(PTY);
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
    notePtySpawn(PTY);
    expect(agentDeliveryTurn(PTY)).toBeUndefined();
  });

  it("never treats hook-free silence after user input as permission to inject another prompt", () => {
    noteUserInput(PTY);
    vi.advanceTimersByTime(60_000);
    state().recompute();
    expect(agentDeliveryReady(PTY, 3000)).toBe(false);
  });

  it("marks working on the agent's word alone, and done the moment it stops", () => {
    // No bytes needed: the hook fired UserPromptSubmit.
    noteAgentTurn(PTY, "working");
    expect(busy()).toBe(true);
    expect(attention()).toBeUndefined();
    // Nothing the screen shows in the meantime changes that — not a 100 ms
    // title timer, not a menu that is not quiet yet.
    vi.advanceTimersByTime(5000);
    notePtyOutput(PTY, "\x1b]0;[ . ] Codex\x07");
    state().recompute();
    expect(busy()).toBe(true);

    noteAgentTurn(PTY, "done");
    const doneAt = Date.now();
    expect(busy()).toBe(false);
    // Nobody is looking: the finish is unread.
    expect(attention()).toBe("done");
    expect(state().attentionByScope["proj-a"]).toBe("done");
    expect(state().lastDoneByTab[PTY]).toBe(doneAt);
    expect(state().lastWorkingByTab[PTY]).toBe(doneAt);
    // Silence afterwards books nothing new: a turn finishes once.
    vi.advanceTimersByTime(10_000);
    state().recompute();
    expect(state().lastDoneByTab[PTY]).toBe(doneAt);
  });

  it("holds no unread finish for a tab that is on screen, and none once it is looked at", () => {
    seedAgentTab(true);
    state().recompute(); // stamps "seen" for the visible tab
    vi.advanceTimersByTime(300);
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "done");
    expect(attention()).toBeUndefined();
    expect(state().lastDoneByTab[PTY]).toBe(Date.now());

    // Finished while the user was away, then read.
    seedAgentTab(false);
    vi.advanceTimersByTime(300);
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "done");
    expect(attention()).toBe("done");
    state().clearAttention(PTY);
    state().recompute();
    expect(attention()).toBeUndefined();
  });

  it("reads a permission notice as a decision, watched or not, until the user answers", () => {
    seedAgentTab(true);
    noteAgentTurn(PTY, "working");
    noteAgentTurn(PTY, "decision");
    expect(busy()).toBe(false);
    expect(attention()).toBe("decision");
    expect(state().lastDoneByTab[PTY]).toBe(Date.now());
    // Looking does not answer it.
    state().clearAttention(PTY);
    state().recompute();
    expect(attention()).toBe("decision");
    // Typing does: the verdict retires and the bytes speak until the next hook
    // (a finished tool, or Stop) — here the agent resumes and its tool ends.
    noteUserInput(PTY);
    state().recompute();
    expect(attention()).toBeUndefined();
    expect(busy()).toBe(false);
    noteAgentTurn(PTY, "working");
    expect(busy()).toBe(true);
  });

  it("lets a quiet approval menu on screen outrank a working verdict (Codex has no notice hook)", () => {
    noteAgentTurn(PTY, "working");
    notePtyOutput(
      PTY,
      "Would you like to run the following command?\r\n› 1. Yes, just this once\r\n  2. No, and tell Codex what to do\r\n",
    );
    vi.advanceTimersByTime(700); // past DECISION_QUIET_MS
    state().recompute();
    expect(attention()).toBe("decision");
    expect(busy()).toBe(false);
    expect(state().statusTabsByScope["proj-a"]).toEqual([{ key: "agent-1", state: "needs-decision" }]);
  });

  it("retires a working verdict on an interrupt key, and on nothing else typed", () => {
    noteAgentTurn(PTY, "working");
    noteUserInput(PTY); // queuing the next prompt
    noteUserInput(PTY);
    state().recompute();
    expect(busy()).toBe(true);
    expect(isInterruptInput("\x1b[A")).toBe(false); // an arrow key is not bare
    expect(isInterruptInput("\x1b")).toBe(true);
    expect(isInterruptInput("\x03")).toBe(true);
    noteUserInput(PTY, true);
    state().recompute();
    // Back on the bytes, which show nothing sustained.
    expect(busy()).toBe(false);
    expect(attention()).toBeUndefined();
  });

  it("drops a working verdict that outlived all paint, and a session's end retires any verdict", () => {
    noteAgentTurn(PTY, "working");
    vi.advanceTimersByTime(19_000);
    notePtyOutput(PTY, "\x1b]0;⠋\x07"); // still painting: the verdict stands
    state().recompute();
    expect(busy()).toBe(true);
    vi.advanceTimersByTime(20_500);
    state().recompute();
    expect(busy()).toBe(false);

    noteAgentTurn(PTY, "done");
    expect(attention()).toBe("done");
    noteAgentTurn(PTY, "idle");
    expect(attention()).toBeUndefined();

    // A respawned tab starts from nothing, whatever its predecessor said.
    noteAgentTurn(PTY, "working");
    expect(busy()).toBe(true);
    notePtySpawn(PTY);
    state().recompute();
    expect(busy()).toBe(false);
  });

  it("ignores a verdict for an id that is not a PTY, and in a popout", () => {
    noteAgentTurn("not-a-pty-id", "working");
    expect(state().busyByTab["not-a-pty-id"]).toBeUndefined();
  });
});

describe("activity store — the bytes under the verdicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    seedAgentTab(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a working Codex — one timer digit a second between spinner frames — as working", () => {
    noteUserInput(PTY);
    vi.advanceTimersByTime(200);
    notePtyOutput(PTY, "› fix the tests\r\n• Working (0s • esc to interrupt)\r\n");
    codexWorks(4050);
    state().recompute();
    expect(busy()).toBe(true);
    // …and as finished once the digits stop, while the idle field keeps painting.
    notePtyOutput(PTY, "Done. Fixed 3 tests.\r\n");
    for (let t = 0; t < 3000; t += 150) {
      vi.advanceTimersByTime(150);
      notePtyOutput(PTY, "\x1b[16;10H⠁\x1b[16;40H⠈⢀");
    }
    state().recompute();
    expect(busy()).toBe(false);
    expect(attention()).toBe("done");
  });

  it("never lights working for the user typing a prompt, however long", () => {
    // Each keystroke's echo lands right behind it; the composer repaints.
    for (let i = 0; i < 40; i += 1) {
      noteUserInput(PTY);
      vi.advanceTimersByTime(30);
      notePtyOutput(PTY, `\x1b[20;${3 + i}Hx`);
      vi.advanceTimersByTime(70);
    }
    state().recompute();
    expect(busy()).toBe(false);
    // The agent answering afterwards still counts as work.
    vi.advanceTimersByTime(200);
    for (let t = 0; t < 1800; t += 300) {
      notePtyOutput(PTY, "✻ Thinking…\r\n");
      vi.advanceTimersByTime(300);
    }
    state().recompute();
    expect(busy()).toBe(true);
  });

  it("bridges a once-a-second text cadence but not a real pause", () => {
    noteUserInput(PTY);
    vi.advanceTimersByTime(200);
    for (let t = 0; t < 3000; t += 1000) {
      notePtyOutput(PTY, `${t / 1000}s`);
      vi.advanceTimersByTime(1000);
      notePtyOutput(PTY, "\x1b]0;spin\x07"); // paint between the digits
      vi.advanceTimersByTime(0);
    }
    notePtyOutput(PTY, "3s");
    state().recompute();
    expect(busy()).toBe(true);
    vi.advanceTimersByTime(1600); // past TEXT_GAP_MS with nothing said
    notePtyOutput(PTY, "\x1b]0;spin\x07"); // painting alone is not working
    state().recompute();
    expect(busy()).toBe(false);
  });
});
