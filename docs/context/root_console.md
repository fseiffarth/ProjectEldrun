# Root console

The root scope is Eldrun's cross-project working surface. It is where you
manage everything that sits above a single project: the calendar, the to-do
board and the project list itself. This doc covers two design choices: why the
root scope is an overlay, and why its agents have rights no other agent has.

## An overlay, not a scope to switch to

The root terminal used to be a scope like a project, so opening it replaced the
project on screen. The one terminal that belongs to no project was also the
only one that cost you the project you were working in. Now Ctrl+Shift+R, the
scope chip's Root entry and every "log in in the root terminal" flow open
`RootOverlay`: one subwindow that floats over whatever is open.

The scope itself is unchanged. Its tabs still live in `tabsByScope.root` and
persist under `sessions/root/`. Their PTYs are still owned by `CenterPanel`'s
keep-alive pane layer, and the overlay's panes are attach-only views of them.
This is the same arrangement popouts use, so closing the overlay ends nothing.

It is the only overlay onto the root terminal. One-click installs
(`runInstallInTab`) used to float a second one, `InstallOverlay`: a single
attach-only terminal on the install's root tab. That made two dialogs over one
scope, and the smaller one could show only the tab it was opened for. An install
now opens its tab in the console through `openTabInRootConsole`, the same door
a parked login (`openConnectionInRoot`) takes. That door restores the root
scope *before* adding the tab. A tab added to a root never opened this session
creates the scope key, which reads as "hydrated", so the restore would be
skipped and the host's persist would write the lone new tab over the saved root
layout.

The overlay renders the root layout as stored, splits included. Dragging a tab
onto another subwindow's strip or a body's edge rearranges it as in a project,
through the tab store's `…InScope` actions. The ordinary layout actions only
write the *active* scope, and root is not the active one while the overlay
floats over a project. The drag keeps its state local rather than in
`stores/drag`, because that store puts `CenterPanel` into drag mode underneath.

It is a window, not a dialog, so it behaves like one. The title bar is the move
handle (a press on a tab or a control keeps its own meaning), eight grips on the
edges and corners resize it, and ⤢ fills the window — as does a double-click on
the bar. The frame lives in `stores/rootOverlay`, in localStorage rather than
`settings.json`: where a window sits on one desk is not a preference worth
syncing. It is re-clamped against the window it actually opens in, so a console
sized on an external display is still reachable on the laptop panel, and an edge
dragged past the minimum pins the opposite edge instead of pushing the console
across the screen. An untouched console keeps the size the stylesheet gives it.

Every subwindow also docks the **file viewer** on its right edge, through the
same ◫ a project's subwindows carry — the shared `SubwindowFilesSidebar`, i.e.
the `ProjectFilesView` the side panel and the Files (Project) tab render, so
there is no fourth copy of the viewer. It is rooted at `~/eldrun/root`, the
folder that belongs to no project: the console had a terminal on it and no way
to see what was in it but `ls`. The state is the group node's own
(`filesOpen`/`filesWidth`/`filesFolder`), so it persists with the root layout
under `sessions/root/` — but it is written through `setGroupFiles*InScope`,
because root is not the active scope while the console floats and the plain
actions would have filed the console's file column onto the project on screen.
Unsplit, the ◫ sits in the console's title bar and the control cluster reserves
the column's width the way `TabBar` does; split, each subwindow carries its own.

Two jobs moved into the overlay's always-mounted host because root no longer
becomes the active scope:

- **Persisting root.** `CenterPanel` saves only the active scope.
- **Hydrating root.** Restoring root on first use used to happen on a scope
  switch.

With no project open, `CenterPanel` still shows the root scope. While the
overlay is up, the panel's copies of the root panes stand down: two visible
views of one PTY would take turns resizing it.

## The extra rights

A root agent is asked for things that are not any project's business: "add a
calendar entry on Friday at 14:00 for an hour", "put a card on the board for
project X". Those stores are Eldrun's own, so Eldrun serves them as MCP tools
(`services::root_mcp`) over loopback HTTP (`POST /mcp`, one JSON-RPC message in
and one reply out).

**The boundary is one bearer token.**

- **Minted per run and never written to disk.** A fenced project agent sees `/`
  read-only, so a token in a file would be a token it can read.
- **Handed out in one place.** `pty_spawn` calls
  `root_mcp::apply_to_spawn` only when `is_agent && project_id.is_none()`.
  `project_id` is the same trusted spawn input that picks the fence roots, and
  an agent cannot make Tauri calls, so it cannot ask for a root spawn.
- **Given on the CLI's own command line, never through its config files.**
  Eldrun does not write another application's config, and a flag dies with the
  tab. Claude gets an inline `--mcp-config`. Codex gets
  `-c mcp_servers.eldrun.url=…` plus `bearer_token_env_var`, so its token stays
  out of its argv. Every other agent gets `ELDRUN_ROOT_MCP_URL` and
  `ELDRUN_ROOT_MCP_TOKEN` only.
- **Hidden from fenced project agents.** Bubblewrap gives each fenced agent its
  own pid namespace and `/proc`, so it cannot read the root agent's environment
  or argv.

**Known limit.** An agent you chose to run *unfenced* shares your uid and can
read `/proc/<pid>/environ` and `/proc/<pid>/cmdline` of a root agent. That is
what turning the fence off means, and the token does not pretend otherwise.

**Browsers.** A request carrying an `Origin` header is refused. Browsers send
that header on cross-origin POSTs and agent CLIs don't, so a web page cannot
reach the tools through your own browser, DNS rebinding included.

**Writes reach the window.** A tool that writes emits `root-mcp-changed` with
the row it wrote. The overlay host merges the row into the calendar store and
announces it through `notifyCalendarWrite`, so a CalDAV-backed calendar pushes
it exactly as it would a dialog edit.

**The board's tools are the board's gestures.** `todo_add`, `todo_update`,
`todo_complete`, `todo_reopen`, `todo_move` and `todo_delete` go through the
same task CRUD and the same `move_tasks_at` a drag uses, so the rank algebra and
the done↔column coupling stay in one place. A move can reindex a whole column,
so one call may emit several rows. Rows whose only change is `column`/`rank`
carry `local: true` and are merged without a CalDAV push, which is what a drag
on the board does too — no server stores those fields. A delete is permanent
and its tool description says so; the row rides along so the CalDAV copy can
still be addressed.

**The sweeps answer for every project at once.** `projects_git_status`,
`sync_status`, `time_summary`, `usage_recap` and `boxes_list` are the questions
a *project* agent structurally cannot answer — which projects have uncommitted
work, whether anything is out of step with its host, how long last week went.
All five are pure reads of files Eldrun already owns, and none of them opens a
connection. The git sweep runs `git` on the **local** working copy only: a
remote project through its mirror, and reported as skipped, with the reason,
when it has none. `sync_status` reports what the last pass recorded rather than
probing the host. A synchronous SSH round trip inside a tool call would stall
the handler for as long as a dead session takes to time out, once per project —
the freeze the remote UI's connected-gates already exist to avoid. The git sweep
also runs with `GIT_OPTIONAL_LOCKS=0`, because a background reader that
refreshes the index takes `index.lock`, which is half of the root git-status
loop.

The two rollups are bucketed by **UTC** date, since that is how
`time_summary.json` and `usage_stats.json` were written; the tool descriptions
say so rather than passing them off as local days. Eldrun's own window time is
reported as `app_seconds` and never inside a project's total, and a scope whose
project has since been deleted keeps its bare id — the hours are still real.

**An event is edited, not re-created.** `calendar_update_event` closes the gap
that made rescheduling a delete plus an add, which loses the row's identity: a
CalDAV server would see a cancellation and a new invitation instead of a change.
Moving `start` alone keeps the event's own length — an agent that omits `end` is
moving the event, not resizing it, and `calendar_add_event`'s one-hour default
would quietly shorten a three-hour meeting every time it was moved. An event in
a read-only calendar is refused before anything is written locally, because the
window could not push it.

**Showing is not writing.** `mail_open`, `calendar_open` and `todo_open` put the
header's overlays on screen — "show me my mail", "open the board on that card".
They travel as their own event, `root-mcp-open`, because there is no row to
merge and nothing for CalDAV. Two details:

- **The backend reads the overlay's settings gate first** (`mail_client`,
  `calendar_global_app`, `todo_board`). Each overlay host applies that gate on
  its own, so an ungated call would report success and show nothing.
- **The console closes.** It is a modal mounted after the other three, so it
  would sit on top of the overlay it was asked for. Closing it ends nothing, and
  Ctrl+Shift+R brings it back.

**Tools say what they do, not whether to ask.** Each tool carries MCP
annotations: the `*_list` and `*_open` tools are `readOnlyHint` (an overlay
writes no store and closes with Escape), and the deletes and
`todo_update` are `destructiveHint`. Codex asks before any tool not marked
read-only, so reads now go through without a prompt and writes still ask.
Eldrun never passes `default_tools_approval_mode`: approval is the CLI's own,
like its permission mode.

**One switch turns it all off.** `settings.json`'s `root_mcp` — absent means
on — is read per spawn and per request rather than at startup, so it needs no
restart in either direction. Off closes both halves, because only one would be
a lie: a root agent spawned from then on is handed no endpoint, and the
endpoint answers `503` to the agents that already hold the token. The check
sits after the bearer check, so an unauthenticated caller learns nothing from
it. The listener itself stays bound; rebinding would mint a port the running
agents were never told about, and turning the tools back on would not reach
them. Settings and the console's ⚿ badge are two doors onto that one key.

**Failure is safe.** If the listener cannot bind, or the OS has no entropy,
root agents are ordinary agents. The ⚿ badge in the overlay says which case
you are in.

## Never the phone

- `mobile_control::discovery` builds its catalog from `projects.json` and
  `boxes.json`. Root is in neither file, and a hand-edited record using the id
  `root` (which would borrow `sessions/root/`) is refused explicitly.
- Root Claude tabs spawn without `--remote-control`, so they never appear in
  Claude's own phone app.
