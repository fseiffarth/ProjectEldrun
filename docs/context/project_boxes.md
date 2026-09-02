# Project boxes — design rationale

Why the box subsystem works the way it does; the *what* is in
`DOCUMENTATION.md` ("Project Boxes") and the code
(`src/stores/boxes.ts`, `src-tauri/src/commands/boxes.rs`).

## The overlay model (why members never fold into their box)

A box is a **temporary joining** of projects, not a container that owns them.
Two consequences drive the switcher's rendering:

- Member pills always render individually, wearing only a small ▣ badge. The
  earlier bucketing model (member pills hidden inside the box pill) made a
  box *cost* something — putting a project into a box removed its pill, so
  users had to choose between grouping and reachability. Overlaying keeps
  grouping free.
- Membership is N:M. A paper project can sit in a "thesis" box and a
  "collaboration" box at once; exclusive membership (the old per-project
  `box_id` back-reference) forced silent un-grouping whenever a second
  grouping was wanted. `member_ids` on each box is the only membership record;
  a stale persisted `box_id` is stripped in-memory on load and falls off disk
  with the next ordinary `save_projects`.

## Why silent dissolve died

`assignToBox` used to dissolve any box left with exactly one member — "a box
is meaningless with a single member". Under N:M and the overlay model that
reasoning inverted: a one-member (or empty) box is a *staging area* the user
is still filling, and tearing it down as a side effect of removing one member
destroyed work (the box's name, position, folder association) nobody asked to
lose. Dissolving is now exclusively the box editor's explicit, confirmed
action; the confirm states what survives (folder + agent docs on disk, every
member untouched). Empty boxes render dimmed rather than vanishing.

## The box tab scope (`box:<id>`)

A first-class persisted scope, disjoint from project ids and `"root"`:

- **Persist**: `CenterPanel` persists the *active scope*; a box scope goes to
  `<state_dir>/sessions/box_<id>/terminals.json` with an empty `localFile`, so
  the project-tree export copy is skipped (the root-scope pattern — there is
  no `project.json` for a box, and the box folder must never become a source
  of executable intent).
- **Restore**: lazy, on first entry per session (`restoreBoxScope` in
  `stores/boxes.ts`); nothing restorable seeds one shell at the box folder.
  The seed lives in the restore path, NOT in `openBox`, so restore and seed
  cannot race — `openBox` only ensures the folder and switches the scope.
- **Leaving**: `activeId` doesn't change when a box opens, so the scope-setting
  effect keys on `switchGeneration` too — clicking the already-active
  project's pill is the gesture that must exit the box.
- **Spawn/read authority**: the PTY gate (`pty_spawn`) and the absolute-path
  confinement (`compute_allowed_roots`) both accept the box folder ∪ member
  roots ∪ remote members' mirrors and fail closed on an unknown box. A tab may
  be rooted in a member root — deliberately, since Claude keys its resume
  history by cwd, so a member-rooted agent tab resumes that member's
  conversations.
- **Trust (v1)**: box tabs run local + uncontained. A member's container/VM
  boundary is a per-project promise; silently extending one member's sandbox
  to a scope that can also reach the other members' trees would look like a
  boundary without being one. `enforce_spawn_authority` pins `sandbox: false`
  for box scopes, and the box editor shows a one-line notice when a member is
  containerized/VM.

## The symlink farm and its manifest

The box folder carries one symlink per member (`./<member>/`, Unix only) so
agent CLIs launched there can traverse into every member's tree — that is the
whole reason the box folder is a useful agent cwd. Ownership is the subtle
part: `.eldrun-box-links.json` records exactly which names Eldrun created, so
regeneration removes only manifest-owned entries that are *still symlinks* and
whose member vanished or moved. A user file shadowing a member's natural name
is never replaced — the member re-links under a `-1`/`-2` suffix. Dangling
targets are still linked (a member's folder may not exist yet). Eldrun's own
confinement deliberately does not follow the links; the multi-root Files view
is Eldrun's file surface, and the allowed-roots sets are explicit.

## What stays out of scope (v1)

- A disconnected remote member's section in the box file view shows a connect
  prompt; a mirror fallback is a follow-on.
- No box-level sandbox or VM.
- Box tabs are local-only (`closeRemoteTab`'s remote-session classification
  resolves no project for a box scope); local shells DO get tmux persistence,
  since the scope restores and a surviving session has a tab to reattach to.
