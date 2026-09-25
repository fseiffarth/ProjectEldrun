# Agent git push MCP

Desktop v1 implements `docs/git_push_mcp_plan.md`: a fenced agent tab can ask
Eldrun to push the project it works in, without a credential ever entering the
fence. Globally off by default (`Settings::git_push_mcp`, Settings → Manage
CLIs). When on, every new local project-agent spawn (not a container tab; not
a remote, VM or container project) gets the `eldrun-git` server on `/mcp/git`
with a `Caller::Pusher` token bound to the tab, the project and the trusted
entry's canonical directory. The per-project level lives in the `projects.json`
entry's `git_push_mcp` block (`level` off / propose / apply, `protected`,
`confirmed_url`), default **off**, also on the project pill menu. An `off`
project still gets the tools: every write answers `level_off` naming the
setting, so the agent can tell the user where to turn it on.

Tools: `git_push_status` (read-only), `git_push { branch?, note? }`,
`git_push_cancel { id }`. No remote, URL, refspec, tag or force selector
exists. Every failure is a normal tool result with a fixed `category`, one
`message` saying what to do next, capped and redacted `output`, and `state`.

## Why two phases

`commands::git::git_push` runs the repo's `pre-push` on the host with
`ELDRUN_GIT_TOKEN` in the environment after `exec_trust` approved the hook
*files*; what those files run is not fingerprinted (this repo's hook runs
`scripts/privacy-check.sh` and `scripts/bump-version.sh`, both agent-writable).
Fine for a user's click, a fence escape once the agent can trigger the push.
So an agent push never runs project code on the host, and no process that
runs project code holds the token:

1. **Preflight, fenced, no token.** `resolve_pre_push_hook` finds the hook the
   way `exec_trust` does (`rev-parse --git-path hooks`). It runs with git's
   arguments (`<remote> <url>`) and stdin line, `ELDRUN_PUSH_PREFLIGHT=1`, the
   token variables removed, inside `agent_fence::one_shot_command` when the
   tab was fenced (`fenced_scope_of_tab`) — a *narrower* bubblewrap profile
   built from the same primitives (project/box roots, allowlist, git-control
   guard, credential and state masks), none of the tab's agent-home or
   launcher mounts. A fenced tab whose fence cannot run fails closed
   (`fence_unavailable`); an unfenced tab's hook runs unfenced, still without
   the token. Linux only; a fenced tab elsewhere gets `fence_unavailable`, an
   unfenced Windows tab with a hook `preflight_failed`. Exit ≠ 0 refuses with
   the hook's output; five minutes is the cap. Commits the hook adds are
   picked up: the plan's SHA, commit list and diffstat are re-read.
2. **Transport, host, hooks off.** `push_transport_command`:
   `hardened_git_command_in` (pins `core.hooksPath=`, so
   `reference-transaction` is off too) with the scoped inline credential
   helper for `token_origins(project)`, `GIT_TERMINAL_PROMPT=0`, `--no-verify`,
   the URL positional and the one refspec `refs/heads/B:refs/heads/B`.

`.githooks/pre-push` knows the variable: under it the signing reminder (gh +
network) is skipped, the privacy scan and bump commit run as before, and it
exits 0 instead of re-pushing and aborting. Without it nothing changed.

## What may be pushed

Decided on the host from the hardened git's view and `projects.json`; nothing
from the in-folder `project.json`. The checked-out branch only (`branch` must
name it), with a same-named upstream (`branch.B.remote` / `.merge`). Never the
remote's default branch — `ls-remote --symref HEAD`, falling back to
`refs/remotes/<r>/HEAD` then `main`/`master` — nor a listed `protected` one.
The remote branch must exist; the push is fast-forward only (`merge-base
--is-ancestor` against the `ls-remote` SHA, `diverged` otherwise, never
retried). No tags, no deletes, no `+`. The URL is the raw `remote.<r>.url`,
passed positionally so `pushurl` plays no part; because a repo-scope
`url.*.insteadOf` / `pushInsteadOf` would still rewrite a positional URL, its
presence refuses (`url_rewritten`). The first push to a URL stages for the
user's confirmation whatever the level, and pressing Push records it as
`confirmed_url`; a changed URL asks again. An https URL without a stored token
is `auth_failed` up front.

## Levels, budget, proposals

`admit` validates arguments and takes the budget before any git runs: six
`git_push` calls per tab per rolling hour (`Session::admit_push_rate`), at most
two pending/running requests per tab. A `git_push` creates a proposal record
and runs plan → preflight → stage-or-push on a worker under a per-project lock;
the call waits up to 18 s (the listener's sockets live 30 s) and otherwise
answers `running` with the id. **propose** stages after the preflight, so the
card shows the *final* commit list, bump included; **apply** pushes at once.
Approval binds the post-preflight SHA: a moved branch is `stale_approval`, a
moved remote is re-checked for fast-forward. Unapproved proposals expire after
24 h; records live 24 h in memory beside the tokens (neither survives a
restart) and go with a revoked session. There is no typed notice into the
tab — the schedule lane types *prompts*, and a push outcome must not become one
— so a `staged`/`running` result tells the agent to poll `git_push_status`.
The audit ring keeps the session, tool and category; never the note or output.

Output hygiene: last 8 KB, invisible controls stripped
(`root_mcp_mail::strip_invisible`), the effective token, `ghp_`/`github_pat_`/
`glpat-`-shaped tokens and URL userinfo replaced by `[redacted]`.

## Wiring

Copied from the schedule lane: `Caller::Pusher`, route `/mcp/git` checked
before the body read (`path_serves`), its own branch in `commands::root_mcp::
handle`, tools known only to `git_push_mcp` (the root registry never serves
the class; tests hold that). `root_mcp::lane` gives every class its lane, so
the schedule, push and help tokens coexist on one tab and a respawn replaces
only its own. Spawn: `apply_git_push_to_spawn` after the schedule wiring,
Claude `--mcp-config`, Codex `-c mcp_servers.eldrun-git…`, tool-tagged Vibe
merged into `VIBE_MCP_SERVERS`, other CLIs the inert `ELDRUN_GIT_MCP_TOKEN` /
`_URL` pair. `SpawnTokenGuard`, the PTY exit path, `tmux_local::SECRET_ENV` and
`sandbox::is_secret_exec_env` know the new variable. Sessions appear in MCP
session access with Revoke (which drops the session's proposals). State
changes ring `git-push-mcp-changed` through a change hook the command layer
installs, so the service stays `AppHandle`-free.

Frontend (`components/agents/GitPushMcp.tsx`): switch + per-project level and
protected list in Manage CLIs, pill-menu level (apply asks first), the card in
the git bar (`ProjectFilesView`) and the Agents view. Everything carries the
`gitPushMcp` untested id.

## Known limits

- **The token is inherited** by every process in the tab, as with schedule
  and root (`docs/context/root_console.md`). Hence propose by default and
  fixed rules even at apply.
- **The preflight can lie**: it runs agent-writable code with the agent's own
  authority, so a hook's privacy scan is only as strong as the fence. Inside
  the fence `$HOME` is empty, so this repo's per-user
  `~/.config/eldrun/privacy-denylist` is not seen there (the per-clone
  `.git/info/privacy-denylist` is). CI's privacy job is the backstop. What the
  lie cannot do is touch the token or the host.
- Hooks other than `pre-push` do not run for agent pushes. Global
  `insteadOf` rewrites are the user's own and apply as they do to the Push
  button.
- Out of v1: phone approval cards, remote/mirror projects, creating remote
  branches, other forges' token quirks, a typed outcome notice.

## User-run live QA

Only after choosing to load a build with the backend; agents never restart
the app.

1. Settings → Manage CLIs: turn on agent pushes. Set this project to Propose
   (pill menu or the row). Open a fresh fenced Claude tab.
2. Commit something trivial and ask the agent to push. The git bar shows a
   card asking to confirm the URL; its commit list should include the bump
   commit. Press "Confirm URL and push"; check GitHub, and that the agent's
   `git_push_status` reports `pushed`.
3. Ask it to push `main`: expect `branch_protected`. Ask for a force-push or
   a tag: the tool cannot express either.
4. Make `scripts/privacy-check.sh` exit 1: expect `preflight_failed` with its
   output on the card and in the tool result, nothing pushed. Restore it.
5. Set Apply: a push lands without a card (the URL is confirmed by now).
   Revoke the session in MCP session access: further calls fail, the tab
   stays open, its card disappears.
6. Repeat step 2 in Codex and in an unfenced tab.
