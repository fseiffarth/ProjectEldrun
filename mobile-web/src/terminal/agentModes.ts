/**
 * The permission modes a session offers, as a list the phone can show — the
 * counterpart of `selectPrompt` for the chip that has no dialog behind it.
 *
 * None of these CLIs opens a picker for its permission mode: the mode is
 * cycled with Shift+Tab, one step at a time, and the only readout is the line
 * the TUI redraws below its input box. So the sheet lists a family's modes and
 * the caller *applies* one by pressing Shift+Tab until `statusLine` reports
 * the mode the user asked for — every step verified against what the session
 * actually printed, never against an assumed cycle order.
 *
 * Which family a session belongs to is decided by the mode it is currently
 * showing, with the tab's agent label breaking ties — "plan" is a mode of both
 * Claude Code and Qwen Code, and only the label says which session this is. A
 * session whose mode no table claims gets no list at all, and the chip keeps
 * cycling as before — an honest fallback beats offering a mode the session may
 * not have. The one exception is a family with a `silent` mode: Claude Code
 * prints *nothing* while in its default mode, so for a tab whose label names
 * such a family, an input frame with no mode text is itself the readout.
 *
 * Deliberately absent:
 *   - Gemini CLI — since ~0.5 the approval mode is conveyed only as prompt
 *     colour and an aria-label; nothing the readable view can parse, so no
 *     switch could ever be confirmed. The chip keeps blind-cycling.
 *   - Vibe / OpenCode — full-screen (alternate-screen) TUIs; the Focus view
 *     already hands those to the Terminal view.
 */

export interface ModeChoice {
  /** The mode as `statusLine` names it — what an applied switch is checked
   * against. */
  value: string;
  label: string;
  description: string;
  /** Other names `statusLine` may report for the same mode. */
  aliases?: string[];
  /** The session shows no mode text at all while in this mode; an input frame
   * with no mode line is read as being in it. At most one per family. */
  silent?: boolean;
}

interface ModeFamily {
  /** Matches the tab's agent label ("Claude", "Qwen", …). */
  agent: RegExp;
  choices: ModeChoice[];
}

/** Claude Code: the Shift+Tab cycle, plus the mode a session started with
 * `--dangerously-skip-permissions` sits in. Bypass is deliberately listed even
 * though the ordinary cycle never reaches it: a session that has it shows it,
 * and one that does not says so when the switch fails to confirm. Default is
 * `silent` — Claude Code draws no mode line while in it. */
const CLAUDE: ModeFamily = {
  agent: /claude/iu,
  choices: [
    { value: "default", label: "Default", description: "Asks before each edit or command", silent: true },
    { value: "accept edits", label: "Accept edits", description: "Applies file edits without asking", aliases: ["auto-accept"] },
    { value: "plan", label: "Plan", description: "Researches and plans; changes nothing" },
    { value: "bypass permissions", label: "Bypass permissions", description: "Runs everything unasked — only where the session allows it" },
  ],
};

/** Codex: its approval modes, as its own status line names them. */
const CODEX: ModeFamily = {
  agent: /codex/iu,
  choices: [
    { value: "read only", label: "Read only", description: "Reads and answers; changes nothing" },
    { value: "auto", label: "Auto", description: "Edits and runs inside the workspace" },
    { value: "full access", label: "Full access", description: "Edits and runs without a workspace boundary" },
  ],
};

/** Qwen Code: all five approval modes are on its Shift+Tab cycle and every one
 * draws its own indicator text ("⏸ Ask permissions", "plan mode",
 * "auto-accept edits", "Auto mode", "YOLO mode"), so each is verifiable. */
const QWEN: ModeFamily = {
  agent: /qwen/iu,
  choices: [
    { value: "ask permissions", label: "Ask permissions", description: "Asks before each tool call" },
    { value: "plan", label: "Plan", description: "Researches and plans; changes nothing" },
    { value: "auto-accept", label: "Accept edits", description: "Applies file edits without asking", aliases: ["accept edits"] },
    { value: "auto", label: "Auto", description: "Approves safe tool calls on its own judgement" },
    { value: "yolo", label: "YOLO", description: "Runs every tool call unasked" },
  ],
};

const FAMILIES = [CLAUDE, CODEX, QWEN];

function claims(choice: ModeChoice, mode: string) {
  return choice.value === mode || (choice.aliases?.includes(mode) ?? false);
}

/** The modes to offer for a session showing `mode`, or an empty list when no
 * family recognizes it. `agentLabel` — the tab's label — breaks a tie between
 * families sharing a mode name, and is the only way in for a family's silent
 * mode: with no mode text on screen, only a label naming a silent-mode family
 * earns a list. */
export function modeChoices(mode?: string, agentLabel?: string): ModeChoice[] {
  const labelled = agentLabel
    ? FAMILIES.find((family) => family.agent.test(agentLabel))
    : undefined;
  if (!mode) {
    // No mode text. Only a family that draws none for one of its modes can
    // read that as a state; for every other family it just means the bottom of
    // the screen is not a status readout right now.
    return labelled?.choices.some((choice) => choice.silent) ? labelled.choices : [];
  }
  const normalized = mode.trim().toLowerCase();
  const claimants = FAMILIES.filter((family) =>
    family.choices.some((choice) => claims(choice, normalized)));
  if (claimants.length === 0) return [];
  return (labelled && claimants.includes(labelled) ? labelled : claimants[0]).choices;
}

/** Which listed choice the session is in right now, by value or alias.
 * `framed` says whether an input frame is on screen at all — required before
 * the absence of mode text may be read as the family's silent mode. */
export function currentMode(
  choices: readonly ModeChoice[],
  mode?: string,
  framed?: boolean,
): string | undefined {
  if (!mode) {
    return framed ? choices.find((choice) => choice.silent)?.value : undefined;
  }
  const normalized = mode.trim().toLowerCase();
  return choices.find((choice) => claims(choice, normalized))?.value;
}
