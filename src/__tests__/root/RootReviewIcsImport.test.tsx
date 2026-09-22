import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { RootReviewStrip } from "../../components/layout/RootReviewStrip";
import { useRootReviewStore, type StagedIcsImport } from "../../stores/rootReview";

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:1",
  "SUMMARY:Keynote",
  "DTSTART:20260921T090000",
  "DTEND:20260921T100000",
  "ATTACH:https://evil.example/payload.exe",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");
const staged = (over: Partial<StagedIcsImport> = {}): StagedIcsImport =>
  ({ id: "a".repeat(64), tab: "root:a", name: "Conf‮", created: "0", text: ICS, ...over });

const initial = useRootReviewStore.getState();
beforeEach(() => {
  vi.clearAllMocks();
  useRootReviewStore.setState({ ...initial, proposals: [], imports: [staged()], count: 0 });
  invoke.mockImplementation(async (command: string, args: Record<string, { id: string }>) => {
    if (command === "root_mcp_review_list" || command === "root_mcp_import_list") return [];
    if (command === "create_calendar") return { ...args.calendar, id: "cal" };
    if (command === "create_event") return { ...args.event, id: "ev" };
    return undefined;
  });
});
afterEach(cleanup);

describe("a calendar file staged by a root agent", () => {
  it("shows the window's own report and is never part of Approve all", () => {
    render(<RootReviewStrip />);
    expect(screen.getByText("Conf")).toBeTruthy();
    expect(document.querySelector(".ics-review-list")?.textContent).toContain("evil.example");
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
  });

  it("imports the reported text into a calendar marked imported, staged copy dropped first", async () => {
    render(<RootReviewStrip />);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_event", expect.anything()));
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands.indexOf("root_mcp_import_remove")).toBeLessThan(commands.indexOf("create_calendar"));
    expect(invoke).toHaveBeenCalledWith("root_mcp_import_remove", { id: "a".repeat(64) });
    expect(invoke).toHaveBeenCalledWith("create_calendar", {
      calendar: expect.objectContaining({ name: "Conf‮", imported: true, readonly: false }),
    });
  });

  it("discards without importing, and refuses text that is not a calendar", async () => {
    useRootReviewStore.setState({ imports: [staged({ text: "root:x:0:0" })] });
    render(<RootReviewStrip />);
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("root_mcp_import_remove", { id: "a".repeat(64) }));
    expect(invoke).not.toHaveBeenCalledWith("create_calendar", expect.anything());
  });
});
