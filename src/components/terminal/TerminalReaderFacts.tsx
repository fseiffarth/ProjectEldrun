import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { readAgentUsage } from "../../lib/agents/agentUsage";
import { OPENCODE_MODEL_KEYS, isOpenCodeTab } from "../../../mobile-web/src/terminal/openCodeMini";
import { modelPickKeys, readModelPicker, type ReaderLive } from "../../lib/agents/readerLive";
import { submitScheduledAgentCommand } from "../../lib/agents/scheduledAgentInput";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { UntestedTag } from "../common/UntestedTag";
import type { TabEntry } from "../../stores/tabs";
import type { SessionUsage } from "../../../mobile-web/src/api";
import { resetCountdown, resetText } from "../../../mobile-web/src/terminal/limitResets";
import { sameSelectStep, type SelectPrompt, type SelectStep } from "../../../mobile-web/src/terminal/selectPrompt";
import { sessionLimits } from "../../../mobile-web/src/terminal/sessionUsage";
import { limitMeters, parseUsageReport, type LimitMeters } from "../../../shared/usageReport";

/** The phone's pacing: how often the CLI's usage panel is read again (the
 * backend floors it besides), and how often the reset countdowns tick. */
const LIMITS_POLL_MS = 120_000;
const CLOCK_MS = 30_000;
/** How often the picker is read while it is open, how long a picker that is
 * never drawn (or an answer that never lands) is waited for, and how long an
 * answered step is given to draw the next one (Codex's reasoning level). */
const PICKER_POLL_MS = 150;
const PICKER_WAIT_MS = 6_000;
const NEXT_STEP_WAIT_MS = 700;

/**
 * The Reader's facts row — the phone's (`mobile-web` `Terminal.tsx`
 * `.session-facts`) on the desktop: the model the session prints (a button
 * that opens its own `/model` picker as a list here), the branch, the
 * context left and the account's 5-hour and weekly limits. The status facts
 * come off the pane's live screen (`ReaderLive.status`); the limits from the
 * CLI's usage panel (`agent_usage`, which spends no quota), or — Codex, which
 * has none — from the figures its rollout stores.
 */
export function TerminalReaderFacts({ tab, ptyId, agentLabel, live, modelTag, usage, visible, typeKeys, onPicking }: {
  tab: TabEntry;
  ptyId: string;
  agentLabel: string;
  live: ReaderLive;
  /** The tab's model tag when the screen shows no status line. */
  modelTag: string | undefined;
  /** The stored session's own figures (Codex), for what the screen and the
   * usage panel leave out. */
  usage: SessionUsage | undefined;
  visible: boolean;
  typeKeys: (keys: string[]) => Promise<void>;
  /** Whether the model list is up: the Reader then leaves the picker out of
   * its own answer buttons. */
  onPicking: (picking: boolean) => void;
}) {
  const t = useT();
  const status = live.status;
  const [limits, setLimits] = useState<LimitMeters>({});
  const [readAt, setReadAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!visible || tab.kind !== "agent") return;
    let stopped = false;
    const poll = () => {
      void readAgentUsage(tab.cmd).then((report) => {
        if (stopped) return;
        if (!report.supported) {
          stopped = true;
          return;
        }
        if (!report.raw) return;
        const next = limitMeters(parseUsageReport(report.raw));
        if (!next.session && !next.week) return;
        setLimits(next);
        setReadAt(Date.now());
      });
    };
    poll();
    const timer = setInterval(() => { if (!stopped) poll(); }, LIMITS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [visible, tab.kind, tab.cmd]);

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(clock);
  }, [visible]);

  // --- The model picker ------------------------------------------------------
  const [picking, setPicking] = useState(false);
  const [picker, setPicker] = useState<SelectPrompt | null>(null);
  const [answered, setAnswered] = useState<SelectStep | null>(null);
  const sawPicker = useRef(false);
  useEffect(() => { onPicking(picking); }, [picking, onPicking]);

  useEffect(() => {
    if (!picking) return;
    const read = () => {
      const term = terminalFor(ptyId);
      const next = term ? readModelPicker(term.buffer.active, agentLabel) : null;
      setPicker((previous) => (previous && next && sameSelectStep(previous, next) && previous.current === next.current ? previous : next));
    };
    read();
    const timer = setInterval(read, PICKER_POLL_MS);
    return () => clearInterval(timer);
  }, [picking, ptyId, agentLabel]);

  const finish = useCallback(() => {
    setPicking(false);
    setPicker(null);
    setAnswered(null);
  }, []);

  // The step on screen, unless it is the one just answered and the session
  // has not redrawn yet.
  const step = picker && answered && sameSelectStep(answered, picker) ? null : picker;
  useEffect(() => {
    if (!picking) return;
    if (step) {
      sawPicker.current = true;
      if (answered) setAnswered(null);
      return;
    }
    // The answered list is still up: the keys have not landed. Give it back
    // if they never do.
    if (answered && picker) {
      const stuck = setTimeout(() => setAnswered(null), PICKER_WAIT_MS);
      return () => clearTimeout(stuck);
    }
    if (sawPicker.current) {
      // Gone: answered (a next step may still come), picked in the terminal,
      // or dismissed there.
      if (!answered) {
        finish();
        return;
      }
      const next = setTimeout(finish, NEXT_STEP_WAIT_MS);
      return () => clearTimeout(next);
    }
    // Never drawn: the session may have no picker, or was busy.
    const never = setTimeout(finish, PICKER_WAIT_MS);
    return () => clearTimeout(never);
  }, [picking, step, picker, answered, finish]);

  const openPicker = () => {
    if (picking) return;
    sawPicker.current = false;
    setAnswered(null);
    setPicker(null);
    const sent = isOpenCodeTab(agentLabel)
      ? typeKeys(OPENCODE_MODEL_KEYS)
      : tab.scheduleTargetId
        ? submitScheduledAgentCommand(tab.scheduleTargetId, "/model")
        : Promise.reject(new Error("no agent input"));
    setPicking(true);
    void sent.catch(finish);
  };
  const choose = (index: number) => {
    if (!step) return;
    const option = step.options.find((entry) => entry.index === index);
    if (!option) return;
    setAnswered({ title: step.title, options: step.options });
    void typeKeys(modelPickKeys(step, option, agentLabel)).catch(() => setAnswered(null));
  };
  const close = () => {
    // The picker is the session's own: close it there too.
    if (picker) void typeKeys(["\u001b"]).catch(() => {});
    finish();
  };

  const contextLeft = status?.context ?? (usage?.contextLeft != null ? `${usage.contextLeft}%` : undefined);
  const clock = new Date(now);
  const fromPanel = !!(limits.session || limits.week);
  const shown = fromPanel ? limits : sessionLimits(usage, clock);
  const readTime = fromPanel ? new Date(readAt) : clock;
  const limitFact = (meter: LimitMeters["session"], key: "mobile.facts.session" | "mobile.facts.week") => {
    if (!meter) return null;
    const left = meter.resets ? resetCountdown(meter.resets, clock, readTime) : "";
    return (
      <span
        className={meter.percent >= 90 ? "terminal-reader-fact high" : "terminal-reader-fact"}
        title={meter.resets ? resetText(meter.resets, clock, readTime) : undefined}
      >
        {t(key, { percent: Math.round(100 - meter.percent) })}
        {left && <> · {t("mobile.facts.resetIn", { time: left })}</>}
      </span>
    );
  };
  const modelLabel = status?.model ? (status.effort ? `${status.model} · ${status.effort}` : status.model) : modelTag;
  const shownStep = step ?? (answered && picker ? answered : null);
  const busy = !!answered || !step;

  return (
    <div className="terminal-reader-facts-wrap">
      {picking && (
        <div
          className="terminal-reader-picker"
          role="dialog"
          aria-label={shownStep?.title ?? t("terminal.reader.modelTitle")}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}
        >
          <div className="terminal-reader-picker-head">
            <strong>{shownStep?.title ?? t("terminal.reader.modelTitle")}</strong>
            <button type="button" className="terminal-reader-picker-close" onClick={close} aria-label={t("terminal.reader.modelClose")} title={t("terminal.reader.modelClose")}>✕</button>
          </div>
          {shownStep ? (
            <div className="terminal-reader-options">
              {shownStep.options.map((option) => (
                <button
                  key={`${option.index}:${option.label}`}
                  type="button"
                  className={picker && option.index === picker.current ? "terminal-reader-option current" : "terminal-reader-option"}
                  disabled={busy}
                  onClick={() => choose(option.index)}
                >
                  <span className="terminal-reader-option-number">{option.number}</span>
                  <span className="terminal-reader-option-label">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <small className="terminal-reader-question-more">{t("terminal.reader.modelWaiting")}</small>
          )}
          {step?.hidden ? <small className="terminal-reader-question-more">{t("terminal.reader.moreChoices")}</small> : null}
        </div>
      )}
      <div className="terminal-reader-facts">
        <button
          type="button"
          className="terminal-reader-fact-model"
          onClick={picking ? close : openPicker}
          disabled={!picking && (!!live.working || !!live.question)}
          aria-haspopup="dialog"
          aria-expanded={picking}
          title={t("terminal.reader.modelHint")}
        >
          {modelLabel ?? t("terminal.reader.model")}
        </button>
        <UntestedTag id="terminal.reader.facts" />
        {status?.branch && <span className="terminal-reader-fact">⎇ {status.branch}</span>}
        {contextLeft && <span className="terminal-reader-fact">{t("terminal.reader.contextLeft", { percent: contextLeft })}</span>}
        {limitFact(shown.session, "mobile.facts.session")}
        {limitFact(shown.week, "mobile.facts.week")}
      </div>
    </div>
  );
}
