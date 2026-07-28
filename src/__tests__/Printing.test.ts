/**
 * The print manager's pure helpers (`lib/printing.ts`). Two things are pinned
 * here, both of them the reason the helpers exist rather than being inlined into
 * the pane:
 *
 *  1. **A state word is rendered, never guessed.** The backend maps CUPS and the
 *     Windows spooler onto one small closed set; anything else must degrade to
 *     "unknown", never to something that looks healthy. A future print system
 *     inventing a word must not be able to paint a broken printer green.
 *  2. **A queued job is always reachable.** Jobs are grouped by printer, so a job
 *     whose printer the snapshot did not list would silently vanish — and a job
 *     nobody can see is a job nobody can cancel.
 */
import { describe, it, expect } from "vitest";
import {
  jobStateLabelKey,
  jobsFor,
  orphanJobs,
  printerStateKey,
  printerStateLabelKey,
  printerTone,
} from "../lib/printing";
import type { PrintJob, PrintSnapshot, PrinterInfo } from "../types/printing";

function printer(over: Partial<PrinterInfo> = {}): PrinterInfo {
  return {
    name: "Office",
    description: "",
    location: "",
    state: "idle",
    state_message: "",
    accepting: true,
    is_default: false,
    ...over,
  };
}

function job(over: Partial<PrintJob> = {}): PrintJob {
  return {
    id: "Office-1",
    number: 1,
    printer: "Office",
    user: "ada",
    title: "report.pdf",
    size_bytes: 1024,
    submitted: "Mon 28 Jul 2026 09:12:00 AM CEST",
    state: "pending",
    ...over,
  };
}

describe("printer state", () => {
  it("keeps the states we have wording for", () => {
    expect(printerStateKey("idle")).toBe("idle");
    expect(printerStateKey("printing")).toBe("printing");
    expect(printerStateKey("stopped")).toBe("stopped");
  });

  it("degrades an unrecognized state to unknown, not to idle", () => {
    expect(printerStateKey("toner-low-but-fine")).toBe("unknown");
    expect(printerStateKey("")).toBe("unknown");
    // The label follows the same way round: no wording is invented for a word
    // we do not know.
    expect(printerStateLabelKey(printer({ state: "brand-new-word" as never }))).toBe(
      "printing.stateUnknown",
    );
  });

  it("tones a stopped printer AND one that refuses jobs as bad", () => {
    expect(printerTone(printer())).toBe("good");
    expect(printerTone(printer({ state: "printing" }))).toBe("busy");
    expect(printerTone(printer({ state: "stopped" }))).toBe("bad");
    // The case a single status word hides: the printer says it is ready, but
    // nothing sent to it will ever come out.
    expect(printerTone(printer({ state: "idle", accepting: false }))).toBe("bad");
    expect(printerTone(printer({ state: "unknown" as never }))).toBe("unknown");
  });

  it("labels a job's state from the same closed set", () => {
    expect(jobStateLabelKey(job({ state: "printing" }))).toBe("printing.jobPrinting");
    expect(jobStateLabelKey(job({ state: "held" }))).toBe("printing.jobHeld");
    expect(jobStateLabelKey(job({ state: "pending" }))).toBe("printing.jobPending");
    expect(jobStateLabelKey(job({ state: "nonsense" as never }))).toBe("printing.stateUnknown");
  });
});

describe("grouping jobs", () => {
  const snapshot: PrintSnapshot = {
    supported: true,
    backend: "cups",
    default_printer: "Office",
    printers: [printer(), printer({ name: "Lab-Plotter" })],
    jobs: [
      job({ id: "Office-1", number: 1 }),
      job({ id: "Lab-Plotter-7", number: 7, printer: "Lab-Plotter" }),
      // A queue that was removed while its jobs were still draining.
      job({ id: "Removed-9", number: 9, printer: "Removed" }),
    ],
    note: "",
  };

  it("keeps the print system's own order within a printer", () => {
    expect(jobsFor(snapshot.jobs, "Office").map((j) => j.id)).toEqual(["Office-1"]);
    expect(jobsFor(snapshot.jobs, "Lab-Plotter").map((j) => j.id)).toEqual(["Lab-Plotter-7"]);
    expect(jobsFor(snapshot.jobs, "Nothing")).toEqual([]);
  });

  it("surfaces a job whose printer is not listed rather than dropping it", () => {
    expect(orphanJobs(snapshot).map((j) => j.id)).toEqual(["Removed-9"]);
  });

  it("reports no orphans when every job's printer is listed", () => {
    expect(orphanJobs({ ...snapshot, jobs: snapshot.jobs.slice(0, 2) })).toEqual([]);
  });
});
