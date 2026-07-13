# Git Lockstep Hardening Plan (#28p)

> **Status: implemented 2026-07-13 — all eight defects (D1–D8) fixed**, plus three
> more (**D9–D11**) found in a follow-up data-loss-focused audit and fixed the same
> day. The design below is what shipped; deviations are noted inline as **[shipped]**.
> What is still owed is the **live-host QA** at the end of this document: D1, D3, and
> now D9/D11 are precisely the cases a unit test cannot fully prove, and the 🖐️ box on
> #28n was never ticked either. Until that runs, treat this as *code-complete, not
> verified*.

Follow-up to **#28n Phases 1–3** (`services/git_peer.rs`, `commands/git_peer.rs`).
Lockstep is code-complete and unit-tested but has never run against a live host.
Tracing the full local↔remote case matrix surfaced eight defects — two of them
data-loss or correctness class. This plan fixes all eight, in dependency order.
D9–D11 were surfaced later, once #28p D1–D8 already shipped, by re-reading the same
code specifically for remaining data-loss vectors — see each section below.

## Background: the invariant that generates the bugs

A remote project has **two real git repos** (the local mirror,
`remote_sync::mirror_dir`, and the host tree at `spec.remote_path`) joined by
**two transports that are blind to each other**:

| Transport | Moves | Sees |
|---|---|---|
| **Byte-sync** (`remote_sync` + `sync_auto`) | file *contents* over SFTP | everything except `.git`/`.eldrun` (`remote_sync.rs:388`, `:741`) |
| **Git lockstep** (`git_peer`) | *commits + refs* via `git bundle` over SFTP | only committed objects — untracked/uncommitted files are invisible |

Neither knows what the other owns. Every genuinely broken case below is these two
racing for the same file, or a probe failure being read as "the other side is
empty".

Two git behaviours, **verified experimentally** rather than assumed, decide most
outcomes:

1. `git merge --ff-only <sha>` **refuses** to overwrite an untracked working-tree
   file — *even when its content is byte-identical* to the incoming blob.
2. `git reset --hard <sha>` **silently clobbers** that same colliding untracked
   file.

That asymmetry is both the bug (1) and the recovery path (2).

---

## D1 — Byte-sync and git race for the same file *(correctness; blocking)*

**Problem.** `sync_auto::reconcile_pass` builds its candidate set from a raw
host+mirror walk that excludes only `.git`/`.eldrun`. It has no notion of
"git-tracked". So a file that lockstep is about to deliver as a *commit* may first
be shipped by byte-sync as *loose bytes*, landing on the peer **untracked** — and
then blocking the very fast-forward that would have delivered it properly
(behaviour 1 above). Status goes `Desynchronized` and the commit never crosses.

Which branch you land in is decided by a **debounce race**: auto-sync debounces
1500 ms (`sync_auto.rs:DEBOUNCE`), lockstep 800 ms (`git_peer.rs:GIT_DEBOUNCE`).
Commit within ~1.5 s of the last file write → clean fast-forward. Hesitate → wedged.
Nondeterminism is the worst property this could have.

Symmetric in both directions: local create → auto-push → local commit, and host
create → auto-pull → host commit.

**Fix (two layers — do both).**

1. *Primary — remove the race by construction.* When lockstep is enabled for a
   project, subtract the mirror's git-tracked set from the auto-sync candidate
   list. Lockstep owns the tracked tree; byte-sync owns everything else.
   - In `sync_auto::reconcile_pass`, after `candidates.retain(is_auto)`, drop any
     path in the tracked set.
   - Tracked set = `git ls-files -z` in the mirror (the exact call
     `git_peer::seed_manifest_after_pairing` already makes, `git_peer.rs:948`) —
     extract it into a shared `git_peer::tracked_paths(project_id) -> HashSet<String>`.
   - Gate on `git_peer::load_state(project_id).enabled` so a lockstep-off project
     keeps today's behaviour exactly.
   - Cache the set per pass (one local `git` invocation, no SSH).

2. *Safety net — recover the collisions that still happen* (files byte-synced
   before lockstep was ever enabled; see D-note below). When `merge --ff-only`
   fails in `transfer_and_apply` (`git_peer.rs:529`), parse the
   `error: The following untracked working tree files would be overwritten by merge:`
   list from stderr; for each listed path compare the incoming blob
   (`git cat-file blob <sha>:<path>`) against the on-disk bytes; if **identical**,
   delete the file and retry the merge once. If any differ, leave everything alone
   and fall through to today's `dirty_blocked` path.
   - Only ever deletes a file whose content is provably already in the incoming
     commit — nothing recoverable is destroyed.

**D-note.** Case #9 (lockstep *off*, byte-sync *on*) pre-seeds exactly this
collision: both sides hold the content, only one holds the history. Enabling
lockstep later walks straight into it. Layer 2 is what makes that first enable
succeed instead of immediately going red.

**[shipped]** Layer 1 is `git_peer::tracked_paths` + `sync_auto::drop_tracked` (a pure,
tested filter, gated on `load_state(project_id).enabled`). Layer 2 is
`git_peer::retry_ff_clearing_identical`: it parses the stderr, proves identity with
`git hash-object` vs `git rev-parse <sha>:<path>` **on the dest** (so nothing is read
over the wire), and is **all-or-nothing** — one differing file and nothing is deleted.
Deletion uses `git clean -f -x -- :(literal)<path>` so a path with glob metacharacters
can never widen into a pathspec that removes more than it names. Both behaviours are
pinned against a real repo, not a mocked stderr.

**Files.** `services/sync_auto.rs`, `services/git_peer.rs`.

**Tests.**
- Rust unit: `parse_untracked_overwrite_paths(stderr) -> Vec<String>` (pure).
- Rust unit: `tracked_paths` excludes `.git`, splits NUL, normalizes separators.
- Rust unit: candidate filtering drops tracked paths when lockstep is enabled and
  keeps them when it is off.
- Manual: create 10 files under an auto-sync-all root, wait >2 s (so byte-sync
  pushes), commit → host fast-forwards cleanly, status stays green.

~~**Until this ships:** never enable project-wide auto-sync-all together with
lockstep.~~ **[shipped]** — the combination is now safe by construction, so the caveat
is lifted and never needed to reach `CLAUDE.md`.

---

## D2 — The desync message lies *(clarity; trivial)*

**Problem.** A blocked fast-forward always renders as *"A peer has uncommitted
changes blocking a fast-forward"* (`git_peer.rs:851-855`), but the real cause is
usually **untracked** collisions (D1). The merge's stderr — which says exactly
what is wrong and names the files — is discarded at `git_peer.rs:529-533`. Users
go hunting for uncommitted changes that do not exist.

**Fix.** Widen `TransferResult.dirty_blocked: bool` to
`blocked: Option<String>` carrying the trimmed stderr of the failed merge (and
the branch name). Surface it in the `Desynchronized` detail. Keep the message
short enough for the desync bar's single line; the full text goes in the
`title=` tooltip, which `GitHistory.tsx:531` already renders.

**[shipped]** As planned, minus the separate tooltip: `detail` carries the composed
sentence (which *names the files*), so the bar text and the `title=` tooltip agree
rather than diverging. `TransferResult.dirty_blocked: bool` → `blocked: Option<String>`.

**Files.** `services/git_peer.rs`, `components/files/GitHistory.tsx` (no shape
change — `detail` is already `Option<String>`).

**Tests.** Rust unit on the detail string composed from a captured stderr sample.

---

## D3 — `init_pairing` can clobber host files *(data loss; blocking)*

**Problem.** The extend-local flow runs `git init` + `reset --hard <source HEAD>`
on the host (`git_peer.rs:726-751`). The pre-backup at `git_peer.rs:715-722` saves
**refs** — but a not-yet-a-repo host *has no refs*, which is precisely why we are
pairing. And `reset --hard` silently overwrites colliding **untracked** files
(behaviour 2 above). So if `remote_path` points at a directory that already holds
differing files, they are destroyed with no backup and no prompt.

Note the asymmetry: the *local* side has an explicit `probe_error` guard against
exactly this class of accident (`git_peer.rs:807-816`, "a transient local-git
failure must never license a wipe"). The *remote* side — the one reached over a
flaky network, i.e. the far more likely one to misprobe — has no equivalent.

**Fix.**
1. Before pairing into a non-repo dest, list the dest's existing files (the
   `remote_sync` walkers already do this, `.git`-excluded). Compute the set that
   **collides** with a path in the source's tracked tree **and differs in content**
   (size first, then hash the small residue over SFTP).
2. If that set is empty → pair as today (this is the intended
   "file-sync already mirrored them, adopt them as the tracked tree" path).
3. If non-empty → **refuse**. Return `Desynchronized` with a detail naming the
   conflicting files, and require an explicit confirmation (reuse the existing
   confirm-gated Use-local/Use-remote pattern in the desync bar rather than
   inventing new UI).
4. Independently, extend the `probe_error` refusal to be **symmetric**: refuse to
   auto-initialize *either* side when its probe errored, not just the local one.

**[shipped]** The check runs in `reconcile_with` *before* `init_pairing` (which keeps
`init_pairing` focused on the happy path), via `pairing_conflicts` → the pure
`pairing_collisions`. The dest's hashes come from `git hash-object`, which works
**outside a repo** — that is what lets it run on the not-yet-`init`ed dest without
reading file bytes over SFTP. Rather than overloading Use-local/Use-remote (meaningless
when nothing is paired yet), the refusal surfaces a typed `pairingConflict` on the state
and the bar offers exactly one action: `git_peer_pair_confirm`, behind a confirm that
lists the files. Symmetric probe-error refusal: `pairing_dest_probe_error`.

**Files.** `services/git_peer.rs` (`init_pairing`, `reconcile`),
`components/files/GitHistory.tsx` (a third confirm action).

**Tests.**
- Rust unit: pairing-collision detection (pure, over two path→(size,hash) maps).
- Rust unit: symmetric `probe_error` refusal truth table.
- Manual: extend a local project onto a host dir that already contains a differing
  `README.md` → refused with the filename named, host file untouched.

---

## D4 — Disconnected "Sync now" reports green *(correctness; small)*

**Problem.** A dropped SSH connection surfaces as `Ok(nonzero exit)`, not a spawn
error, so `probe` leaves `probe_error == false` (`git_peer.rs:341-344`, and its own
comment says so). The host therefore reads as a *clean, legitimately empty side*.
`reconcile` then takes the "exactly one side is a repo" branch and attempts
`init_pairing` **into the host** — every remote git command fails, `init_pairing`
returns `Err`, and the final status computes to **`Synchronized`** via the
`!final_remote.is_repo` arm (`git_peer.rs:842-845`). Green pill, nothing done.

Nothing is written (all the SSH commands fail), so this is not destructive — but
the signal is actively wrong, and it is the same misread that would route a
*connected-but-misprobing* host into a doomed pairing.

**Fix.** Gate `reconcile` (and `detect_and_sync`) on connectivity up front:
`crate::services::remote::pooled_sftp(pool, project_id).await.is_none()` →
return a state carrying today's persisted heads with a new
`status: Disconnected` (or `Desynchronized` + detail `"Not connected"`, if adding
a variant is not worth the schema churn — decide at implementation time; the
frontend pill already handles three states and would need a fourth colour).

This subsumes half of D3's risk: no pool, no pairing.

**[shipped]** Took the `SyncStatus::Disconnected` variant (the fourth pill colour) over
the `Desynchronized` + detail hack — a disconnected project is not desynchronized, and
conflating them would have offered destructive resolve actions against a host nobody can
see. The gate (`connected()`) is applied to **every** entry point that writes or claims:
`reconcile`, `detect_and_sync`, `checkout_lockstep`, `resolve`, `restore_backup`.

**Files.** `services/git_peer.rs`, `commands/git_peer.rs`,
`components/files/GitHistory.tsx` (pill state), `src/__tests__/GitLockstep.test.tsx`.

**Tests.** Frontend: pill renders the disconnected state and Sync-now is disabled.
Rust: `reconcile` early-returns without touching either peer when the pool is cold.

---

## D5 — SSH chattiness *(performance)*

**Problem.** Every reconcile pass costs, over the network:
- `probe(remote)` = **6** separate `run_git_remote` round trips (`rev-parse
  --is-inside-work-tree`, `symbolic-ref`, `rev-parse HEAD`, `for-each-ref` ×2,
  `status --porcelain`), each its own SSH exec;
- `is_ancestor` = **2 more per branch, per direction** (`git_peer.rs:501-502`),
  run on the *dest* peer;
- and `reconcile` runs **both** directions.

A 20-branch repo is ≈80 SSH round trips **every 12 s** (`GIT_POLL_INTERVAL`), plus
a full pass on **every `git add`** — case #4: the index write trips the `.git`
watcher, `detect_and_sync` runs, HEAD hasn't moved, and the bundle create errors on
an empty range for nothing. On a high-latency link this will feel broken.

**Fix.**
1. **Batch the probe** into a single `run_git_remote` of one `sh -c` script emitting
   a delimited block (`\x1e`-separated sections), parsed by a new pure
   `parse_probe_block(stdout) -> PeerSnapshot`. 6 round trips → 1.
2. **Batch ancestry.** After the bundle fetch the dest holds every object, so all
   `merge-base --is-ancestor` checks can run in one scripted invocation emitting
   `<branch> <fwd> <back>` per line → one round trip per direction instead of 2·N.
3. **Early-out.** Persist the last-seen ref *sets* (not just HEAD) in
   `GitPeerState`; if neither side's refs moved since the previous pass, skip the
   bundle/transfer entirely and re-emit the cached status. This alone kills the
   `git add` storm.

Keep the existing per-command `Peer::run` path as the fallback when the batched
script fails (a host without a POSIX `sh` — Windows hosts are out of scope for
remote projects today, but do not hard-depend on it).

**[shipped]** All three parts. The helper was needed: `ssh_exec::run_remote_script`
(`cd <quoted path> && { <script> }`), documented as embedding its script *verbatim* —
so callers must pass a constant (`PROBE_SCRIPT`) or interpolate only values proven inert
(`ancestry_script` takes hex object names only, guarded by `is_hex_sha`). The early-out
is narrower than "refs didn't move": it fires **only when the last pass was green**, so a
manual Retry after the user clears a blocker that moved no ref (deleting an untracked
collision) is never answered from cache; `ReconcileOpts::forced` bypasses it outright.
The ref signature includes `dirty_tracked`, since a dirty→clean transition can unblock a
fast-forward and must not be invisible. Both scripts are tested through a real `sh` and
asserted to agree with the per-command path — a syntax error would otherwise make the
batching fall back silently, leaving D5 "done" and doing nothing.

**Files.** `services/git_peer.rs`, `services/ssh_exec.rs` (`run_remote_script`).

**Tests.** Rust unit: `parse_probe_block` round-trips a synthesized block, tolerates
missing sections (unborn HEAD, no tags); early-out predicate truth table.

---

## D6 — Backup refs are write-only *(ops)*

**Problem.** `refs/eldrun/backup/<ts>/*` accrues on every `resolve` and every
`init_pairing`, pinning objects forever (the repo only grows), and there is **no UI
to list, restore from, or prune them**. The safety net exists but the user cannot
reach it — which also weakens D8's "it's recoverable" defence.

**Fix.**
- `git_peer_backups(project_id) -> Vec<BackupRef { ts, branch, sha, peer, subject }>`
  (`for-each-ref refs/eldrun/backup` on both peers).
- Surface in the lockstep bar behind a small "Backups (n)" affordance: list, and a
  per-entry **Restore** that force-moves the branch back (creating a *fresh* backup
  of the current tip first — restore must itself be undoable).
- Prune policy: keep the most recent N (default 20) per peer **and** anything newer
  than 30 days; drop the rest on each successful reconcile. Never prune the newest.

**[shipped]** As planned. Pruning is driven from where backups are *born* (`resolve`,
`restore_backup`) rather than from every successful reconcile — same effect on growth,
zero cost on the hot path (which creates no backups at all).

**Files.** `services/git_peer.rs`, `commands/git_peer.rs`, `GitHistory.tsx`.

**Tests.** Rust unit: backup-ref name parse (round-trips `backup_ref_name`), prune
selection (keeps newest N + recent, never empties). Frontend: list renders, restore
routes to the command.

---

## D7 — The paired mirror has no `origin` *(usability)*

**Problem.** `init_pairing` creates the mirror with `git init` + a bundle
(`git_peer.rs:726`), so **no remote is configured**. A `git push` from a local agent
tab in the mirror fails. Bundles deliberately never carry `config`/`remotes`
(correctly — they are machine-specific), so nothing sets it.

This may be intentional: the Git panel pushes *from the host* with the host's
credentials (`commands/git.rs:15-20`). But the mirror is where local agents work,
and "push from here" silently not existing is a bad surprise.

**Fix.** After a successful pairing, read the source peer's `remote.origin.url`; if
it exists and the dest has none, set it on the dest (`git remote add origin <url>`).
URL only — never credentials, never other config keys. If the host's origin is an
SSH URL the mirror may not be able to authenticate to, that is the user's existing
git setup and not ours to paper over; a failing push is then a normal git error with
a normal git fix.

**[shipped]** As planned (`should_propagate_origin`, URL only, never over an existing
origin).

**Files.** `services/git_peer.rs` (`init_pairing` tail).

**Tests.** Rust unit: origin propagation is skipped when the dest already has one.
Manual: pair, then `git push` from a local agent tab in the mirror.

---

## D8 — Divergence offers authority, not merge *(feature gap)*

**Problem.** On a genuine two-sided divergence (case #10) the entire menu is **Use
local** / **Use remote** — pick a winner, the loser's tip goes to a backup ref you
cannot browse (D6) and its commits leave the working tree. There is no merge, no
rebase, and no way to just *look* at the two histories side by side.

**Fix (deliberately minimal — do not build a merge UI).**
1. Add a third desync action: **Resolve in terminal** — opens a local shell tab in
   the mirror, on the diverged branch, with the peer's tip already fetched into a
   local ref (`refs/eldrun/peer/<branch>`, created by the reconcile that detected the
   divergence — the objects are already there from the bundle, so this is free).
   The user then merges/rebases with plain git, and the next `.git`-watcher pass
   picks up the result and fast-forwards the host normally.
2. Show both heads' short sha + subject in the desync bar so the choice is informed.

This turns an unrecoverable-feeling dead end into "git, as usual" without Eldrun
having to own conflict resolution.

**[shipped]** The peer ref lives in its own namespace (`refs/eldrun/peer/*`), so
`cleanup_incoming` — which only ever touched `refs/eldrun/incoming/*` — needed no change;
instead `peer_ref_op` sets the ref on a diverged branch and **clears** it on any other
outcome, so it never outlives the divergence it documents. `tabs.ts` needed no change
either: the existing `addTab({kind: "shell", location: "local"})` already spawns a local
shell, and `git_peer_mirror_dir` supplies the cwd.

**Files.** `services/git_peer.rs`, `commands/git_peer.rs`, `GitHistory.tsx`.

**Tests.** Rust unit: diverged branches retain `refs/eldrun/peer/*` while in-sync
ones are still cleaned. Frontend: the action spawns a local tab in the mirror.

---

## D9 — `resolve`/`restore_backup` can clobber untracked files, with no D3-style guard *(data loss; blocking)*

**Problem.** `force_reset_branch` (called by `resolve_inner` for Use-local/Use-remote,
and by `restore_backup`) runs `git reset --hard <sha>` on the dest's checked-out
branch. This is *exactly* behaviour 2 from the top of this file — `reset --hard`
silently clobbers a colliding untracked file — and it is exactly what `init_pairing`
was hardened against in D3. But `force_reset_branch` has no equivalent check: it
backs up the branch *ref* to `refs/eldrun/backup/*` and then resets, with nothing
proving the working tree is safe to overwrite.

The gap is real because a backup ref only saves **committed** history. An untracked
file was never a git object, so there is nothing to restore it from once `reset
--hard` overwrites it.

**Concrete scenario.** Lockstep + byte-sync enabled, local and host diverge. The
user clicks "Use remote." If the local mirror has an untracked file at a path the
winning remote history tracks (build output, a local-only config, or a file
byte-synced there before ever being committed), `reset --hard` overwrites it with
zero backup and zero warning. The confirm dialog (`GitHistory.tsx`) actively
undersells the risk here: it says the loser's commits are "backed up... first,"
which reads as "nothing is lost" — true for commits, false for untracked files. The
pairing-conflict dialog gets this right ("NOT in git — they will be lost"); the
resolve dialog doesn't carry the equivalent warning because the backend never
detects the collision in the first place.

**Fix.** Mirror D3: before any `force_reset_branch` call that would move a checked-
out branch, compute the untracked files on the dest that collide with (and differ
from) what the target sha's tree holds. If any exist, refuse the whole
resolve/restore and name them — the same "blocked, user clears it, retries" UX
`blocked_detail` (D1/D2) already established, rather than a new confirm-override
flow.

**[shipped]** `reset_collisions(source_peer, dest_peer, target_sha)` — `ls-tree -r -l
-z` on the source for the target tree, `ls-files --others -z` on the dest for its
untracked set, `hash_objects` (already used by `pairing_conflicts`) to prove content
identity. An unprovable hash counts as a difference, the same conservative default as
`pairing_collisions`. Wired into `resolve_inner` (checked against the *losing* side's
checked-out branch before `transfer_and_apply(force: true)` runs) and into
`restore_backup` (checked before `force_reset_branch` whenever the branch being
restored is the peer's HEAD) — both return `Err` naming the paths instead of
proceeding, and `restore_backup` resumes auto-sync first so a refusal never leaves it
paused.

**Files.** `services/git_peer.rs` (`reset_collisions`, `resolve_inner`,
`restore_backup`).

**Tests.** Rust unit: `reset_collisions` against two real local repos — an
identical-content collision pairs clean, a differing one is named, an unrelated
untracked file is ignored. Manual: diverge, drop a colliding untracked file on the
losing side, click Use-{local,remote} → refused with the filename named, file
intact.

---

## D10 — Stale-residue deletion trusted a stat heuristic instead of content *(data loss; narrow)*

**Problem.** `retry_ff_clearing_identical`'s two grounds for deleting a colliding
untracked file before retrying a blocked fast-forward are (a) `blob_matches_worktree`
— real content equality via `git hash-object` vs the incoming blob — and (b)
`stale_byte_sync_residue`, which instead relied on `remote_sync::divergence`: a pure
size+mtime comparison against the sync manifest's recorded base, with **no content
hash anywhere in `SyncEntry`**. Ground (a) is a proof; ground (b) was a heuristic
wearing a proof's clothes, and the caller **deletes the file** on either ground with
the same confidence.

If size and mtime happen to coincide with the manifest's stale base while the actual
bytes differ (clock skew, a tool that preserves mtimes on copy, or plain bad luck),
`stale_byte_sync_residue` reports the path safe and `retry_ff_clearing_identical`
deletes real, never-committed work via `git clean -f -x`, with no backup — untracked
content has none.

**Fix.** Replace the stat comparison with a content-based proof that needs no schema
change: the bundle fetch (step 3 of `transfer_and_apply`) has already deposited every
object the incoming commit needs into the dest's own object store by the time the
residue check runs. So "the file's current bytes are already a git object the dest's
store knows about" (`git hash-object` to name it, `git cat-file -e` to check
existence) proves the content is *some* prior git-known state — either history the
peer already had, or an object the fetch just brought in — never content nothing has
ever recorded. That is exactly the distinction that matters: real independent work
was never a git object anywhere, so it can never pass this check by accident.

**[shipped]** `stale_byte_sync_residue` keeps its manifest gate (only a path
byte-sync has ever touched is even considered, preserving the D1/case-#12 framing —
scope, not the safety proof) but the actual verdict is now `object_already_known`
(`hash-object` + `cat-file -e` on the dest peer, no SFTP, no manifest stat fields
needed). Dropped the now-unused `pool`/`spec`/`to_remote` params — the check runs
entirely through `Peer::run`, local or remote alike.

**Files.** `services/git_peer.rs` (`stale_byte_sync_residue`, `object_already_known`).

**Tests.** Rust unit (real repo): content matching a git-known blob (an old commit,
or an object the incoming fetch deposited) is recognized as safe residue; content
that has never been part of any commit or fetch is refused even with a matching
manifest entry; a path outside the manifest is refused regardless of content.

---

## D11 — A genuine bundle-create failure still fell through to ref application *(correctness / potential corruption)*

**Problem.** `transfer_and_apply` creates the bundle, then — regardless of whether
that succeeded — always runs step 4 (apply safe ref updates per branch). The
`if out.status.success()` guard only gates steps 2–3 (move + fetch). The reasoning in
the existing comment is sound for exactly one failure mode: git's "Refusing to
create empty bundle" refusal, which means the dest already has every object and step
4 must still run (this is bug #4 from the original #28n live QA). But it does not
distinguish that from a **genuine** creation failure — disk full, a bad path,
permission denied — where no objects moved anywhere. In that case step 4 still runs
using the pre-transfer snapshots and, e.g., blindly `update-ref`s a new branch onto a
sha the dest never received: a dangling ref pointing at a missing object, reported as
`applied`, which can compute the whole pass to `Synchronized`. Same "false green"
shape as the four bugs D1–D8 already fixed, reintroduced by the fix for #4 going one
conditional too far in the safe direction.

**Fix.** Distinguish the two failure shapes by parsing git's own message: only the
empty-bundle refusal may still let step 4 proceed. Any other failure aborts the whole
direction before step 4 ever runs.

**[shipped]** `is_empty_bundle_error(stderr)` (pure — matches git's literal "Refusing
to create empty bundle" text). On any other bundle-create failure, `transfer_and_apply`
returns `Err` immediately, before step 4. Every caller already handles `Err` correctly
(`reconcile_with` surfaces it as `blocked`/`Desynchronized`, per the bug-#2 fix;
`resolve_inner` propagates it via `?`; `init_pairing` already discarded errors from
this call and continues to, so its behaviour on a genuine failure only gets safer —
zero refs applied instead of some applied against missing objects).

**Files.** `services/git_peer.rs` (`transfer_and_apply`, `is_empty_bundle_error`).

**Tests.** Rust unit: `is_empty_bundle_error` recognizes git's exact refusal text and
rejects an unrelated failure message (e.g. "No space left on device"). Full
end-to-end proof that a real creation failure aborts the whole direction needs a live
remote (same caveat as D1/D3's live-only cases) — exercise via `lockstep_drv.rs` when
next on a live host.

---

## Phasing

**Phase 1 — trust (blocking; nothing else matters until these land).**
D1 → D3 → D4 → D2. D1 and D3 are the two defects that can lose or wedge real work;
D4 removes the misread that feeds D3; D2 is a one-liner that makes D1's residual
failures self-explanatory. Ship together.

**Phase 2 — viability on a real link.**
D5, then D6. D5 is what determines whether this is usable over a WAN at all; D6
makes the existing safety net reachable.

**Phase 3 — polish.**
D7, D8.

## Gates

`cargo test --manifest-path src-tauri/Cargo.toml`, `npx tsc --noEmit`, `vitest`.
Every item above lands with its unit tests in the same commit.

Phase 1 additionally requires **live-host manual QA** — the 🖐️ box on #28n is still
unticked, and D1/D3 are precisely the cases a unit test cannot prove. The minimum
live matrix:

| # | Check |
|---|---|
| 1 | auto-sync-all + lockstep, create 10 files, wait 3 s, commit → host fast-forwards, green |
| 2 | same but commit immediately → still green (no regression on the fast path) |
| 3 | pre-existing byte-synced tracked files, *then* enable lockstep → first reconcile succeeds |
| 4 | extend local onto a host dir holding a differing `README.md` → refused, host file intact |
| 5 | disconnect → Sync now → reports disconnected, not green |
| 6 | commit on both sides → diverged → Use local → host resets, backup ref present and listable |
| 7 | diverge, drop a *differing* untracked file at a path the winner tracks on the losing side, Use-{local,remote} → refused, filename named, file untouched (D9) |
| 8 | same as #7 but the untracked file is byte-identical → resolve proceeds, no refusal |
| 9 | force a genuine bundle-create failure (e.g. a full disk on the source) → Desynchronized with the real error, no dangling ref on the dest (D11) |
