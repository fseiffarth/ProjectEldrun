/**
 * Signing an agent in from the phone alone: the ＋ sheet's "Sign in to an
 * agent" list, the readers that notice a session asking for a login and one
 * saying it went through, and the step sheet's sign-in-tab states.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasSignInTab, readSignedOut, signInAlternate, signInDone } from "../../../mobile-web/src/terminal/signIn";
import { SignInSheet } from "../../../mobile-web/src/screens/SignInSheet";
import { NewTabSheet } from "../../../mobile-web/src/screens/NewTabSheet";

const rows = (...texts: string[]) => texts.map((text) => ({ text }));
const DEVICE = { url: "https://github.com/login/device", site: "github.com", flow: "device" as const, userCode: "ABCD-1234" };
const CODE = { url: "https://claude.ai/oauth/authorize?client_id=x&response_type=code", site: "claude.ai", flow: "code" as const };

describe("reading a session's login state", () => {
  it("sees a session asking for a sign-in", () => {
    expect(readSignedOut(rows("> fix the build", "Not logged in · Please run /login"))).toBe(true);
    expect(readSignedOut(rows("API Error: 401 · Invalid API key · Please run /login"))).toBe(true);
    expect(readSignedOut(rows(" Select login method:", " ❯ 1. Claude account with subscription"))).toBe(true);
    expect(readSignedOut(rows("How would you like to authenticate for this project?"))).toBe(true);
  });

  it("lets go once the sign-in went through, and ignores what scrolled away", () => {
    expect(readSignedOut(rows("Not logged in · Please run /login", "Login successful. Press Enter to continue"))).toBe(false);
    expect(readSignedOut(rows("Not logged in", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)))).toBe(false);
    expect(readSignedOut(rows("All tests pass."))).toBe(false);
  });

  it("reads a success, never a 'not logged in'", () => {
    expect(signInDone(rows("Login successful."))).toBe(true);
    expect(signInDone(rows("Successfully logged in"))).toBe(true);
    expect(signInDone(rows("✓ Logged in as octocat"))).toBe(true);
    expect(signInDone(rows("Not logged in · Please run /login"))).toBe(false);
    expect(signInDone(rows("You aren't signed in yet"))).toBe(false);
  });

  it("knows which CLIs have a sign-in tab and another way in", () => {
    expect(hasSignInTab("claude")).toBe(true);
    expect(hasSignInTab("cursor")).toBe(true);
    expect(hasSignInTab("antigravity")).toBe(false);
    expect(hasSignInTab("gemini")).toBe(false);
    expect(signInAlternate("claude")).toBe("console");
    expect(signInAlternate("codex")).toBe("browser");
    expect(signInAlternate("copilot")).toBeUndefined();
  });
});

describe("SignInSheet in a sign-in tab", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("waits for the link, then shows the steps with one tap to copy the code and open the page", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { rerender } = render(<SignInSheet tabId="t1" agent="Copilot" signIn={null} signInTab connected onType={() => true} onClose={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("Starting Copilot's sign-in");
    rerender(<SignInSheet tabId="t1" agent="Copilot" signIn={DEVICE} signInTab connected onType={() => true} onClose={() => undefined} />);
    const open = screen.getByRole("link", { name: /Copy the code and open the page/ });
    expect(open.getAttribute("href")).toBe(DEVICE.url);
    fireEvent.click(open);
    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
    await screen.findByRole("button", { name: "Copied" });
    expect(screen.getByText(/Paste the code on the page and approve/)).toBeTruthy();
  });

  it("pastes the page's code from the clipboard in one tap", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: () => Promise.resolve("  code#state \n"), writeText: () => Promise.resolve() } });
    const onType = vi.fn(() => true);
    render(<SignInSheet tabId="t1" agent="Claude" signIn={CODE} signInTab connected onType={onType} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste the code" }));
    await waitFor(() => expect(onType).toHaveBeenCalledWith("code#state"));
    expect(screen.getByRole("status").textContent).toContain("Claude is checking the code");
  });

  it("says when it went through, and Done finishes the tab", () => {
    const onFinish = vi.fn();
    render(<SignInSheet tabId="t1" agent="Claude" signIn={null} done signInTab connected onType={() => true} onFinish={onFinish} onClose={() => undefined} />);
    expect(screen.getByText("Signed in to Claude")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onFinish).toHaveBeenCalled();
  });

  it("offers to start again, or the other way in, once the sign-in ended without success", () => {
    const onRetry = vi.fn();
    render(<SignInSheet tabId="t1" agent="Codex" signIn={null} ended signInTab alternate="browser" connected onType={() => true} onRetry={onRetry} onClose={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toContain("ended without signing in");
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(onRetry).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Sign in through the browser instead" }));
    expect(onRetry).toHaveBeenLastCalledWith(true);
  });
});

describe("NewTabSheet → Sign in to an agent", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("lists each agent's login and opens a sign-in tab for the one picked", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        worktrees: [],
        cloud: [],
        sign_in: [
          { agent_id: "a1", signed_in: true, account: "me@example.com", alternate: "console" },
          { agent_id: "a2", signed_in: false, alternate: "browser" },
          { agent_id: "a3" },
        ],
      }),
    } as Response);
    const onPick = vi.fn();
    const agents = [
      { id: "a1", label: "Claude", modes: [] },
      { id: "a2", label: "Codex", modes: [] },
      { id: "a3", label: "Copilot", modes: [] },
    ];
    render(<NewTabSheet projectId="p1" agents={agents} busy={false} onPick={onPick} onSendFile={() => undefined} onClose={() => undefined} />);
    const entry = await screen.findByRole("button", { name: /Sign in to an agent/ });
    expect(entry.textContent).toContain("1 not signed in");
    fireEvent.click(entry);
    expect(screen.getByText("Signed in as me@example.com")).toBeTruthy();
    expect(screen.getByText("Not signed in")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[0]);
    expect(onPick).toHaveBeenLastCalledWith("agent", agents[1], undefined, { sign_in: "default" });
    fireEvent.click(screen.getByRole("button", { name: "Use an Anthropic Console account instead" }));
    expect(onPick).toHaveBeenLastCalledWith("agent", agents[0], undefined, { sign_in: "alternate" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(onPick).toHaveBeenLastCalledWith("agent", agents[0], undefined, { sign_in: "default" });
  });
});
