# Headless owner — the desktop's live state moves into the sidecar

*Split out on 2026-09-29 from
[`eldrun_hosted_plan.md`](eldrun_hosted_plan.md) (§1 decision 3, §3.4, P0
and P1), because every step pays off on the desktop whether or not a server
ever ships. File references were measured at `923e0202`; re-verify before
building on one.*

*Status: **H0 landed** (2026-09-29, never live-verified): `write_json_atomic`
fsyncs the parent directory (#172); `calendar.json` writes are
compare-and-swap on a file `rev` with per-record `rev`s (#171,
`commands::calendar::transact`); the sidecar answers `Todo`, `Calendar`,
`Schedules`, `Prompts` and `AgentTranscript` off the state dir when the
window is closed (`services::mobile_control::headless`), flagged
`desktop_available: false` and read-only.*

*Status: **H1 landed in part** (2026-09-29, never live-verified).
`services::workspace` is the group-0 owner: the session file carries a
version and every tab a stable `id`; the desktop syncs through
`workspace_sync` with the version it last saw and the service merges only
what that client changed (a tab another client opened survives, a close it
never saw stands — the two-client test in `workspace.rs`); `save_tab_layout`
is refused once a scope is versioned; settings and boxes are
compare-and-swap on a `rev`. Chosen against the plan and why: (1) the owner
is the versioned file plus its lock rather than the sidecar process — the
sidecar only runs while Mobile is enabled, and both processes run the same
`AppHandle`-free service, so no owner has to be alive; (2) ops are derived
by the service from the client's snapshot against its base version instead
of being sent one by one, so the tab store's internals stay and the wire
shape is `toSavedTabEntry`'s; (3) tmux names are still minted client-side
and the default tmux socket stays — `-L eldrun` would hide every live
session from a window that had not restarted, and owner-side spawning needs
a detached `tmux new-session` path `pty_spawn` does not have; (4) the
per-client layout is split at the API (`groups`/`sessions`/`active_tab_index`
are the client's fields the merge never reads), not into a second file;
(5) default apps keep their whole-document save (a bare map with nowhere to
hold a revision); (6) `Catalog`/`Activity`/`GitStates` are still the
window's.*

*Status: **H2 interim landed** (2026-09-29, never live-verified): the
single-client lease. `services::timer_lease` grants one client per state
dir a heartbeat-renewed lease (`timer-lease.json`, 30 s TTL, released on
the way out); the React timer hosts — scheduled prompts, auto-continue, the
warm-up cron, calendar alarms, CalDAV sync — tick only while their window
holds it, and the schedule dialog says so when another window does. Git
probing is not gated (a duplicate probe costs, never fires). The port of the
timers into the owner — "fires once with no client" — is still plan only,
as is H3.*

The request behind it: **the phone, schedules and alarms keep working with
the desktop window closed, and two clients never fight over the same state.**
The hosted plan builds on this; nothing here depends on it.

---

## 1. The problem

Today the React app is the authority for far more than it looks:

- **Spawning.** Terminal processes only start when `TerminalView` mounts:
  the only `pty_spawn` call is `TerminalView.tsx:1430`. The frontend decides
  tmux-or-not (`CenterPanel.tsx:199`) and mints tmux names (`tabs.ts:45`).
- **Timers.** Scheduled prompts, auto-continue and the warm-up cron are fired
  by React hosts mounted in `AppShell.tsx:1420-1422`. `AgentScheduleHost`
  ticks every 15 s against the frontend's `lastPtyOutputAt`. Calendar alarms
  (`stores/calendar/alarms.ts:148`), the CalDAV sync host and git probing run
  on frontend timers too; the phone's git dots are "what the desktop's pills
  already probed".
- **The tab set** is saved as one whole client snapshot (`save_tab_layout`,
  `projects.rs:2565`, debounced from `tabs.ts:5127`).
  `terminal_service.rs:78-93` records four tabs lost to *one* client racing
  itself.
- **The phone is answered by the window.** `commands/mobile_control.rs:1331`
  emits a `DesktopRequest` to window `"main"`, and `MobileBridgeHost.tsx`
  (2302 lines) answers it. Popouts forward their writes to the main window
  (`detachedContext`).
- **Project activation and restore** live in the store
  (`projects.ts:1408-1437`).

The consequences: with no window open, nothing is scheduled and the phone
gets no answer. With two windows open, every schedule fires twice and the tab
set is last-writer-wins as a whole. Closing the main window quits the whole
app (`lib.rs:776-783`), so the owner cannot live in the Tauri process either.

## 2. The owner

**The owner is the existing per-user Mobile sidecar** (`eldrun --mobile-host`,
`main.rs:21-45`, already a user systemd unit), grown into a `workspace`
service. It already runs without a window and survives the desktop closing.
On a server the same code becomes the per-user daemon (hosted plan §3.1).

| State | Owner | Why |
|---|---|---|
| Project list, active/stopped, per-project settings | owner (`projects.json`). `save_projects` already patches only `status`, `position` and `box_id` (`projects.rs:655-673`); activation/restore logic moves out of the store. | Already mostly backend-owned. |
| **Tab set** per project: id, kind, label, colour, order, tmux name, agent session record, untested marks | **owner, per-operation commands** (group 0) | Must be identical on every client. |
| **Spawn policy and launch assembly**: tmux-or-not, tmux name, launch script | **owner** (group 0) | A tab's process must start whether or not a client is connected. Decided by the host's OS, never a client's. |
| **Timers**: schedules, auto-continue, warm-up cron, calendar alarms, CalDAV sync, git probing | **owner** | With no client they never fire; with two clients they fire twice. |
| Agent turn state, prompts, transcript pointers | owner (hooks already write it backend-side) | Already mostly backend-side. |
| Todo, calendar, alerts, mail overview | owner | The phone reads them without a window. |
| Settings, boxes, default apps | owner, **compare-and-swap** replacing the whole-document `save_settings` / `save_boxes` / `save_default_apps` | A laptop and a phone saving at once must not erase each other. |
| Pane split, focused tab per pane, scroll position, overlays, keyboard steering, hover, **terminal size** | **client** | Per screen; a phone and a 4K monitor cannot share a layout (decided, hosted plan Q4). `TerminalSession` splits into the shared tab set and a per-client layout (today both sit in `save_tab_layout`'s `tab_groups`). |

**Protocol.** On connect, the client gets a versioned snapshot. After that it
receives `workspace:patch {version, ops}` events. Mutations are
per-operation commands that return the new version, and a client whose
version skipped re-fetches the snapshot. Stores keep optimistic updates but
reconcile on the patch. Field edits (labels, colours) are last-writer-wins
per field. Tab creation, closing and reordering are serialised by the owner.
**`save_tab_layout` is refused once the owner holds the tab set; no second
client connects before that.**

**One writer per slice.** `JSON_MUTATION_LOCK` (`storage.rs:97-100`) only
serialises writes within one process, and the sidecar is a second process.
Once the sidecar owns a slice, the desktop window writes that slice **only**
through the sidecar, over the existing desktop bridge, and never touches the
file.

## 3. Phases

Each phase ships on its own.

**H0: prerequisites, no owner yet.**
- **#172, parent-directory fsync.** `write_json_atomic` already calls
  `sync_all` on the staged file (`storage.rs:117`); what is missing is an
  fsync of the parent directory after `persist` (`:118`), so a crash can
  lose the rename. A two-line durability fix.
- **#171, compare-and-swap on `calendar.json`.** `write_data`
  (`commands/calendar.rs:63-65`) is a whole-file write. The calendar lock
  serialises writers within one process only, the sidecar is a second
  process, and the board writes on every drag. Add a per-record `rev` and
  make writes CAS.
- **The sidecar serves the persisted-state `DesktopRequest` kinds** (`Todo`,
  `Calendar`, `Schedules`, `Prompts`, `AgentTranscript`) from files when the
  window is closed. `Catalog`, `Activity` and `GitStates` come back as
  "desktop closed" or marked stale. **Visible payoff: the phone reads todo,
  calendar and schedules with the desktop closed.**

**H1: group 0, tab set, spawning, whole-document saves.** The riskiest step.
- Per-operation tab commands in the `workspace` service.
- The owner spawns into `tmux -L eldrun`, and every client, the desktop
  included, attaches. Today tmux uses the default socket; only tests pass
  `-L` (`tmux_local.rs:899`).
- `save_tab_layout` is refused. Settings, boxes and default apps use
  compare-and-swap. `TerminalSession` splits into the shared tab set and the
  per-client layout.
- `Catalog`, `Activity` and `GitStates` are then answered by the owner,
  because they read React stores today (`MobileBridgeHost.tsx:2160-2171`).

**H2: timers.** Schedules, auto-continue, cron, alarms, CalDAV, git probing.
In the interim, a timer host still in React runs only under a single-client
**lease** granted by the owner. Two windows can never both fire it, and until
its port lands a schedule needs a connected client (stated in the UI).

**H3: the remaining `DesktopRequest` kinds** (34 in total,
`protocol.rs:752`):
- read-only: `AgentStatus`, `AgentTranscript`, `Todo`, `Alerts`,
  `Calendar`, `Schedules`, `Prompts`, `LaunchOptions`, `MailOverview`,
  `MailFolder`, `MailMessage`, `DesktopImages`;
- tab mutations: `RenameTab`, `ColorTab`, `ReorderTab`, `CloseTab`,
  `ReopenTab`, `TabSeen`, `UndoClear`, `Create`, `Activate`;
- input paths: `TabInput`, `TabPrompt`, `AttachDesktopImage`;
- writes with side effects: `TodoMutate`, `CalendarMutate`,
  `ScheduleMutate`, `PromptMutate`, `AlertResolve`, `MailMark`,
  `MailReply`.

After each port, the desktop's React store switches from owning that slice to
subscribing to it, and `MobileBridgeHost.tsx` shrinks by that handler.

**Exit, live:** with the desktop window closed, the phone lists tabs, starts
an agent, and sees a scheduled prompt fire. Two desktop windows open at once
fire every schedule exactly once. `MobileBridgeHost.tsx` answers nothing the
owner can.

## 4. Verification

- **Gates:** all five AGENTS.md gates at zero warnings after each step.
- **H0:** the write path calls `sync_all` on the temp file and on the parent
  directory handle (assert via a seam); two interleaved calendar
  read-modify-writes, where the second is rejected and retried against fresh
  state; each persisted-state kind answered by the sidecar with no window.
- **Owner tests (H1–H2):**
  - two simulated clients rename, reorder and close tabs concurrently, and
    the final tab set equals the owner's, with no tab lost;
  - `save_tab_layout` is refused once the owner holds the tab set;
  - each timer fires exactly once with two clients and once with none.
- **Manual:** the exit above, plus two windows dragging a card on the same
  board within a second, where neither edit vanishes.

## 5. Related decisions

- `docs/mcp_control_plan.md` §1 decision 2 says re-implementing the
  frontend's model backend-side "would be a second implementation that
  drifts". This plan does exactly that, on purpose: it *moves* the model, and
  does not duplicate it. That decision carries a note saying it no longer
  applies to a slice once that slice has moved.
- The hosted plan's P1 is this plan, plus the start of the crate extraction.
