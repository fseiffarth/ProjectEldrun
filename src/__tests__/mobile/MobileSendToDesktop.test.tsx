/**
 * Send to desktop: a phone file goes to the desktop's global inbox
 * (`POST /api/v1/inbox`), never to a tab's project inbox, and each pick says
 * whether it landed.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendToDesktop } from "../../../mobile-web/src/components/SendToDesktop";
import { MAX_INBOX_FILE } from "../../../mobile-web/src/api";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function pick(files: File[]) {
  const input = screen.getByTestId("send-to-desktop-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

describe("Mobile Send to desktop", () => {
  it("posts the raw file to the global inbox and says it landed", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ file: { name: "20260921-120000-ticket.pdf", size: 3 } }), { status: 201 }));
    render(<SendToDesktop />);
    pick([new File(["pdf"], "ticket.pdf", { type: "application/pdf" })]);
    expect(await screen.findByText("On the desktop — in its inbox")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/inbox?name=ticket.pdf");
    expect(init.method).toBe("POST");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss ticket.pdf" }));
    expect(screen.queryByText("ticket.pdf")).toBeNull();
  });

  it("maps the desktop's refusal to a sentence and refuses oversized picks before sending", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "inbox_full" }), { status: 507 }));
    render(<SendToDesktop />);
    const big = new File(["x"], "movie.mp4");
    Object.defineProperty(big, "size", { value: MAX_INBOX_FILE + 1 });
    pick([new File(["x"], "a.txt"), big]);
    expect(await screen.findByText("did not fit — the desktop's inbox is full.")).toBeTruthy();
    expect(screen.getByText("is larger than 24 MB.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
