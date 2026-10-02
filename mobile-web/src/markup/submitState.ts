/**
 * What the agent did with the last markup Submit — the pill a markup view
 * shows while it stays open (`docs/pdf_markup_rounds_plan.md` §2.2). One pure
 * machine for the phone and the desktop: each host feeds it the agent's state
 * as it sees it (the phone: the live screen's busy row and select prompt; the
 * desktop: the tab's activity) and a clock.
 *
 * ```
 * Submit ─► queued (agent was working) ─┐
 *        └► sent   (agent was idle)    ─┼─ work seen ─► working ⇄ question
 *                                       │                 │ idle ≥ SETTLE_MS
 *                                       │                 ▼
 *                                       │              finished ── work again ─► working
 *                                       └─ no work within CONFIRM_MS ─► unconfirmed
 * ```
 *
 * `finished` needs idle to hold for `SETTLE_MS`: between a turn and a queued
 * prompt the CLI is briefly idle. The machine keeps following the tab after
 * `finished` — the default instruction makes the agent list the changes
 * first, and the edit comes in a later turn — and a new Submit restarts it.
 */

/** The agent as the host sees it now. */
export type AgentSignal = "working" | "question" | "idle";
export type RoundPhase = "sent" | "queued" | "working" | "question" | "finished" | "unconfirmed";
/** `since`: when `phase` began. `sentAt`: the Submit. `idleSince`: when a
 * working or asking agent was last seen going idle, until it settles.
 * `applied`: this round is the **Make these changes** follow-up, not a
 * Submit — the button that sends it is offered only on a round without. */
export type Round = { phase: RoundPhase; since: number; sentAt: number; idleSince: number | null; applied?: boolean };

/** How long idle must hold before a turn counts as finished — as the
 * desktop scheduler's `COMPLETION_STABLE_MS`. */
export const SETTLE_MS = 3_000;
/** How long a Submit may wait for the agent to be seen at work before the
 * pill stops claiming to know (an agent whose state the host cannot read). */
export const CONFIRM_MS = 20_000;

/** A Submit went out: into the agent's queue (it was working) or straight in.
 * `applied`: it was the **Make these changes** follow-up instead. */
export function startRound(queued: boolean, now: number, applied = false): Round {
  const round: Round = { phase: queued ? "queued" : "sent", since: now, sentAt: now, idleSince: null };
  return applied ? { ...round, applied: true } : round;
}

/** Whether **Make these changes** fits the round: the agent is done with a
 * Submit's marks (or nothing says what it does) and the follow-up has not
 * gone out yet — with the default instruction the agent has only listed the
 * changes. */
export function canApply(round: Round | null): boolean {
  return round !== null && !round.applied && (round.phase === "finished" || round.phase === "unconfirmed");
}

/** A view opened again over marks sent before: no Submit of its own, so the
 * pill appears only once the agent is seen at work. */
export function followRound(agent: Exclude<AgentSignal, "idle">, now: number): Round {
  return { phase: agent, since: now, sentAt: now, idleSince: null };
}

/** The round after one look at the agent — the same object when nothing
 * changed, so a host can step it on every render without looping. */
export function stepRound(round: Round, agent: AgentSignal, now: number): Round {
  if (agent !== "idle") {
    if (round.phase === agent && round.idleSince === null) return round;
    return { ...round, phase: agent, since: round.phase === agent ? round.since : now, idleSince: null };
  }
  switch (round.phase) {
    case "sent":
    case "queued":
      return now - round.sentAt >= CONFIRM_MS ? { ...round, phase: "unconfirmed", since: now } : round;
    case "working":
    case "question": {
      const idle = round.idleSince ?? now;
      if (now - idle >= SETTLE_MS) return { ...round, phase: "finished", since: now, idleSince: null };
      return round.idleSince === null ? { ...round, idleSince: now } : round;
    }
    default:
      return round;
  }
}

/** Milliseconds until the round could change with the agent as it is — when
 * a host should look again — or `null` when only the agent can change it. */
export function nextCheck(round: Round, agent: AgentSignal, now: number): number | null {
  if (agent !== "idle") return null;
  if (round.phase === "sent" || round.phase === "queued") return Math.max(0, CONFIRM_MS - (now - round.sentAt));
  if ((round.phase === "working" || round.phase === "question") && round.idleSince !== null) return Math.max(0, SETTLE_MS - (now - round.idleSince));
  return null;
}
