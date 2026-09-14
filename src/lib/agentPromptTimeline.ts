import { addDays, addMonths, startOfWeek, toDateStr } from "./calendarTime";
import {
  latestScheduleOccurrence,
  localOccurrenceKey,
  nextScheduleOccurrence,
} from "./agentSchedule";
import { snapPromptTime, type PromptChartCard } from "./agentPromptChart";

/**
 * The prompt chart's time axis: one proportional, horizontal scale that a Day,
 * a Week or a Month fits into edge to edge, the way a calendar's views do.
 *
 * Everything here is pure geometry and pure decision — pixels to instants,
 * instants to pixels, cards to lanes, a pointer to a drop zone, a zone to the
 * write it means — so the component that draws the chart owns only the DOM
 * and the tests need none of it. The one rule the whole file leans on: a card
 * that lands at or before the now line is a **send now**, never a schedule in
 * the past, because nothing can be scheduled for a minute that has gone.
 */
export type TimelineView = "day" | "week" | "month";

/** What a drop snaps to, per view: a finer grid is meaningless at a coarser scale. */
export const TIMELINE_SNAP_MIN: Record<TimelineView, number> = { day: 5, week: 15, month: 60 };
/** A card's fixed width on the axis, in px; it marks an instant, not a span. */
export const TIMELINE_CARD_WIDTH = 168;
/** One lane's height (card plus gap), in px: a three-line message with its
 *  agent row, tags and fact line, so a full card never overlaps the lane below. */
export const TIMELINE_LANE_HEIGHT = 120;
/** Room past a session card's last tick, so that tick is not cut by the edge. */
export const SESSION_TICK_ROOM = 6;
/** Lanes the body always shows, so an empty window has somewhere to drop. */
export const TIMELINE_MIN_LANES = 2;

export interface TimelineWindow {
  view: TimelineView;
  /** `YYYY-MM-DD`; the day, or any day of the week or month shown. */
  anchor: string;
  /** Inclusive, local midnight. */
  start: Date;
  /** Exclusive. */
  end: Date;
  snapMinutes: number;
}

function localMidnight(stamp: string): Date {
  const [y, m, d] = stamp.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function timelineWindow(view: TimelineView, anchor: string, weekStart: 0 | 1): TimelineWindow {
  const day = anchor.slice(0, 10);
  let first = day;
  let after: string;
  if (view === "day") {
    after = addDays(day, 1);
  } else if (view === "week") {
    first = startOfWeek(day, weekStart);
    after = addDays(first, 7);
  } else {
    first = `${day.slice(0, 7)}-01`;
    after = addMonths(first, 1);
  }
  return {
    view,
    anchor: day,
    start: localMidnight(first),
    end: localMidnight(after),
    snapMinutes: TIMELINE_SNAP_MIN[view],
  };
}

/** ◀ ▶: a day, a week, or a calendar month (the day of month is clamped). */
export function shiftAnchor(view: TimelineView, anchor: string, step: -1 | 1): string {
  const day = anchor.slice(0, 10);
  if (view === "day") return addDays(day, step);
  if (view === "week") return addDays(day, 7 * step);
  return addMonths(day, step);
}

export function timelineX(at: Date, win: TimelineWindow, width: number): number {
  const span = win.end.getTime() - win.start.getTime();
  return ((at.getTime() - win.start.getTime()) / span) * width;
}

export function timelineTimeAt(x: number, win: TimelineWindow, width: number): Date {
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)));
  return new Date(win.start.getTime() + ratio * (win.end.getTime() - win.start.getTime()));
}

export function snapTimelineTime(at: Date, win: TimelineWindow): Date {
  return snapPromptTime(at, win.snapMinutes);
}

export interface TimelineTick {
  x: number;
  at: Date;
  major: boolean;
  label: "hour" | "day";
}

/**
 * Axis marks: hours across a day (every sixth major), days across a week with
 * quarter-day minors, days across a month (Mondays major).
 */
export function timelineTicks(win: TimelineWindow, width: number): TimelineTick[] {
  const ticks: TimelineTick[] = [];
  if (win.view === "day") {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(win.start.getFullYear(), win.start.getMonth(), win.start.getDate(), hour);
      ticks.push({ x: timelineX(at, win, width), at, major: hour % 6 === 0, label: "hour" });
    }
    return ticks;
  }
  for (let day = new Date(win.start); day < win.end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    ticks.push({ x: timelineX(day, win, width), at: day, major: win.view === "week" || day.getDay() === 1, label: "day" });
    if (win.view === "week") {
      for (const hour of [6, 12, 18]) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
        ticks.push({ x: timelineX(at, win, width), at, major: false, label: "hour" });
      }
    }
  }
  return ticks;
}

export interface TimelineItem {
  /** Unique on the axis: the card's key, plus the occurrence for a recurring rule. */
  key: string;
  card: PromptChartCard;
  at: Date;
  /** Set on every expanded occurrence of a recurring rule but its first. */
  occurrence?: string;
  /** A session's sent prompts drawn as one card (`sessionItems`), oldest
   *  first. `at` is then the first of them and `card` the newest. */
  members?: TimelineItem[];
}

/** What a session card is handed to draw: its prompts oldest first, and each
 *  one's distance in px from the card's left edge, where its tick goes. */
export interface SessionSpan {
  cards: PromptChartCard[];
  offsets: number[];
}

const MAX_OCCURRENCES = 64;

/**
 * Every card with a place on the axis inside the window: sent cards at their
 * `sent_at`, one-time rules at their minute, recurring rules at each future
 * occurrence in the window (their past ones are the history's rows already).
 * Queued cards sit at the now line, drafts on the strip, chained cards under
 * their source — none of those has an instant of its own.
 */
export function timelineItems(cards: PromptChartCard[], win: TimelineWindow, now: Date): TimelineItem[] {
  const items: TimelineItem[] = [];
  const inside = (at: Date | null): at is Date =>
    !!at && Number.isFinite(at.getTime()) && at >= win.start && at < win.end;
  for (const card of cards) {
    if (card.state === "sent") {
      if (inside(card.at)) items.push({ key: card.key, card, at: card.at });
      continue;
    }
    if (card.state !== "scheduled" || !card.schedule) continue;
    if (!card.recurring) {
      if (inside(card.at)) items.push({ key: card.key, card, at: card.at });
      continue;
    }
    let from = new Date(Math.max(win.start.getTime(), now.getTime()));
    let first = true;
    for (let n = 0; n < MAX_OCCURRENCES; n += 1) {
      const occurrence = nextScheduleOccurrence(card.schedule, from);
      if (!occurrence || occurrence.at >= win.end) break;
      items.push({
        key: first ? card.key : `${card.key}@${occurrence.key}`,
        card,
        at: occurrence.at,
        occurrence: first ? undefined : occurrence.key,
      });
      first = false;
      from = new Date(occurrence.at.getTime() + 60_000);
    }
  }
  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Which session a sent card belongs to: its session id, or its strand (the
 *  tab) for a row written before the tab had one. Only sent cards group. */
export function sessionGroupKey(card: PromptChartCard): string | null {
  if (card.state !== "sent") return null;
  return card.history?.session_id ? `session:${card.history.session_id}` : `session:${card.strandId}`;
}

/**
 * One card per session instead of one per prompt: the sent items of a session
 * become one item that starts at its first prompt and carries the rest as
 * `members`. A session with a single prompt in the window stays a plain card,
 * and scheduled and queued cards are never folded in — they are the ones a
 * user still drags. Day and week views only; a month's lamps stay per prompt.
 */
export function sessionItems(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const key = sessionGroupKey(item.card);
    if (!key) {
      out.push(item);
      continue;
    }
    const rows = groups.get(key);
    if (rows) rows.push(item);
    else groups.set(key, [item]);
  }
  for (const [key, rows] of groups) {
    if (rows.length === 1) {
      out.push(rows[0]);
      continue;
    }
    const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
    out.push({ key, card: sorted[sorted.length - 1].card, at: sorted[0].at, members: sorted });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Queued cards in the order the scheduler will take them. */
export function queuedStack(cards: PromptChartCard[], now: Date): PromptChartCard[] {
  const due = (card: PromptChartCard) =>
    (card.schedule && latestScheduleOccurrence(card.schedule, now)?.at.getTime())
    ?? card.at?.getTime()
    ?? Number.MAX_SAFE_INTEGER;
  return cards.filter((card) => card.state === "queued").sort((a, b) => due(a) - due(b) || a.id.localeCompare(b.id));
}

/** Chained cards by the id of the card they wait for. */
export function attachedChains(cards: PromptChartCard[]): Map<string, PromptChartCard[]> {
  const map = new Map<string, PromptChartCard[]>();
  for (const card of cards) {
    if (card.state !== "chained" || !card.chainLink) continue;
    const rows = map.get(card.chainLink.from) ?? [];
    rows.push(card);
    map.set(card.chainLink.from, rows);
  }
  return map;
}

export interface LaneItem extends TimelineItem {
  x: number;
  lane: number;
  /** The card's width: the fixed one, or a session's span when that is wider. */
  width: number;
}

/**
 * Greedy interval packing, newest first: from the latest card back (a session
 * card counts from its newest prompt), each takes the lowest lane whose
 * earliest card so far starts (less a gap) after this one ends — so the
 * newest prompt is always on the top lane and older overlapping ones step
 * down beneath it. Items come back in time order. A
 * session card is as wide as its first-to-last span (and never narrower than
 * a card), so its last tick sits on its last prompt's minute.
 */
export function packLanes(
  items: TimelineItem[],
  win: TimelineWindow,
  width: number,
  cardWidth = TIMELINE_CARD_WIDTH,
  gap = 6,
): { lanes: number; items: LaneItem[] } {
  const starts: number[] = [];
  const newest = (item: TimelineItem) => (item.members?.[item.members.length - 1] ?? item).at.getTime();
  const placed = [...items]
    .sort((a, b) => newest(b) - newest(a))
    .map((item) => {
      const x = timelineX(item.at, win, width);
      const last = item.members?.[item.members.length - 1];
      const span = last ? timelineX(last.at, win, width) - x + SESSION_TICK_ROOM : 0;
      const itemWidth = Math.max(cardWidth, span);
      let lane = starts.findIndex((start) => x + itemWidth + gap <= start);
      if (lane < 0) lane = starts.length;
      starts[lane] = x;
      return { ...item, x, lane, width: itemWidth };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return { lanes: starts.length, items: placed };
}

export interface DayCluster {
  date: string;
  x: number;
  width: number;
  items: TimelineItem[];
}

/** One cluster per calendar day of the window, empty days included. */
export function dayClusters(items: TimelineItem[], win: TimelineWindow, width: number): DayCluster[] {
  const clusters: DayCluster[] = [];
  const days = Math.round((win.end.getTime() - win.start.getTime()) / 86_400_000);
  for (let index = 0; index < days; index += 1) {
    const day = new Date(win.start.getFullYear(), win.start.getMonth(), win.start.getDate() + index);
    const date = toDateStr(day);
    clusters.push({
      date,
      x: (index / days) * width,
      width: width / days,
      items: items.filter((item) => toDateStr(item.at) === date),
    });
  }
  return clusters;
}

export type TimelineZone =
  | { kind: "none" }
  | { kind: "strip" }
  | { kind: "now" }
  | { kind: "time"; at: Date };

export interface TimelineRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TimelineRects {
  strip: TimelineRect | null;
  /** The scrolling body; a point inside it maps to a time by content x. */
  body: TimelineRect | null;
  nowBand: TimelineRect | null;
}

function contains(rect: TimelineRect | null, point: { x: number; y: number }): rect is TimelineRect {
  return !!rect
    && point.x >= rect.left && point.x <= rect.left + rect.width
    && point.y >= rect.top && point.y <= rect.top + rect.height;
}

/**
 * Where a pointer is, in the chart's terms. The now band and everything at or
 * left of the now line mean "send now"; the future maps to a snapped minute.
 */
export function timelineHitZone(
  point: { x: number; y: number },
  rects: TimelineRects,
  win: TimelineWindow,
  width: number,
  scrollLeft: number,
  now: Date,
): TimelineZone {
  if (contains(rects.strip, point)) return { kind: "strip" };
  if (contains(rects.nowBand, point)) return { kind: "now" };
  if (!contains(rects.body, point)) return { kind: "none" };
  const at = snapTimelineTime(timelineTimeAt(point.x - rects.body.left + scrollLeft, win, width), win);
  return at.getTime() <= now.getTime() ? { kind: "now" } : { kind: "time", at };
}

export type PromptTimelineDrop =
  | { type: "send"; targetId: string }
  | { type: "schedule"; targetId: string; at: string }
  | { type: "retime"; targetId: string; fromTargetId?: string; at: string }
  | { type: "unschedule"; fromTargetId?: string }
  | { type: "none" };

/**
 * A drop is a write, decided here and nowhere else. `targets` are the live
 * agent tabs' schedule target ids, first one the default: a card aimed at a
 * tab that is gone falls back to it, and with no tab at all nothing moves.
 */
export function timelineDropAction(
  card: PromptChartCard,
  zone: TimelineZone,
  targets: readonly string[],
): PromptTimelineDrop {
  // A sent card is history: it stays where it went. "Collect again" is a
  // button on its face, never a drop.
  if (zone.kind === "none" || card.recurring || card.state === "sent") return { type: "none" };
  if (zone.kind === "strip") {
    if (card.schedule) return { type: "unschedule", fromTargetId: card.targetId };
    return { type: "none" };
  }
  const targetId = card.targetId && targets.includes(card.targetId) ? card.targetId : targets[0];
  if (!targetId) return { type: "none" };
  if (zone.kind === "now") {
    return card.state === "queued" ? { type: "none" } : { type: "send", targetId };
  }
  const at = localOccurrenceKey(zone.at);
  return card.schedule
    ? { type: "retime", targetId, fromTargetId: card.targetId, at }
    : { type: "schedule", targetId, at };
}

const TARGET_COLORS = [
  "var(--accent)",
  "var(--status-working)",
  "var(--status-decision)",
  "var(--success)",
  "var(--warning)",
];

/** The stripe colour of the n-th agent tab; a closed session is grey. */
export function promptTargetColor(index: number): string {
  return index < 0 ? "var(--text-muted)" : TARGET_COLORS[index % TARGET_COLORS.length];
}
