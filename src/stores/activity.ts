import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { looksLikeDecisionPromptStripped, stripAnsi } from "../lib/agentPrompt";
import { METRIC, agentPromptLeaf } from "../lib/usageMetrics";
import { splitPtyId } from "../lib/ptyId";
import { allGroups, isPtyTabKind, useTabsStore } from "./tabs";
import type { TabEntry } from "./tabs";
import { bumpUsage } from "./usage";
import { isDetachedWindow } from "./detachedContext";

/** Mirrors `DETACHED_ACTIVITY` in stores/detached (spelled here so this module
 *  stays free of that import: detached.ts imports this one). */
const DETACHED_ACTIVITY_EVENT = "detached-activity";

/// A scope (project) stays "running" until its PTYs have been quiet for this
/// window. Short enough to clear quickly when a task ends, long enough to bridge
/// the gaps in bursty agent/terminal output.
const BUSY_WINDOW_MS = 800;

/// But it only BECOMES "running" once output has been sustained for this long —
/// an onset debounce so a brief blip (a quick command, a keystroke echo) doesn't
/// flash the working indicator. A burst must last past this before it counts.
const WORK_ONSET_MS = 1500;

/// How long an unwatched agent tab must have been quiet before we call what it's
/// doing. The two are deliberately asymmetric: a decision prompt in its output is
/// POSITIVE evidence that the agent is blocked, so it may glow almost at once;
/// "done" is inferred from the ABSENCE of output, so it waits out a longer
/// silence rather than calling every pause between writes a finished turn.
const DECISION_QUIET_MS = 600;
const DONE_QUIET_MS = 2500;

/// How much of an agent's output tail is kept to classify it by — enough to hold
/// the last screenful of a TUI redraw, small enough to be free.
const TAIL_CAP = 8000;

// Per-PTY activity, all keyed by the composed PTY id (`<scope>:<tabKey>`, the id
// the backend emits under): when output last arrived; when the current burst of
// output began (reset whenever output resumes after a quiet gap); the ANSI-
// stripped tail of that burst; when the user last had eyes on the tab; when the
// agent in it last rang the terminal bell; and when the user last sent input to
// it. Kept outside the store: they churn on every output batch (~60/s) and
// nothing renders off them directly — only the derived maps, recomputed on an
// interval, drive the UI.
/// When `recompute` last ran, so the usage recap can bill agent working time by
/// the real gap between ticks rather than by an assumed interval.
let lastTickAt: number | null = null;

/// The largest gap between two `recompute` ticks that may be billed as agent
/// working time. A longer gap means the interval was not running — the laptop
/// slept, the tab was throttled — and whatever the agents were doing across it is
/// not something we observed. Billing it would silently invent hours.
const MAX_WORK_TICK_MS = 5_000;

const lastOutputByPty: Record<string, number> = {};
const onsetByPty: Record<string, number> = {};
const tailByPty: Record<string, string> = {};
const seenAtByPty: Record<string, number> = {};
const bellByPty: Record<string, number> = {};
const inputByPty: Record<string, number> = {};
/// When the tab was last DELIBERATELY opened — switched to in a tab bar, or put
/// on a phone's screen (`clearAttention`). Deliberately not the same as
/// `seenAtByPty`, which `attentionFor` re-stamps on every tick for as long as a
/// tab is the visible one: an agent tab left on screen on an unattended desktop
/// is "being looked at" forever, and that is what kept a finished turn from ever
/// being reported to the phone. This one only moves when somebody arrives.
const readAtByPty: Record<string, number> = {};
/// Whether the tab has been busy since its last turn-end mark (see
/// `lastDoneByTab`): a turn "finishes" only after it was seen working, so a
/// stray blip followed by silence never books a finished turn.
const busySinceMarkByPty: Record<string, boolean> = {};

/// Memo for the decision-prompt test, keyed by PTY id and validated against the
/// tail it was computed from. `attentionFor` asks the question of every agent tab
/// on every 300ms tick, but the answer can only change when the tail does — and a
/// tab quiet enough to hold a decision prompt is precisely one whose tail is NOT
/// changing. Without this, a settled prompt re-ran four regexes over 8 KB, three
/// of them case-insensitive, ~3.3 times a second forever. The guard is a string
/// compare that hits JS's reference-equality fast path, since `tailByPty` holds
/// the same string instance while the tab is quiet.
const decisionMemo = new Map<string, { tail: string; hit: boolean }>();

function tailLooksLikeDecision(ptyId: string): boolean {
  // Already ANSI-stripped on the way in (see `notePtyOutput`), so this must NOT
  // be routed through `stripAnsi` again.
  const tail = tailByPty[ptyId] ?? "";
  const memo = decisionMemo.get(ptyId);
  if (memo !== undefined && memo.tail === tail) return memo.hit;
  const hit = looksLikeDecisionPromptStripped(tail);
  decisionMemo.set(ptyId, { tail, hit });
  return hit;
}

const PTY_MAPS: Record<string, unknown>[] = [
  lastOutputByPty,
  onsetByPty,
  tailByPty,
  seenAtByPty,
  bellByPty,
  inputByPty,
  readAtByPty,
  busySinceMarkByPty,
];

/** Record that a PTY produced output just now, keeping the tail of the current
 *  burst so `recompute` can tell a finished turn from a decision prompt. Cheap;
 *  safe to call often. */
export function notePtyOutput(ptyId: string, data = "") {
  const now = Date.now();
  const text = data ? stripAnsi(data) : "";
  // A frame that paints no text — a terminal-title update, a cursor move, a
  // blanked cell — says nothing about what the agent is doing, and a BLOCKED
  // Codex tab emits nothing else: its title alternates between
  // "[ ! ] Action Required" and "[ . ] Action Required" on a ~100ms timer for as
  // long as an approval sits unanswered (the same timer spins a braille frame
  // into the title while it works). Counting those as activity is what kept such
  // a tab stuck on "working": the quiet never reached DECISION_QUIET_MS, so its
  // tail was never classified and the decision lamp never lit. Claude Code's
  // prompts do not hit this — it goes properly silent — which is why the bug
  // looked Codex-only.
  if (data && !text.trim()) return;
  const prev = lastOutputByPty[ptyId];
  // Start of a fresh burst after quiet (or the very first output): reset the
  // onset. Output within the busy window keeps the existing onset, so a
  // continuous stream ages past WORK_ONSET_MS and flips to "working".
  if (prev === undefined || now - prev >= BUSY_WINDOW_MS) {
    onsetByPty[ptyId] = now;
    // A new burst redraws the screen, so the last one's tail is stale. Dropping
    // it is what stops an ALREADY-ANSWERED prompt from being matched again as a
    // live one: an agent sits quiet while a prompt awaits the human, so whatever
    // it does once answered necessarily arrives as a new burst.
    tailByPty[ptyId] = "";
  }
  lastOutputByPty[ptyId] = now;
  if (text) {
    const tail = (tailByPty[ptyId] ?? "") + text;
    tailByPty[ptyId] = tail.length > TAIL_CAP ? tail.slice(-TAIL_CAP) : tail;
  }
}

/** When a PTY last produced output (ms epoch), or undefined if none was seen
 *  this session. Read-only view for the tab hover card's "quiet for…" line —
 *  the raw map stays module-private because it churns per output batch. */
export function lastPtyOutputAt(ptyId: string): number | undefined {
  return lastOutputByPty[ptyId];
}

/** When the tab was last deliberately opened by a person (ms epoch), on either
 *  surface, or undefined if nobody has this session. Read-only view of
 *  `readAtByPty` for the surfaces that must decide "has anyone seen this turn?"
 *  for themselves — the phone's, which cannot infer it from the desktop's
 *  `done` flag (that one is suppressed while the tab is the visible one here). */
export function lastTabReadAt(ptyId: string): number | undefined {
  return readAtByPty[ptyId];
}

/** Record that input was sent to a PTY on the user's behalf — a keystroke, a
 *  paste, a user-triggered flow typing its command (`initialInput`), or a
 *  keystroke a phone sent over the Mobile bridge (`MobileBridgeHost`, which is
 *  told about it because the phone types into a tmux client of its own that this
 *  window never sees). This is
 *  what makes output COUNT: "working" and "done" only ever arise from output
 *  produced after input this session, so a restored tab bursting its resume
 *  banner or replaying a prior transcript — real bytes, but nothing anybody
 *  asked for — never lights up a tab or its project pill. `decision` is exempt:
 *  a resumed agent genuinely sitting at an unanswered prompt is real signal
 *  worth surfacing immediately, commanded or not.
 *
 *  Sending input also drops the tail: answering a prompt is input, and a menu
 *  that has been answered must not be matched again as a live one. This is the
 *  ONLY thing that retires a decision prompt the user is looking at (looking is
 *  no longer enough — see `attentionFor`), and it covers the case the per-burst
 *  reset in `notePtyOutput` misses: an answer so fast that the agent's next
 *  output lands inside the same burst, leaving the answered menu in the tail. */
export function noteUserInput(ptyId: string) {
  // Group B #234: a popout's terminal reports to the classifier that lives in
  // the main window — the popout's own maps are never read by anything.
  if (isDetachedWindow()) {
    void emit(DETACHED_ACTIVITY_EVENT, { ptyId, kind: "input" });
    return;
  }
  inputByPty[ptyId] = Date.now();
  tailByPty[ptyId] = "";
}

/**
 * Group B #234, the popout side: adopt the statuses the main window mirrored
 * over (`detachedStatusEvent`) into THIS window's activity store, keyed the way
 * `TabBar` reads them, so the popout's strip paints the same lamps. Replaces the
 * whole verdict for `scope`'s keys in `status`; keys of other scopes are kept.
 */
export function applyDetachedStatus(
  scope: string,
  status: Record<string, "working" | "needs-decision" | "finished">,
): void {
  const prefix = `${scope}:`;
  const busyByTab: Record<string, boolean> = {};
  const attentionByTab: Record<string, AttentionKind> = {};
  const cur = useActivityStore.getState();
  for (const [id, v] of Object.entries(cur.busyByTab)) if (!id.startsWith(prefix)) busyByTab[id] = v;
  for (const [id, v] of Object.entries(cur.attentionByTab)) {
    if (!id.startsWith(prefix)) attentionByTab[id] = v;
  }
  for (const [key, state] of Object.entries(status)) {
    const ptyId = `${prefix}${key}`;
    if (state === "working") busyByTab[ptyId] = true;
    else if (state === "needs-decision") attentionByTab[ptyId] = "decision";
    else if (state === "finished") attentionByTab[ptyId] = "done";
  }
  useActivityStore.setState({
    busyByTab,
    attentionByTab,
    attentionByScope: rollupAttentionScopes(attentionByTab),
  });
}

/** Forget everything recorded about a PTY, called when it is (re)spawned. A
 *  respawn — app launch, a project closed and reopened, a pane remounting — is
 *  a new program: input sent to its predecessor mustn't license the successor's
 *  restore/resume replay as a finished turn. */
export function notePtySpawn(ptyId: string) {
  for (const map of PTY_MAPS) delete map[ptyId];
  decisionMemo.delete(ptyId);
}

// The parser lives in `lib/ptyId` — one cut for every consumer, and one that
// knows a box scope carries a colon of its own. Re-exported so the call sites
// that have always imported it from here keep working.
export { splitPtyId };

/** True when the tab is the one the user is currently looking at: it's the
 *  active (visible) tab of its group in the CURRENT scope. Background tabs and
 *  background projects are never "looked at". */
function isTabLookedAt(scope: string, key: string): boolean {
  const st = useTabsStore.getState();
  // A tab in a popout is looked at when it is the active tab of its pane there
  // (#234): the popout is its own window, on screen whichever scope the main
  // window shows. Its window focus is not visible from here; the active tab of
  // an unfocused popout is still the one on its screen, which is what "looked
  // at" means for retiring a `done` flag.
  for (const d of st.detachedGroupsByScope[scope] ?? []) {
    for (const g of allGroups(d.subtree)) {
      if (g.tabKeys.includes(key)) return g.activeKey === key;
    }
  }
  if (st.scope !== scope) return false;
  for (const g of allGroups(st.layoutByScope[scope] ?? null)) {
    if (g.tabKeys.includes(key)) return g.activeKey === key;
  }
  return false;
}

// (A `isTabDetached` suppression used to sit here: a popped-out agent raised no
// attention at all, because this window could not tell whether anyone was
// looking at it and a flag it raised would have been unclearable. Group B #234
// answers both — `isTabLookedAt` reads the popout's own active tab, and the
// popout's strip clears the flag over DETACHED_ACTIVITY — so the suppression is
// gone and a popped-out agent lights the project pill like a docked one.)

/** Test-only: forget all recorded PTY activity so cases start isolated. */
export function _clearPtyActivityForTest() {
  for (const map of PTY_MAPS) {
    for (const k of Object.keys(map)) delete map[k];
  }
  decisionMemo.clear();
  useActivityStore.setState({
    busyByScope: {},
    busyByTab: {},
    attentionByTab: {},
    attentionByScope: {},
    statusCountsByScope: {},
    statusTabsByScope: {},
    lastWorkingByTab: {},
    lastDoneByTab: {},
  });
}

/** The kind of attention a tab/scope is raising: an agent waiting on a user
 *  decision (a prompt is on screen) vs one that simply finished its turn. */
export type AttentionKind = "decision" | "done";

/** What an agent tab is asking for, or null if it isn't asking for anything.
 *  Derived on each `recompute` tick from the tab's own output rather than pushed
 *  in by the terminal: the bell we used to rely on is optional in every agent we
 *  support (and never even reaches xterm for a tab whose pane has not been opened
 *  yet), which left a finished agent showing no state at all.
 *
 *  The two kinds treat "the user is looking at this tab" differently, because
 *  they mean different things:
 *  - `done` is about UNREAD output, so looking at the tab IS the thing that
 *    retires it. A looked-at tab also stamps `seenAtByPty`, so only what the
 *    agent does AFTER the user looks away can raise the flag again.
 *  - `decision` is about a BLOCKED agent, and looking at a prompt does not answer
 *    it. It therefore holds while watched (nothing else in the UI says "this one
 *    is stuck on you" once the tab is on screen but the eyes are elsewhere), and
 *    is retired only by input — `noteUserInput` drops the tail the match is made
 *    against. */
function attentionFor(
  scope: string,
  tab: TabEntry,
  ptyId: string,
  now: number,
): AttentionKind | null {
  // Only AI agent tabs raise attention; a shell finishing a build doesn't.
  if (tab.kind !== "agent" && tab.kind !== "local_agent") return null;
  // A popped-out agent is classified like any other (#234): its input reaches
  // this window over DETACHED_ACTIVITY, `isTabLookedAt` reads its popout's
  // active tab, and the verdict is mirrored back so the popout's strip shows it.
  const lookedAt = isTabLookedAt(scope, tab.key);
  // What's on screen has been read, so it can't be what raises a "done" later.
  if (lookedAt) seenAtByPty[ptyId] = now;
  const seen = seenAtByPty[ptyId] ?? 0;
  const out = lastOutputByPty[ptyId] ?? 0;
  const bell = bellByPty[ptyId] ?? 0;
  const quiet = now - Math.max(out, bell);
  if (quiet >= DECISION_QUIET_MS && tailLooksLikeDecision(ptyId)) {
    return "decision";
  }
  // Past here everything is inferred from silence, which a watched tab's own
  // screen already tells the user better than a lamp could.
  if (lookedAt) return null;
  // Nothing has happened here since the user last had eyes on the tab.
  if (out <= seen && bell <= seen) return null;
  // "Done" means the agent finished work somebody asked for, so it requires
  // input to have been sent this session (see `noteUserInput`): without it, the
  // quiet that follows a restore banner or a resumed session's replayed
  // transcript — and any stray bell replayed with it — would read as a finished
  // turn on every launch. A bell after real input is the agent explicitly
  // asking to be looked at, so it doesn't have to wait out the full silence.
  if (!inputByPty[ptyId]) return null;
  if (bell > seen || quiet >= DONE_QUIET_MS) return "done";
  // Still streaming: the "working" glow already speaks for it.
  return null;
}

/** Roll the per-tab attention flags up to a per-scope kind (decision outranks
 *  done), so the project pill can reflect a backgrounded project's state. */
function rollupAttentionScopes(
  attentionByTab: Record<string, AttentionKind>,
): Record<string, AttentionKind> {
  const byScope: Record<string, AttentionKind> = {};
  for (const [ptyId, kind] of Object.entries(attentionByTab)) {
    const parts = splitPtyId(ptyId);
    if (!parts) continue;
    if (kind === "decision" || byScope[parts.scope] === undefined) {
      byScope[parts.scope] = kind;
    }
  }
  return byScope;
}

/** True when two attention maps hold the same flags. */
function sameAttention(
  a: Record<string, AttentionKind>,
  b: Record<string, AttentionKind>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** A project's tally of tab statuses — one entry per tab, drawn as one little
 *  bar each along the bottom of the project pill. */
export interface TabStatusCounts {
  working: number;
  decision: number;
  done: number;
}

function sameCounts(a: TabStatusCounts, b: TabStatusCounts): boolean {
  return a.working === b.working && a.decision === b.decision && a.done === b.done;
}

/** One non-idle tab of a scope: WHICH tab a status bar stands for, so the bar
 *  can be clicked to jump to it. The `state` is the bar's own CSS class, i.e.
 *  the same three words the tab glow uses. */
export interface StatusTab {
  /** The tab's key within its scope (not the composed PTY id). */
  key: string;
  state: "working" | "needs-decision" | "finished";
}

function sameTabs(a: StatusTab[], b: StatusTab[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.key === b[i].key && t.state === b[i].state);
}

/** True when two per-tab status maps hold the same tabs in the same states.
 *  Relies on `computeStatusScopes` preserving object identity for unchanged
 *  scopes, exactly as `sameCountMaps` does. */
function sameTabMaps(
  a: Record<string, StatusTab[]>,
  b: Record<string, StatusTab[]>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** True when two count maps are equivalent. Relies on `countStatusScopes`
 *  preserving object identity for unchanged scopes, so a per-scope `===` is a
 *  full comparison. */
function sameCountMaps(
  a: Record<string, TabStatusCounts>,
  b: Record<string, TabStatusCounts>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** Tally each scope's tabs by status. A tab counts exactly once: working wins
 *  over a pending attention flag, mirroring how the tab bar resolves its own
 *  glow, so the pill's bars can never disagree with the tabs they stand for.
 *  Every tab counts, including the one under the user's eyes: the pill's strip is
 *  a tally of what the PROJECT is doing, not of what still needs a glance, and a
 *  project whose bars emptied out the moment it was selected could not answer the
 *  one question the strip exists for — "is anything still running in there?" —
 *  for the project you are actually in. (The tab bar still hides the viewed tab's
 *  own glow: there, the tab IS the thing you're looking at.) A looked-at tab that
 *  went quiet can still hold no `done` flag, so what a selected project shows is
 *  its working tabs and its unanswered prompts — see `attentionFor`.
 *  Scopes whose counts are unchanged keep their previous object identity, so a
 *  tab going busy in one project doesn't re-render every other project's pill. */
function computeStatusScopes(
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
  prevCounts: Record<string, TabStatusCounts>,
  prevTabs: Record<string, StatusTab[]>,
): { counts: Record<string, TabStatusCounts>; tabs: Record<string, StatusTab[]> } {
  const { tabsByScope } = useTabsStore.getState();
  const counts: Record<string, TabStatusCounts> = {};
  const byScope: Record<string, StatusTab[]> = {};
  for (const [scope, tabs] of Object.entries(tabsByScope)) {
    const tally: TabStatusCounts = { working: 0, decision: 0, done: 0 };
    // Most urgent state first, so the strip's bars and this list are one order —
    // a bar's position IS its tab, which is what makes a click on it addressable.
    const working: StatusTab[] = [];
    const decision: StatusTab[] = [];
    const done: StatusTab[] = [];
    for (const t of tabs) {
      const ptyId = `${scope}:${t.key}`;
      if (isPtyTabKind(t.kind) && busyByTab[ptyId]) {
        tally.working++;
        working.push({ key: t.key, state: "working" });
      } else if (attentionByTab[ptyId] === "decision") {
        tally.decision++;
        decision.push({ key: t.key, state: "needs-decision" });
      } else if (attentionByTab[ptyId] === "done") {
        tally.done++;
        done.push({ key: t.key, state: "finished" });
      }
    }
    if (!tally.working && !tally.decision && !tally.done) continue;
    const beforeCounts = prevCounts[scope];
    counts[scope] = beforeCounts && sameCounts(beforeCounts, tally) ? beforeCounts : tally;
    const list = [...working, ...decision, ...done];
    const beforeTabs = prevTabs[scope];
    byScope[scope] = beforeTabs && sameTabs(beforeTabs, list) ? beforeTabs : list;
  }
  return { counts, tabs: byScope };
}

/** True when two string sets hold exactly the same members. */
function sameStringSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function withoutScript(set: Set<string>, scriptPath: string): Set<string> {
  if (!set.has(scriptPath)) return set;
  const next = new Set(set);
  next.delete(scriptPath);
  return next;
}

interface ActivityStore {
  /** project scope ("root" or project id) → has a running task right now. */
  busyByScope: Record<string, boolean>;
  /** Composed PTY id (`<scope>:<tabKey>`) → that individual tab is actively
   *  producing output right now. Drives the per-tab "working" animation in the
   *  tab bar. */
  busyByTab: Record<string, boolean>;
  /** Composed PTY id → an agent tab nobody is looking at wants something:
   *  `decision` (a prompt is on its screen) or `done` (it finished its turn).
   *  Derived from the tab's own output by `recompute`; drives the per-tab "needs
   *  attention" glow and clears once the tab is viewed. */
  attentionByTab: Record<string, AttentionKind>;
  /** Per-scope rollup of `attentionByTab` (decision outranks done) so the project
   *  pill can glow for a backgrounded project. */
  attentionByScope: Record<string, AttentionKind>;
  /** Scope → how many of its tabs are working / awaiting a decision / finished.
   *  Drives the per-tab status bars along the bottom of the project pill. Scopes
   *  with nothing to report are absent. */
  statusCountsByScope: Record<string, TabStatusCounts>;
  /** Scope → the same tabs the counts tally, named and in the strip's own order,
   *  so each bar knows which tab it stands for and a click can jump there.
   *  Kept beside the counts rather than derived from them at render: the strip is
   *  drawn from one walk of the tabs, and a second walk in the component could
   *  order the bars differently from the tally they came from. */
  statusTabsByScope: Record<string, StatusTab[]>;
  /** Composed PTY id → when (ms epoch) the tab last produced output while
   *  counted as working. Published on the busy→idle edge only — while a tab IS
   *  busy, `busyByTab` already says "now" — so the Agents views can sort by
   *  "last working" without re-rendering on every output batch. Session-only. */
  lastWorkingByTab: Record<string, number>;
  /** Composed PTY id → when (ms epoch) an agent tab last finished a turn: the
   *  time of its last output before it went quiet for `DONE_QUIET_MS`, marked
   *  whether or not anybody was looking (unlike the `done` attention flag, which
   *  is about UNREAD output and never rises on a watched tab). A decision prompt
   *  counts too — the agent stopped. Session-only. */
  lastDoneByTab: Record<string, number>;
  /** Record a terminal bell from a PTY (`ptyId` is the composed `<scope>:<key>`).
   *  Only a hint that the agent wants attention now — WHAT it wants is worked out
   *  from its output on the next `recompute`, which doesn't race the paint the way
   *  reading the screen inside the bell handler did. */
  noteBell: (ptyId: string) => void;
  /** Clear a tab's attention flag and mark its output read (called the moment the
   *  tab becomes the visible one, ahead of the next `recompute`). */
  clearAttention: (ptyId: string) => void;
  /** Recompute `busyByScope`/`busyByTab`/`attentionByTab` from recent PTY output.
   *  Call on an interval. */
  recompute: () => void;
  /** Absolute paths of `.sh` scripts currently running detached. The run_id
   *  used with the backend is the script's absolute path (see runScript). */
  runningScripts: Set<string>;
  /** Absolute paths of files whose run-launched terminal tab (Python Run/Debug
   *  or a foreground shell run, tagged via `TabEntry.runFile`) is producing
   *  sustained output right now. Derived by `recompute` from `busyByTab`, so it
   *  drops out the moment the tab closes or goes quiet. Drives the green pulse on
   *  the file tree's ▶ run button for the tab-backed run paths (the detached `.sh`
   *  path uses `runningScripts` instead). */
  runningRunFiles: Set<string>;
  /** Spawn a `.sh` script detached and track it so the run button can show a
   *  spinner until the backend emits `script-finished`. */
  runScript: (scriptPath: string, cwd: string, projectId?: string | null) => void;
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  busyByScope: {},
  busyByTab: {},
  attentionByTab: {},
  attentionByScope: {},
  statusCountsByScope: {},
  statusTabsByScope: {},
  lastWorkingByTab: {},
  lastDoneByTab: {},
  runningScripts: new Set(),
  runningRunFiles: new Set(),

  noteBell: (ptyId) => {
    if (!splitPtyId(ptyId)) return;
    if (isDetachedWindow()) {
      void emit(DETACHED_ACTIVITY_EVENT, { ptyId, kind: "bell" });
      return;
    }
    bellByPty[ptyId] = Date.now();
    get().recompute();
  },

  clearAttention: (ptyId) => {
    // A popout's strip clears a lamp the same way: by telling the main window
    // the tab was looked at. Its own mirrored copy is refreshed by the next
    // status broadcast, which follows the main store's update.
    if (isDetachedWindow()) {
      void emit(DETACHED_ACTIVITY_EVENT, { ptyId, kind: "seen" });
      return;
    }
    seenAtByPty[ptyId] = Date.now();
    readAtByPty[ptyId] = seenAtByPty[ptyId];
    const kind = get().attentionByTab[ptyId];
    if (!kind) return;
    // Looking at a tab marks its output read — but it does not ANSWER a prompt,
    // and the next `recompute` would only raise the flag straight back (see
    // `attentionFor`). Keep it, so the lamp holds steady instead of blinking off
    // and on at the switch. Input is what retires it.
    if (kind === "decision" && tailLooksLikeDecision(ptyId)) return;
    const attentionByTab = { ...get().attentionByTab };
    delete attentionByTab[ptyId];
    const status = computeStatusScopes(
      get().busyByTab,
      attentionByTab,
      get().statusCountsByScope,
      get().statusTabsByScope,
    );
    set({
      attentionByTab,
      attentionByScope: rollupAttentionScopes(attentionByTab),
      statusCountsByScope: status.counts,
      statusTabsByScope: status.tabs,
    });
  },

  runScript: (scriptPath, cwd, projectId) => {
    set((s) => ({ runningScripts: new Set(s.runningScripts).add(scriptPath) }));
    // `projectId` scopes the backend's path confinement (`run_script_detached`) to
    // the owning project rather than whichever one happens to be current — a file
    // tree in a detached popout is not necessarily showing the active project.
    void invoke("run_script_detached", { scriptPath, cwd, runId: scriptPath, projectId: projectId ?? null })
      .catch(() => {
        set((s) => ({ runningScripts: withoutScript(s.runningScripts, scriptPath) }));
      });
  },

  recompute: () => {
    // A popout classifies nothing (its tabs store is empty — a recompute here
    // would only wipe the statuses the main window mirrored over).
    if (isDetachedWindow()) return;
    const now = Date.now();
    // Seconds of agent work this tick is worth, for the usage recap. Derived from
    // the gap since the last tick rather than assuming the interval, and clamped:
    // a suspended laptop or a stalled interval must not book hours of "agent
    // working time" that never happened.
    const sinceLastTick = lastTickAt === null ? 0 : now - lastTickAt;
    const workedDeltaS =
      sinceLastTick > 0 && sinceLastTick <= MAX_WORK_TICK_MS ? sinceLastTick / 1000 : 0;
    lastTickAt = now;

    const { tabsByScope } = useTabsStore.getState();
    const prevScope = get().busyByScope;
    const prevTab = get().busyByTab;
    const prevAttn = get().attentionByTab;
    const nextScope: Record<string, boolean> = {};
    const nextTab: Record<string, boolean> = {};
    const nextAttn: Record<string, AttentionKind> = {};
    // Files whose run-launched tab is busy this tick (see `runningRunFiles`).
    // Collected from live tabs only, so a closed/replaced run tab drops out.
    const nextRunFiles = new Set<string>();
    const live = new Set<string>();
    let changed = false;
    // Copied lazily: both maps move rarely (an edge per turn), and an untouched
    // tick must hand the same object back so subscribers do not re-render.
    let nextWorking = get().lastWorkingByTab;
    let nextDone = get().lastDoneByTab;

    for (const [scope, tabs] of Object.entries(tabsByScope)) {
      let scopeBusy = false;
      for (const t of tabs) {
        // PTY output is recorded under the composed id (`<scope>:<tabKey>`, what
        // the backend emits and AppShell feeds in), and tab keys can collide
        // across projects, so every derived map is keyed the same way — a bare
        // key would let one project's agent light another project's pill.
        const ptyId = `${scope}:${t.key}`;
        live.add(ptyId);
        const ts = lastOutputByPty[ptyId];
        const onset = onsetByPty[ptyId];
        // Busy = the tab was commanded at some point this session (see
        // `noteUserInput` — so restored tabs bursting resume banners on launch
        // never read as "working"), output is still recent, AND the burst has
        // been sustained past the onset debounce (so a lone blip never
        // registers as "working").
        const tabBusy =
          inputByPty[ptyId] !== undefined &&
          ts !== undefined &&
          now - ts < BUSY_WINDOW_MS &&
          onset !== undefined &&
          now - onset >= WORK_ONSET_MS;
        if (tabBusy) {
          nextTab[ptyId] = true;
          scopeBusy = true;
          // A run-launched tab (Python Run/Debug, foreground shell run) pulses
          // its source file's ▶ run button while it produces output. Busy-gated,
          // so a restored-but-quiet run tab never lights up.
          if (t.runFile) nextRunFiles.add(t.runFile);
        }
        if ((prevTab[ptyId] ?? false) !== tabBusy) changed = true;
        if (tabBusy) {
          busySinceMarkByPty[ptyId] = true;
        } else if (ts !== undefined && inputByPty[ptyId] !== undefined) {
          // Was the burst that just ended work? Either a tick saw it busy, or
          // — a tick can miss a burst that ended between two of them — the
          // burst itself lasted past the onset debounce. A lone blip is neither.
          const worked =
            busySinceMarkByPty[ptyId] || (onset !== undefined && ts - onset >= WORK_ONSET_MS);
          if (worked && nextWorking[ptyId] !== ts) {
            // The last output of the burst is when this tab was last seen working.
            if (nextWorking === get().lastWorkingByTab) nextWorking = { ...nextWorking };
            nextWorking[ptyId] = ts;
          }
          if (worked && now - ts >= DONE_QUIET_MS && agentPromptLeaf(t) && nextDone[ptyId] !== ts) {
            // Quiet long enough after work to call the turn finished — the same
            // silence `attentionFor` waits out, but marked for every tab, watched
            // or not.
            busySinceMarkByPty[ptyId] = false;
            if (nextDone === get().lastDoneByTab) nextDone = { ...nextDone };
            nextDone[ptyId] = ts;
          }
        }

        const attn = attentionFor(scope, t, ptyId, now);
        if (attn) nextAttn[ptyId] = attn;

        // ── Usage recap ────────────────────────────────────────────────────
        // The busy/attention state this tick is already the truth about what the
        // agents are doing; the recap just needs it accumulated rather than only
        // rendered. Only agent tabs count — a busy shell is the user working, not
        // an agent.
        if (agentPromptLeaf(t)) {
          if (tabBusy && workedDeltaS > 0) {
            // Agent-seconds: two agents working in parallel for a minute is two
            // agent-minutes. That is the quantity worth reporting.
            bumpUsage(scope, METRIC.AGENT_WORKED_S, workedDeltaS);
          }
          // Count the EDGE, not the state: an agent sitting on a decision prompt
          // for ten ticks stopped to ask once, not ten times.
          if (attn && prevAttn[ptyId] !== attn) {
            bumpUsage(
              scope,
              attn === "decision" ? METRIC.AGENT_DECISION : METRIC.AGENT_DONE,
            );
          }
        }
      }
      if (scopeBusy) nextScope[scope] = true;
      if ((prevScope[scope] ?? false) !== scopeBusy) changed = true;
    }
    // A scope/tab that was busy and is now gone or idle also counts as a change.
    for (const scope of Object.keys(prevScope)) {
      if (!(scope in nextScope) && prevScope[scope]) changed = true;
    }
    for (const tab of Object.keys(prevTab)) {
      if (!(tab in nextTab) && prevTab[tab]) changed = true;
    }
    // Closed tabs would otherwise keep their output history (and their tail)
    // forever, and hand it back to whatever tab next reuses the key.
    for (const map of PTY_MAPS) {
      for (const ptyId of Object.keys(map)) {
        if (!live.has(ptyId)) delete map[ptyId];
      }
    }
    for (const ptyId of decisionMemo.keys()) {
      if (!live.has(ptyId)) decisionMemo.delete(ptyId);
    }
    for (const ptyId of Object.keys(nextWorking)) {
      if (live.has(ptyId)) continue;
      if (nextWorking === get().lastWorkingByTab) nextWorking = { ...nextWorking };
      delete nextWorking[ptyId];
    }
    for (const ptyId of Object.keys(nextDone)) {
      if (live.has(ptyId)) continue;
      if (nextDone === get().lastDoneByTab) nextDone = { ...nextDone };
      delete nextDone[ptyId];
    }
    const workingChanged = nextWorking !== get().lastWorkingByTab;
    const doneChanged = nextDone !== get().lastDoneByTab;

    const attnChanged = !sameAttention(prevAttn, nextAttn);
    const prevCounts = get().statusCountsByScope;
    const prevStatusTabs = get().statusTabsByScope;
    const status = computeStatusScopes(nextTab, nextAttn, prevCounts, prevStatusTabs);
    const nextCounts = status.counts;
    // The tally can move even when no tab flipped busy — a tab carrying an
    // attention flag was closed, say — so it gates the publish independently.
    const countsChanged = !sameCountMaps(prevCounts, nextCounts);
    // The per-tab list can move while the tally stands still: one tab going quiet
    // as another goes busy keeps "1 working" true but changes WHICH tab the bar
    // aims at, so it gates its own publish.
    const statusTabsChanged = !sameTabMaps(prevStatusTabs, status.tabs);
    // The run-file set can move independently of `busyByTab` — a run tab going
    // busy flips both, but a run tab closing while still "busy" drops out here
    // via `live` even if some other tab keeps the same busy tally — so gate it
    // on its own comparison, same as the other maps.
    const runFilesChanged = !sameStringSet(get().runningRunFiles, nextRunFiles);
    if (
      !changed &&
      !attnChanged &&
      !countsChanged &&
      !statusTabsChanged &&
      !runFilesChanged &&
      !workingChanged &&
      !doneChanged
    )
      return;
    // Only re-publish the maps that actually moved: every tab bar subscribes to
    // the whole `busyByTab` object, so handing it a fresh-but-equal one on each
    // interval tick would re-render them all for nothing.
    set({
      ...(changed ? { busyByScope: nextScope, busyByTab: nextTab } : {}),
      ...(attnChanged
        ? { attentionByTab: nextAttn, attentionByScope: rollupAttentionScopes(nextAttn) }
        : {}),
      ...(countsChanged ? { statusCountsByScope: nextCounts } : {}),
      ...(statusTabsChanged ? { statusTabsByScope: status.tabs } : {}),
      ...(runFilesChanged ? { runningRunFiles: nextRunFiles } : {}),
      ...(workingChanged ? { lastWorkingByTab: nextWorking } : {}),
      ...(doneChanged ? { lastDoneByTab: nextDone } : {}),
    });
  },
}));

// App-lifetime listener: clears the run animation when a detached script
// finishes (run_id is the script's absolute path). Lives in the store rather
// than in FileTree so the run state survives side-panel hide/show, which
// unmounts the tree — see TODO group R #34. Guarded so non-Tauri contexts
// (e.g. unit tests, where the IPC bridge is absent) don't throw on import.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  try {
    // `Promise.resolve` rather than a bare `.catch`: this module is imported
    // (transitively) by suites that stub the event module with a plain `vi.fn()`,
    // whose `undefined` return would throw HERE, at import time, and take the
    // whole suite down before a single test ran. A store's module scope must not
    // be able to fail on the shape of somebody else's mock.
    void Promise.resolve(
      listen<{ runId: string; success: boolean }>("script-finished", (e) => {
        useActivityStore.setState((s) => ({
          runningScripts: withoutScript(s.runningScripts, e.payload.runId),
        }));
      }),
    ).catch(() => {});
  } catch {
    /* no IPC bridge (tests) */
  }
}
