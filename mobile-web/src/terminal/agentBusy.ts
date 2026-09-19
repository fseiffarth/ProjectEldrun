/** Whether the agent is in the middle of a turn, read off its live screen.
 *
 * Nearly every agent TUI prints how to stop it while — and only while — it
 * works: Claude Code's spinner row `✻ Thinking… (9s · esc to interrupt)`, Codex's
 * `• Working (0s • esc to interrupt)`, Gemini CLI's and Qwen Code's
 * `(esc to cancel, 3s)`, and OpenCode's status row, which carries
 * `esc interrupt` in a column of its own. Claude Code 2.1.278 dropped the
 * hint from its spinner (`✶ Cascading… (36s · ↓ 2.1k tokens)`), so that row is
 * read by its own shape (`CLAUDE_SPINNER`). The desktop's hook-driven turn state
 * would say the same, but reading it means a status call that can spawn the
 * CLI; the screen is already streaming to the phone. */

/** Rows read from the bottom. The hint sits above the input box, with at most
 * Claude Code's to-do list, the box itself and the footer rows below it. */
const BUSY_WINDOW = 24;

/** The hint as the TUIs print it: inside the spinner's parentheses after a
 * separator (`(9s · esc to interrupt)`, `(0s • esc to interrupt)`), opening
 * them (`(esc to interrupt)`, Gemini's `(esc to cancel, 3s)`), or ending a
 * status row (`⬝⬝■■  esc interrupt`) with no sentence stop after it. A bare
 * "esc to cancel" is a dialog's footer — a question, not work — so the cancel
 * form needs its elapsed time. */
const BUSY_HINT =
  /\((?:[^()]*[·•,]\s*)?esc to interrupt\b[^()]*\)|\(esc to cancel, \d+s\)|(?:^|\s)esc (?:to )?interrupt\s*$/iu;

/** Claude Code's spinner row without the hint: a spinner glyph, the verb with
 * its ellipsis, then the elapsed time opening the parentheses. The finished
 * row (`✻ Worked for 7m 59s · done 18:36`) has neither, and prose that ends a
 * bullet in an ellipsis has no timer after it. */
const CLAUDE_SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S[^()]*…\s*\(\d+(?:\.\d+)?[hms]\b/u;

export function agentWorking(lines: readonly { text: string }[]): boolean {
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - BUSY_WINDOW; index -= 1) {
    const text = lines[index].text;
    if (BUSY_HINT.test(text) || CLAUDE_SPINNER.test(text)) return true;
  }
  return false;
}
