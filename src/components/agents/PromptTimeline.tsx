import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { formatTime, monthName, weekdayLabel } from "../../lib/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import type { PromptChartCard } from "../../lib/agentPromptChart";
import {
  TIMELINE_CARD_WIDTH,
  TIMELINE_LANE_HEIGHT,
  TIMELINE_MIN_LANES,
  dayClusters,
  packLanes,
  queuedStack,
  sessionItems,
  timelineItems,
  timelineTicks,
  timelineX,
  type SessionSpan,
  type TimelineWindow,
} from "../../lib/agentPromptTimeline";
import type { ChartDrag } from "./usePromptChartDrag";

interface Props {
  win: TimelineWindow;
  cards: PromptChartCard[];
  now: Date;
  drag: ChartDrag | null;
  /** The scrolling body — measured by the drag hook for its hit test. */
  bodyRef: RefObject<HTMLDivElement>;
  /** The now band — the "send now" drop zone, measured the same way. */
  nowBandRef: RefObject<HTMLDivElement>;
  /** Draws one card; `session` is set when the card stands for a whole
   *  session's sent prompts. */
  renderCard: (card: PromptChartCard, occurrence?: string, session?: SessionSpan) => ReactNode;
  /** Month view: a day's cluster asks to be looked at up close. */
  onRefine: (date: string) => void;
  /** The badge text for the card being carried, decided by the chart. */
  dropLabel: string | null;
}

const BODY_PADDING = 8;
/** The band is the width of the line plus a grip either side. */
const NOW_BAND_WIDTH = 22;
/** The queue's caption above its first card. */
const QUEUE_LABEL_HEIGHT = 16;

function hhmm(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The axis and the lanes: one proportional scale across the body's width,
 * cards at their instant, packed into lanes where they overlap. Everything
 * that moves during a drag (the ghost, the indicator, the badge) is drawn from
 * the hook's state, never by moving the card itself.
 *
 * What marks *time* rather than a card — the past band, the grid lines, the
 * now line and its drop band, the drop indicator — is drawn in layers beside
 * the scrolling body, not inside it: an absolutely placed `top: 0; bottom: 0`
 * child of a scroller spans only its first screenful, so an expanded card
 * that scrolled the body took the now line away with it. The axis, with the
 * NOW label, is sticky, so scrolling the tab keeps the clock in view too.
 */
export function PromptTimeline({ win, cards, now, drag, bodyRef, nowBandRef, renderCard, onRefine, dropLabel }: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setWidth(body.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [bodyRef]);

  const items = useMemo(() => timelineItems(cards, win, now), [cards, now, win]);
  // A session's sent prompts share one card on the lanes; the month's lamps
  // stay one per prompt.
  const laneItems = useMemo(() => (win.view === "month" ? items : sessionItems(items)), [items, win.view]);
  const packed = useMemo(() => packLanes(laneItems, win, width), [laneItems, width, win]);
  const clusters = useMemo(() => (win.view === "month" ? dayClusters(items, win, width) : []), [items, width, win]);
  const queued = useMemo(() => queuedStack(cards, now), [cards, now]);
  const ticks = useMemo(() => timelineTicks(win, width), [width, win]);
  const nowInside = now >= win.start && now < win.end;
  const nowX = Math.max(0, Math.min(width, timelineX(now, win, width)));
  const lanes = Math.max(TIMELINE_MIN_LANES, win.view === "month" ? TIMELINE_MIN_LANES : packed.lanes);
  // The queue is a column at the now line, outside the lanes: the body is as
  // tall as the taller of the two, so no waiting card sits below the edge.
  // What still outgrows it (an expanded card) scrolls inside the body.
  const queueHeight = queued.length > 0 ? QUEUE_LABEL_HEIGHT + queued.length * TIMELINE_LANE_HEIGHT : 0;
  const bodyHeight = Math.max(lanes * TIMELINE_LANE_HEIGHT, queueHeight) + BODY_PADDING * 2;

  const tickLabel = (at: Date, label: "hour" | "day", major: boolean): string => {
    if (label === "hour") return formatTime(hhmm(at), use24h);
    if (win.view === "week" || major) return `${weekdayLabel(lang, at.getDay(), "short")} ${at.getDate()}`;
    return String(at.getDate());
  };

  const dropAt = drag?.kind === "card" && drag.zone.kind === "time" ? drag.zone.at : null;
  const dropNow = drag?.kind === "card" && drag.zone.kind === "now";
  const dropDate = (at: Date) => win.view === "day"
    ? formatTime(hhmm(at), use24h)
    : `${weekdayLabel(lang, at.getDay(), "short")} ${at.getDate()} ${monthName(lang, at.getMonth() + 1).slice(0, 3)} · ${formatTime(hhmm(at), use24h)}`;

  return (
    <div className={`agent-prompt-timeline is-${win.view}`} data-testid="prompt-timeline">
      <div className="agent-prompt-timeline-axis" aria-hidden="true">
        {ticks.filter((tick) => tick.major || win.view === "day").map((tick) => (
          <span key={tick.at.getTime()} className={`agent-prompt-timeline-tick${tick.major ? " is-major" : ""}`} style={{ left: tick.x }}>
            {tick.major || win.view !== "day" ? tickLabel(tick.at, tick.label, tick.major) : ""}
          </span>
        ))}
        <span className={`agent-prompt-timeline-now-label${nowInside ? "" : " is-outside"}`} style={{ left: nowX }} title={t("promptChart.nowBand")}>
          {t("promptChart.now")}
        </span>
      </div>
      <div className="agent-prompt-timeline-stage">
        <div className="agent-prompt-timeline-underlay" aria-hidden="true">
          {(nowInside || now >= win.end) && <div className="agent-prompt-timeline-past" style={{ width: nowInside ? nowX : width }} />}
          {ticks.map((tick) => (
            <span key={`line:${tick.at.getTime()}`} className={`agent-prompt-timeline-line${tick.major ? " is-major" : ""}`} style={{ left: tick.x }} />
          ))}
        </div>
        <div
          className="agent-prompt-timeline-body"
          ref={bodyRef}
          data-testid="prompt-timeline-body"
          style={{ height: bodyHeight }}
        >
          {win.view === "month"
            ? clusters.map((cluster) => (
              <button
                key={cluster.date}
                type="button"
                className={`agent-prompt-timeline-day${cluster.items.length ? "" : " is-empty"}`}
                style={{ left: cluster.x, width: cluster.width }}
                title={t("promptChart.refineDay")}
                onClick={() => onRefine(cluster.date)}
              >
                {cluster.items.slice(0, 6).map((item) => (
                  <span
                    key={item.key}
                    className={`agent-prompt-lamp is-${item.card.history?.result ?? item.card.state}`}
                    title={item.card.message}
                  />
                ))}
                {cluster.items.length > 6 && <small>{t("promptChart.more", { count: cluster.items.length - 6 })}</small>}
              </button>
            ))
            : packed.items.map((item) => (
              <div
                key={item.key}
                className="agent-prompt-timeline-item"
                style={{ left: item.x, top: BODY_PADDING + item.lane * TIMELINE_LANE_HEIGHT, width: item.width }}
              >
                {renderCard(item.card, item.occurrence, item.members && {
                  cards: item.members.map((member) => member.card),
                  offsets: item.members.map((member) => timelineX(member.at, win, width) - item.x),
                })}
              </div>
            ))}
          {queued.length > 0 && (
            <div className="agent-prompt-timeline-queue" style={{ left: Math.min(nowX + NOW_BAND_WIDTH / 2 + 4, Math.max(0, width - TIMELINE_CARD_WIDTH)), width: TIMELINE_CARD_WIDTH }} data-testid="prompt-timeline-queue">
              <small>{t("promptChart.queue", { count: queued.length })}</small>
              {queued.map((card) => renderCard(card))}
            </div>
          )}
        </div>
        <div className="agent-prompt-timeline-overlay" aria-hidden="true">
          {nowInside && <div className="agent-prompt-timeline-now" style={{ left: nowX }} />}
          <div
            className={`agent-prompt-timeline-now-band${dropNow ? " is-drop-over" : ""}${nowInside ? "" : " is-outside"}`}
            ref={nowBandRef}
            data-testid="prompt-timeline-now-band"
            style={{ left: nowX - NOW_BAND_WIDTH / 2, width: NOW_BAND_WIDTH }}
          />
          {dropAt && (
            <div className="agent-prompt-timeline-indicator" style={{ left: timelineX(dropAt, win, width) }}>
              <span className="agent-prompt-timeline-badge">{dropLabel ? `${dropLabel} · ` : ""}{dropDate(dropAt)}</span>
            </div>
          )}
        </div>
      </div>
      {drag?.kind === "card" && (
        <div
          className="agent-prompt-timeline-ghost"
          style={{ width: drag.width, transform: `translate(${drag.x - drag.grabDx}px, ${drag.y - drag.grabDy}px)` }}
          aria-hidden="true"
        >
          <span className="agent-prompt-card-message">{drag.card.message}</span>
          {drag.zone.kind !== "time" && dropLabel && (
            <span className={`agent-prompt-timeline-badge${drag.zone.kind === "none" ? " is-blocked" : ""}`}>{dropLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
