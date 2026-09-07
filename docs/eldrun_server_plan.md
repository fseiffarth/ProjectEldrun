# Eldrun Server — self-hosted projects, calendar and to-do for several people

*Plan only. Nothing here is implemented. Produced 2026-07-29 from four parallel
investigations — server architecture/ops, identity/auth/threat model,
calendar+board sync protocol, collaborative projects + UX — reconciled into one
design. Backlog: [`todo/group-z-server.md`](../todo/group-z-server.md) (#169–#199).*

The request: **Eldrun should be able to set up a server (e.g. a Raspberry Pi)
holding projects, the calendar and the to-do board, so that several people with
correct authentication can connect to it for calendar/to-do sync and for
collaborative work on projects.**

---

## 1. The recommendation, in one page

**Do not build a server. Provision one, and reach it over SSH.**

The Eldrun server is a Linux box running exactly two daemons — `sshd` (already
there) and **Radicale** (a small CalDAV server, packaged in Raspberry Pi OS) —
plus a directory of **bare git repositories** and a small **forced-command RPC**
for the pieces CalDAV and git cannot carry. There is **no listening Eldrun
daemon and no ARM64 build of anything we ship**.

Four decisions carry the design:

1. **The transport is SSH, not HTTP.** Every call is a command over the pooled
   ControlMaster Eldrun already maintains. This buys authentication, transport
   security, a first-contact fingerprint gate that already exists
   (`services/ssh_common.rs:1575` `guard_first_contact` + `HostKeyConfirmDialog`),
   and — decisively — it means **no TLS, no PKI, no certificates on a home LAN**.
   That matters because this codebase has a standing "no cert-ignore hatch"
   precedent (`docs/context/caldav.md`), and a self-signed-certificate checkbox
   would be the first breach of it.

2. **Identity is a per-person, per-device Ed25519 key.** The server's
   `authorized_keys` is generated from a person/device table. A device key is a
   *file*, so **nothing on the unattended sync path ever touches the OS
   keychain** — the locked-Secret-Service failure class that
   `remote_credentials::read_timed`'s 4-second bound exists to soften
   (`services/remote_credentials.rs:218`) simply cannot arise. Enrolment is a
   single-use invite code that **carries the server's host-key fingerprint**, so
   a new person's first contact is a *pinned* key rather than TOFU — strictly
   stronger than what the app does today.

3. **Calendar and to-do sync is CalDAV plus a native board overlay.** CalDAV
   because the client is **already written, including push**: `caldav_push`,
   `caldav_delete`, `caldav_resource_etag`, `caldav_refresh_access`
   (`commands/caldav.rs:557-709`), `put_resource`/`delete_resource`
   (`services/caldav.rs:1291,1362`), `CalDavAccount::allow_write`
   (`schema/caldav.rs:119`) — **all present in the working tree and absent from
   HEAD** (verified: `git show HEAD:src-tauri/src/commands/caldav.rs | grep -c
   caldav_push` → 0). An Eldrun server that speaks CalDAV *is* a CalDAV account,
   so it composes with the existing feature for free. The overlay exists because
   CalDAV cannot represent the board — `column`/`rank`/`tags`/`subtasks`/
   `project_id`/`mail`/`event`/`created` (`schema/calendar.rs:400-457`) — and
   smuggling those into `X-` properties would destroy the invariant the whole
   CalDAV feature rests on.

4. **Collaborative projects means a shared *registry* plus a shared *bare git
   remote* — never a shared working tree.** Eldrun's sync engine is a two-tree
   lockstep between one mirror and one host working tree, and its correctness
   arguments assume **one human**. A bare repo removes the entire failure class
   by removing the thing that breaks: no working tree means nothing to check out
   into, nothing to `reset --hard` over, nothing to deadlock on.

**The honest summary: this is roughly 70% configuration and UX over machinery
that already exists.** The genuinely novel code is a provisioning script, a
catalog, a board-overlay op log, and one settings panel.

**And one thing stated up front, because it changes the shape of the backlog:**
calendar/to-do sharing and *read-only* project sharing are shippable on this
design. **Writable project sharing is not, and should not ship** until the three
gates in §9 are closed — the sharpest being that `.git/hooks/*` is executable
intent that Group O #151 deliberately left residual on the reasoning that "a
repo's own hooks are a feature". **That reasoning inverts under multi-user**: a
collaborator's hook fires on *your* machine on *your* next commit.

---

## 2. What already exists and is reusable

This table is the reason the plan is small. Every row is verified.

| Capability | Where | What it gives free |
|---|---|---|
| **Bidirectional CalDAV client, incl. push** | `services/caldav.rs:847,1096,1150,1260,1291,1362`; `commands/caldav.rs:351,394,453,557,626` | Discovery, RFC 6578 incremental sync, ETag-conditional writes, per-collection `read_only` read from the server's own `current-user-privilege-set`. **The entire calendar transport.** |
| **Multi-writer merge, already correct** | `commands/calendar.rs:532` `merge_caldav_calendar_at` | Merges by `caldav_href`, preserves each user's `column`/`rank`/`tags`/`subtasks`/`mail`/`event`/`project_id`, and gets all three deletion cases right. The hardest logic in the feature, written and tested. |
| `http://` explicitly permitted for self-hosted, **no cert-ignore hatch** | `services/caldav.rs:467-482` | A Pi behind an SSH forward works today, and there is no escape hatch to be tempted by. |
| Background CalDAV timer | `src/components/calendar/CalDavSyncHost.tsx` | Unattended sync, ctag-cheap, already mounted at the shell. |
| **Pooled ControlMaster + SFTP per host** | `services/remote.rs:40,70` | One authentication for every server interaction. |
| One-shot remote script execution | `services/ssh_exec.rs:701,273` | The RPC channel — the pattern `slurm.rs`/`hpc_ws.rs` already use. |
| **Host-key first-contact gate** | `services/ssh_common.rs:1575,1591`; `lib/hostKey.ts` | TOFU with the fingerprint actually shown, before any secret moves. |
| Credential policy, keychain, locked-keyring handling | `services/remote_credentials.rs:218,232,285,498,566` | Opt-in save (default off), `true \| null` never bare `false`, 4 s bound, unlock affordance. |
| **Machine registry with a shareable export format** | `commands/global_machines.rs:19-45` `MachineIo` | An export deliberately carrying host/port/label and **no id, no `auto_connect`, no `user`** — built for "share this host list with colleagues who each log in as themselves". **This is the invite mechanism**; add one optional flag. |
| Hardened clone + URL allowlist | `commands::git::validate_clone_url`, `git_clone_blocking` | Cloning from the server is the existing import path. |
| Clone/fork → land tree → register as project | `ProjectDialog.tsx`, `commands/git_fork.rs` | **The entire "join a shared project" provisioning path already exists.** |
| Duplicate-project gate | `commands/projects.rs` `find_project_conflict` / `check_project_site` | A double-join is refused *and* offers to open the existing project, before the clone downloads anything. |
| Publish + `git_type` | `commands/git_publish.rs:57-69`, `commands/git_hosting.rs` | GitHub **and GitLab** dispatch already shipped. Only Group P #79's *generic remote URL* bullet is open. |
| `PublishSite` / `describe_mirror_guard` | `commands/git_publish.rs` | Refuses publishing from a stale mirror — subsumes a class of "which side pushes" bugs. |
| **One-click install-in-a-tab** | `src/lib/installCommand.ts:69` `runInstallInTab` (policy `:40-57`) | The provisioning UX, verbatim. |
| Connect/browse state machine + terminal sign-in | `components/projects/useRemoteBrowse.ts`, `TerminalSignInToggle.tsx` | The wizard's login step, composed not rewritten. |
| **Status lamp vocabulary** | `components/common/ConnLamp.tsx:21`, `stores/remoteStatus.ts:10` | `off \| connecting \| connected \| error` with `busy` as an **orthogonal** axis. Reuse verbatim. |
| Aggregate-by-status, not one lamp per host | `components/header/RemoteConnMenu.tsx` | The lesson already learned: don't render a long row of near-identical dots. |
| Refcounted single-poll store | `stores/hostSessions.ts` | "Sessions are a property of the **host**, not of the surface looking at one" — the exact shape presence needs. |
| **Don't-touch-this-host tags** | `schema/settings.rs:330,353`; `services/hpc_mode.rs:165` | A Pi must not be swept by `du -ak`, GPU probes or lockstep loops. Tag on registration; the argv builders already refuse. |
| **Session state already out of the project tree** | `storage.rs:121-139`; tripwire `src-tauri/tests/project_tree_intent.rs` | The "what must not be shared" work is **done and test-enforced**. |
| `.eldrun/` + `project.json` gitignored by default | `commands/projects.rs:2053`, `:2158` | Per-user state already excluded from anything travelling by git. |
| Byte-sync skips `.eldrun`/`.git` | `services/remote_sync.rs:471` | Even the non-git transport refuses to carry Eldrun's control files. |
| Push-only, conflict-free fan-out | `services/worker_sync.rs` | Proof the hard half of lockstep is dodgeable by making a direction one-way. |
| Atomic JSON writes | `storage.rs:36` `write_json_atomic` | Reusable — **but see the fsync defect, §10.** |
| SQLite-store precedent | `services/mail_store.rs:1964` (WAL, `foreign_keys`, `temp_store=MEMORY`) | If a bespoke store is ever needed. (`commands/sqlite.rs:29` is only the read-only DB *viewer*, not a store.) |
| `UntestedTag` | `components/common/UntestedTag.tsx:13` | The standing obligation on every new surface. |
| One canonical dialog chrome | `styles/themes.css:11829`, `:11818` | No new dialog styling is needed or permitted. |

---

## 3. Architecture

### 3.1 What runs on the server

```
sshd                       # already there; the only listening port
radicale.service           # CalDAV, bound to 127.0.0.1:5232
eldrun-server-maint.timer  # backup + git gc
```

No Docker (adds a large runtime and an overlayfs write layer on an SD card to do
what two systemd units do natively; `docker/` in this repo is *per-project dev
containers* and unrelated). No Gitea in v1 (~100 MB Go binary, its own DB, its
own web auth realm — a second identity system). Gitea remains a legitimate later
swap precisely because it speaks the same `git@host:repo.git` URLs, so nothing
in Eldrun would change.

### 3.2 Why not the alternatives

| Option | Verdict |
|---|---|
| **New Rust `eldrun-server/` crate in the workspace** | **Deferred, not rejected.** The workspace root exists (`Cargo.toml:1-3`) and `schema/` is already **100% Tauri-free** (the only occurrence of `tauri` in the whole directory is a comment at `schema/settings.rs:431`), so the split is cheap *later*. It loses now: it reimplements CalDAV server-side when the client is done and Radicale exists; it introduces an ARM64 build/distribution/upgrade pipeline a v1 doesn't need; and a bespoke sync daemon is new attack surface on a port when SSH is already the authenticated transport. |
| **Desktop app in headless "server mode"** | **Rejected hard.** On Linux the crate unconditionally pulls `webkit2gtk`, `gtk`, `xcb`, `zbus`, `dbus-secret-service` (`Cargo.toml:225-243`) plus `arboard`/`tauri`/`wry`. A "headless" build still needs WebKitGTK + GTK3 + Secret Service to *link* on a Pi, and the keychain design assumes a user session's D-Bus. Also wrong-shaped: the desktop's `<state_dir>/sessions/` is read back as **executable intent**. |
| **Purpose-built HTTP+JSON API** | Rejected. Needs a listening port, TLS, PKI, tokens, rate limiting, and a client HTTP layer — and the codebase has **no server framework at all** (`axum\|hyper::Server\|warp\|actix\|tiny_http\|tungstenite` return nothing; `reqwest` is client-only). Every one of those is solved by SSH for free, with a credential the user already has. |
| **gRPC** | Same, plus a protoc/codegen toolchain against a deliberate "no C toolchain" posture (`Cargo.toml:134-138`). |
| **WebSocket** | No WebSocket exists anywhere in this codebase. (`commands/hpc_ws.rs` is HPC *workspaces* — `ws_allocate`/`ws_list` — not WebSockets.) |
| **Syncthing for projects** | Rejected. Byte-level sync of a tree containing `.git` is the exact failure `services/git_peer.rs:20-24` was built to avoid. Two people under Syncthing produce `.git` corruption and conflict-copy files, not merges. |
| **mTLS / OIDC / bearer tokens / password accounts** | All rejected — see §4.2. |
| **git as the board-overlay transport** | Tempting (auth + transport + history free). Rejected because git's conflict model is *human resolution of a divergence* — `Diverged` is never auto-applied (`docs/git_lockstep_case_matrix.md:47`). Two people dragging cards a second apart = a divergence per gesture. **Right transport, wrong semantics.** |

### 3.3 Transport, and the loopback forward

Radicale binds `127.0.0.1:5232`. Each client raises
`ssh -O forward -L 127.0.0.1:<local>:127.0.0.1:5232` against the ControlMaster it
already holds, and the CalDAV account points at `http://127.0.0.1:<local>/`.
`normalize_base_url` (`services/caldav.rs:467-482`) explicitly honours a typed
`http://` for exactly this case.

Result: **one credential (SSH) for everything, no TLS, no PKI, and the Pi exposes
exactly one port.**

**Unix clients only.** Win32-OpenSSH has no ControlMaster — recorded as an
intentional gap at `todo/group-h-crossplatform.md:10-13`. Windows falls back to reaching
Radicale over the LAN/VPN directly. This must be a **stated capability, not a
silent degrade**: the `browser_capabilities` precedent — ask the backend what is
supported, hide the control where it isn't, name the reason.

### 3.4 Storage layout on the server

```
/var/lib/eldrun-server/
  repos/<slug>.git/            # bare; collaboration is git. setgid, sharedRepository=group
  radicale/collections/        # one directory per user, one file per resource
  radicale/{config,rights,users}
  catalog.json                 # {slug,title,description,created_by,visibility}; flock-guarded
  overlay/                     # board op log (Phase 3)
  VERSION                      # DISPLAYED, never branched on
```

**Relation to the desktop layout: deliberately none.** Three categories never
cross, and the first is a hard non-goal:

- **`<state_dir>/sessions/**`** — tab layouts, `open_apps`, host-bound markers.
  `storage.rs:121-139` states the reason in as many words: everything under it is
  read back by the host as executable intent, and its previous home *inside the
  project tree* was the entire sandbox-audit bug (#142). A shared server is a
  **worse** host for it than the container mount already ruled out.
- **Credentials.** Nothing leaves the OS keychain toward the server. The server
  holds public keys and an htpasswd file it generated itself.
- **`settings.json`, `time_log.json`, `usage_stats.json`.** Personal and
  per-machine; `usage_stats` is explicitly local-only.

**Authority on existence** (content is §5's):

- **Projects — the server is authoritative for *existence*, never for
  *destruction*.** A project exists iff `repos/<slug>.git` exists. A local clone
  is a working copy: deleting it locally never deletes the server's, and a
  project vanishing from the catalog **must never delete or reset a clone** — it
  becomes an ordinary local project. This is the `probe_error` wipe-safety rule
  `extend_project_to_remote` already enforces (a transient failure never licenses
  `reset --hard`); disposal goes to the existing holding area (`paths.rs:385`).
- **Calendar/to-do — Radicale is authoritative per *resource*, under rules
  already implemented** (`commands/calendar.rs:532`).

### 3.5 Raspberry-Pi resource budget

**ARM64 build story: there isn't one, and that is the feature.** CI
(`.github/workflows/ci-cd.yml`) has `ubuntu-24.04`/`windows-latest`/`macos-latest`
and no ARM target; `package` (`:279`) is x86_64 only. Cross-compiling the current
crate to `aarch64` would need an ARM sysroot with WebKitGTK 4.1 + GTK3 + libsoup.
**Phases 0–4 need no ARM artifact at all** — `sshd`, `git` and `radicale` come
from the distro.

Footprint: `sshd` ~10 MB RSS, `radicale` ~30–50 MB RSS, a `receive-pack` spike per
push. A 2 GB Pi 4 is comfortable for a handful of users; CPU idles between pushes.

**SD-card write amplification is the real constraint, and it is why
`calendar.json` must not live on the server.** Today the calendar/board is one
file rewritten in full on every change (`commands/calendar.rs:51` →
`storage.rs:36`), and `todo_move_tasks` rewrites it **on every drag, from every
window**. A 300–800 KB rewrite per card drag is fine on NVMe and a genuine
flash-wear and latency problem on an SD card with 4× write amplification.
Radicale's layout is the right shape by construction: **one small file per
event/todo**, so a change writes ~1 KB.

---

## 4. Identity, authentication, authorization

### 4.1 The model

- **Person**, with N **devices**. `Device{id, label, ed25519_pub, added_at,
  last_seen, trust}`, where `trust` reuses `SignerTrust::{Known, Verified}` from
  the PGP stack (`services/mail_pgp.rs:117,126`). We take the **UX model** from
  PGP — the `Known` → explicit "I compared the fingerprint" → `Verified`
  promotion (`mail_pgp.rs:34,246-248`) — **not the crypto**.
- **Enrolment** is a single-use, time-boxed invite code encoding
  `fingerprint ‖ invite-id ‖ secret ‖ checksum`. The client pins the host key
  *from the code*. The human-readable part reveals a fingerprint and an opaque
  id — **never a display name or hostname**, because the code gets pasted into
  chat.
- **Sessions** are ControlMaster masters, not bearer tokens. There is no token to
  leak; revocation is one `authorized_keys` line removed plus a master sweep.
- **Authorization** is per-resource membership with three roles — **owner /
  writer / reader** — evaluated **only on the server**.

### 4.2 Rejected, with reasons

- **Username + password accounts** — breaks the standing no-persist rule at its
  most load-bearing point. `remember_action(Some(false)) → Remember::Clear` is
  *unrepresentable from the UI* (`services/remote_credentials.rs:498,518,549,565`),
  `remember_secret` refuses `Clear` unless `store_readable()` (`:566,:320`), and
  `set` refuses outright on a locked keyring (`:285-287`). Unattended background
  sync would force either persist-by-default or keychain-on-the-hot-path.
- **mTLS client certs** — a CA, issuance, expiry, renewal, *and* still a server-cert
  story. Zero reuse. Buys only third-party interop, a non-goal.
- **OIDC/SSO** — moves the trust root off the user's own hardware, which is the
  opposite of what a self-hosted server is for.
- **PGP as primary identity** — object-signing, not authentication: no session, no
  channel binding, no replay protection.
- **Device bearer tokens** — a password with better branding; would land in
  `settings.json` like `git_token` already did (`schema/settings.rs:27`, flagged in
  `docs/CODE_REVIEW_SECURITY.md` §4.2, still plaintext and now genuinely read at
  `commands/git_hosting.rs:142`). **Do not let this feature add a second one.**
- **HTTPS/TLS on the LAN** — self-signed needs the forbidden escape hatch; a local
  CA is a *harder* key-distribution problem than one fingerprint and grants that CA
  authority over every TLS connection on those machines; LE DNS-01 needs a real
  domain and public DNS records naming the user's home.
- **WireGuard/Tailscale as a built-in** — not rejected as a *deployment*, rejected
  as a *dependency*. SSH works over it unchanged. Building overlay management in
  would be a second machine-wide tunnel next to OpenVPN, whose hardest-won lesson
  is that a machine-wide tunnel is a machine-wide commitment.

### 4.3 Threat model

| Adversary | Capability | Denied | Residual |
|---|---|---|---|
| **A1 Another authorized person** | Valid device key; read/write within their ACL; push to projects they can write | Roles evaluated server-side per resource; a `reader` cannot write regardless of what their client sends | **The sharp one** — see A5 |
| **A2 LAN neighbour** | Sees traffic; can ARP/DNS-spoof; can offer a fake server | SSH confidentiality + integrity; the invite **pins the host key out-of-band**, so a fake server fails at enrolment rather than being TOFU-accepted | If we ever offer "type a hostname" enrolment, we are back on TOFU with a dialog people click through. **So we don't.** |
| **A3 Stolen unlocked client** | The device key file, local mirrors, `calendar.json` | Nothing at the moment of theft (same posture as `~/.ssh/id_ed25519`) — but **per-device revocation**: drop one row, the person's other machines are untouched | The window before revocation. Opt-in device-key passphrase (default **off**); a locked keychain degrades to a visible amber `!`, never a silent stop |
| **A4 Compromised Pi / root** | Everything the server stores in plaintext | **Nothing — and the UI must say so plainly.** `mail_encryption.md`'s own rule: "a security feature that oversells itself buys behaviour changes it did not earn" | Full compromise = full disclosure. Cannot impersonate a person elsewhere: device private keys never leave clients. Mitigation deferred — see Q4 |
| **A5 Malicious shared project tree** | Writes any file in the project, which lands in your working copy | Already denied: `open_apps`/tab layout read from `<state_dir>/sessions/<id>/terminals.json` never the tree (`services/terminal_service.rs:364,370-383`; tripwire `tests/project_tree_intent.rs`); `pty_spawn` re-derives authority from `projects.json` (`commands/terminal.rs:151-159` → `services/sandbox.rs:551`) with `cwd` confined (#149); `commands/git.rs:95,196,232,269` harden git argv and strip config by shape | **`.git/hooks/*` is a file in a well-known directory, not a config key, so no denylist reaches it.** Under multi-user this is a live host-RCE path between collaborators. `commands/python.rs:132-158`'s `.venv` auto-select (#146) becomes attacker-planted-by-default |
| **A6 The agent, steered by A5** | Reads `CLAUDE.md`/`AGENTS.md`/`.claude/settings.json`/`.claude/skills/**` from the shared tree and acts on them | Container containment when toggled; `agentMode` is a launch flag re-derived on respawn; custom-agent argv comes from the **global** settings, not the project (`services/terminal_service.rs:243,251,257,343`), so a shared tree cannot define a new agent command | **Instruction-level steering is untouched.** Eldrun *scaffolds and git-tracks* `.claude/settings.json` (`commands/projects.rs:2229`, asserted `:3877-3879`), so it travels between collaborators **by design**. Skills install verbatim (#155); arriving via sync bypasses the Library preview. **Nothing today reviews an incoming change to the agent-facing surface.** |
| **A7 Curious server owner** | Reads any file on their own machine | Nothing technical | The answer is social, and enrolment must say so in one sentence |
| **A8 Public internet** | Nothing unless the user forwards a port | Eldrun never listens, never binds, never advises a port-forward. The app opens **zero** inbound sockets today — the only `TcpListener` is an ephemeral loopback probe (`services/openvpn.rs:1061`) | If the user exposes `sshd`, that is their existing, well-understood surface |

### 4.4 Auditability

An append-only server log of `(timestamp, person_id, device_id, verb,
resource_id, result)` and **nothing else** — no titles, no card text, no paths
beyond a resource id, **no IP addresses** (which `privacy-check.sh:56` would flag
in any fixture anyway and which tell you nothing on a home LAN). Bounded
retention (90 days), pruned on write, the bucket-and-prune shape
`schema::usage_stats` already uses.

Two rules make it defensible: it is **symmetric** (each person reads the log of
their own actions; a resource owner reads the log for their resources; nobody
gets a server-wide view), and it is **not disable-able** (a log you can turn off
is worthless as an audit trail and worse than none as a promise), so it is kept
small enough to be uncontroversial and stated at enrolment.

The privacy cost is named, not minimized: **this is the first place in Eldrun
where one person's activity becomes legible to another.** It must never feed
usage stats, never leave the server, and never enter the daily recap — that
feature reads local sources *at their source* precisely so they cannot drift.

---

## 5. Calendar and to-do sync

### 5.1 The store, accurately

`~/.local/share/eldrun/calendar.json` is `CalendarData { version, calendars,
events, tasks, task_columns, extra }` (`schema/calendar.rs:463-479`). **The
board's cards ARE the tasks** — "one store, not two, on purpose" (`:18-22`).

Load-bearing properties any sync must respect:

- **Shape dispatch, not version dispatch.** `CalendarFile` is
  `#[serde(untagged)]` (`:747-752`); `CALENDAR_VERSION` is stamped
  unconditionally and **nothing may branch on it** — an older build writes a v3
  file back stamped `2` with v3 fields intact in `extra`, so the number can go
  *backwards* (`:29-38`). Guard test at `:1436`.
- **`extra` flatten on every record** — already the CalDAV extension point
  (`caldav_href`/`caldav_etag` ride it, `commands/calendar.rs:490-493`; so does
  `uid`).
- **Times are local wall-clock, never UTC** (`:11-13,179-183`). No timezone crate;
  the backend has no local clock, which is why `created` and `completed_stamp` are
  minted by the **frontend**.
- **`CalendarTask` splits cleanly in two** (`:374-458`): a *VTODO half* that
  round-trips to ICS (`title`, `notes`, `due`, `start`, `priority`, `percent`,
  `completed`, `category`, `alarms`) and a *board half* that never leaves
  (`column`, `rank`, `tags`, `subtasks`, `mail`, `event`, `project_id`, `created`).
- **`normalize` is the anti-drift function** (`:517-550`), runs on **every read**
  as well as every write — hence every rule in it is idempotent and clock-free.
  It reconciles done-ness → column **one-directionally**, backfills unplaced cards
  **from `percent` only, never from `due`** (a date rule would migrate the same
  file differently depending on the hour), and drops non-finite ranks.
- **`normalize` never creates a board** — `ensure_board` is write-path-only
  (`:552-561`).
- **Ranks** are fractional: `RANK_GAP = 1024.0`, `RANK_EPSILON = 1e-6`.
  `move_tasks_at` takes an **index, never a rank** (`commands/calendar.rs:213-218`),
  bisects, and reindexes a column whose adjacent pair falls inside epsilon
  (`:302-318`). `column_order` sorts `total_cmp` **then id** (`:202-211`), so equal
  ranks are stable rather than shuffled.
- **Writes are whole-file, atomic, read-modify-write, with no compare-and-swap**
  (`:44-51`). **Two Eldrun windows already lose the loser's edit silently.** That
  is a pre-existing single-machine multi-writer bug this work should fix, not
  inherit.
- `notifyCalendarWrite` (`src/lib/calendarWriteHook.ts:14-23`) already has exactly
  the right asymmetry for offline-first: **an upsert is announced after the local
  write, a delete before it, where a rejection cancels it.** That hook is the seam
  the sync layer plugs into, and it exists.

### 5.2 Already answered by the CalDAV work — do not re-derive

Identity merge, not replacement · board state survives by explicit field copy
(`commands/calendar.rs:628-638`) · "absent" is a deletion **only for events and
only from a full listing**; an explicit `404` deletes both kinds; absence from an
incremental report deletes nothing · a recurring master and its overrides match
**within an href group, positionally** · incremental sync is ctag-gate →
`sync-collection` → full `calendar-query` fallback · conflict detection is
`If-Match`/`If-None-Match: *` → `412`, including the refusal to `PUT`
unconditionally with no known ETag (`services/caldav.rs:1304-1314`) ·
per-collection write permission is *asked of the server*, and `read_only`
defaults **true** on deserialize.

### 5.3 The two questions `caldav_plan.md` deferred

**"Is write access even wanted?"** — **This feature is the answer, and it is
yes.** The plan itself proposed it: "reserve push for a self-hosted server where
the user is the sole stakeholder" (`docs/caldav_plan.md:491-495`). A Pi the user
administers is exactly that server, and the working tree already encodes the
answer as a per-account `allow_write`, default false, gated three ways
(`commands/caldav.rs:508-544`).

**"The conflict UX is undesigned."** — Answered here: **a 412 must almost never
reach the user.** Keep the row as the server last gave it (a *stored base*); on a
412, re-fetch, do a field-level three-way merge (base/mine/theirs) locally, and
re-`PUT`. Only fields **both** sides changed **differently** raise a dialog. That
turns the common case — Alice moves the room while Bob fixes the title — into
silence.

### 5.4 Why CalDAV alone fails, and why native-only fails

**CalDAV alone** loses the board, which is what was asked for. Smuggling
`(column, rank)` into `X-ELDRUN-*` works on Radicale but (i) inverts
`merge_caldav_calendar_at`'s central rule so the server *does* own board state,
legitimising the eviction the merge was built to prevent; (ii) turns
`todo_move_tasks`' single atomic write into N conditional `PUT`s, each
independently 412-able mid-drag; (iii) makes a column reindex an N-resource
rewrite; and (iv) **a phone whose client drops unknown `X-` properties on re-save
silently deletes your card's column.** (iv) alone disqualifies it.

**Native alone** throws away ~2,400 written and tested lines, gives up every
non-Eldrun client, and makes the Eldrun server sole custodian of the highest-stakes
data in the app with a one-implementation protocol. It would also force *two*
sync engines into one calendar list for anyone with an existing institutional
CalDAV account.

### 5.5 The board overlay

A native side channel over the same forced-command SSH RPC: an **append-only op
log** with a **server-assigned monotonic `seq`** for ordering plus a **client HLC
per op** for LWW resolution. Not vector clocks (grow with the user count, buy
ordering nobody needs); not last-write-wins-by-arrival (an offline client's stale
edits would beat fresh ones); not bare wall-clock (skew).

**An HLC is UTC epoch millis + a logical counter + a node id, and that does not
violate the no-UTC rule** — that rule is about *displayed calendar data*. Sync
metadata is not displayed and must be absolutely ordered. `SystemTime::now()` is
in std; no crate needed.

**The overlay needs no tombstones of its own.** An overlay row's lifetime is
subordinate to its UID's object, which is CalDAV's fact to assert.

### 5.6 Conflict-resolution rules

Layer matters: **iCal** = one CalDAV resource, resource-level, `If-Match`.
**Overlay** = a native op, field-level, LWW by HLC.

| Case | Layer | Event | Task | Why |
|---|---|---|---|---|
| Two clients edit **different fields** | iCal | 412 → auto three-way merge on the stored base → re-`PUT`, **no dialog** | same | A resource-level protocol reports a conflict that is not one; the base is what proves it |
| **Same field**, different values | iCal | 412 → **named conflict dialog**; keep-mine re-reads the ETag first (`commands/caldav.rs:656-670`) | same | The one case a human must decide. Keep-mine stays *conditional* so an edit landing between question and answer conflicts again rather than being lost |
| One edits the title, another ticks complete | iCal | n/a | Different fields → silent merge | `normalize` treats `percent`/`completed` as authoritative and `column` as derived (`schema/calendar.rs:641-657`); the merge must preserve that direction |
| **Delete vs edit** | iCal | **Delete wins**; the editor's `PUT` gets 412/404 and the row drops on the next sync's explicit-404 path | same | Already the shipped rule. Resurrection-on-edit would make a delete un-performable while anyone is typing |
| Absent from a **full** listing | iCal | Deleted | **Kept** | Already answered — a VTODO can vanish from the server's own default filter. **Unchanged by a server we control, because the *client* still cannot tell the two apart** |
| Absent from an **incremental** report | iCal | Kept | Kept | Unchanged resources are simply not in the reply |
| **Same card dragged to different columns** | Overlay | n/a | **LWW on the pair `(column, rank)` by HLC** — the card lands in one column on both screens; the loser watches it move | A dialog for a drag is unusable. **`column` and `rank` must be ONE unit** — a card taking Alice's column and Bob's rank lands in the right column at a nonsense position. *The non-obvious rule.* |
| Two clients **insert at the same index** | Overlay | n/a | Both compute the same midpoint → identical ranks → `total_cmp().then(id)` (`commands/calendar.rs:209`) decides → **both replicas agree** | Fractional indexing survives this **already**. No new machinery |
| **Reindex races a drag** | Overlay | n/a | **Reindex is a server op**, applying `(i+1)*RANK_GAP` at one `seq` | The one place fractional ranking breaks: a whole-column renumber is not commutative, and per-card LWW across two concurrent renumberings interleaves into arbitrary order |
| Two clients add different **tags** | Overlay | n/a | Both survive — tags are an **OR-Set**, not an LWW list | An LWW list makes a concurrent add lose one and the user cannot tell which. `normalize`'s trim/dedupe/cap runs after the merge, unchanged |
| Tick a **subtask** vs add one | Overlay | n/a | Both survive — OR-Set of ids + per-item LWW on `done`/`title` | `Subtask.id` is already stable and backfilled (`:296-307`) — the CRDT key for free |
| Card **deleted** one side, **moved** the other | Overlay | n/a | Delete wins; the orphaned overlay row is GC'd | The overlay has no independent lifetime |
| Card names a **project** the peer lacks | Overlay | n/a | Synced; renders as a dimmed unknown-project chip that still filters | **Already designed for** (`:436-445`) — the one cross-reference that degrades correctly by construction |
| Card carries a **mail link** | Overlay | n/a | **Never synced. Stays local.** | `message_id` keys *that machine's* sealed store and `subject`/`from` snapshot a private message (`:309-338`). Syncing it is a data leak with no upside |
| Card carries an **event link** | Overlay | n/a | Not synced in v1; if ever, re-key `event_id` → the event's iCal `UID` | `TaskEventLink.event_id` is Eldrun's minted row id and dangles on any other machine |
| Offline a day, then reconnect | Both | Pull server ops → apply → replay the outbox with **original HLCs** → LWW decides | same | Replaying with the reconnect-time clock would let a day-old edit beat an hour-old one purely by arriving later |
| Sync token stale / not offered | iCal | Full `calendar-query` fallback; "full deletes events, never tasks" applies | same | Already implemented; `full` is already a merge parameter |
| Overlay `seq` too old | Overlay | n/a | Server answers "snapshot required"; client takes a full overlay snapshot | **The snapshot must not delete overlay rows for UIDs the server doesn't know** — they may be local-only cards. The events/tasks asymmetry, one layer up |

### 5.7 The timezone question — do not gloss it

Today every stamp is floating local wall-clock, and `parseIcsDate` **ignores a
`TZID` parameter entirely** (`src/lib/ics.ts:133-159`) — it handles `YYYYMMDD`,
floating, and `Z`, nothing else. So `DTSTART;TZID=Europe/Berlin:20260801T140000`
already lands as floating `2026-08-01T14:00` regardless of the reader's zone.

For one person in one zone that is invisibly correct. **Multi-user across zones
it is wrong, and wrong silently**: Alice in Berlin creates a 14:00 meeting; Bob in
Boston sees 14:00 and arrives six hours late. Nothing anywhere reports it.

1. **Declare single-timezone and detect violations.** Zero model change. The
   server records each client's UTC offset at sync; the calendar banners on
   mismatch. ~a day. Turns a silent wrongness into a visible one — this codebase's
   standing posture. **Recommended.**
2. **Optional `tzid` per event, floating when absent.** Rides `extra` for free.
   The real cost is not storage: *every* stamp consumer must convert —
   `lib/calendarTime.ts`, `lib/recurrence.ts` (a weekly 09:00 stays 09:00 *in that
   zone* across DST, i.e. a different UTC instant each side), `expandEvents`,
   alarms, the grid, `EventOverride.occurrence_start` **as a key**, and the civil
   arithmetic at `schema/calendar.rs:808-900` — plus a tz database. **Multi-week,
   long DST bug tail, touching the most-read code in the app.**
3. **Store UTC. Rejected** — breaks "09:00 standup stays 09:00", breaks the
   all-day encoding, forces a migration of every existing `calendar.json`.

**Ship (1). Put (2) behind a human decision, and let the detector be the thing
that says whether it is ever needed.**

---

## 6. Collaborative projects

### 6.1 What it means here

**A shared registry plus a shared bare git remote. Not a shared working tree.**

The schema already models the axis: **`Project.git_type`
(`schema/project.rs:310`) is the *push* axis, distinct from `Project.remote`
(`:361`), the *work* axis.** Collaboration belongs on the push axis. The work
axis — SSH remote projects, lockstep, byte-sync, workers — stays a
single-user-across-machines feature and must be **off** for anything shared.

### 6.2 Where two humans break the current sync engine

This is the sharpest technical finding in the investigation. Every item is a
place whose correctness argument silently assumes one person.

**Byte-sync stays safe and becomes useless.** Its policy is judged against a
**per-machine** base manifest (`services/remote_sync.rs:258-273,712-735`), so a
second human makes every base stale: host-moved-only still auto-pulls
(`sync_auto.rs:415-431`), local-moved-only is gated on `Safe` and gets skipped
(`:436`), both-moved is skipped (`:454`). It degrades to **permanently amber** —
destroying nothing, and leaving both members staring at a diverged list neither
can clear except through the manual force paths below. **Byte-sync is not a
collaboration transport. Do not enable it on a shared project.**

1. **`detect_and_sync` follows the peer's checkout onto your working tree,
   unasked.** `git_peer.rs:3300-3323` reads "the host's HEAD moved" as "the user
   checked out a branch" and runs `git checkout` on your local mirror (`:2746`),
   **on a 12 s poll** (`:72`). The only mitigation is a `local_loss` report *after*
   the fact.
2. **`git clean -f -x` on the peer to unblock a fast-forward** (`:1683` via
   `:1664`). Its safety argument is "provably byte-identical, or provably stale
   byte-sync residue **this install** created" (`:1417`) — a claim about *our*
   history. A second human's untracked file at the same path is not our residue,
   and `FfRetry::ClearedButFailed` (`:1709-1711`) leaves it gone with nothing to
   rewrite it.
3. **`resolve` destroys the loser's uncommitted *tracked* work, silently, on a
   machine you cannot see.** `git_peer.rs:2830-2884`. The only pre-flight lists
   `ls-files --others` — **untracked only** (`:2222`). `dest.dirty_tracked` is
   computed and sitting on the snapshot (`:104`, probed `:1135`) and is **never
   consulted here**. `force_reset_branch` then `reset --hard`s the host tree; the
   `refs/eldrun/backup/*` net saves refs, and uncommitted work was never a ref.
   And because the audit is direction-gated (`:1266`), **nothing is recorded at
   all** when the destroyed side is the host.
4. **A dirty host is a permanent deadlock, not a transient one.** With one human,
   "commit or stash and it clears". With two, member A sits `Desynchronized` for as
   long as B has uncommitted work — most of the working day — and A's only offered
   exit is (3).
5. **Concurrent commits are correctly detected and badly resolved.** `Diverged`
   is reported, not applied (`:1497-1503`) — good. But the UI's answer is
   Use-local/Use-remote, a force push with a backup ref. **Two humans committing
   on one branch is the normal case, and the tool offers "pick a winner" instead
   of "merge/rebase".** Correct git here is `pull --rebase` against a bare remote.
6. **`sync_push(force: true)` bypasses the base check entirely**
   (`commands/sync.rs:1027`), and `local_loss` records only *mirror-side* loss
   (`services/local_loss.rs:1-27`). **Overwriting a colleague's host file is
   unpriced and unrecorded.**
7. **`remote_kill_all_jobs` is machine-wide** — `tmux kill-server`
   (`commands/ssh.rs:753-775` → `services/ssh_exec.rs:347`): every session, every
   project, **every user**. On a shared box it ends your colleague's training run.
8. **A shared tmux session actively evicts the other person.** The wrap is
   `tmux new-session -A -D` — **`-D` detaches any other client**. Two people
   attaching take turns kicking each other out, silently. `filter_sessions_for_project`
   already makes the Sessions *view* multi-user-aware; the *attach* is not.
9. **Worker hosts are fine** — `worker_sync.rs` is push-only, never `git clean`,
   files read-only, and inherits none of the divergence machinery. One caveat: each
   member's fan-out resets the worker to *their* HEAD, so a worker shared between
   two members thrashes. Per-member worker paths, or declare workers single-owner.

**A bare repo on the server removes 1–6 by removing the working tree.**

### 6.3 What must never be shared

Mostly already enforced; the value of the list is that a shared project is
exactly the scenario the enforcement was built for.

| Must not travel | Why | Status |
|---|---|---|
| Tab layout, `tab_groups`, `open_tab_sessions`, `open_apps` | The host reads them back as **executable intent** — `open_apps` → `spawn_reaped`, a layout's `cmd`/`args`/`env`/`cwd` → `pty_spawn`. A shared project makes "the tree is attacker-controlled" true **by design** | **Done (#142)**; enforced by `tests/project_tree_intent.rs`. **New rule: the adopt path must never fire automatically for a shared project** |
| `project.json` entire | Every field is *this person's* machine: SSH login, mirror path, container knobs, interpreter, agent-authority override. `pty_spawn` already refuses to trust it for `remote_control`/`sandbox` (`schema/project.rs:390-400`) | **Done** — `GITIGNORE_DEFAULT` (`commands/projects.rs:2053`), back-filled into imported repos |
| `.eldrun/` | Same class | **Done** — gitignored and skipped by both byte-sync walkers |
| Credentials of every kind | All live in the OS keyring keyed by target. **The invite must not become a fourth credential mechanism** | **Done by construction**; the work is not breaking it |
| Agent session ids | `TabEntry.sessionId` is a pointer into `~/.claude/projects` **on the machine that created it** — at best a dead id, at worst a resume of someone else's transcript | Travels only inside `tab_layout`, already excluded |
| Time tracking | Keyed by project id in `state_dir()` | **Already per-person, and that is right**: "my hours", never "the team's". A team view would be a **new aggregate computed from opt-in submissions**, never a shared file |
| Usage stats | Explicitly local-only | Already per-person |
| `settings.json`, `global_machines.json`, `default_apps.json` | Per-machine by definition | **Done** |
| The board's per-user session state | `stores/todo.ts` filters, drag state, `focusTaskId` — deliberately unpersisted | **Done.** A shared board syncs **cards**, never filters or selection |
| **NEW: the member's own identity in `extra["shared"]`** | The server address is shareable; the member's credential is not | The `MachineIo` bargain — scrub on export exactly as it scrubs `user` |

### 6.4 Presence

**MVP:** a heartbeat `{project_id, member, host_label, ts}` every ~30 s; the
server keeps a TTL'd set. Render as a **member-count chip** beside the existing
category dots on the pill (`ProjectPill.tsx:2287-2297`) — `👥 2`, tooltip naming
them, hidden at 0. Server connectivity is a `ConnLamp` in the same four states.
**One poll per window, not per pill** — the `stores/hostSessions` refcount shape.

**Advisory locking: not worth it.** (a) The unit of conflict here is a *commit*,
and git reports it precisely — a file lock answers a question git answers better
and later. (b) **Eldrun does not own the editor**: files open in `xdg-open`'d
external apps and agent terminals, so a lock the app cannot enforce will be
routinely and invisibly violated. (c) The one case where a lock would help is the
long-running job, **and that is already visible** (`stores/hostBusy`, the Sessions
view, `ConnLamp`'s busy pulse). Extend the existing busy signal to say **whose**
session it is — the tmux name already carries `eldrun-<scope>--<uuid>` — rather
than inventing locks.

---

## 7. UX

Everything rides the canonical chrome: `.modal-backdrop` + `.project-dialog`,
`.settings-title-row` h2 with the accent rule, `.dialog-close-btn`
(`styles/themes.css:11829`); a dialog over a dialog uses `.modal-backdrop-elevated`
(`:11818`). **Portaled elements must set an explicit `color`** — `body` sets none,
so a portal inherits black.

1. **Server setup → a new `"team"` Settings panel.** `SettingsPanelKind` is a
   closed union at `components/layout/SettingsPanel.tsx:659`; add `"team"` plus a
   `.settings-nav-item`. Settings rather than the project dialog, for
   `MachinesIndicator`'s reason: **a server is machine-wide and the projects on it
   come and go.** Contents: **Server** (host, `ConnLamp`, Test — **no presets
   ever**, the rule `CalDavAccountDialog` already states: a base URL is a login on
   someone's infrastructure and this repo is public, so a preset list could only
   name institutions); **Identity** (display name, device list with fingerprints,
   `SavePasswordRow` off `useSavedCredentialSource` **verbatim** — opt-in, default
   off, `true | null` never bare `false`, 4 s bound, locked-keyring banner; **do
   not hand-roll a second one**); **Join by invite** (the `MachineExportFile`
   shape — address and labels only, no user, no secret); **Sign in in a terminal**
   (`TerminalSignInToggle`, the standing answer to "headless can only ask what it
   has fields for").
2. **Sharing → one pill-menu entry**, "Share on my server…", beside the existing
   Publish entries; a dialog that is 90% the publish dialog. Role defaults render
   from the **server's** answer (the `read_only` rule: ask, don't assume). It
   states, in one sentence, that **git lockstep is force-disabled** for a shared
   project and why — *the single most important piece of copy in the feature.*
3. **Joining → no new dialog.** `ProjectDialog` gains a fourth import source,
   "From my server", listing the registry filtered to your memberships. Everything
   downstream is the existing clone-then-import path including `check_project_site`.
   The container row already defaults **on for an import**; for a shared project
   the argument is stronger and the default stays on.
4. **How a shared project appears.** The presence chip on the pill; a **Shared**
   tag on `ProjectFilesView`'s type tag (where the local/remote source switch
   already lives, so it is where "where does this come from" is asked); errors in
   the existing amber `!` treatment, not a new colour.
5. **Calendar/board.** `CalendarSidebar.tsx:288-302` already renders a per-calendar
   sync affordance (`⇅`, `…`, amber `!` with the backend's own sentence) — **a team
   calendar is that row with a different badge; do not build a second affordance.**
   `assignee` rides `CalendarTask.extra`, rendered as an initials chip on
   `TodoCard`, picked in `TodoCardDialog`. **`TodoIndicator`'s badge must count
   *your* cards** — its whole rationale is "what today actually demands", and a
   team-wide overdue count never falls.
6. **Status vocabulary: reuse, don't extend.** `off | connecting | connected |
   error` with `busy` orthogonal. **Presence is a count, not a fifth colour.**
7. **`UntestedTag` on every new surface** until the user says otherwise.
8. **i18n is a real cost, not a tidy-up.** `lib/i18n.ts` is one ~21.5k-line file;
   `const en` (`:46`) is the source of truth and `src/__tests__/i18n.test.ts`
   enforces parity across en/de/es/fr/it — missing keys, extra keys and placeholder
   mismatches all fail, and it now runs in CI. **Realistic: 60–90 keys × 5 =
   300–450 entries.** One saving grace that must be honoured: **the server speaks
   tokens, the frontend speaks sentences** — the `web_safety::REASON_TOKENS` +
   `reasonPhrase` pattern with a tripwire reading the token list out of the Rust
   source. **Server error reasons must be a closed token set, never prose.**

---

## 8. Invariants

Rules any implementation must not break, each with its *why*. These are the
candidates for `docs/context/eldrun_server.md`.

1. **The server is the only authority on permission. A client-side flag is a
   mirror, never a gate.** A client that computes its own authorization is a
   client an attacker can patch, and the sync path is the one place where "the UI
   wouldn't let you" is not a defence.
2. **Nothing on the unattended path may depend on the OS keychain.** A locked
   collection is indistinguishable from an empty one; the 4-second bound converts
   a freeze into *silence*.
3. **No typed secret is persisted without an explicit, default-off opt-in, and the
   enrolment invite is consumed, never stored.**
4. **There is no "trust this certificate anyway" control, in any form, ever.** The
   one place TOFU is accepted (SSH host keys) is fenced by a fingerprint dialog
   that background and launch paths deliberately never take.
5. **A shared project tree is hostile input, at the same tier as a cloned repo —
   and stricter, because it keeps changing.** The `project_tree_intent.rs` tripwire's
   coverage must expand, never shrink.
6. **A writable shared project runs in a container, or it does not run.** Where
   containers are unavailable — Windows (`commands/terminal.rs:292-293` refuses) or
   a remote project (`services/sandbox.rs:505-512` forces sandbox off) —
   collaboration is **refused with a reason**, never silently downgraded.
7. **A change to a project's agent-facing surface is a decision, not a sync.**
   `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/settings.json`,
   `.claude/skills/**` — an incoming change blocks the next agent spawn until the
   user has seen the diff; hash-keyed, re-asked when the bytes change. This is
   #143's shipped `spec_source_hash` pattern applied to the file set that steers
   the agent instead of the one that builds the image.
8. **The server stores no credential that authenticates anyone anywhere else.**
   Public keys only — no password hashes worth cracking, no OAuth refresh tokens,
   no git PATs.
9. **No hostname, network, user or address is ever a literal in this repo.**
10. **`CALENDAR_VERSION` is stamped, never branched on — and sync must not
    introduce a version gate either.** In a client/server deployment clients are
    *permanently* at mixed versions, so every wire and on-disk struct carries
    `#[serde(flatten)] extra`, fields are additive-only, and the server's `VERSION`
    is **displayed, never branched on**. *The single most important ops rule, and
    already the codebase's idiom.*
11. **`normalize` runs on every read and must stay idempotent and clock-free.**
12. **A read never creates a board** — a sync that seeded `task_columns` on a pull
    would grow board state in the file of someone who only uses the calendar.
13. **The CalDAV merge never writes board fields.** The overlay is a separate
    authority precisely so `commands/calendar.rs:628-638` never has to be deleted.
14. **`column` and `rank` are one LWW unit**, and **never travel over CalDAV**.
15. **`CalendarTask.mail` never leaves the machine.**
16. **Cross-machine references are keyed by `UID`, never by Eldrun row id.**
    `TaskEventLink.event_id` violates this today and must be re-keyed before it is
    ever shared. **A UID is never re-minted on a write** — that is how one
    appointment becomes two.
17. **A row is stamped with its server identity only *after* the server accepted.**
18. **A delete goes server-first, local-second; an upsert local-first,
    server-second.** Already the shape of `calendarWriteHook.ts:14-23`.
19. **A task is never deleted on mere absence** — true for CalDAV, equally true
    for an overlay snapshot, which must not prune UIDs it does not recognise.
20. **A reindex is atomic** — the whole column moves at one `seq`, or not at all.
21. **The overlay never attaches to a collection on a different server.**
22. **Do not read another service's storage** — the overlay must not read
    Radicale's collection directory to learn what exists.
23. **Failure is visible, never silent** — extend the amber `!` to "N changes
    waiting to send".
24. **Nothing under `<state_dir>/sessions/` ever crosses.**

---

## 9. The three gates on writable project sharing

Read-only project sharing (a bare git remote you clone and fetch from) is
shippable. **Writable sharing is gated on all three of these, and if the first
cannot be resolved it should not ship at all.**

**Gate 1 — `.git/hooks/*`.** Group O #151 mitigated `.git/config` by shape-based
key stripping but explicitly left hooks, `core.sshCommand` and `credential.helper`
residual, reasoning that they fire only on **user-initiated** Commit/Push/Checkout
and "a repo's own hooks are a feature". **That premise is false under multi-user:
the hooks are someone else's, and Commit/Push/Checkout is what collaboration
consists of.** Proposed answer: pin `core.hooksPath` to an empty, Eldrun-owned
directory for shared projects, as a per-invocation `-c` threaded through
`hardened_git_command_in` (`commands/git.rs:269`) so every existing call site
inherits it. The named cost: a shared repo's legitimate hooks are inert — the same
shape as the Git-LFS cost the config sanitizer already accepts. **There is no
third answer.** A hook is an arbitrary script, so no value-level allowlist exists,
and "trust your collaborators" is not a mechanism.

**Gate 2 — the agent-surface review gate** (invariant 7). Without it, a
collaborator writes prose in `CLAUDE.md` and your agent obeys it.

**Gate 3 — container-mandatory with an explicit refusal** (invariant 6). #147
concluded "warn, don't refuse" for a remote project, which is correct for solo use
and wrong for a writable shared project. Both can coexist: **warn if solo, refuse
if shared.**

---

## 10. Phased plan

Each phase ships alone and is worth shipping alone. Backlog items in
[`todo/group-z-server.md`](../todo/group-z-server.md).

**Phase 0 — Prerequisites (all pre-existing debt, all worth fixing anyway).**
Land and live-test the uncommitted CalDAV push work and correct `group-x-caldav.md` #160,
which still reads "deliberately not built". Build Group P #79's generic remote
URL. Give `write_data` a compare-and-swap so two Eldrun windows stop silently
losing an edit. Add `fsync` to `write_json_atomic` — `storage.rs:36-50` does
`fs::write(tmp)` then `rename` with **no `sync_all()` on the file or the parent
directory**, which on a machine defined by being unplugged rather than shut down
is a data-loss path.

**Phase 1 — Provisioning, identity, connectivity.** The setup script, the RPC
surface, device keys, invite codes, the Team panel, registration as a machine
tagged `careful_hosts`, the loopback forward. Ends with: the lamp goes green, two
people are enrolled with their own device keys, revoking one device drops that
device only.

**Phase 2 — Calendar and to-do over CalDAV.** The Eldrun server as a CalDAV
account; three-way merge on 412; the timezone detector; migration of the existing
single-user `calendar.json`. Ends with: two people, one shared calendar, events
and VTODO fields converge; each also has a private collection; a read-only share
is read-only without anyone configuring that locally.

**Phase 3 — The board overlay.** Op log, HLC, LWW, OR-Sets, server-side reindex,
collection-scoped columns, assignee, the outbox with a visible pending count.

**Phase 4 — Shared projects, read-only.** Bare repos, catalog, Share, Join,
`ProjectSite` for the duplicate gate, lockstep and byte-sync force-disabled and
*said so*, presence.

**Phase 5 — Writable shared projects. GATED on §9.** Plus the shared-host hazard
guards (`remote_kill_all_jobs`, the tmux `-D` eviction, `resolve`'s missing
`dirty_tracked` check).

**i18n runs inside each phase, never after it** — the parity test is a CI gate.

---

## 11. Verification

The precedent that should govern expectations: `docs/git_lockstep_case_matrix.md`
records that **4 of 28 cases were "reported green" by the unit tests and were
wrong when run against a real host** — every one of them a no-op computing to
`Synchronized`. **Expect the same failure class: a sync that transferred nothing
and reported success.** Fixtures are structurally unable to find it.

Two harnesses, following `src-tauri/examples/lockstep_drv.rs` (a driver calling
the same service entry points the Tauri commands call, so a case exercised
through it exercises shipped code):

- **Deterministic replay** — N in-process clients against an in-process server, no
  network, script-driven. Property tests: a permuted op set converges to one state
  (commutativity under HLC order); applying any op twice is a no-op (idempotence,
  which `normalize` already demands of itself).
- **Live two-machine QA** against a real Radicale, because lockstep says fixtures
  do not catch transport-level no-ops.

**Case-matrix axes:** object kind (event · recurring master · occurrence override ·
VTODO · task with subtasks · board-only card) · **layer touched** (iCal · overlay ·
**both in one gesture** — a drag into Done writes `column`+`rank` *and*
`percent`+`completed` (`commands/calendar.rs:277-293`), the highest-value row) ·
concurrency (sequential · simultaneous · one-offline-then-reconnect ·
both-offline · reconnect order reversed) · op pair (edit/edit same field ·
edit/edit different field · edit/delete · move/move same column · move/move
different · insert-at-same-index · reindex vs move · tag-add/tag-add ·
tag-add/tag-remove · subtask-tick/subtask-add · complete/uncomplete) · transport
state (reachable · unreachable · ctag unchanged · token stale · token invalid ·
overlay seq too old · 403 · 412) · membership (both subscribed · one unsubscribes
mid-flight · card names a project the peer lacks · card names a mail message ·
**card sits in a column the peer lacks**) · config (`allow_write`, `read_only`,
overlay on/off, shared columns).

**Rows to write first**, by false-green risk: both-offline-then-reconnect with an
edit/delete pair; a drag into Done racing a Tasks-view tick from the other
machine; a reindex racing a drag; and **a card in a column id that exists only on
one machine — today `normalize` step 3 silently refiles it to Backlog
(`schema/calendar.rs:639-641`), so the peer watches the card teleport with no
error anywhere.**

---

## 12. Open questions — a human must decide

**Q1. Is Radicale (Python) an acceptable dependency?** The crate's posture is
emphatic: no OpenSSL, no C toolchain, pure Rust (`Cargo.toml:134-138`). A Python
service is a *different* kind of dependency — apt-managed on the user's own
machine, not linked into our binary — but it is one this project has never taken.
There is no credible Rust CalDAV server. The fallback (our own daemon) costs the
entire CalDAV server implementation and gains a single-binary install.

**Q2. Does Eldrun writing a Radicale config violate "never manipulate another
app's paths/config"?** The two standing rules genuinely collide. The reading that
lets it through: this is a script Eldrun *authored* but **the user executes, on a
machine they administer, into a directory the script itself creates** — not a
silent edit of an installed app's settings on the user's own box. The alternative
— ship the script for the user to run themselves — violates the *other* standing
rule ("never a copy-it-yourself option"). One rule has to be given an explicit,
documented exception.

**Q3. Is the team single-timezone?** Decide **before** Phase 3 — a shared board
full of wrong times is worse than no shared board.

**Q4. Should server-stored calendar payloads be sealed?** Feasible via
`services/mail_crypt.rs`'s shape (sealed values, cleartext structural keys, AAD
binding a ciphertext to its row). It would deny A4 almost entirely. Not v1,
because a *shared* calendar needs a group key and revoking one person means
re-encryption. **But the decision is needed now, not later: keep server payloads
opaque and unindexed, or sealing is off the table forever.**

**Q5. Does the board become shared, or does each person keep private placement of
shared tasks?** Both are defensible products. Private placement costs *nothing* —
it is today's behaviour plus a CalDAV server, and ships at Phase 2.

**Q6. Does a shared board mean shared `tags`, `subtasks`, `notes`?** `notes`
already goes over CalDAV; tags and subtasks currently never leave the machine.
Making them shared is a user-visible privacy change and needs a per-calendar
choice, not a global default.

**Q7. Whose columns win?** The seeded set (`backlog/today/doing/done`) has stable
slug ids so default boards already agree — but a user-added column is a uuid and
dangles on the peer. Either columns become collection-scoped (recommended) or the
board is shareable only at default columns.

**Q8. Is writable project collaboration wanted at all, or is read-only the end
state?** `docs/context/caldav.md` asks and answers exactly this for CalDAV push —
"shipping read-only as the end state may simply be correct". It applies with *more*
force here, because the blast radius is code execution rather than a double-booked
meeting.

**Q9. Who reviews the agent-facing surface, and how often?** Possibly several
times a day on an active project, and `sandbox_hardening_plan.md` already warns
that a per-repo confirmation "decays to a reflex click". Per-change (safe, noisy) /
**per-author** (leaning) / allowlisted paths.

**Q10. Device-key passphrase default.** Off means a stolen unlocked laptop has
access until revoked; on puts the keychain back on the sync path, which invariant 2
exists to prevent. **The one place the constraint and the threat genuinely pull in
opposite directions.**

**Q11. Recovery when a person loses every device.** The owner re-invites; there is
no reset and no backup code — correct and simple, but **losing the owner's last
device loses the admin path** (fallback: shell on the Pi).

**Q12. A shared bare repo is a shared filesystem.** `sharedRepository=group` is
standard but means any collaborator can `push --force` or delete a branch. Branch
protection does not exist in bare git — that is Gitea's actual value proposition.
If the answer is "we need it", Phase 5 becomes Gitea rather than a bespoke binary,
**and nothing in Eldrun changes, because the clone URLs are identical.**

**Q13. Clock skew.** A Pi has no RTC and boots with a wrong clock. Invite expiry,
log timestamps and merge ordering all depend on it. Refuse to serve until NTP has
synced, or tolerate skew?

---

## 13. Known defects and doc drift found during this investigation

Not part of the feature; found while reading, and worth fixing regardless.

- **`write_json_atomic` has no `fsync`** (`storage.rs:36-50`) — `fs::write(tmp)`
  then `rename`, with no `sync_all()` on the file or the parent directory. The
  rename can be ordered ahead of the data.
- **`calendar.json` writes have no compare-and-swap** (`commands/calendar.rs:44-51`)
  — two Eldrun windows already lose the loser's edit silently, today, on one machine.
- **`resolve` has no `dirty_tracked` guard** (`git_peer.rs:2859-2882`) — a real
  single-user hazard too, since `dirty_tracked` is computed and simply not consulted.
- **`docs/context/tmux_sessions.md` is stale** — it claims `remote_disconnect` /
  `remote_disconnect_all_hosts` end every tmux session on the host;
  `commands/remote.rs:16-22` records that this was **removed** precisely because it
  destroyed sessions on a plain project switch. Fix before anyone reasons about
  shared-host behaviour from the doc.
- **`todo/group-x-caldav.md` #160 and `docs/context/caldav.md:130-152` are out of date** —
  both say push is deliberately not built; it is written and sitting uncommitted in
  the working tree. **Any plan built on the docs alone will be wrong about the
  starting point.**
- **`git_token` is still plaintext in `settings.json`** (`schema/settings.rs:27`)
  and now genuinely read (`commands/git_hosting.rs:142`), despite
  `services/git_credentials.rs` existing to hold exactly that.

---

## 14. Explicit non-goals

- **Not a GitHub.** No web UI, no issues, no pull requests, no CI, no code review.
- **No real-time collaborative editing (CRDT/OT, Live Share) — loudly, permanently.**
  Eldrun does not own an editor: the centre surface is a terminal, files open in
  `xdg-open`'d external applications and in-app viewers that edit text via splices.
  A CRDT layer would have to own every editing surface **including the ones outside
  the process**, and would be a from-scratch subsystem larger than `git_peer.rs`.
  The repo's own competitive assessment names "Eldrun is a shell *around* the dev
  experience, not the dev experience" as its biggest conceptual gap; co-editing bets
  on the opposite premise.
- **No shared or attachable agent sessions, no shared terminals.** `-A -D` evicts
  by design, and a shared agent conversation is a shared **authority** —
  `agent_authority.md`'s three axes are all per-install decisions, and there is no
  model for "whose permission mode is in force". This is also the door into agent
  orchestration, which the project has deliberately chosen not to build. Keep it shut.
- **Not a work host.** A Pi is a push remote, not a compute host. No agent tabs, no
  builds, no `du` censuses, no GPU probes, no lockstep loops — enforced by the tag,
  not by trusting the UI.
- **No merge UI.** Divergence is reported; resolution is git's, in a terminal, and
  the Share dialog says so.
- **No team-aggregate time tracking or usage stats.** Both are per-person by
  explicit design; turning either into a team dashboard is a surveillance feature
  wearing a productivity hat.
- **Byte-sync is never a collaboration transport.**
- **No inbound listening socket in the client. Ever.**
- **No HTTP/HTTPS server API, no web UI, no third-party client interop.** If a user
  wants other CalDAV clients against their Pi, that is Radicale's job and Eldrun's
  CalDAV *client* already speaks to it — the right seam.
- **No mDNS/zeroconf, no Docker on the server, no reverse tunnel, no custom
  TLS/PKI, and no self-signed-certificate override** — the last one in v1 or ever.
- **No cross-server federation, multi-tenancy, anonymous/guest or link-shared access.**
- **No end-to-end encryption of server-stored data in v1** — the server sees
  plaintext, and the UI must **say** so rather than implying otherwise.
- **No version-gated migrations.** Client and server are permanently at different
  versions; `CALENDAR_VERSION`'s rule is the law here, not a stylistic preference.
- **No presets or bundled server addresses**, ever — the repo is public and a
  preset list could only name institutions.
- **iTIP scheduling, CardDAV, free/busy, OAuth2-fronted CalDAV, and a CRDT library
  dependency** are all out. The overlay's pieces (LWW register, OR-Set, fractional
  index) are a few hundred lines, and the standing posture is to hand-roll small,
  well-specified protocol rather than take an awkward-fit crate.
