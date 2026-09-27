import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pastedCallback, readSignIn, signInCommand } from "../../../mobile-web/src/terminal/signIn";
import { SignInSheet } from "../../../mobile-web/src/screens/SignInSheet";
import { slashSuggestions } from "../../../mobile-web/src/slashCommands";

const rows = (...texts: string[]) => texts.map((text) => ({ text }));

// Claude Code's manual-code URL, wrapped by the TUI itself at 60 columns.
const CLAUDE_URL = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abcDEF123&code_challenge_method=S256&state=xyz789";

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += width) out.push(text.slice(at, at + width));
  return out;
}

describe("readSignIn", () => {
  it("rejoins a URL the TUI wrapped and reads Claude's paste-back prompt", () => {
    const signIn = readSignIn(rows(
      " Browser didn't open? Use the url below to sign in",
      "",
      ...wrap(CLAUDE_URL, 60).map((piece) => ` ${piece}`),
      "",
      " Paste code here if prompted > ",
    ));
    expect(signIn).toEqual({ url: new URL(CLAUDE_URL).toString(), site: "claude.ai", flow: "code" });
  });

  it("reads a device login and its code", () => {
    expect(readSignIn(rows("To authenticate, visit https://github.com/login/device and enter code ABCD-1234.", "Waiting for authorization..."))).toEqual({
      url: "https://github.com/login/device", site: "github.com", flow: "device", userCode: "ABCD-1234",
    });
    const qwen = readSignIn(rows("Visit https://chat.qwen.ai/authorize?user_code=K7QX-P2MD&client=qwen-code to sign in"));
    expect(qwen).toMatchObject({ flow: "device", userCode: "K7QX-P2MD" });
  });

  it("reads a redirect to the CLI's own listener as a callback, unless the CLI also takes a pasted code", () => {
    const codex = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1";
    expect(readSignIn(rows("If the link doesn't open automatically, open the following link to authenticate:", codex))?.flow).toBe("callback");
    const agy = `https://accounts.google.com/o/oauth2/v2/auth?client_id=c&redirect_uri=${encodeURIComponent("http://127.0.0.1:40123/oauth2callback")}&response_type=code&state=s`;
    expect(readSignIn(rows(agy, "If you weren't automatically redirected, paste the authorization code below:", "Or, paste the authorization code here and press Enter:"))?.flow).toBe("code");
  });

  it("reads a polling sign-in as one to open and wait on", () => {
    expect(readSignIn(rows("Open this link to log in:", "https://cursor.com/loginDeepControl?challenge=abc&uuid=u1&mode=login")))
      .toMatchObject({ flow: "wait", site: "cursor.com" });
  });

  it("ignores ordinary links, and links scrolled out of the bottom window", () => {
    expect(readSignIn(rows("See https://docs.anthropic.com/en/docs/claude-code/setup for details."))).toBeNull();
    expect(readSignIn(rows("http://localhost:1455/auth/callback?client_id=x"))).toBeNull();
    const old = rows("https://github.com/login/device ABCD-1234", ...Array.from({ length: 60 }, (_, i) => `line ${i}`));
    expect(readSignIn(old)).toBeNull();
  });

  it("lets go of a link once the CLI says the sign-in went through", () => {
    expect(readSignIn(rows("To authenticate, visit https://github.com/login/device and enter code ABCD-1234.", "Signed in successfully as octocat."))).toBeNull();
    expect(readSignIn(rows(CLAUDE_URL, "Login successful. Press Enter to continue"))).toBeNull();
  });

  it("keeps a sentence's punctuation and the next line's words out of the URL", () => {
    const signIn = readSignIn(rows("Go to https://example.com/device.", "Then come back"));
    expect(signIn?.url).toBe("https://example.com/device");
  });
});

describe("pastedCallback", () => {
  it("takes only a loopback address carrying an OAuth answer", () => {
    expect(pastedCallback(" http://localhost:1455/auth/callback?code=c&state=s ")).toBe("http://localhost:1455/auth/callback?code=c&state=s");
    expect(pastedCallback("http://127.0.0.1:40123/oauth2callback?state=s&error=access_denied")).not.toBeNull();
    expect(pastedCallback("4/0AbCdEf#state")).toBeNull();
    expect(pastedCallback("https://localhost:1455/cb?code=c&state=s")).toBeNull();
    expect(pastedCallback("http://example.com:1455/cb?code=c&state=s")).toBeNull();
    expect(pastedCallback("http://localhost/cb?code=c&state=s")).toBeNull();
    expect(pastedCallback("http://localhost:1455/cb?code=c")).toBeNull();
  });
});

describe("sign-in commands", () => {
  it("offers only the commands the CLIs document", () => {
    expect(signInCommand("claude")).toBe("/login");
    expect(signInCommand("copilot")).toBe("/login");
    expect(signInCommand("gemini")).toBe("/auth");
    expect(signInCommand("qwen")).toBe("/auth");
    expect(signInCommand("codex")).toBeNull();
    expect(signInCommand("antigravity")).toBeNull();
    expect(slashSuggestions("/log", "claude", []).map((row) => row.line)).toEqual(["/login", "/logout"]);
  });
});

describe("SignInSheet", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("types a pasted code into the session", () => {
    const onType = vi.fn(() => true);
    render(<SignInSheet tabId="t1" agent="Claude" signIn={{ url: CLAUDE_URL, site: "claude.ai", flow: "code" }} connected onType={onType} onClose={() => undefined} />);
    expect(screen.getByRole("link", { name: /Open the sign-in page/ }).getAttribute("href")).toBe(CLAUDE_URL);
    fireEvent.change(screen.getByLabelText("Code from the page"), { target: { value: "  abc#xyz  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Claude" }));
    expect(onType).toHaveBeenCalledWith("abc#xyz");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Claude is checking the code");
  });

  it("hands a localhost address to the desktop, and refuses anything else on a callback flow", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ delivered: true }) } as Response);
    const onType = vi.fn(() => true);
    render(<SignInSheet tabId="t1" agent="Codex" signIn={{ url: "https://auth.openai.com/oauth/authorize?client_id=x", site: "auth.openai.com", flow: "callback" }} connected onType={onType} onClose={() => undefined} />);
    const field = screen.getByLabelText("Address the browser ended on");
    fireEvent.change(field, { target: { value: "just-a-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    expect(screen.getByRole("alert").textContent).toContain("http://localhost");
    expect(onType).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "http://localhost:1455/auth/callback?code=c&state=s" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Codex is finishing the sign-in"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/v1/tabs/t1/sign-in-callback");
    expect(JSON.parse(String(init.body))).toEqual({ url: "http://localhost:1455/auth/callback?code=c&state=s" });
  });

  it("shows a device code and says when the session has moved on", () => {
    const { rerender } = render(<SignInSheet tabId="t1" agent="Copilot" signIn={{ url: "https://github.com/login/device", site: "github.com", flow: "device", userCode: "ABCD-1234" }} connected onType={() => true} onClose={() => undefined} />);
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    rerender(<SignInSheet tabId="t1" agent="Copilot" signIn={null} connected onType={() => true} onClose={() => undefined} />);
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("moved on");
  });
});
