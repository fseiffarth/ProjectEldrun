/**
 * The green-pulse run-button state: a run-launched terminal tab (Python
 * Run/Debug or a foreground shell run) is tagged with `TabEntry.runFile`, and
 * while it produces sustained output the activity store lists that file in
 * `runningRunFiles` — which drives the ▶ run button's green pulse in the file
 * tree. Busy-gated (commanded + sustained past the onset), and dropped the
 * moment the tab closes or goes quiet, mirroring `busyByTab`.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useActivityStore,
  notePtyOutput,
  noteUserInput,
  _clearPtyActivityForTest,
} from "../stores/activity";
import { useTabsStore } from "../stores/tabs";

const RUN_PATH = "/proj/run_me.py";

function seedRunTab() {
  useTabsStore.setState({
    tabsByScope: {
      "proj-a": [
        {
          key: "shell-1",
          label: "▶ run_me.py",
          cmd: "",
          cwd: "/proj",
          kind: "shell",
          runFile: RUN_PATH,
        },
      ],
    },
    scope: "proj-a",
    layoutByScope: {
      "proj-a": { type: "group", id: "g-a", tabKeys: ["shell-1"], activeKey: "shell-1" },
    },
    detachedGroupsByScope: {},
  });
}

// Commanded (noteUserInput) + sustained output past WORK_ONSET_MS (1500), the
// shape the store requires before a tab counts as "working".
function sustain(id: string, totalMs = 1600) {
  noteUserInput(id);
  notePtyOutput(id, "running…\n");
  for (let elapsed = 0; elapsed < totalMs; elapsed += 400) {
    vi.advanceTimersByTime(400);
    notePtyOutput(id, "running…\n");
  }
}

describe("activity store runningRunFiles (run-button pulse)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _clearPtyActivityForTest();
    useActivityStore.setState({ runningRunFiles: new Set() });
    seedRunTab();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists a busy run tab's file, and clears it once output goes quiet", () => {
    sustain("proj-a:shell-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().runningRunFiles.has(RUN_PATH)).toBe(true);

    // Output goes stale (> BUSY_WINDOW_MS = 800): the tab is no longer busy, so
    // its file drops out of the set.
    vi.advanceTimersByTime(1000);
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().runningRunFiles.has(RUN_PATH)).toBe(false);
  });

  it("drops the file when the run tab is removed mid-run", () => {
    sustain("proj-a:shell-1");
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().runningRunFiles.has(RUN_PATH)).toBe(true);

    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {} });
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().runningRunFiles.has(RUN_PATH)).toBe(false);
  });

  it("never lights up a restored, uncommanded run tab (resume replay)", () => {
    // Same sustained output, but WITHOUT noteUserInput — a restored tab replaying
    // banner text nobody asked for. Busy-gating must keep it dark.
    notePtyOutput("proj-a:shell-1", "restored\n");
    for (let elapsed = 0; elapsed < 1600; elapsed += 400) {
      vi.advanceTimersByTime(400);
      notePtyOutput("proj-a:shell-1", "restored\n");
    }
    useActivityStore.getState().recompute();
    expect(useActivityStore.getState().runningRunFiles.has(RUN_PATH)).toBe(false);
  });
});
