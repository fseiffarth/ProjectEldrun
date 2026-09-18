import { describe, expect, it } from "vitest";
import { chatTurns } from "../../mobile-web/src/terminal/chatTurns";
import { inputFrameStart, sessionStatus, statusFrameLines } from "../../mobile-web/src/terminal/statusLine";
import { currentMode, modeChoices, modeFixed } from "../../mobile-web/src/terminal/agentModes";
import {
  joinOpenCodeWraps,
  openCodePickKeys,
  readOpenCodePicker,
} from "../../mobile-web/src/terminal/openCodeMini";
import type { ReadableLine } from "../../mobile-web/src/terminal/readableScreen";

/**
 * `opencode --mini` as the phone reads it. Every screen below is a real one:
 * the rows come from captures of an OpenCode 1.18.31 session replayed through
 * the phone's own emulator at 60 and 100 columns, after `readableScreen` (so
 * trailing padding is gone and runs of blanks are one).
 */

let seq = 0;
const line = (text: string): ReadableLine => ({
  key: `l${seq += 1}`,
  text,
  spans: text ? [{ text }] : [],
});
const lines = (...texts: string[]) => texts.map((text) => line(text));
const texts = (rows: readonly { text: string }[]) => rows.map((row) => row.text);

/** The live area at the bottom of every mini frame: the empty input box, then
 * the status row. */
const FRAME = ["", " BUILD                                                    223.0K (21%) · ctrl+p cmd"];

describe("Eldrun Mobile OpenCode mini status", () => {
  it("reads the agent, the context and the model a turn footer named", () => {
    expect(sessionStatus(lines(
      "The tests pass.",
      "",
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
      ...FRAME,
    ), "OpenCode")).toEqual({
      mode: "build",
      context: "21%",
      model: "Muse Spark 1.3 Free",
    });
  });

  it("reads the chip alone, which is all a narrow pane has room for", () => {
    expect(sessionStatus(lines("The tests pass.", "", " PLAN"), "OpenCode"))
      .toEqual({ mode: "plan" });
  });

  it("prefers the model OpenCode notices in the status row after a switch", () => {
    expect(sessionStatus(lines(
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
      "",
      " BUILD  model union-alpha                                            ctrl+p cmd",
    ), "OpenCode")?.model).toBe("union-alpha");
  });

  it("is not confused by a notice it does not know", () => {
    expect(sessionStatus(lines("", " BUILD  no variants available                      ctrl+p cmd"), "OpenCode"))
      .toEqual({ mode: "build" });
  });

  it("belongs to a tab whose label names OpenCode, and to no other", () => {
    expect(sessionStatus(lines("The tests pass.", "", ...FRAME), "Claude")).toBeNull();
    expect(sessionStatus(lines("The tests pass.", "", ...FRAME))).toBeNull();
  });

  it("cuts the box and the status row out of the reading view", () => {
    const screen = lines("The tests pass.", "", "▣ Build · Muse Spark 1.3 Free · 6.2s", ...FRAME);
    expect(inputFrameStart(screen, "OpenCode")).toBe(3);
    // Without the label the frame is not found, and nothing is cut.
    expect(inputFrameStart(screen, "Claude")).toBe(screen.length);
  });

  it("takes the empty box's placeholder into the frame", () => {
    const screen = lines(
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
      "",
      "Ask anything... \"Fix a TODO in the codebase\"",
      "",
      " BUILD",
    );
    expect(inputFrameStart(screen, "OpenCode")).toBe(1);
    expect(statusFrameLines(screen, "OpenCode")).toEqual([" BUILD"]);
  });
});

describe("Eldrun Mobile OpenCode mini turns", () => {
  it("drops the banner, the tool calls and the turn footer", () => {
    const turns = chatTurns(lines(
      "█▀▀█  OpenCode",
      "█  █  ~/eldrun/projects/projecteldrun",
      "",
      "› fix the failing test",
      "",
      "✱ Grep \"describe\" in src",
      "→ Read src/app.test.ts",
      "% WebFetch https://vitest.dev/api",
      "",
      "The second assertion was wrong.",
      "",
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
    ), "OpenCode", 60);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(texts(turns[0].prompt ?? [])).toEqual(["fix the failing test"]);
    expect(texts(turns[1].lines)).toEqual(["The second assertion was wrong."]);
  });

  it("keeps the bash tool's own output, which is the session's words", () => {
    const turns = chatTurns(lines(
      "› run echo hi",
      "",
      "Running that for you.",
      "",
      "$ echo hi",
      "",
      "hi",
    ), "OpenCode", 60);
    expect(texts(turns[1].lines)).toEqual(["Running that for you.", "", "$ echo hi", "", "hi"]);
  });

  it("keeps a wrapped tool call whole instead of stranding its tail", () => {
    // OpenCode wraps its own rows; the tail carries no marker at all, and
    // before the block rule it was read as the agent's first answer line.
    const turns = chatTurns(lines(
      "› go on",
      "",
      "✱ Grep \"permitted|AgentCatalog|agents.*=|listAgents|AGENT\"",
      "in src/components/mobile",
      "",
      "Nothing matches.",
    ), "OpenCode", 60);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(texts(turns[1].lines)).toEqual(["Nothing matches."]);
  });

  it("keeps a wrapped prompt in one bubble", () => {
    const turns = chatTurns(lines(
      "› Is there a good opencode cli terminal wrapper for mobile",
      "phones?",
      "",
      "No official one.",
    ), "OpenCode", 60);
    expect(texts(turns[0].prompt ?? []))
      .toEqual(["Is there a good opencode cli terminal wrapper for mobile phones?"]);
  });

  it("leaves every other family's tab exactly as it was", () => {
    const screen = lines("█▀▀█  OpenCode", "", "› ask", "", "→ Read src/app.ts", "", "done");
    expect(texts(chatTurns(screen, "Claude", 60).flatMap((turn) => turn.lines)))
      .toEqual(["█▀▀█  OpenCode", "› ask", "→ Read src/app.ts", "", "done"]);
  });
});

describe("Eldrun Mobile OpenCode wrapped rows", () => {
  const joined = (columns: number, ...rows: string[]) => texts(joinOpenCodeWraps(lines(...rows), columns));

  it("puts back the space a word wrap broke at", () => {
    expect(joined(60,
      "Thinking: Summarizing community mobile wrappers for",
      "opencode using Web UI and HTTP/SSE with auth and streaming.",
    )).toEqual(["Thinking: Summarizing community mobile wrappers for opencode using Web UI and HTTP/SSE with auth and streaming."]);
  });

  it("leaves a break the session meant alone", () => {
    // The next word would have fitted, so the newline was the session's.
    expect(joined(60, "opencode web --hostname 0.0.0.0 --port 4096", "# with auth:"))
      .toEqual(["opencode web --hostname 0.0.0.0 --port 4096", "# with auth:"]);
  });

  it("rejoins a long token broken at its own punctuation", () => {
    expect(joined(60,
      "- Android: OpenCode: AI Coding Agent (github.com/dzianisv/",
      "  opencode-mobile, MIT, Play Store) — streaming, diff",
    )).toEqual(["- Android: OpenCode: AI Coding Agent (github.com/dzianisv/opencode-mobile, MIT, Play Store) — streaming, diff"]);
    expect(joined(60,
      "- src-tauri/src/services/sandbox.rs:1815 — fence mounts ~/.",
      "  local/share/opencode rw so --continue survives",
    )).toEqual(["- src-tauri/src/services/sandbox.rs:1815 — fence mounts ~/.local/share/opencode rw so --continue survives"]);
  });

  it("gives the space back when the wrap kept it past the hanging indent", () => {
    expect(joined(60,
      "- Alt wrapper: bmpenuelas/opencode-mobile-client (Capacitor,",
      "   wraps Web UI, server profiles, basic-auth, secure",
    )).toEqual(["- Alt wrapper: bmpenuelas/opencode-mobile-client (Capacitor, wraps Web UI, server profiles, basic-auth, secure"]);
  });

  it("never joins onto a row that opens a block of OpenCode's own", () => {
    expect(joined(60,
      "The change is in src/components/mobile/MobileBridgeHost.tsx,",
      "› and the next prompt",
    )).toHaveLength(2);
    expect(joined(60,
      "It reads the catalog, the tabs and the schedules in order,",
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
    )).toHaveLength(2);
  });

  it("does nothing without the pane's width", () => {
    expect(joined(0, "a row that was wrapped", "and its tail")).toHaveLength(2);
  });
});

describe("Eldrun Mobile OpenCode mode chip", () => {
  it("lists the agents a mini session can be in, for a tab labelled OpenCode", () => {
    const choices = modeChoices("build", "OpenCode");
    expect(choices.map((choice) => choice.value)).toEqual(["build", "plan"]);
    expect(currentMode(choices, "build")).toBe("build");
    // "plan" is four other families' word; the label decides.
    expect(modeChoices("plan", "OpenCode").map((choice) => choice.value)).toEqual(["build", "plan"]);
    expect(modeChoices("plan", "Claude").map((choice) => choice.value)).toContain("accept edits");
  });

  it("never claims a session no label names", () => {
    expect(modeChoices("build")).toEqual([]);
    expect(modeChoices("build", "Codex")).toEqual([]);
  });

  it("says the mode is fixed, so the chip presses nothing", () => {
    expect(modeFixed("OpenCode")).toBe(true);
    expect(modeFixed("Claude")).toBe(false);
    expect(modeFixed()).toBe(false);
  });
});

describe("Eldrun Mobile OpenCode model picker", () => {
  const picker = lines(
    "  Select model 25                                                          esc",
    "",
    "  Search",
    "",
    "  OpenCode Zen",
    "  Big Pickle                                                              Free",
    "  Muse Spark 1.3 Free                                                     Free",
  );

  it("reads the rows of OpenCode's own picker", () => {
    const read = readOpenCodePicker(picker);
    expect(read?.title).toBe("Select model");
    expect(read?.options.map((option) => option.label))
      .toEqual(["OpenCode Zen", "Big Pickle", "Muse Spark 1.3 Free"]);
    expect(read?.options[1].description).toBe("Free");
    // The highlight is drawn in colour alone, which is not read: no row is
    // reported as the session's current one.
    expect(read?.current).toBe(-1);
  });

  it("is not a picker when none is on screen", () => {
    expect(readOpenCodePicker(lines("The tests pass.", "", " BUILD"))).toBeNull();
  });

  it("answers by typing into the picker's search field", () => {
    expect(openCodePickKeys("Muse Spark 1.3 Free")).toEqual(["", "Muse Spark 1.3 Free", "\r"]);
    // A label the pane truncated is typed without its ellipsis: the picker
    // filters on a prefix, and the `…` itself matches nothing.
    expect(openCodePickKeys("Ling 3.0 Flash Fin…")).toEqual(["", "Ling 3.0 Flash Fin", "\r"]);
  });
});
