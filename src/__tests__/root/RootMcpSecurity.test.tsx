import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RootMcpSecurity } from "../../components/layout/RootMcpSecurity";
import { useCalendarStore } from "../../stores/calendar/calendar";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const access = {
  calendars: { all: true, ids: [] }, projects: { all: true, ids: [] }, accounts: { all: true, ids: [] },
  families: ["calendar", "board", "projects", "mail"], write: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  useCalendarStore.setState({ loaded: true, calendars: [] });
  invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "root_mcp_security_status"
    ? { sessions: [{ id: "session", tab: "Root <script>\u202e", caller: "agent", access }], audit: [] }
    : cmd === "mail_accounts_list" ? [] : undefined));
});
afterEach(cleanup);

it("saves read-only grants for the displayed session and revokes by session id", async () => {
  render(<RootMcpSecurity />);
  await screen.findByText("Root <script> · Root agent");
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow calendar, board and draft changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("root_mcp_session_access", {
    id: "session", access: { ...access, write: false },
  }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Revoke access" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("root_mcp_session_revoke", { id: "session" }));
  expect(invoke.mock.calls.some(([command]) => command === "mail_open" || command === "mail_body")).toBe(false);
});

it("shows backend refusals without interpreting markup", async () => {
  invoke.mockImplementation(() => Promise.reject(new Error("<img src=x>\u202e denied")));
  render(<RootMcpSecurity />);
  expect((await screen.findByRole("alert")).textContent).toContain("<img src=x> denied");
  expect(document.querySelector("img")).toBeNull();
});
