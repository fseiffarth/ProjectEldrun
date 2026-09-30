/**
 * Prompts the phone sent while the agent worked (`holdTabPrompt` in
 * `MobileBridgeHost`), by the id of the send-now rule that carries each.
 *
 * Such a rule is held back only long enough for the reader to edit it from
 * the phone. Once that window has passed the scheduler types it even while
 * the agent works, as a prompt typed then would go — into the CLI's own
 * queue, where the agent can take it in mid-turn (`AgentScheduleHost`). An
 * idle agent gets it at once, window or not.
 *
 * In memory only: a rule whose entry is lost with the window is an ordinary
 * send-now rule, delivered at the agent's next idle point.
 */

/** How long a held phone prompt stays editable; an edit starts it again. */
export const PHONE_HOLD_EDIT_MS = 60_000;

const holds = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();

/** Hold `scheduleId` for the edit window, from now. */
export function holdPhonePrompt(scheduleId: string): void {
  forgetPhoneHold(scheduleId);
  const timer = setTimeout(() => {
    for (const listener of listeners) listener();
  }, PHONE_HOLD_EDIT_MS);
  holds.set(scheduleId, { until: Date.now() + PHONE_HOLD_EDIT_MS, timer });
}

/** A phone hold whose edit window is over: it may go in while the agent works. */
export function phoneHoldDue(scheduleId: string): boolean {
  const hold = holds.get(scheduleId);
  return hold !== undefined && Date.now() >= hold.until;
}

export function forgetPhoneHold(scheduleId: string): void {
  const hold = holds.get(scheduleId);
  if (!hold) return;
  clearTimeout(hold.timer);
  holds.delete(scheduleId);
}

/** Hear an edit window end; the return value stops it. */
export function onPhoneHoldDue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function _clearPhoneHoldsForTest(): void {
  for (const id of [...holds.keys()]) forgetPhoneHold(id);
  listeners.clear();
}
