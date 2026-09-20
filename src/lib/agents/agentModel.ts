import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { sessionStatus } from "../../../mobile-web/src/terminal/statusLine";

/**
 * The model tag beside an agent tab: the transcript's model id, shortened for
 * a pill. `claude-opus-4-1-20250805` → `opus-4-1`; a name with no vendor
 * prefix or date (`gpt-5-codex`, `o3`) is shown as it is. Nothing is mapped
 * through a table — a model this file has never heard of still gets an honest
 * tag, which is the point of reading the transcript instead of guessing.
 */
export function shortModelName(id: string): string {
  const trimmed = id.trim();
  const short = trimmed.replace(/-\d{8}$/, "").replace(/^claude-/, "");
  return short || trimmed;
}

/**
 * The model an agent session is *showing* — the one it prints under its own
 * input box, read off the pane's screen with the parser the phone's Focus
 * status line uses (`mobile-web/src/terminal/statusLine`), so the tag beside a
 * tab and the chip over its keyboard say the same words. The effort joins it
 * where the session prints one beside the model (Antigravity), exactly as the
 * chip composes it.
 *
 * It is the transcript's answer (`shortModelName` above) that this stands in
 * front of, and for two reasons: the transcript names the model of the last
 * *answer*, so a `/model` switch is invisible until the next one, and it names
 * it as an API id (`claude-opus-4-1-20250805`) rather than as the session's own
 * words. A pane this window does not hold — a popped-out tab, a tab whose view
 * has never mounted — has no screen to read, and the transcript answers.
 */
export function screenModelTag(buffer: ReadableBufferLike, agentLabel?: string): string | undefined {
  const status = sessionStatus(readableScreen(buffer).lines, agentLabel);
  if (!status?.model) return undefined;
  return status.effort ? `${status.model} · ${status.effort}` : status.model;
}
