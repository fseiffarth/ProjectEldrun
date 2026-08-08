import type { TabKind } from "../stores/tabs";

const CSI = "\x1b[";
const claimedInitialInputs = new Set<string>();

/** xterm answers terminal identity probes by emitting CSI ... c back through
 *  `onData`, for example secondary DA: `ESC [ > 0 ; 276 ; 0 c`. During an
 *  auto-run tab startup that response can land in readline before Eldrun types
 *  `initialInput`, making the shell execute `0;276;0c...` instead of the command.
 *  Suppress only the standalone identity replies while an auto-input is pending;
 *  normal interactive terminal programs can still receive them afterward. */
export function isTerminalIdentityResponse(data: string): boolean {
  return new RegExp(`^(?:${CSI.replace("[", "\\[")}[?>]?[0-9;]*c)+$`).test(data);
}

/** The queries a program sends TO the terminal — device attributes, device
 *  status, mode and version reports. Each one is *answered* by xterm through
 *  `onData`, i.e. straight back into the PTY as if the user had typed it.
 *
 *  They are stripped out of output that reaches xterm LATE — everything a pane
 *  buffered while it was closed or hidden (see `TerminalView`'s `flushPending`).
 *  A query is only meaningful to the program that asked it, within the timeout
 *  it waits out; parsed minutes later, the answer lands at whatever prompt is on
 *  screen by then. That is how a remote shell ends up holding `0;276;0c`: tmux
 *  probes the terminal with `ESC[>c` when it attaches, the tab was in the
 *  background so the probe sat in the buffer, and the reply readline finally
 *  received became command-line text (readline consumes the `ESC[>` prefix as an
 *  unknown key sequence and inserts the rest literally).
 *
 *  Dropping them costs the catch-up nothing: not one of these sequences draws
 *  anything. Only ever applied to buffered output — a query in *live* output is
 *  answered normally, so a program running in a visible pane still gets its
 *  reply. */
const TERMINAL_QUERIES = new RegExp(
  [
    "\\x1b\\[[?>=]?[0-9;]*c", // DA1 / DA2 / DA3 — device attributes
    "\\x1b\\[\\??[0-9;]*n", // DSR — device status (5n, 6n cursor position, ?6n)
    "\\x1b\\[\\??[0-9;]*\\$p", // DECRQM — "is this mode set?"
    "\\x1b\\[>[0-9;]*q", // XTVERSION (a space before `q` would be DECSCUSR, not a query)
    "\\x1bP\\$q[^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)", // DECRQSS — "what is this setting?"
    "\\x1b\\](?:4;[0-9]+|1[0-9]);\\?(?:\\x1b\\\\|\\x07)", // OSC palette / fg / bg colour query
  ].join("|"),
  "g",
);

export function stripTerminalQueries(data: string): string {
  return data.includes("\x1b") ? data.replace(TERMINAL_QUERIES, "") : data;
}

/** Anything xterm emits through `onData` as an *answer* rather than as a
 *  keystroke: the replies to {@link TERMINAL_QUERIES}. Every one of them is a
 *  CSI/OSC/DCS sequence no key produces (F3 is `ESC O R`, never `ESC [ … R`), so
 *  matching the whole string is safe against real user input.
 *
 *  Used to refuse a reply provoked by a *stale* write — the belt to
 *  {@link stripTerminalQueries}'s braces, covering any query shape that list
 *  does not know about. */
const TERMINAL_REPORT = new RegExp(
  "^(?:" +
    [
      "\\x1b\\[[?>=]?[0-9;]*[cnR]", // DA reply, DSR status, CPR cursor position
      "\\x1b\\[\\??[0-9;]*\\$y", // DECRPM — the mode report
      "\\x1b\\](?:4;[0-9]+|1[0-9]);[^\\x07\\x1b]*(?:\\x1b\\\\|\\x07)", // OSC colour reply
      "\\x1bP[01]\\$r[^\\x1b]*\\x1b\\\\", // DECRPSS
    ].join("|") +
    ")+$",
);

export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORT.test(data);
}

/** Clear any startup junk already sitting in a shell's readline buffer before
 *  auto-typing a command. No-op for agent TUIs: their prompt behavior is not a
 *  POSIX shell line editor. */
export function initialInputForPty(input: string, kind: TabKind): string {
  return kind === "shell" ? `\x15${input}` : input;
}

/** Claim the right to auto-submit `input` for `ptyId`. React dev remounts,
 *  duplicate panes, or duplicate ready events must not type the same run command
 *  twice into one shell. */
export function claimInitialInput(ptyId: string, input: string): boolean {
  const key = `${ptyId}\0${input}`;
  if (claimedInitialInputs.has(key)) return false;
  claimedInitialInputs.add(key);
  return true;
}

export function clearClaimedInitialInputsForTest(): void {
  claimedInitialInputs.clear();
}

/** Longest clipboard a program may set via OSC 52. Generous for a copied command,
 *  a diff hunk or a key, small enough that the clipboard cannot be used as a
 *  megabyte-scale dumping ground the user can't see. */
export const OSC52_MAX_CHARS = 4096;

/**
 * Decode an OSC 52 clipboard-write payload into the text it may set, or `null`
 * when the sequence must be ignored.
 *
 * OSC 52 is how a TUI (Claude Code's copy action among them) sets the system
 * clipboard when it can't reach it itself — over SSH, inside tmux, inside a
 * container. Eldrun honours it, because xterm parses OSC 52 but performs no
 * action without a handler, so the CLI's "copied!" would otherwise be a lie.
 *
 * But *any* process whose output reaches a terminal pane can emit it — a
 * contained agent, a `make` run, a hostile repo's build script, `cat` of a
 * crafted file, a remote host — and the user's next Ctrl+V might land in a root
 * shell or at a `sudo` prompt. So the payload is bounded rather than trusted:
 *
 * - **Newlines are stripped.** A `\n` is what turns a paste into an *executed*
 *   command line; without one the payload has to be read and submitted by hand.
 *   (Bracketed paste is no defence — the payload can carry its own newline.)
 * - **Length is capped** at [`OSC52_MAX_CHARS`], so a long run of spaces cannot
 *   scroll a malicious tail out of sight.
 * - A read-back query (`Pc;?`) returns `null`: answering it would let any program
 *   read whatever the user last copied anywhere.
 * - A target register that isn't the clipboard (`p`/`s` only) returns `null`.
 *
 * The caller adds the two things this function cannot see: the pane must be
 * focused, and the write is announced.
 */
export function decodeOsc52Clipboard(data: string): string | null {
  const parts = data.split(";");
  // Pc (parts[0]) names the target selection buffer(s) — "c" (clipboard), ""
  // (spec default, also clipboard), or a combination like "cp"/"cs" that includes
  // clipboard alongside primary/select. Anything without "c" (e.g. a
  // primary-selection-only "p") isn't Eldrun's one clipboard.
  if (parts.length < 2 || (parts[0] !== "" && !parts[0].includes("c"))) return null;
  if (parts[1] === "?") return null;
  let text: string;
  try {
    const binary = atob(parts[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    // Malformed payload — ignore rather than surface a write error.
    return null;
  }
  const flattened = text.replace(/[\r\n]+/g, " ").slice(0, OSC52_MAX_CHARS);
  return flattened.length > 0 ? flattened : null;
}
