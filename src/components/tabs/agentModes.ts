/**
 * Per-tab agent authority mode: the "planner tab vs doer tab" split.
 *
 * A mode is passed to the agent as a *launch flag*, so switching one on a live
 * tab means respawning it. That is only non-destructive for an agent whose
 * conversation comes back on respawn — which is why this table is a capability
 * table, not a universal field: an agent appears here only when BOTH halves are
 * true of it.
 *
 *   - It has an ABSOLUTE mode flag. Claude's `--permission-mode` sets the mode
 *     outright. (Its in-TUI shift+tab, by contrast, *cycles* — you cannot set a
 *     known mode with it without first knowing the current one, which Eldrun
 *     can't read back out of the TUI.)
 *   - It RESUMES on respawn. `resolve_claude_session_impl` (backend) rewrites
 *     `--session-id <uuid>` → `--resume <live-id>` once a session log exists, so
 *     a Claude tab killed and respawned comes back on the same conversation.
 *
 * Claude and Gemini qualify:
 *   - Claude — `--permission-mode` (absolute) + resume-by-id.
 *   - Gemini — `--approval-mode` (default/auto_edit/yolo/plan — absolute) +
 *     resume (see RESUMABLE_AGENTS). Its resume is *continue-last*, not
 *     resume-by-id, which carries one accepted caveat: a respawn brings back the
 *     project's most-recent Gemini session, so with two Gemini tabs in one
 *     project a mid-session mode toggle can reattach to the sibling's
 *     conversation — the very same ambiguity their ordinary restore already has,
 *     not a new failure the toggle introduces.
 *
 * Deliberately absent:
 *   - Codex — resumes fine, but has no plan mode: only a read-only sandbox that
 *     approximates one, and it is unverified whether `--sandbox`/`--full-auto`
 *     are accepted on `codex resume`.
 *   - Everyone else — no mode flag at all.
 */
export type AgentMode = "plan" | "auto";

/**
 * `cmd` → the launch args that put the agent in a mode.
 *
 * "auto" is edits-only auto-approval, NOT full auto-approve: for Claude that is
 * `acceptEdits` (the mode its own shift+tab reaches — "⏵⏵ auto-accept edits on",
 * where file edits apply without asking but bash/network still prompt); for
 * Gemini it is `auto_edit` (auto-approve edit tools), NOT `yolo` (auto-approve
 * ALL tools). Mapping "auto" to the bypass-everything level would hide a strictly
 * more dangerous authority behind a familiar word.
 */
export const AGENT_MODE_ARGS: Record<string, (mode: AgentMode) => string[]> = {
  claude: (mode) => ["--permission-mode", mode === "plan" ? "plan" : "acceptEdits"],
  gemini: (mode) => ["--approval-mode", mode === "plan" ? "plan" : "auto_edit"],
};

/** The flags whose `<flag> <value>` pair a mode owns, per agent. Stripped before
 *  a new mode is applied so repeated toggling can never stack them. */
const MODE_FLAGS: Record<string, string[]> = {
  claude: ["--permission-mode"],
  gemini: ["--approval-mode"],
};

/** Whether this agent can be mode-switched at all (see the note above). */
export function supportsAgentMode(cmd: string): boolean {
  return cmd in AGENT_MODE_ARGS;
}

/**
 * Rewrite an agent tab's launch args to carry `mode`: drop any mode flag already
 * present (with its value), then append the new one. Idempotent — toggling
 * plan→auto→plan yields exactly one `--permission-mode` pair, never a stack —
 * and it leaves every sibling arg (`--session-id <uuid>`, `--resume <id>`,
 * `--remote-control`) untouched.
 *
 * Returns `args` unchanged for an agent with no mode support.
 */
export function withAgentMode(cmd: string, args: string[], mode: AgentMode): string[] {
  const modeArgs = AGENT_MODE_ARGS[cmd];
  if (!modeArgs) return args;
  const flags = MODE_FLAGS[cmd] ?? [];
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i])) {
      i++; // skip the flag's value too
      continue;
    }
    stripped.push(args[i]);
  }
  return [...stripped, ...modeArgs(mode)];
}
