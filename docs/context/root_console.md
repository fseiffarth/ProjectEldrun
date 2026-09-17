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
This is the same arrangement popouts and `InstallOverlay` use, so closing the
overlay ends nothing.

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

**Failure is safe.** If the listener cannot bind, or the OS has no entropy,
root agents are ordinary agents. The ⚿ badge in the overlay says which case
you are in.

## Never the phone

- `mobile_control::discovery` builds its catalog from `projects.json` and
  `boxes.json`. Root is in neither file, and a hand-edited record using the id
  `root` (which would borrow `sessions/root/`) is refused explicitly.
- Root Claude tabs spawn without `--remote-control`, so they never appear in
  Claude's own phone app.
