# Git lockstep + byte-sync

Referenced from `CLAUDE.md`.

- **Two transports keep a remote project in step, and they split the tree by
  git.** *Git lockstep* (`services::git_peer`) owns the **git-tracked** files and
  moves them **semantically** — commits and refs via `git bundle`, never `.git`
  bytes. *Byte-sync* (`services::sync_auto`) owns **everything else** and moves raw
  bytes. `drop_tracked` enforces the split so the two never race for one file. One
  consequence to internalize: with lockstep on, a saved edit to a **tracked** file
  no longer reaches the host until it is **committed** (`docs/git_lockstep_case_matrix.md`
  #5/#7). Live-QA log: `docs/git_lockstep_live_qa.md`.
- **Anything the sync destroys on the local side says so** (#28q, `services::local_loss`).
  Byte-sync is non-destructive *by construction* — it pulls only when the local side is
  unchanged, pushes only when the host is, and skips a both-sides-changed file rather than
  pick a winner — so every local **deletion** comes from the git side: a fast-forward,
  `reset --hard` or checkout on the mirror drops the tracked files the incoming commit no
  longer carries, and the `git clean` that un-blocks a refused fast-forward removes
  untracked ones outright. Correct, git-recoverable, and *silent* — which is the problem,
  because it happens during background passes nobody triggered. Each site now files a
  warning that `LocalLossDialog` raises. The exception that is **not** recoverable, and is
  labelled as such: `sync_now`/`sync_pull` overwriting a mirror file that held unsynced
  local edits ("clears amber → green" means the host wins). It is a **log file**, not an
  event: the services are `AppHandle`-free and a background pass can delete with no window
  listening, so a loss recorded while the app was closed still surfaces on next launch.
- **Lockstep is ON by default for a new git-backed remote project** — set at
  creation by both `create_project` and `extend_project_to_remote` (gated on the
  mirror actually being a repo). It is safe as a default precisely there: the host
  root was just created empty, so the first pass can only seed one direction, and a
  host dir that already holds *differing* files makes pairing **refuse** and ask
  (`pairing_conflict`) rather than clobber. It is written as explicit per-project
  state, never as `GitPeerState::default()` — `load_state` falls back to that
  default for every project with no state file, so flipping it there would silently
  enable lockstep on existing projects that never opted in.
- **Byte-sync is opt-in per path and does not read `.gitignore`.** Scope comes from
  an explicit manifest (`is_auto`: nearest marker wins, root `""` = project-wide);
  no marker ⇒ nothing crosses. This is what leaves a remote project's *deliberately
  host-side* data — experiment output, checkpoints, everything gitignored and hence
  invisible to lockstep — on the host. The corollary is that the two systems have
  **different notions of scope**, so marking a folder auto-sync is the one click
  that can haul a multi-GB tree into the mirror; the file tree prices the host
  subtree first (`sync_auto_preview`) and confirms when it is large.
  - **The giant folders are asked about once, at setup, on both sides**
    (`services::big_folders` → `BigFolderExcludeDialog`). Pricing one folder on the
    click that syncs it is too late for a project whose `node_modules/`, `.venv/`,
    `data/` or `checkpoints/` was there before Eldrun was: nothing else in the app
    would ever mention them, since byte-sync doesn't read `.gitignore`. So a
    project newly created/imported as remote, or **extended** to a host, gets one
    census — the local mirror walked directly, the host in one `du -ak` round trip
    (skipped, never attempted, at a cold pool: dispatching at a dead session is
    what freezes the window) — and one prompt listing each side's numbers, ticked
    to **exclude** by default. The answer is a manifest `excluded` marker, which is
    deliberately *stronger* than `auto_off`: it is honoured by the whole-project
    pull and push too (`is_excluded`, whose `under` waives only the marker on the
    path the user explicitly asked to transfer), and it makes the rsync fast path
    stand down, since a whole-subtree rsync cannot honour a carve-out. Byte-side
    only — a **git-tracked** file in an excluded folder still travels as a commit.
