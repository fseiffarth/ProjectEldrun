/**
 * Reads an agent CLI's browser sign-in off the live screen, so the phone can
 * finish it: `/login` in Claude Code, Copilot's device code, Codex's
 * "Sign in with ChatGPT", Gemini's and Qwen's `/auth`, Antigravity's and
 * Cursor's launch-time sign-in.
 *
 * Every one of them prints a URL and then waits in one of four ways, and the
 * way is read off the URL and the lines around it — nothing per CLI:
 *
 *   - `device`   the page asks for a short code the CLI printed
 *                (`ABCD-1234`); the CLI polls until it is entered there.
 *   - `code`     the page ends on a code to paste back into the session
 *                (Claude's `Paste code here if prompted >`, Gemini's
 *                "Enter the authorization code").
 *   - `callback` the page redirects to `http://localhost:<port>/…` — the
 *                CLI's own listener on the desktop. On the phone that
 *                redirect fails, and the address it failed on is what the
 *                desktop relays to the listener (`sign_in.rs`).
 *   - `wait`     none of those: the CLI polls its provider until the page
 *                says yes.
 *
 * Only a URL that carries an OAuth or device-login marker counts — a link in
 * an answer is not a sign-in — and only near the bottom of the screen, where
 * the CLI is waiting. Nothing here sends keystrokes.
 */

export type SignInFlow = "device" | "code" | "callback" | "wait";

export interface SignIn {
  /** The page to open, rejoined across the rows the session wrapped it on. */
  url: string;
  /** The page's host, for the button. */
  site: string;
  flow: SignInFlow;
  /** The code a device-login page asks for, as printed. */
  userCode?: string;
}

interface SignInLineLike { text: string }

/** How far up from the bottom the URL may sit. The CLI draws its prompt, a
 * spinner and a footer under it, and at phone width a long line wraps. */
const SEARCH_WINDOW = 40;
/** Characters a URL may contain (RFC 3986), without the closing bracket and
 * quote a sentence wraps it in. */
const URL_CHARS = /[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]/u;
const URL_START = /https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+/u;
/** A row that is nothing but more of the URL. */
const URL_ROW = /^[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+$/u;
/** Query keys only an OAuth or device-login request carries. */
const AUTH_KEYS = ["client_id", "code_challenge", "response_type", "user_code", "challenge"];
/** Device-login pages, which take their code on the page. */
const DEVICE_PATH = /\/(?:login\/device|device|activate)(?:\/|$)/iu;
/** A device code as the CLIs print them: `ABCD-1234`, `WDJB-MJHT`. */
const USER_CODE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/u;
/** The CLI saying the sign-in went through. A CLI that prints this under the
 * link leaves the link on screen; it no longer leads anywhere. */
const SIGNED_IN = /\b(?:signed|logged) in\b|\blogin successful\b|\bsuccessfully (?:signed|logged|authenticated)\b|\bauthenticat(?:ed|ion) (?:successfully|successful|complete)\b/iu;
/** The CLI asking for a code to be pasted back into the session. */
const PASTE_PROMPT = /\b(?:paste|enter)\b[^.\n]{0,30}\b(?:authori[sz]ation\s+)?code\b/iu;

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/gu, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(bare);
}

/** Whether the address a redirect points at is the CLI's own listener. */
function redirectsHome(url: URL): boolean {
  const redirect = url.searchParams.get("redirect_uri");
  if (!redirect) return false;
  try {
    const target = new URL(redirect);
    return target.protocol === "http:" && isLoopback(target.hostname);
  } catch {
    return false;
  }
}

function isSignInUrl(url: URL): boolean {
  return AUTH_KEYS.some((key) => url.searchParams.has(key)) || DEVICE_PATH.test(url.pathname);
}

/** The URL starting on `rows[index]`, with the rows the session wrapped it
 * onto: a row it fills to its end is continued by the next rows that are
 * nothing but URL. A TUI wraps a long line itself, with hard breaks, so
 * xterm's own soft-wrap join does not see them. */
function urlAt(rows: string[], index: number): { url: string; end: number } | null {
  const match = URL_START.exec(rows[index]);
  if (!match) return null;
  let url = match[0];
  let end = index;
  let reachesEnd = rows[index].trimEnd().endsWith(match[0]);
  while (reachesEnd && end + 1 < rows.length) {
    const next = rows[end + 1].trim();
    // A box border or a gutter mark around the URL is the TUI's, not the URL's.
    const piece = next.replace(/^[│|]\s*/u, "").replace(/\s*[│|]$/u, "");
    if (!piece || !URL_ROW.test(piece)) break;
    url += piece;
    end += 1;
    reachesEnd = true;
  }
  // A sentence's full stop or a closing bracket is not part of the link.
  while (url.length > 0 && !URL_CHARS.test(url[url.length - 1])) url = url.slice(0, -1);
  url = url.replace(/[.,;:!?']+$/u, "");
  return { url, end };
}

/**
 * The sign-in the session is waiting on, or `null`. The newest sign-in URL in
 * the bottom window wins: a CLI that printed a first link and then a second
 * ("Browser didn't open? Use the url below") means the second.
 */
export function readSignIn(lines: readonly SignInLineLike[]): SignIn | null {
  const from = Math.max(0, lines.length - SEARCH_WINDOW);
  const rows = lines.slice(from).map((line) => line.text);
  let found: { url: URL; index: number; end: number } | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const hit = urlAt(rows, index);
    if (!hit) continue;
    const url = httpsUrl(hit.url);
    if (url && isSignInUrl(url)) found = { url, index, end: hit.end };
    index = hit.end;
  }
  if (!found) return null;
  const { url } = found;
  if (rows.slice(found.end + 1).some((row) => SIGNED_IN.test(row))) return null;
  // What the CLI printed around its link: the lines that introduce it, the
  // rest of its own line ("… and enter code ABCD-1234") and whatever it asks
  // under it — never the URL, whose query can hold anything.
  const around = rows.slice(Math.max(0, found.index - 3), found.index)
    .concat(rows[found.index].replace(URL_START, " "), rows.slice(found.end + 1))
    .join("\n");
  const userCode = url.searchParams.get("user_code") ?? USER_CODE.exec(around)?.[1] ?? undefined;
  let flow: SignInFlow;
  if (userCode && !url.searchParams.has("redirect_uri")) flow = "device";
  else if (PASTE_PROMPT.test(around)) flow = "code";
  else if (redirectsHome(url)) flow = "callback";
  else if (url.searchParams.has("redirect_uri")) flow = "code";
  else flow = "wait";
  return { url: url.toString(), site: url.hostname, flow, ...(userCode ? { userCode } : {}) };
}

/**
 * What the reader pasted back, told apart: the address a `localhost`
 * redirect failed on — which only the desktop can deliver — or anything else,
 * which the session reads as typed text. An address is accepted only in the
 * shape the desktop will take (`sign_in.rs`), so a refusal there is rare.
 */
export function pastedCallback(pasted: string): string | null {
  const text = pasted.trim();
  if (!/^http:\/\//iu.test(text)) return null;
  try {
    const url = new URL(text);
    if (!isLoopback(url.hostname) || !url.port) return null;
    return url.searchParams.get("state") && (url.searchParams.get("code") || url.searchParams.get("error")) ? text : null;
  } catch {
    return null;
  }
}

/** The slash command that starts a sign-in in each CLI's own session, where
 * its docs name one. A CLI missing here signs in when it starts (Antigravity,
 * Codex, Cursor) or has no command the phone is sure of; the screen reader
 * above still catches its link. */
const SIGN_IN_COMMANDS: Record<string, string> = {
  claude: "/login",
  copilot: "/login",
  gemini: "/auth",
  qwen: "/auth",
};

export function signInCommand(cli: string): string | null {
  return SIGN_IN_COMMANDS[cli] ?? null;
}
