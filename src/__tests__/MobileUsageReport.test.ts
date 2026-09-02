import { describe, expect, it } from "vitest";
import { noteParts, parseUsageReport } from "../../shared/usageReport";

/** The panel a real `claude -p "/usage" --output-format json` run returns, as
 * `services::agent_usage` hands it over. */
const CLAUDE_PANEL = [
  "Current session: 71% used · resets 6:20pm",
  "Current week (all models): 38% used · resets Mon 9am",
  "Current week (Fable): 12% used",
  "",
  "Last 24h: 41 requests · 6 sessions",
].join("\n");

describe("Eldrun Mobile agent usage panel", () => {
  it("reads each window as a labelled bar, with its reset", () => {
    const report = parseUsageReport(CLAUDE_PANEL);
    expect(report.unparsed).toBe(false);
    expect(report.meters).toEqual([
      { label: "Current session", percent: 71, resets: "6:20pm" },
      { label: "Current week (all models)", percent: 38, resets: "Mon 9am" },
      { label: "Current week (Fable)", percent: 12, resets: undefined },
    ]);
  });

  it("keeps a readout with no percentage as a note rather than dropping it", () => {
    const report = parseUsageReport(CLAUDE_PANEL);
    expect(report.notes).toEqual([{ label: "Last 24h", value: "41 requests · 6 sessions" }]);
    expect(noteParts("41 requests · 6 sessions")).toEqual(["41 requests", "6 sessions"]);
  });

  it("keeps decimals and clamps a figure outside 0–100", () => {
    const report = parseUsageReport("Current session: 45.2% used\nWeek: 140% used\nMonth: -3% used");
    expect(report.meters.map((meter) => meter.percent)).toEqual([45.2, 100, 0]);
  });

  it("reads a panel drawn inside a box, and drops the frame", () => {
    const report = parseUsageReport([
      "┌────────────────────────────┐",
      "│ Current session: 71% used  │",
      "└────────────────────────────┘",
    ].join("\n"));
    expect(report.meters).toEqual([{ label: "Current session", percent: 71, resets: undefined }]);
    expect(report.notes).toEqual([]);
  });

  it("reports a shape it does not recognize instead of inventing bars", () => {
    // What a CLI release that reworded the panel would look like. The sheet
    // shows the raw block for this, so nothing the CLI said is lost.
    const report = parseUsageReport("You have plenty of quota left this week.");
    expect(report.unparsed).toBe(true);
    expect(report.meters).toEqual([]);
    expect(report.notes).toEqual([{ label: undefined, value: "You have plenty of quota left this week." }]);
  });

  it("does not turn an unattributed percentage into a bar", () => {
    // A bar with no label is a figure the reader cannot attribute; it stays a
    // note, where it is still readable.
    const report = parseUsageReport("71% used");
    expect(report.meters).toEqual([]);
    expect(report.notes).toEqual([{ label: undefined, value: "71% used" }]);
  });

  it("survives an empty panel without throwing", () => {
    expect(parseUsageReport("")).toEqual({ meters: [], notes: [], unparsed: true });
  });
});
