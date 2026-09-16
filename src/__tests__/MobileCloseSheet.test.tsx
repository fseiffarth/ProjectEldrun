/**
 * `CloseSheet` on its own (the desktop half — the bridge closing the tab and
 * writing the layout — is MobileTabClose). This sheet exists so a phone cannot
 * end a session by a mis-tap: it asks, it says the session keeps running, and
 * it names the reason when the desktop is not there to do the closing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TabRow } from "../../mobile-web/src/api";
import { CloseSheet } from "../../mobile-web/src/screens/CloseSheet";

const tab: TabRow = { id: "t#7", label: "Shell", kind: "shell", available: true, viewer_busy: false };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Mobile close sheet", () => {
  it("asks first, names the tab, and says the session behind it keeps running", () => {
    render(<CloseSheet tab={tab} onClose={() => {}} onClosed={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Close Shell" })).toBeTruthy();
    expect(screen.getByText(/“Shell” leaves the Eldrun window/).textContent).toContain("keeps running");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DELETEs the URL-encoded tab id only on confirm, then reports closed", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ closed: true }), { status: 200 }));
    const onClosed = vi.fn();
    render(<CloseSheet tab={tab} onClose={() => {}} onClosed={onClosed} />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/v1/tabs/t%237");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("says to open desktop Eldrun on a 503 and re-enables the buttons", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 }));
    const onClosed = vi.fn();
    render(<CloseSheet tab={tab} onClose={() => {}} onClosed={onClosed} />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Open desktop Eldrun to close a tab.");
    expect(onClosed).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Close tab" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports any other failure without naming the desktop", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "unknown_tab" }), { status: 404 }));
    render(<CloseSheet tab={tab} onClose={() => {}} onClosed={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The tab could not be closed.");
  });

  it("closes without a request from Cancel, ✕ and the backdrop, and ignores a tap inside", () => {
    const onClose = vi.fn();
    render(<CloseSheet tab={tab} onClose={onClose} onClosed={() => {}} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
