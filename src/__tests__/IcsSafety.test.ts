/**
 * The pre-import report on an `.ics` file (`lib/icsSafety.ts`).
 *
 * Two failure modes are worth pinning, and they pull in opposite directions:
 *
 *  1. **Missing something that is there.** A `PROCEDURE` alarm, an `ATTACH`, a
 *     `zoommtg:` location and a right-to-left override in a title are all
 *     dropped or cleaned in silence by the importer — so if the report misses
 *     them, nothing in the app ever mentions them at all.
 *  2. **Crying wolf.** An ordinary calendar export must produce *no* findings,
 *     because the dialog is only raised when there are some. A report that
 *     flags every file is a dialog nobody reads, which is worse than no dialog:
 *     it trains the click-through on the one file that mattered.
 *
 * The second is why `LOCATION: Room 3` is a test case.
 */
import { describe, expect, it } from "vitest";

import { inspectIcs, uriScheme } from "../lib/icsSafety";

const ORDINARY = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example//EN
BEGIN:VEVENT
UID:a@example
DTSTART:20260803T090000
DTEND:20260803T100000
SUMMARY:Team sync
LOCATION:Room 3, Building B
DESCRIPTION:Agenda in the wiki
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:Team sync
END:VALARM
END:VEVENT
BEGIN:VTODO
UID:t@example
SUMMARY:Write it up
END:VTODO
END:VCALENDAR`;

function kinds(text: string): string[] {
  return inspectIcs(text)
    .findings.map((f) => f.kind)
    .sort();
}

describe("an ordinary calendar file", () => {
  const report = inspectIcs(ORDINARY);

  it("produces no findings at all", () => {
    expect(report.findings).toEqual([]);
    expect(report.notable).toBe(false);
  });

  it("still counts what it holds", () => {
    expect(report.events).toBe(1);
    expect(report.tasks).toBe(1);
    expect(report.looksLikeIcs).toBe(true);
    expect(report.bytes).toBeGreaterThan(100);
  });

  it("does not read a room name as a link", () => {
    // `LOCATION` is a link *sometimes*, which is why it is inspected — and a
    // room name with a colon in it is the normal case that must not trip it.
    expect(kinds("BEGIN:VCALENDAR\nLOCATION:Room 3: Building B\nEND:VCALENDAR")).toEqual([]);
  });
});

describe("the things the importer drops in silence", () => {
  it("names an alarm that asks for a program to be run", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:x
BEGIN:VALARM
ACTION:PROCEDURE
ATTACH:file:///home/me/run.sh
TRIGGER:-PT5M
END:VALARM
END:VEVENT
END:VCALENDAR`;
    const report = inspectIcs(ics);
    // Two findings from three lines: the `ATTACH` is reported once, as an
    // attachment, with its value as the sample — not a second time as a link.
    expect(report.findings.map((f) => f.kind).sort()).toEqual(["active-alarm", "attachment"]);
    expect(report.findings.find((f) => f.kind === "attachment")?.sample).toContain("run.sh");
    // And both say they are ignored — a finding that does not reads as a threat
    // rather than as a fact.
    expect(report.findings.every((f) => f.ignored)).toBe(true);
  });

  it("leaves a plain DISPLAY alarm alone", () => {
    expect(kinds(ORDINARY)).toEqual([]);
  });

  it("names an application-scheme link but not an https one", () => {
    const app = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:x
LOCATION:zoommtg://zoom.us/join?confno=1
END:VEVENT
END:VCALENDAR`;
    expect(kinds(app)).toEqual(["non-web-link"]);

    const web = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:x
CONFERENCE;VALUE=URI:https://example.org/j/1
END:VEVENT
END:VCALENDAR`;
    expect(kinds(web)).toEqual([]);
  });

  it("names a meeting invitation, but not an ordinary publish", () => {
    expect(kinds("BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR")).toEqual(["invitation"]);
    expect(kinds("BEGIN:VCALENDAR\nMETHOD:PUBLISH\nEND:VCALENDAR")).toEqual([]);
  });

  it("names a disguised title, and does not print the disguise back", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:invoice‮gnp.exe
END:VEVENT
END:VCALENDAR`;
    const report = inspectIcs(ics);
    const finding = report.findings.find((f) => f.kind === "hidden-characters");
    expect(finding?.count).toBe(1);
    expect(finding?.sample).toBe("invoicegnp.exe");
    expect(finding?.sample).not.toContain("‮");
  });

  it("names a component kind it does not import", () => {
    expect(kinds("BEGIN:VCALENDAR\nBEGIN:VJOURNAL\nEND:VJOURNAL\nEND:VCALENDAR")).toEqual([
      "unknown-component",
    ]);
  });
});

describe("things that do reach the calendar", () => {
  it("marks an endless sub-daily repeat as kept, not ignored", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:x
DTSTART:20260803T090000
RRULE:FREQ=MINUTELY;INTERVAL=1
END:VEVENT
END:VCALENDAR`;
    const finding = inspectIcs(ics).findings.find((f) => f.kind === "unbounded-repeat");
    expect(finding).toBeDefined();
    expect(finding?.ignored).toBe(false);
  });

  it("says nothing about a bounded or an ordinary daily rule", () => {
    const bounded = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:x
RRULE:FREQ=HOURLY;COUNT=8
END:VEVENT
END:VCALENDAR`;
    expect(kinds(bounded)).toEqual([]);

    const weekly = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:x
RRULE:FREQ=WEEKLY
END:VEVENT
END:VCALENDAR`;
    expect(kinds(weekly)).toEqual([]);
  });
});

describe("a file that is not a calendar", () => {
  it("says so, and is notable on that alone", () => {
    const report = inspectIcs("#!/bin/sh\nrm -rf /\n");
    expect(report.looksLikeIcs).toBe(false);
    expect(report.notable).toBe(true);
  });
});

describe("uriScheme", () => {
  it("reads a scheme only where there is one", () => {
    expect(uriScheme("https://example.org")).toBe("https");
    expect(uriScheme("ZoomMtg://x")).toBe("zoommtg");
    expect(uriScheme("mailto:me@example.org")).toBe("mailto");
    // A room name, a time, a bare word: no scheme, so no finding.
    expect(uriScheme("Room 3: Building B")).toBe("");
    expect(uriScheme("14:00 in the annex")).toBe("");
    expect(uriScheme("")).toBe("");
  });
});
