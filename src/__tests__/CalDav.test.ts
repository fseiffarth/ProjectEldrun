/**
 * CalDAV, frontend half (`docs/caldav_plan.md`, Phases 1–2).
 *
 * Two things are worth locking here, and both are about the seam rather than
 * the protocol (which is Rust's, and fixture-tested there):
 *
 *  1. **`parseChanges` groups by resource, never by component.** One CalDAV
 *     resource can hold a recurring event's master *and* its `RECURRENCE-ID`
 *     overrides — there is no separate occurrence object to fetch — and the
 *     backend reconciles rows *within* an href group. Flattening the groups
 *     would throw away exactly the structure the merge matches on.
 *  2. **A resource that parses to nothing still reports itself.** An empty
 *     group tells the backend the resource exists; dropping it would present
 *     the resource as absent, which a full listing reads as *deleted*.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { DEFAULT_CALDAV_SYNC_MIN, parseChanges, syncStamp } from "../lib/caldav";
import { calendarSyncStatus, type CalDavSyncStatus } from "../stores/caldav";
import type { CalDavChanges } from "../types/caldav";
import type { CalDavAccount } from "../types/caldav";

const EVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc
DTSTART:20260708T090000
DTEND:20260708T091500
SUMMARY:standup
END:VEVENT
END:VCALENDAR`;

const SERIES_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:weekly
DTSTART:20260708T090000
DTEND:20260708T100000
RRULE:FREQ=WEEKLY
SUMMARY:weekly
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID:20260715T090000
DTSTART:20260715T110000
DTEND:20260715T120000
SUMMARY:weekly (moved)
END:VEVENT
END:VCALENDAR`;

const TODO_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:t1
SUMMARY:write it up
DUE:20260710T170000
PERCENT-COMPLETE:50
END:VTODO
END:VCALENDAR`;

function changes(partial: Partial<CalDavChanges>): CalDavChanges {
  return {
    resources: [],
    removed: [],
    sync_token: null,
    ctag: "",
    incremental: false,
    unchanged: false,
    ...partial,
  };
}

describe("parseChanges", () => {
  it("keeps each resource's identity with the rows it parsed to", () => {
    const out = parseChanges(
      changes({
        resources: [
          { href: "https://d/c/a.ics", etag: '"1"', data: EVENT_ICS },
          { href: "https://d/c/t.ics", etag: '"2"', data: TODO_ICS },
        ],
      }),
    );
    expect(out.parsed).toHaveLength(2);
    expect(out.parsed[0].href).toBe("https://d/c/a.ics");
    expect(out.parsed[0].etag).toBe('"1"');
    expect(out.parsed[0].events).toHaveLength(1);
    expect(out.parsed[0].events[0].title).toBe("standup");
    expect(out.parsed[0].tasks).toHaveLength(0);

    expect(out.parsed[1].tasks).toHaveLength(1);
    expect(out.parsed[1].tasks[0].title).toBe("write it up");
    expect(out.parsed[1].tasks[0].percent).toBe(50);
    expect(out.parsed[1].events).toHaveLength(0);
  });

  it("keeps a master and its override together under one href", () => {
    // The grouping the backend's positional match depends on: two components,
    // one resource, one group.
    const out = parseChanges(
      changes({ resources: [{ href: "https://d/c/s.ics", etag: '"1"', data: SERIES_ICS }] }),
    );
    expect(out.parsed).toHaveLength(1);
    expect(out.parsed[0].events).toHaveLength(2);
    expect(out.parsed[0].events.map((e) => e.title)).toEqual(["weekly", "weekly (moved)"]);
  });

  it("reports a resource whose body is empty rather than dropping it", () => {
    const out = parseChanges(
      changes({ resources: [{ href: "https://d/c/empty.ics", etag: '"1"', data: "  " }] }),
    );
    expect(out.parsed).toHaveLength(1);
    expect(out.parsed[0].events).toHaveLength(0);
    expect(out.parsed[0].tasks).toHaveLength(0);
    // Counted, never guessed at — a full listing reads an *absent* href as a
    // deletion, so a silently dropped resource would delete its own event.
    expect(out.skipped).toBe(1);
  });

  it("counts components the parser could not understand", () => {
    // A VEVENT with no start is not an event `ics.ts` will invent a time for —
    // it is counted and dropped, and that count has to survive the grouping.
    const out = parseChanges(
      changes({
        resources: [
          {
            href: "https://d/c/x.ics",
            etag: "",
            data: "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:broken\nSUMMARY:no start\nEND:VEVENT\nEND:VCALENDAR",
          },
        ],
      }),
    );
    expect(out.skipped).toBeGreaterThan(0);
    expect(out.parsed[0].events).toHaveLength(0);
  });

  it("passes deletions through untouched — they carry no body to parse", () => {
    const c = changes({ removed: ["https://d/c/gone.ics"], incremental: true });
    expect(parseChanges(c).parsed).toHaveLength(0);
    expect(c.removed).toEqual(["https://d/c/gone.ics"]);
  });
});

describe("calendarSyncStatus", () => {
  const account: CalDavAccount = {
    id: "acc-1",
    label: "Work",
    base_url: "https://dav.example.org/dav/",
    user: "me",
    save_password: false,
    sync_interval_min: 15,
    calendars: [
      {
        href: "https://dav.example.org/dav/me/personal/",
        calendar_id: "cal-1",
        display_name: "Personal",
        ctag: "c1",
        read_only: true,
      },
    ],
  };
  const failed: CalDavSyncStatus = {
    phase: "error",
    error: "could not reach the server",
    at: "",
    unchanged: false,
  };

  it("finds the status of the collection feeding a calendar", () => {
    const status = calendarSyncStatus(
      { "https://dav.example.org/dav/me/personal/": failed },
      [account],
      "cal-1",
    );
    expect(status?.phase).toBe("error");
    expect(status?.error).toBe("could not reach the server");
  });

  it("reports idle — not null — for a subscribed calendar never synced yet", () => {
    // The distinction the sidebar renders: a CalDAV calendar always gets its
    // sync affordance, whether or not a sync has run.
    expect(calendarSyncStatus({}, [account], "cal-1")?.phase).toBe("idle");
  });

  it("says nothing about a calendar no account feeds", () => {
    // A local or ICS-subscribed calendar gets no CalDAV chrome at all.
    expect(calendarSyncStatus({}, [account], "cal-other")).toBeNull();
    expect(calendarSyncStatus({}, [], "cal-1")).toBeNull();
  });
});

describe("sync scheduling constants", () => {
  it("defaults to a quarter of an hour, not to never", () => {
    // Zero would mean the interval field is a second opt-in on top of adding
    // the account — the mistake mail's check interval originally made.
    expect(DEFAULT_CALDAV_SYNC_MIN).toBeGreaterThan(0);
  });

  it("stamps local wall-clock, the encoding the whole calendar file uses", () => {
    expect(syncStamp(new Date(2026, 6, 28, 9, 5))).toBe("2026-07-28T09:05");
  });
});
