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
  useRootReviewStore.setState({ ...initial, proposals: [], imports: [staged()], count: 0, imported: [], error: null });
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

  it("imports the reported text into a calendar marked imported, then drops the staged copy", async () => {
    render(<RootReviewStrip />);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("root_mcp_import_remove", { id: "a".repeat(64) }));
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands.indexOf("create_calendar")).toBeLessThan(commands.indexOf("create_event"));
    expect(commands.indexOf("create_event")).toBeLessThan(commands.indexOf("root_mcp_import_remove"));
    expect(invoke).toHaveBeenCalledWith("create_calendar", {
      calendar: expect.objectContaining({ name: "Conf‮", imported: true, readonly: false }),
    });
    expect(useRootReviewStore.getState().imported).toEqual(["a".repeat(64)]);
  });

  it("keeps the card and removes the partial calendar when a row fails, and never imports twice", async () => {
    invoke.mockImplementation(async (command: string, args: Record<string, { id: string }>) => {
      if (command === "root_mcp_review_list") return [];
      if (command === "root_mcp_import_list") return [staged()];
      if (command === "create_calendar") return { ...args.calendar, id: "cal" };
      if (command === "create_event") throw new Error("disk full");
      return undefined;
    });
    render(<RootReviewStrip />);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_calendar", { id: "cal" }));
    expect(invoke).not.toHaveBeenCalledWith("root_mcp_import_remove", expect.anything());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("disk full");
    expect(alert.textContent).toContain("removed the partial calendar");
    // The card is still there, with a live ✓ for another try.
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false);
    expect(useRootReviewStore.getState().imported).toEqual([]);
    // Once imported in this window, a card that lingers (its removal failed)
    // has no second ✓.
    invoke.mockImplementation(async (command: string, args: Record<string, { id: string }>) => {
      if (command === "root_mcp_review_list") return [];
      if (command === "root_mcp_import_list") return [staged()];
      if (command === "create_calendar") return { ...args.calendar, id: "cal2" };
      if (command === "create_event") return { ...args.event, id: "ev" };
      if (command === "root_mcp_import_remove") throw new Error("gone already");
      return undefined;
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(useRootReviewStore.getState().imported).toEqual(["a".repeat(64)]));
    await waitFor(() => expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true));
    const creates = invoke.mock.calls.filter(([c]) => c === "create_calendar").length;
    await useRootReviewStore.getState().importStaged(staged(), "Imported");
    expect(invoke.mock.calls.filter(([c]) => c === "create_calendar").length).toBe(creates);
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
