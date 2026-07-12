/**
 * Heuristic detection of an agent "waiting for a decision" prompt from its
 * terminal output. An agent tab that has gone quiet is either done with its turn
 * or blocked on a permission/choice prompt, and only the text on screen tells
 * the two apart — so we sniff the tail of its output for the interactive
 * selection menu that Claude/Codex (and similar) render while awaiting input.
 *
 * This is deliberately conservative and agent-shaped: it degrades to "not a
 * decision" (→ treated as finished) for agents whose prompts we don't recognize,
 * which is the safe default (a green "finished" lamp rather than a wrong orange).
 */

// A pointer glyph marking a numbered choice, e.g. "❯ 1. Yes" / "▶ 2) No" — the
// shape Claude Code and Codex use for approval/selection prompts.
const POINTER_CHOICE = /[❯▶►➤»›]\s*\d+[.)]\s/u;

// A yes/no (or allow/deny) style numbered menu visible on screen, matched
// independently of the pointer glyph (some renderers drop it while scrolling).
const AFFIRM = /\b1[.)]\s*(yes|proceed|allow|approve|continue)/i;
const DENY = /\b2[.)]\s*(no|keep|cancel|reject|deny|don'?t)/i;

// A pointer glyph directly beside a bare yes/no-style word, e.g. "❯ Yes" /
// "❯ Allow" — the shape a simple binary confirmation takes when it isn't
// numbered (only multi-choice menus number their options).
const POINTER_WORD =
  /[❯▶►➤»›]\s*(yes|no|proceed|allow|approve|continue|cancel|reject|deny|don'?t)\b/i;

// Terminal escape sequences, peeled off in this order: OSC (`ESC ] … BEL|ST`),
// which can carry an arbitrary payload such as a window title; then CSI
// (`ESC [ … final byte`), the colour/cursor traffic that makes up most of a TUI
// redraw; then charset designators (`ESC ( B` and friends, which agents emit
// constantly); then any remaining two-character escape.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CHARSET = /\x1b[()*+][@-~]/g;
const ESC2 = /\x1b[@-Z\\-_]/g;

/**
 * Strip ANSI escape sequences from terminal text. The prompt regexes above are
 * written against plain rows, but the text we classify comes straight off the
 * PTY stream — the only source available for a tab whose xterm was never opened
 * — where a menu line is shot through with colour codes.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(CHARSET, "")
    .replace(ESC2, "");
}

/**
 * True when the given terminal text (typically the tail of an agent's output)
 * looks like an agent decision/permission prompt awaiting the user's input.
 */
export function looksLikeDecisionPrompt(text: string): boolean {
  const plain = stripAnsi(text);
  if (POINTER_CHOICE.test(plain)) return true;
  if (POINTER_WORD.test(plain)) return true;
  if (AFFIRM.test(plain) && DENY.test(plain)) return true;
  return false;
}
