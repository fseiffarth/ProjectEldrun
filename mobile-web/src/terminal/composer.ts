// One implementation shared with desktop scheduled delivery. Keeping this file
// as the Mobile import seam avoids churn in the terminal screen and its tests.
export {
  AGENT_LINE_RESET,
  PASTE_END,
  PASTE_START,
  agentInputWrites,
  sanitizeAgentMessage,
} from "../../../shared/agentComposer";

const CLAUDE_AGENT = /claude/iu;

/** Whether a phone message goes to the agent inside bracketed paste markers.
 * Claude Code turns every bracketed paste — one short line too — into a
 * `[Pasted text]` block and hands it to the model as pasted content, so a
 * message typed on the phone reaches it as typed keys and its submit rides the
 * write gap. The other families keep the markers where the pane has the mode
 * on: they are what stops Codex reading a coalesced `text CR` as one paste. */
export function bracketsAgentMessage(agentLabel: string | undefined, paneBracketed: boolean): boolean {
  return paneBracketed && !(agentLabel !== undefined && CLAUDE_AGENT.test(agentLabel));
}
