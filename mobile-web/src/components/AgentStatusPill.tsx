import type { AgentStatus } from "../api";

/** The desktop tab strip's status glyphs (`TabStatusMark`): ▶ working,
 *  ? waiting on a decision, ✓ finished. ▶ has an emoji presentation on phones,
 *  so each carries U+FE0E to stay a plain glyph in the pill's own colour —
 *  written as an escape because the selector is invisible in source. */
const TEXT = "︎";
export const AGENT_STATUS_GLYPH: Record<AgentStatus, string> = {
  working: `▶${TEXT}`,
  question: `?`,
  done: `✓${TEXT}`,
};

/** A tab's agent state, as the project and Activity lists both show it: the
 *  desktop's glyph, then the word. The glyph is decoration on a pill that
 *  already names its state, so a screen reader hears the word alone. */
export function AgentStatusPill({ status }: { status: AgentStatus }) {
  return <small className={`agent-status ${status}`}><span className="agent-status-glyph" aria-hidden="true">{AGENT_STATUS_GLYPH[status]}</span>{status}</small>;
}
