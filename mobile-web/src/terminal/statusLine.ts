/**
 * Reads the status area an agent TUI draws *below its input box* — the line
 * Claude Code and Codex use for the working directory, git branch, model, mode
 * and remaining context — so the phone composer can show the same facts as
 * chips (the shape of the official Claude Code mobile composer: ＋ · model ·
 * mode).
 *
 * This is deliberately narrower than the semantic parser `readableScreen`
 * replaced: it never classifies session *output*. It only looks at the last
 * few lines, only below a line that is recognizably the TUI's own input
 * prompt, and only reports a field that positively matched a known shape —
 * an unmatched field stays absent and the chip falls back to a generic label.
 * Nothing here injects keystrokes; the chips' actions are the caller's.
 */

export interface SessionStatus {
  /** Working directory, as printed (`~/…` or absolute). */
  path?: string;
  /** Git branch, from `(branch)` beside the path or a ⎇/🌿-marked token. */
  branch?: string;
  /** Model name (claude/opus/sonnet/haiku/fable, gpt-*, codex, gemini, …). */
  model?: string;
  /** Permission/approval mode (plan, accept edits, bypass permissions, …). */
  mode?: string;
  /** Remaining context, e.g. `85%`. */
  context?: string;
}

interface StatusLineLike { text: string }

/** The input prompt after `readableScreen` stripped the box frame: `>`, `›` or
 * `❯`, alone or followed by the draft being typed. `*` is Qwen Code's YOLO
 * prompt prefix — without it a session in YOLO mode has no readable status at
 * all, and a walk that lands there could not be confirmed. */
const INPUT_LINE = /^\s*[>›❯*](\s|$)/u;

/** How far up from the bottom the input line may sit. The box is always the
 * bottom of a live TUI frame; anything higher is quoted output. */
const SEARCH_WINDOW = 8;
/** Status lines read below the input line. Claude Code draws at most a mode
 * line plus a statusline/shortcut line. */
const MAX_STATUS_LINES = 3;

/** Field separators the CLIs actually print between status facts. */
const SEGMENT_SPLIT = /\s{2,}|\s[·•|]\s/u;

/** Mode phrases, most specific first. The Qwen Code shapes ("YOLO mode",
 * "⏸ Ask permissions", "Auto mode", each with a "(shift + tab to cycle)"
 * suffix in the same segment) come from its `AutoAcceptIndicator`, read out of
 * the installed CLI — English locale only, which is also the CLI's default.
 * Bare "auto" — Codex's middle approval mode — is matched last and only as a
 * segment of its own: unanchored it would claim Claude Code's "auto-compact"
 * context notice and any path with an `auto` component. */
const MODES: [RegExp, string][] = [
  [/\bplan mode\b/iu, "plan"],
  [/\baccept edits\b/iu, "accept edits"],
  [/\bauto-accept\b/iu, "auto-accept"],
  [/\bbypass(?:ing)? permissions\b/iu, "bypass permissions"],
  [/\bdefault mode\b/iu, "default"],
  [/\bread only\b/iu, "read only"],
  [/\bfull access\b/iu, "full access"],
  [/\byolo mode\b/iu, "yolo"],
  [/\bask permissions\b/iu, "ask permissions"],
  [/\bauto mode\b/iu, "auto"],
  [/^[⏵⏩▶›>\s]*auto(?:\s+on)?$/iu, "auto"],
];

/** Model families the chip recognizes. A token, never a sentence. */
const MODEL =
  /\b(claude[\w.-]*|(?:opus|sonnet|haiku|fable|mythos)(?:[ -][\w.]+)?|gpt-[\w.-]+|codex(?:-[\w.-]+)?|o[134](?:-mini)?|gemini[\w.-]*|qwen[\w.:-]*|llama[\w.:-]*|deepseek[\w.:-]*|mistral[\w.:-]*)\b/iu;

/** A working directory as the CLIs print one: `~`, `~/…`, `/…` or `C:\…`. */
const PATH = /(?:^|\s)(~(?:\/[^\s]*)?|\/[^\s]+|[A-Za-z]:\\[^\s]+)(?=\s|$)/u;

/** `(branch)` — no spaces inside, at least one letter, so "(shift+tab to
 * cycle)" and "(3)" stay unmatched. */
const PAREN_BRANCH = /\(([^()\s]*[A-Za-z][^()\s]*)\)/u;
/** A branch named by a git glyph or prefix: `⎇ main`, `🌿 main`, `git:main`. */
const MARKED_BRANCH = /(?:[⎇]|🌿|\bgit:)\s*([\w./-]+)/u;

function classify(segment: string, status: SessionStatus) {
  if (!status.context && /context/iu.test(segment)) {
    const percent = /(\d{1,3}(?:\.\d+)?)\s?%/u.exec(segment);
    if (percent) {
      status.context = `${percent[1]}%`;
      return;
    }
  }
  // Gemini's footer says "NN% used" without the word "context". Only a
  // segment that is nothing but that figure counts — a percentage inside a
  // sentence is not a context readout.
  if (!status.context) {
    const used = /^(\d{1,3}(?:\.\d+)?)\s?%\s+(?:context\s+)?used$/iu.exec(segment);
    if (used) {
      status.context = `${used[1]}%`;
      return;
    }
  }
  if (!status.mode) {
    for (const [pattern, name] of MODES) {
      if (pattern.test(segment)) {
        status.mode = name;
        return;
      }
    }
  }
  if (!status.path) {
    const path = PATH.exec(segment);
    if (path) {
      status.path = path[1];
      if (!status.branch) {
        const branch = PAREN_BRANCH.exec(segment.slice(path.index + path[0].length));
        if (branch) status.branch = branch[1];
      }
      return;
    }
  }
  if (!status.branch) {
    const branch = MARKED_BRANCH.exec(segment);
    if (branch) {
      status.branch = branch[1];
      return;
    }
  }
  if (!status.model) {
    const model = MODEL.exec(segment);
    if (model) status.model = model[1];
  }
}

/**
 * The status the session is showing right now, or `null` when the bottom of
 * the screen is not a TUI input frame (mid-scroll output, a full-screen
 * dialog, a shell).
 */
export function sessionStatus(lines: readonly StatusLineLike[]): SessionStatus | null {
  let inputIndex = -1;
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - SEARCH_WINDOW; index -= 1) {
    if (INPUT_LINE.test(lines[index].text)) {
      inputIndex = index;
      break;
    }
  }
  if (inputIndex < 0) return null;
  const status: SessionStatus = {};
  let read = 0;
  for (let index = inputIndex + 1; index < lines.length && read < MAX_STATUS_LINES; index += 1) {
    const text = lines[index].text.trim();
    if (!text) continue;
    read += 1;
    for (const segment of text.split(SEGMENT_SPLIT)) classify(segment.trim(), status);
  }
  return status;
}

/** A path shortened for a chip-width readout: the last two components, with
 * the home prefix kept as `~`. The full path belongs in the title attribute. */
export function shortenPath(path: string): string {
  const parts = path.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
