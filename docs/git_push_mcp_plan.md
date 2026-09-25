# Agent git push MCP — plan

*Planned 2026-09-25; built the same day. What shipped, and where it differs
from this plan, is in `docs/context/git_push_mcp.md` — read that first.*

The request: **let a fenced agent push the project it is working in**, without
putting a credential inside the fence.

Today a fenced agent tab can commit but cannot push. The fence hides `gh`'s
login and the OS keyring, and the project's access token lives only in the
keyring (`services::git_credentials`). Only Eldrun's own Push button reads it.
Exposing the token to the fence (a bind mount or an opt-in like
`agent_fence_cargo_credentials`) is rejected. Anything the agent can read, a
prompt injection can read and send out, and a classic `ghp_` token usually
reaches every repository the user owns.

The shape instead: a separate MCP lane, `eldrun-git`, with one write tool. The
agent *asks* Eldrun to push. Eldrun pushes from outside the fence with the
keyring token, under rules set in the trusted `projects.json` entry. The token
never enters the tab, and nothing in the project folder decides where it goes.

This follows `docs/agent_schedule_mcp_plan.md` closely (own caller class, own
route, per-project level, staged proposals). Where this plan is silent, do what
that one did.

---

## 1. The shape

```
agent CLI in a local project tab (fenced or not)
   │  streamable HTTP MCP, Bearer ${ELDRUN_GIT_MCP_TOKEN}
   ▼
root_mcp listener ── POST /mcp/git ── Caller::Pusher only
   │  token → (project id, tab id, project dir), bound at spawn
   ▼
services::git_push_mcp (AppHandle-free): admit → policy → plan the push
   │
   ├─ 1. preflight: the repo's pre-push hook, run INSIDE the tab's fence,
   │                no token, ELDRUN_PUSH_PREFLIGHT=1
   └─ 2. transport: hardened hooks-off `git push` on the host,
                    token through the scoped inline helper, explicit refspec
```

## 2. The hook problem (the reason this isn't just "call `git_push`")

`commands::git::git_push` runs the repo's hooks **live, on the host, with
`ELDRUN_GIT_TOKEN` in the environment**, after `exec_trust` approved the hook
files. `exec_trust` fingerprints the hook files. It does not fingerprint what
they run, and `services/exec_trust.rs` states that as a residual.

That residual is fine for a user-initiated push. It is a fence escape when the
agent can trigger the push. This repo shows how: `.githooks/pre-push` runs
`scripts/privacy-check.sh` and `scripts/bump-version.sh`. Both are tracked
files, writable from inside the fence, and neither is fingerprinted. An agent
edits one and calls the tool, and its code runs unfenced with the token in
`env`.

So the rule for this tool: **no project code ever runs on the host during an
agent-requested push, and no process that runs project code ever holds the
token.** That splits the push into two phases:

1. **Preflight, fenced, no token.** Eldrun runs the resolved `pre-push` hook
   with the same bwrap profile the tab was spawned with. It uses the
   `wrap_pty_options_bwrap` inputs, extracted into a one-shot
   `Command` builder, rather than a second policy. The hook gets git's normal
   arguments (`<remote> <url>`) and stdin line (`<local-ref> <local-sha>
   <remote-ref> <remote-sha>`), plus `ELDRUN_PUSH_PREFLIGHT=1`. There is no token
   and no `ELDRUN_GIT_TOKEN`. Exit ≠ 0 refuses the push, and the hook's output
   (capped) goes back to the agent.
   The preflight runs with the agent's own authority, so it needs no
   `exec_trust` approval. An unfenced tab's preflight runs unfenced, which is
   still the agent's own authority, and still without the token.
2. **Transport, host, hooks off.** Eldrun re-resolves the branch. The hook may
   have added commits, such as this repo's version bump. It then runs
   `hardened_git_command_in` (hooks off: `core.hooksPath=`, so
   `reference-transaction` and friends are off too) with
   `scoped_token_config(token_origins(project))`, `GIT_TERMINAL_PROMPT=0`,
   `--no-verify`, and an explicit refspec. No repo hook runs.

A hook that pushes by itself (this repo's re-push trick) would fail in the
preflight, because it has no credentials. **`.githooks/pre-push` gets a
preflight branch.** Under `ELDRUN_PUSH_PREFLIGHT=1` it does the privacy scan
and the bump commit, then exits 0 instead of re-pushing and aborting.
Eldrun's transport then carries the bump. Without the variable it behaves
exactly as today. `gh secret list` inside the fence has no login and stays
silent, which is already its no-`gh` path.

A hook that doesn't know the variable just runs its checks, which is what
`pre-push` is for. Other hooks (`reference-transaction`, `post-*`) do not run
for agent pushes at all. That is stated in the tool description.

## 3. Tools

Strict arguments, and every schema field has a description, as in
`schedule_mcp`. There are no remote, URL, refspec or force selectors.

| tool | does |
|---|---|
| `git_push_status` | Read-only. Current branch, its upstream, ahead/behind, the project's level, which branches the policy allows, and this tab's proposals with their outcome (§3a). |
| `git_push` | `{ branch?: string, note?: string }`. The branch defaults to the checked-out one and must be the checked-out one in v1. The note is at most 200 characters, shown on the approval card, with invisible characters stripped. |
| `git_push_cancel` | `{ id }`. Withdraws this tab's own pending proposal. |

`git_push` returns one of the following:

- `pushed` with the old and new remote SHAs, the commit list, and capped
  output.
- `staged` with an `id`, when the level is propose. The agent polls
  `git_push_status`.
- `refused` / `failed`: see §3a.

### 3a. What the agent hears back when it goes wrong

Every failure is a normal tool *result*, not a transport error, so the agent
can read it and act. Each result carries four things:

- **`category`**: a fixed enum the agent can branch on. The categories are
  `level_off`, `branch_protected`, `not_checked_out`, `no_upstream`,
  `remote_branch_missing`, `diverged` (the remote moved: pull/rebase first),
  `nothing_to_push`, `preflight_failed`, `preflight_timeout`,
  `url_unconfirmed`, `stale_approval`, `dismissed`, `expired`,
  `rate_limited` (with `retryAfterSecs`), `auth_failed` (the stored token was
  rejected or has no access), `network`, `remote_rejected` (server-side hook
  or branch protection), `fence_unavailable`, `not_local`.
- **`message`**: one plain sentence saying what happened and what the agent
  can do next. The user has to act on `auth_failed`, `url_unconfirmed` and
  `level_off`, so for those the sentence names the setting or button, e.g.
  "Ask the user to check the token in Settings → Git Hosting".
- **`output`**: what actually ran. For `preflight_failed` that's the hook's
  stdout and stderr, so the privacy-check matches reach the agent and it can
  fix them. For transport failures it's git's stderr, including `remote:`
  lines. The last 8 KB are kept. Invisible controls are stripped, and anything
  that looks like a token (`ghp_…`, `github_pat_…`, `glpat-…`, and the
  effective token itself) is replaced with `[redacted]`.
- **`state`**: local and remote SHAs and ahead/behind, so the agent doesn't
  need a second call to see where things stand.

A proposal that fails *after* the user presses Push (auth, a remote that moved
in between, a rejected hook) can't answer the original call, which already
returned `staged`. So the outcome is stored on the proposal. `git_push_status`
reports each of this tab's proposals as `pending` / `pushed` / `failed` /
`dismissed` / `expired`, with the same four fields. The result is also typed
into the tab once, as an Eldrun notice line (the same path schedule
deliveries use, gated on the agent being idle). That way the agent learns the
outcome without polling. If the tab is mid-turn, the notice waits for the next
idle.

The audit ring still keeps only the category and SHAs. Output goes to the
agent and the card, never into the audit ring.

## 4. What may be pushed

These rules are decided on the host, from git state read through the hardened
command and from `projects.json`. Nothing comes from the in-folder
`project.json`.

- **One branch, fast-forward only.** The refspec is
  `refs/heads/B:refs/heads/B`. There is no `+`, no `--force*`, and no
  `--tags`. **No tags at all**: a `v*` tag cuts a release in this repo. There
  are no deletes. A non-fast-forward is refused as `diverged` rather than
  retried.
- **The remote branch must already exist** in v1, so no new branches get
  published.
- **Protected branches are never pushed.** These are the remote's default
  branch (`refs/remotes/<r>/HEAD`, falling back to `main`/`master`) plus the
  project's `git_push_mcp.protected` list. For this repo, `develop` is
  pushable and `main` never is.
- **The URL is pinned.** The destination is the upstream remote's `url` as the
  hardened git reads it, passed explicitly so that `pushurl`/`insteadOf` rewrites
  play no part. The first push to a URL needs the user's confirmation, even at
  the apply level. The confirmed URL is stored in the project's
  `projects.json` entry. A later URL change asks again. The token stays scoped
  to `token_origins`, as today.
- **Local projects only.** Remote, worker, VM and container tabs get no token.
  Their loopback isn't Eldrun's, and a remote project's push runs on the mirror
  or the host with different credentials. This mirrors schedule and help.

## 5. Levels and approval

The global switch is `Settings::git_push_mcp` (absent = off), set under
Settings → Manage CLIs. When it is on, new local project-agent spawns are
wired. The per-project level lives in the trusted `projects.json` entry and in
the project pill menu:

- **off** (default): the tool exists, and every write returns `level_off`, so
  the agent can tell the user where to turn it on.
- **propose**: the preflight runs immediately, so the card shows the *final*
  commit list, including a bump. A card then appears in the Agents view and the
  git bar, showing branch, URL, commit list, diffstat and note, with
  Push / Dismiss buttons. **Approval binds the post-preflight SHA.** If the
  branch moved before Push, the approval is stale and it asks again. Unapproved
  proposals expire after 24 hours.
- **apply**: it pushes immediately, still within §4. An unconfirmed URL still
  stages.

Budget: six pushes per tab per rolling hour and at most two pending proposals
per tab. `admit` takes the slot before any git runs, so a malformed or
over-budget call costs nothing. Audit rows keep the session, branch, SHAs and
a fixed category. They never keep the note or hook output.

## 6. Wiring

Copy the schedule lane:

- `Caller::Pusher`, route `/mcp/git`, dispatched before the body read like
  `/mcp/schedule`. The tools are registered for that class only in
  `root_mcp_security`.
- The token binds project id, tab id, and the canonical project dir at spawn.
  Close, exit, failed spawn and revocation invalidate it. It shows up in MCP
  session access with Revoke.
- Claude gets `--mcp-config`, Codex gets `-c mcp_servers.eldrun-git…`,
  tool-tagged Vibe gets env, and other CLIs get only the inert URL/token env
  pair. tmux launcher scripts leave the secret out. Nothing is written to a
  project's or another app's config.
- Fenced tabs only need the loopback port, which they already reach for
  `eldrun-help`.

## 7. Files

Backend:
- `services/git_push_mcp.rs` (new, AppHandle-free): argument validation,
  `admit`, the policy (protected branches, URL pin, level), push planning
  (branch, upstream, refspec, fast-forward check against the fetched remote
  SHA), output capping and redaction, proposal store and RPC.
- `commands/git.rs`: split `push_local` into `push_transport(dir, url, refspec,
  token, origins)` (hooks off, `--no-verify`). `git_push` keeps its current
  hooks-live path. Also add `resolve_pre_push_hook(dir)`, using the same
  lookup `exec_trust` already does.
- `services/agent_fence.rs`: add `one_shot_command(scope, argv, cwd, env)`. It
  builds a `Command` from the same inputs as `wrap_pty_options_bwrap`, and fails
  closed like the rest of the fence.
- `services/root_mcp.rs` + `root_mcp_security.rs` + `commands/root_mcp.rs`:
  the caller class, route, registry, session list and revoke.
- `schema/settings.rs` (`git_push_mcp`) and `schema/projects.rs` (a
  `git_push_mcp` block holding `level`, `protected`, `confirmed_url`). Both are
  optional, and absent means off, so existing files round-trip.
- Spawn wiring in the same place that wires `eldrun-schedule`.

Frontend:
- Settings toggle, pill-menu level, pending-push card (Agents view + git bar),
  first-URL confirm. Everything goes through `useT()` and carries the
  `UntestedTag` id `gitPushMcp`, with a row in `src/lib/untested.ts`.

Repo:
- `.githooks/pre-push`: the `ELDRUN_PUSH_PREFLIGHT` branch.
- File-map rows. After building: `docs/context/git_push_mcp.md` and its entry
  in AGENTS.md's context list.

## 8. Tests

- Refspec builder: no `+`, no tags, no deletes. Protected-branch and
  default-branch detection. Refusal when the remote branch is missing.
- The transport argv has `core.hooksPath=`, `--no-verify`, the scoped helper,
  and the explicit URL. `pushurl`/`insteadOf` in `.git/config` don't change the
  destination (temp repo with a file:// "remote").
- Preflight: the hook gets git's args and stdin line, `ELDRUN_PUSH_PREFLIGHT=1`
  and no `ELDRUN_GIT_TOKEN`. Its commits are picked up. Exit 1 refuses. A hook
  that writes a marker file into `$HOME` outside the fence roots fails to
  (bwrap available, else skipped with a message).
- Approval stale on SHA change, expiry, per-tab budget, cancel of another tab's
  proposal refused, and a revoked token refused.
- `projects.json` without the block round-trips unchanged.
- `.githooks/pre-push` in preflight mode: it bumps, commits, exits 0, and makes
  no network call (bats-style shell test, or a vitest that runs it against a
  temp repo).

## 9. Known limits (stated, not hidden)

- **The MCP token is inherited.** Every process in the tab can call
  `/mcp/git` as the tab, the same as schedule's known limit. That's why propose
  is the default, and why apply still has §4's fixed rules.
- **The preflight can lie.** It runs agent-writable code, so a privacy check in
  a hook is only as strong as the fence around the agent. CI's privacy job
  stays the backstop. The difference from today is that the lie can't touch
  the token or the host.
- **An unfenced tab gains nothing risky and loses nothing.** It already has
  the user's authority. The tool only saves it from needing a login.
- **Hooks other than `pre-push` don't run** for agent pushes.

## 10. User-run live QA

Only after the user chooses to load a build with the backend. Agents never
restart the app.

1. Settings → Manage CLIs: turn on agent push. Set this project to Propose.
   Open a fresh fenced Claude tab.
2. Commit something trivial and ask the agent to push. Confirm the URL on first
   use. The card should list the commits plus the bump commit. Press Push, then
   check GitHub.
3. Ask it to push `main`: expect `branch_protected`. Ask it to force-push or push
   a tag: the tool has no way to express either.
4. Break `scripts/privacy-check.sh` so it exits 1: expect `preflight_failed`
   with its output, and nothing pushed.
5. Set the level to Apply: a push lands without a card. Revoke the session in MCP
   session access: further calls fail and the tab stays open.

Out of v1: phone approval cards (the obvious next step, next to the schedule
proposals on the phone), remote/mirror projects, creating new remote branches,
and other forges' token quirks.
