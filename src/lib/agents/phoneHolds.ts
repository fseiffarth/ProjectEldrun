/**
 * Prompts the phone sent while the agent worked (`holdTabPrompt` in
 * `MobileBridgeHost`), by the id of the send-now rule that carries each.
 *
 * Such a rule does not wait for the agent's idle point: the scheduler types it
 * at once, even while the agent works, as a prompt typed then would go — into
 * the CLI's own queue, where the agent can take it in mid-turn
 * (`AgentScheduleHost`). It waits only while the pane can't take it (not
 * started, or on a question a typed line would answer); until then the phone
 * can still rewrite it.
 *
 * In memory only: a rule whose entry is lost with the window is an ordinary
 * send-now rule, delivered at the agent's next idle point.
 */

const holds = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

/** Mark `scheduleId` for the CLI's queue and wake the scheduler for it. */
export function holdPhonePrompt(scheduleId: string): void {
  forgetPhoneHold(scheduleId);
  // Next task, so the caller's own bookkeeping lands before the sweep.
  holds.set(scheduleId, setTimeout(() => {
    for (const listener of listeners) listener();
  }, 0));
}

/** A phone prompt: it may go in while the agent works. */
export function phoneHoldDue(scheduleId: string): boolean {
  return holds.has(scheduleId);
}

export function forgetPhoneHold(scheduleId: string): void {
  const timer = holds.get(scheduleId);
  if (timer === undefined) return;
  clearTimeout(timer);
  holds.delete(scheduleId);
}

/** Hear a phone prompt arrive; the return value stops it. */
export function onPhoneHoldDue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function _clearPhoneHoldsForTest(): void {
  for (const id of [...holds.keys()]) forgetPhoneHold(id);
  listeners.clear();
}
