/**
 * The seam between a calendar edit and CalDAV push (`lib/calendar/calendarWriteHook`).
 *
 * One slot, last writer wins — two handlers would be two pushes of one edit —
 * and an uninstaller that only drops its OWN handler, so an unmount racing a
 * newer install cannot silently disconnect the server side. With nothing
 * registered a write resolves at once, which is the everyday state for
 * someone with no CalDAV account.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  notifyCalendarWrite,
  setCalendarWriteHandler,
  type CalendarWriteEvent,
} from "../../lib/calendar/calendarWriteHook";
import type { CalendarEvent } from "../../types";

const row = { id: "e1", title: "Standup" } as unknown as CalendarEvent;
const upsert: CalendarWriteEvent = { op: "upsert", kind: "event", row };
const del: CalendarWriteEvent = { op: "delete", kind: "event", row };

afterEach(() => {
  setCalendarWriteHandler(null);
});

describe("notifyCalendarWrite", () => {
  it("resolves immediately with nothing installed", async () => {
    await expect(notifyCalendarWrite(upsert)).resolves.toBeUndefined();
  });

  it("hands the event to the installed handler and returns its promise", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    setCalendarWriteHandler(handler);
    await notifyCalendarWrite(upsert);
    expect(handler).toHaveBeenCalledWith(upsert);
  });

  it("lets a rejection through — that is what cancels a local delete", async () => {
    setCalendarWriteHandler(() => Promise.reject(new Error("412 Precondition Failed")));
    await expect(notifyCalendarWrite(del)).rejects.toThrow("412");
  });
});

describe("setCalendarWriteHandler", () => {
  it("keeps one slot: a second install replaces the first", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    setCalendarWriteHandler(first);
    setCalendarWriteHandler(second);
    await notifyCalendarWrite(upsert);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("uninstalls only its own handler, never a newer one", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const dropFirst = setCalendarWriteHandler(first);
    const dropSecond = setCalendarWriteHandler(second);

    dropFirst(); // stale unmount — must not disconnect the live handler
    await notifyCalendarWrite(upsert);
    expect(second).toHaveBeenCalledTimes(1);

    dropSecond();
    await notifyCalendarWrite(upsert);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
