import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { deliveryRecordId, isFinishedOneTime } from "../../lib/agentPromptSend";
import { promptScheduleKey } from "../../lib/agentPromptScheduled";
import { nextAfter } from "../../lib/agentPromptLinks";
import {
  scheduleVerdict,
  sortSchedules,
  type ScheduleResult,
  type ScheduledAgentPrompt,
} from "../../lib/agentSchedule";
import {
  scheduledAgentInput,
  submitScheduledAgentMessage,
} from "../../lib/scheduledAgentInput";
import { lastPtyOutputAt, useActivityStore } from "../../stores/activity";
import { recordScheduledDelivery, sendCollectedPrompt, useAgentPromptsStore } from "../../stores/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const TICK_MS = 15_000;
const OUTPUT_SETTLE_MS = 1_200;
/**
 * How long the blame wait after a delivery may hold a tab before it is given up
 * on. The wait exists to stamp the files an agent touched onto the history row,
 * and it blocks the next delivery to that tab so two prompts cannot overlap —
 * which meant a delivery that never produced output (the agent exited, the CLI
 * refused the paste) blocked *every* later send to that tab for the life of the
 * window, silently. Blame is best-effort; delivery is not.
 */
const IDLE_WAIT_MAX_MS = 10 * 60_000;
/**
 * Between the submissions of one delivery (a prefix command, then the next, then
 * the message) the tab is given time to act before the following line arrives.
 * The full idle gate is not reusable here: the occurrence is already claimed and
 * `/clear` legitimately leaves the tab busy for a moment, so this waits for the
 * PTY to go quiet and then gives up, rather than abandoning a half-sent
 * delivery.
 */
const PREFACE_SETTLE_MS = 350;
const PREFACE_SETTLE_MAX_MS = 6_000;
const PREFACE_POLL_MS = 100;

interface Binding {
  projectId: string;
  scheduleTargetId: string;
  tab: TabEntry;
}

function bindings(): Binding[] {
  return Object.entries(useTabsStore.getState().tabsByScope).flatMap(([projectId, tabs]) =>
    tabs.flatMap((tab) =>
      (tab.kind === "agent" || tab.kind === "local_agent") && tab.scheduleTargetId
        ? [{ projectId, scheduleTargetId: tab.scheduleTargetId, tab }]
        : [],
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a tab to stop producing output, capped so a chatty agent cannot
 *  hold a claimed delivery open indefinitely. */
async function settleBetweenSubmissions(ptyId: string): Promise<void> {
  const deadline = Date.now() + PREFACE_SETTLE_MAX_MS;
  await sleep(PREFACE_SETTLE_MS);
  while (Date.now() < deadline) {
    const quietFor = Date.now() - (lastPtyOutputAt(ptyId) ?? 0);
    if (quietFor >= PREFACE_SETTLE_MS) return;
    await sleep(PREFACE_POLL_MS);
  }
}

function bindingKey(binding: Pick<Binding, "projectId" | "scheduleTargetId">): string {
  return `${binding.projectId}\u0000${binding.scheduleTargetId}`;
}

function ensureLiveTargetIds(): void {
  useTabsStore.setState((state) => {
    let changed = false;
    const tabsByScope = Object.fromEntries(Object.entries(state.tabsByScope).map(([scope, tabs]) => [
      scope,
      tabs.map((tab) => {
        if ((tab.kind !== "agent" && tab.kind !== "local_agent") || tab.scheduleTargetId) return tab;
        changed = true;
        return { ...tab, scheduleTargetId: crypto.randomUUID() };
      }),
    ]));
    if (!changed) return state;
    return {
      tabsByScope,
      tabs: tabsByScope[state.scope] ?? [],
    };
  });
}

async function complete(
  binding: Binding,
  scheduleId: string,
  occurrence: string,
  result: ScheduleResult,
): Promise<void> {
  const schedules = await invoke<ReturnType<typeof useAgentSchedulesStore.getState>["byTarget"][string]>(
    "agent_schedule_complete",
    {
      projectId: binding.projectId,
      scheduleTargetId: binding.scheduleTargetId,
      scheduleId,
      occurrence,
      result,
    },
  );
  useAgentSchedulesStore.setState((state) => ({
    byTarget: { ...state.byTarget, [bindingKey(binding)]: schedules },
  }));
}

/**
 * Write one run of a schedule onto the project's Sent prompts, and retire the
 * rule if it can never fire again.
 *
 * A finished one-time schedule used to sit in the tab's schedule menu forever,
 * as a rule that says it already ran — a record wearing the shape of a plan.
 * The record belongs with the other sent prompts, where the prompt, the tab,
 * the agent, the session it went to and both times are together; the menu is
 * left holding only rules that still have a future. Recurring rules stay put
 * and contribute one history row per occurrence.
 *
 * The record is written FIRST and the rule deleted only once it lands: the
 * prompt has already reached the agent by the time this runs, so a rule
 * dropped after a failed write would take the only account of the delivery
 * with it. A throw leaves the rule in place for the next tick to retry.
 */
async function retire(
  binding: Binding,
  schedule: ScheduledAgentPrompt,
  last: { occurrence: string; result: ScheduleResult },
): Promise<void> {
  await recordScheduledDelivery(
    binding.projectId,
    { id: deliveryRecordId(schedule, last.occurrence), message: schedule.message, preface: schedule.preface },
    {
      tabLabel: binding.tab.label,
      sessionId: binding.tab.sessionId,
      agent: binding.tab.cmd,
      result: last.result,
      scheduledFor: last.occurrence || undefined,
    },
  );
  if (last.result === "delivered") {
    await continueAfterDelivery(
      binding,
      deliveryRecordId(schedule, last.occurrence),
    ).catch(() => {});
  }
  if (schedule.rule.type !== "once") return;
  await useAgentSchedulesStore
    .getState()
    .remove(binding.projectId, binding.scheduleTargetId, schedule.id)
    .catch(() => {});
  await retireCollected(binding.projectId, schedule.message);
}

/** Queue one hop of every `after` chain. This runs only after the durable
 * delivered record exists; failed and missed runs never reach it. */
async function continueAfterDelivery(binding: Binding, recordId: string): Promise<void> {
  const store = useAgentPromptsStore.getState();
  const [drafts, links] = await Promise.all([
    store.load(binding.projectId),
    store.loadLinks(binding.projectId),
  ]);
  const live = bindings()
    .filter((item) => item.projectId === binding.projectId)
    .map((item) => ({
      scheduleTargetId: item.scheduleTargetId,
      label: item.tab.label,
      sessionId: item.tab.sessionId,
      agent: item.tab.cmd,
    }));
  const schedule = useAgentSchedulesStore.getState().byTarget[bindingKey(binding)]
    ?.find((item) => deliveryRecordId(item, item.last?.occurrence ?? "") === recordId);
  const sourceIds = [recordId];
  if (schedule) {
    const key = promptScheduleKey(schedule.message);
    sourceIds.push(...drafts.filter((prompt) => promptScheduleKey(prompt.message) === key).map((prompt) => prompt.id));
  }
  const nextRows = sourceIds.flatMap((sourceId) => nextAfter(sourceId, links, drafts, live, binding.scheduleTargetId));
  const seen = new Set<string>();
  for (const next of nextRows) {
    if (seen.has(next.prompt.id)) continue;
    seen.add(next.prompt.id);
    if (!next.strand) continue;
    await sendCollectedPrompt(
      binding.projectId,
      next.strand,
      next.prompt,
    ).catch(() => {});
  }
}

/**
 * Take a collected prompt out of the active list once the rule carrying its text
 * has fired for the last time.
 *
 * "Send now" retires its prompt at send time (`sendCollectedPrompt`), so a
 * scheduled one was the only prompt that stayed collected after it had been
 * delivered — sitting in the Agents view as text still waiting to be sent, next
 * to the history row saying it already had been, which is how the same prompt
 * gets sent twice. This is that retirement, deliberately only on the path that
 * has just deleted a **one-time** rule: a recurring rule is going to fire again,
 * and its prompt belongs in the Scheduled section until it does.
 *
 * The delivery has already been recorded by the caller, so this only DELETES —
 * archiving would write a second history row for one delivery. The link is the
 * prompt's text, `lib/agentPromptScheduled`'s key, which is the same link the
 * Scheduled section marks the row by; a prompt reworded since the rule was made
 * simply stays collected, as it should, since the rule no longer carried it.
 * Best-effort throughout: the record is the part that matters, and the next tick
 * cannot retry this one (the rule is gone) but nothing is lost if it fails.
 */
async function retireCollected(projectId: string, message: string): Promise<void> {
  const key = promptScheduleKey(message);
  if (!key) return;
  const store = useAgentPromptsStore.getState();
  // Read the list fresh rather than off the store: this window may never have
  // opened that scope's Agents view, and the send-now path has already deleted
  // its own prompt, so a stale copy would be the one thing that could delete a
  // prompt somebody re-collected in the meantime.
  const prompts = await store.load(projectId).catch(() => []);
  for (const prompt of prompts) {
    if (promptScheduleKey(prompt.message) !== key) continue;
    await store.remove(projectId, prompt.id).catch(() => {});
  }
}

/**
 * Main-window-only owner of per-tab scheduled delivery. TerminalView remains the
 * PTY owner and exposes only a readiness/submission capability through the
 * registry; the scheduler never duplicates terminal lifecycle or output wiring.
 */
export function AgentScheduleHost() {
  const running = useRef(false);
  // `recordId` names the history row the delivery wrote, so the moment the
  // tab is idle again — the agent has done what the prompt asked — the files
  // it touched can be written onto that row (prompt blame, `agent_prompt_blame`).
  const waitingForIdle = useRef(
    new Map<string, { ptyId: string; submittedAt: number; recordId?: string; projectId: string }>(),
  );

  useEffect(() => {
    ensureLiveTargetIds();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const loadBindings = async () => {
      await Promise.all(bindings().map((binding) =>
        useAgentSchedulesStore.getState().load(binding.projectId, binding.scheduleTargetId).catch(() => []),
      ));
    };

    const tick = async () => {
      if (disposed || running.current) return;
      running.current = true;
      try {
        const now = new Date();
        for (const binding of bindings()) {
          if (disposed) break;
          const key = bindingKey(binding);
          const input = scheduledAgentInput(binding.scheduleTargetId);
          const activity = useActivityStore.getState();
          const waiting = waitingForIdle.current.get(key);
          if (waiting) {
            const lastOutput = lastPtyOutputAt(waiting.ptyId) ?? 0;
            const producedOutput = lastOutput > waiting.submittedAt;
            const settled = Date.now() - lastOutput >= OUTPUT_SETTLE_MS;
            const idle = !activity.busyByTab[waiting.ptyId]
              && activity.attentionByTab[waiting.ptyId] !== "decision";
            const expired = Date.now() - waiting.submittedAt >= IDLE_WAIT_MAX_MS;
            if (expired) {
              // Give up on the blame stamp rather than on the tab: whatever
              // happened to that delivery, the next prompt aimed here has to be
              // deliverable. Falls through, so this very tick can send it.
              waitingForIdle.current.delete(key);
            } else if (!producedOutput || !settled || !idle) {
              continue;
            } else {
              waitingForIdle.current.delete(key);
              // Best-effort and off the delivery path: a row the user already
              // cleared, or a project without a local repo, records nothing.
              if (waiting.recordId) {
                void useAgentPromptsStore
                  .getState()
                  .blame(waiting.projectId, waiting.recordId, new Date(waiting.submittedAt).toISOString())
                  .catch(() => []);
              }
            }
          }

          let schedules = useAgentSchedulesStore.getState().byTarget[key];
          if (!schedules) {
            schedules = await useAgentSchedulesStore.getState()
              .load(binding.projectId, binding.scheduleTargetId)
              .catch(() => []);
          }
          // Rules that finished before this ran — written by an older build, or
          // left behind by a crash between the receipt and the retire — are
          // moved to the history the same way, so the menu ends up holding only
          // rules with a future whatever wrote them.
          const finished = schedules.filter(isFinishedOneTime);
          if (finished.length > 0) {
            for (const schedule of finished) {
              await retire(binding, schedule, {
                occurrence: schedule.last?.occurrence ?? "",
                result: schedule.last?.result ?? "delivered",
              }).catch(() => {});
            }
            schedules = useAgentSchedulesStore.getState().byTarget[key] ?? [];
          }

          for (const schedule of sortSchedules(schedules, now)) {
            const verdict = scheduleVerdict(schedule, now);
            if (verdict.kind === "none") continue;
            if (verdict.kind === "missed") {
              const claimed = await invoke<boolean>("agent_schedule_claim", {
                projectId: binding.projectId,
                scheduleTargetId: binding.scheduleTargetId,
                scheduleId: schedule.id,
                occurrence: verdict.occurrence.key,
              }).catch(() => false);
              if (claimed) {
                await complete(binding, schedule.id, verdict.occurrence.key, "missed").catch(() => {});
                await retire(binding, schedule, {
                  occurrence: verdict.occurrence.key,
                  result: "missed",
                }).catch(() => {});
              }
              continue;
            }

            // Delivery waits inside the one-hour window until the PTY exists,
            // has settled, is idle, and is not on an approval/decision prompt.
            // The tab being focused is deliberately not part of this gate.
            if (!input || !input.ready()) break;
            const latestActivity = useActivityStore.getState();
            // `?? 0`, not `?? Date.now()`: a PTY that has produced no output this
            // session has nothing to settle after, and reading "no output" as
            // "output just now" made the gate permanently false — a tab whose
            // whole TUI arrived as a restored snapshot could never be delivered
            // to at all.
            if (latestActivity.busyByTab[input.ptyId]
                || latestActivity.attentionByTab[input.ptyId] === "decision"
                || Date.now() - (lastPtyOutputAt(input.ptyId) ?? 0) < OUTPUT_SETTLE_MS) break;

            const claimed = await invoke<boolean>("agent_schedule_claim", {
              projectId: binding.projectId,
              scheduleTargetId: binding.scheduleTargetId,
              scheduleId: schedule.id,
              occurrence: verdict.occurrence.key,
            }).catch(() => false);
            if (!claimed) continue;
            const submittedAt = Date.now();
            try {
              const ptyId = await submitScheduledAgentMessage(
                binding.scheduleTargetId,
                schedule.message,
                { preface: schedule.preface, settle: settleBetweenSubmissions },
              );
              // Completion after all writes means a partial/write failure becomes
              // `failed`; the durable claim prevents retry in either case.
              await complete(binding, schedule.id, verdict.occurrence.key, "delivered");
              waitingForIdle.current.set(key, {
                ptyId,
                submittedAt,
                projectId: binding.projectId,
                recordId: deliveryRecordId(schedule, verdict.occurrence.key),
              });
              await retire(binding, schedule, {
                occurrence: verdict.occurrence.key,
                result: "delivered",
              }).catch(() => {});
            } catch {
              await complete(binding, schedule.id, verdict.occurrence.key, "failed").catch(() => {});
              await retire(binding, schedule, {
                occurrence: verdict.occurrence.key,
                result: "failed",
              }).catch(() => {});
            }
            // At most one delivery per target per tick. The next waits for output
            // and a fresh idle point through `waitingForIdle` above.
            break;
          }
        }
      } finally {
        running.current = false;
      }
    };

    void loadBindings().then(tick);
    const timer = setInterval(() => void tick(), TICK_MS);
    void listen("agent-schedules-changed", () => {
      void useAgentSchedulesStore.getState().refreshLoaded().then(tick);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    // Delete schedules when their tab disappears from the live store. All tab
    // movement/locality/detach operations retain the binding, so they never hit
    // this diff. A startup GC separately removes targets absent from both live
    // and restorable state (including non-resumable tabs from the prior run).
    //
    // A scope whose KEY vanished is not a closed tab: `unloadScope` (stopping a
    // project) drops the whole in-memory scope while its layout stays on disk and
    // restores — same target ids — when the project is activated again. Deleting
    // there lost every schedule of a stopped project, exactly the state an app
    // restart keeps. So a binding is deleted only while its scope still exists
    // (`closeAllTabs` empties the scope but keeps the key, so a real close of
    // every tab still deletes); a vanished scope only forgets its idle wait, and
    // any target its saved layout no longer names is the startup sweep's to drop.
    let previous = new Map(bindings().map((binding) => [bindingKey(binding), binding]));
    const unsubscribe = useTabsStore.subscribe(() => {
      const scopes = useTabsStore.getState().tabsByScope;
      const current = new Map(bindings().map((binding) => [bindingKey(binding), binding]));
      for (const [key, binding] of previous) {
        if (current.has(key)) continue;
        waitingForIdle.current.delete(key);
        if (!Object.prototype.hasOwnProperty.call(scopes, binding.projectId)) continue;
        void invoke("agent_schedules_delete_target", {
          projectId: binding.projectId,
          scheduleTargetId: binding.scheduleTargetId,
        }).catch(() => {});
      }
      for (const [key, binding] of current) {
        if (!previous.has(key)) {
          void useAgentSchedulesStore.getState()
            .load(binding.projectId, binding.scheduleTargetId)
            .then(tick)
            .catch(() => {});
        }
      }
      previous = current;
    });

    const cleanupTimer = setTimeout(() => {
      const live = bindings().map((binding) => ({
        projectId: binding.projectId,
        scheduleTargetId: binding.scheduleTargetId,
      }));
      void invoke("agent_schedules_cleanup_orphans", { live }).catch(() => {});
    }, 2_000);

    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(cleanupTimer);
      unsubscribe();
      unlisten?.();
    };
  }, []);

  return null;
}
