import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { deliveryRecordId, isFinishedOneTime } from "../../lib/agentPromptSend";
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
import { recordScheduledDelivery } from "../../stores/agentPrompts";
import { useAgentSchedulesStore } from "../../stores/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const TICK_MS = 15_000;
const OUTPUT_SETTLE_MS = 1_200;
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
  if (schedule.rule.type !== "once") return;
  await useAgentSchedulesStore
    .getState()
    .remove(binding.projectId, binding.scheduleTargetId, schedule.id)
    .catch(() => {});
}

/**
 * Main-window-only owner of per-tab scheduled delivery. TerminalView remains the
 * PTY owner and exposes only a readiness/submission capability through the
 * registry; the scheduler never duplicates terminal lifecycle or output wiring.
 */
export function AgentScheduleHost() {
  const running = useRef(false);
  const waitingForIdle = useRef(new Map<string, { ptyId: string; submittedAt: number }>());

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
            if (!producedOutput || !settled || !idle) continue;
            waitingForIdle.current.delete(key);
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
            if (latestActivity.busyByTab[input.ptyId]
                || latestActivity.attentionByTab[input.ptyId] === "decision"
                || Date.now() - (lastPtyOutputAt(input.ptyId) ?? Date.now()) < OUTPUT_SETTLE_MS) break;

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
              waitingForIdle.current.set(key, { ptyId, submittedAt });
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
