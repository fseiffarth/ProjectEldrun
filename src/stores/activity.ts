import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { looksLikeDecisionPromptStripped, stripAnsi } from "../lib/agentPrompt";
import { METRIC, agentPromptLeaf } from "../lib/usageMetrics";
import { allGroups, isPtyTabKind, useTabsStore } from "./tabs";
import type { TabEntry } from "./tabs";
import { bumpUsage } from "./usage";

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
];

/** Record that a PTY produced output just now, keeping the tail of the current
 *  burst so `recompute` can tell a finished turn from a decision prompt. Cheap;
 *  safe to call often. */
export function notePtyOutput(ptyId: string, data = "") {
  const now = Date.now();
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
  if (data) {
    const tail = (tailByPty[ptyId] ?? "") + stripAnsi(data);
    tailByPty[ptyId] = tail.length > TAIL_CAP ? tail.slice(-TAIL_CAP) : tail;
  }
}

/** When a PTY last produced output (ms epoch), or undefined if none was seen
 *  this session. Read-only view for the tab hover card's "quiet for…" line —
 *  the raw map stays module-private because it churns per output batch. */
export function lastPtyOutputAt(ptyId: string): number | undefined {
  return lastOutputByPty[ptyId];
}

/** Record that input was sent to a PTY on the user's behalf — a keystroke, a
 *  paste, or a user-triggered flow typing its command (`initialInput`). This is
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
  inputByPty[ptyId] = Date.now();
  tailByPty[ptyId] = "";
}

/** Forget everything recorded about a PTY, called when it is (re)spawned. A
 *  respawn — app launch, a project closed and reopened, a pane remounting — is
 *  a new program: input sent to its predecessor mustn't license the successor's
 *  restore/resume replay as a finished turn. */
export function notePtySpawn(ptyId: string) {
  for (const map of PTY_MAPS) delete map[ptyId];
  decisionMemo.delete(ptyId);
}

/** Split a composed PTY id (`<scope>:<tabKey>`) into its parts, mirroring
 *  `isDetachedPtyId` in stores/tabs. Returns null for a bare (colon-less) id. */
export function splitPtyId(ptyId: string): { scope: string; key: string } | null {
  const idx = ptyId.indexOf(":");
  if (idx < 0) return null;
  return { scope: ptyId.slice(0, idx), key: ptyId.slice(idx + 1) };
}

/** True when the tab is the one the user is currently looking at: it's the
 *  active (visible) tab of its group in the CURRENT scope. Background tabs and
 *  background projects are never "looked at". */
function isTabLookedAt(scope: string, key: string): boolean {
  const st = useTabsStore.getState();
  if (st.scope !== scope) return false;
  for (const g of allGroups(st.layoutByScope[scope] ?? null)) {
    if (g.tabKeys.includes(key)) return g.activeKey === key;
  }
  return false;
}

/** True when the tab lives in a detached popout (#42). Such a tab has its own OS
 *  window and its own tab strip, and this window has no idea whether the user is
 *  looking at it — so it raises no attention here, which also stops a popped-out
 *  agent from leaving its project pill glowing with a flag nothing can clear. */
function isTabDetached(scope: string, key: string): boolean {
  const groups = useTabsStore.getState().detachedGroupsByScope[scope] ?? [];
  return groups.some((d) =>
    allGroups(d.subtree).some((g) => g.tabKeys.includes(key)),
  );
}

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
  if (isTabDetached(scope, tab.key)) return null;
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
function countStatusScopes(
  busyByTab: Record<string, boolean>,
  attentionByTab: Record<string, AttentionKind>,
  prev: Record<string, TabStatusCounts>,
): Record<string, TabStatusCounts> {
  const { tabsByScope } = useTabsStore.getState();
  const next: Record<string, TabStatusCounts> = {};
  for (const [scope, tabs] of Object.entries(tabsByScope)) {
    const counts: TabStatusCounts = { working: 0, decision: 0, done: 0 };
    for (const t of tabs) {
      const ptyId = `${scope}:${t.key}`;
      if (isPtyTabKind(t.kind) && busyByTab[ptyId]) counts.working++;
      else if (attentionByTab[ptyId] === "decision") counts.decision++;
      else if (attentionByTab[ptyId] === "done") counts.done++;
    }
    if (!counts.working && !counts.decision && !counts.done) continue;
    const before = prev[scope];
    next[scope] = before && sameCounts(before, counts) ? before : counts;
  }
  return next;
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
  runScript: (scriptPath: string, cwd: string) => void;
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  busyByScope: {},
  busyByTab: {},
  attentionByTab: {},
  attentionByScope: {},
  statusCountsByScope: {},
  runningScripts: new Set(),
  runningRunFiles: new Set(),

  noteBell: (ptyId) => {
    if (!splitPtyId(ptyId)) return;
    bellByPty[ptyId] = Date.now();
    get().recompute();
  },

  clearAttention: (ptyId) => {
    seenAtByPty[ptyId] = Date.now();
    const kind = get().attentionByTab[ptyId];
    if (!kind) return;
    // Looking at a tab marks its output read — but it does not ANSWER a prompt,
    // and the next `recompute` would only raise the flag straight back (see
    // `attentionFor`). Keep it, so the lamp holds steady instead of blinking off
    // and on at the switch. Input is what retires it.
    if (kind === "decision" && tailLooksLikeDecision(ptyId)) return;
    const attentionByTab = { ...get().attentionByTab };
    delete attentionByTab[ptyId];
    set({
      attentionByTab,
      attentionByScope: rollupAttentionScopes(attentionByTab),
      statusCountsByScope: countStatusScopes(
        get().busyByTab,
        attentionByTab,
        get().statusCountsByScope,
      ),
    });
  },

  runScript: (scriptPath, cwd) => {
    set((s) => ({ runningScripts: new Set(s.runningScripts).add(scriptPath) }));
    void invoke("run_script_detached", { scriptPath, cwd, runId: scriptPath })
      .catch(() => {
        set((s) => ({ runningScripts: withoutScript(s.runningScripts, scriptPath) }));
      });
  },

  recompute: () => {
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

    const attnChanged = !sameAttention(prevAttn, nextAttn);
    const prevCounts = get().statusCountsByScope;
    const nextCounts = countStatusScopes(nextTab, nextAttn, prevCounts);
    // The tally can move even when no tab flipped busy — a tab carrying an
    // attention flag was closed, say — so it gates the publish independently.
    const countsChanged = !sameCountMaps(prevCounts, nextCounts);
    // The run-file set can move independently of `busyByTab` — a run tab going
    // busy flips both, but a run tab closing while still "busy" drops out here
    // via `live` even if some other tab keeps the same busy tally — so gate it
    // on its own comparison, same as the other maps.
    const runFilesChanged = !sameStringSet(get().runningRunFiles, nextRunFiles);
    if (!changed && !attnChanged && !countsChanged && !runFilesChanged) return;
    // Only re-publish the maps that actually moved: every tab bar subscribes to
    // the whole `busyByTab` object, so handing it a fresh-but-equal one on each
    // interval tick would re-render them all for nothing.
    set({
      ...(changed ? { busyByScope: nextScope, busyByTab: nextTab } : {}),
      ...(attnChanged
        ? { attentionByTab: nextAttn, attentionByScope: rollupAttentionScopes(nextAttn) }
        : {}),
      ...(countsChanged ? { statusCountsByScope: nextCounts } : {}),
      ...(runFilesChanged ? { runningRunFiles: nextRunFiles } : {}),
    });
  },
}));

// App-lifetime listener: clears the run animation when a detached script
// finishes (run_id is the script's absolute path). Lives in the store rather
// than in FileTree so the run state survives right-panel hide/show, which
// unmounts the tree — see TODO group R #34. Guarded so non-Tauri contexts
// (e.g. unit tests, where the IPC bridge is absent) don't throw on import.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void listen<{ runId: string; success: boolean }>("script-finished", (e) => {
    useActivityStore.setState((s) => ({
      runningScripts: withoutScript(s.runningScripts, e.payload.runId),
    }));
  }).catch(() => {});
}
