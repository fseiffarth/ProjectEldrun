## Group Z — Eldrun Server: self-hosted projects, calendar & to-do for several people

*Nothing here is implemented — this is a plan, produced 2026-07-29 from four
parallel investigations (server architecture/ops, identity/auth/threat model,
calendar+board sync protocol, collaborative projects + UX). Full design,
reasoning, threat model, conflict-resolution table, invariants and the open
questions a human must answer: [`docs/eldrun_server_plan.md`](../docs/eldrun_server_plan.md).*

*The shape in one paragraph: **do not build a server, provision one.** A Linux
box (e.g. a Raspberry Pi) running `sshd` + Radicale + a directory of bare git
repos, reached entirely over the pooled SSH ControlMaster Eldrun already
maintains — no TLS, no PKI, no listening Eldrun daemon, no ARM64 build of
anything we ship. Identity is a per-person, per-device Ed25519 key, so nothing
on the unattended sync path ever touches the OS keychain. Calendar/to-do is
CalDAV (the client, **including push**, is already written and sitting
uncommitted in the working tree) plus a small native overlay for the board
fields CalDAV cannot represent. Collaborative projects means a shared registry +
a shared **bare** git remote — never a shared working tree, because the lockstep
engine's correctness arguments all assume one human.*

> 📌 **Scope note (2026-07-30).** This group is **strictly the multi-person
> case.** *Solo* use of a Raspberry Pi — register it and run Claude/shells on it
> yourself — is **already shipped** by the work-remote (SSH) axis and needs
> **none** of Group Z: a remote project (`RemoteSpec`, tree on the host, tabs over
> `ssh -tt`, files over SFTP, git over SSH — `docs/context/remote_projects.md`) or
> the Pi as a registered global machine / worker host (`host:<id>` tab locality —
> `docs/context/multi_host_remote.md`). The server earns its keep **only** when
> several authenticated people sync the *same* projects + a shared calendar/board.
> If that is not wanted, read-only project sharing may be the end state and the
> server track may correctly never be built. One caveat that *is* real for the
> solo Pi and is **not** a Group Z item: **a remote agent (Claude) tab is not
> tmux-wrapped** — `ssh_exec::wrap_pty_options` excludes agent tabs (only
> shell/script tabs persist), so shutting the laptop kills the remote agent
> *process*; only the *conversation* resumes via `--resume`. A long autonomous run
> that must outlive the laptop has to be launched from a persistent **shell** tab.

> ⚠️ **Sequencing rule.** Items #169–#172 are **prerequisites and pre-existing
> debt** — all four are worth doing on their own merits and #169 is blocking.
> **Writable project sharing (#193–#196) must not ship** until the three gates
> in the plan's §9 are closed; the sharpest is that `.git/hooks/*` is executable
> intent that Group O #151 deliberately left residual on reasoning that
> **inverts under multi-user**. Read-only project sharing (#188–#192) and the
> whole calendar/board track are shippable without it.

*Files (planned): new `src-tauri/src/services/eldrun_server.rs`,
`src-tauri/src/commands/eldrun_server.rs`, `src-tauri/src/schema/eldrun_server.rs`,
`src-tauri/src/schema/hub.rs`, `scripts/eldrun-server-setup.sh`,
`docs/context/eldrun_server.md`; additions to `src-tauri/src/commands/git.rs`,
`services/ssh_common.rs`, `services/ssh_exec.rs`, `commands/global_machines.rs`,
`commands/calendar.rs`, `commands/caldav.rs`, `storage.rs`, `src-tauri/src/lib.rs`
(`generate_handler!`); frontend new `src/lib/eldrunServer.ts`,
`src/stores/eldrunServer.ts`, `src/stores/presence.ts`,
`src/components/server/ServerSetupWizard.tsx` + `ServerBrowser.tsx`, additions to
`src/components/layout/SettingsPanel.tsx`, `src/components/projects/ProjectDialog.tsx`,
`src/components/header/ProjectPill.tsx`, `src/components/calendar/CalendarSidebar.tsx`,
`src/components/todo/TodoCard.tsx` + `TodoCardDialog.tsx`, `src/lib/i18n.ts`.*

---

### Z.0 — Prerequisites and pre-existing debt (#169–#172)

169. **Live-test the CalDAV push work.** *Code-complete as of 2026-07-29 (still
    uncommitted at time of writing).* `caldav_push` / `caldav_delete` /
    `caldav_resource_etag` / `caldav_refresh_access`, `put_resource` /
    `delete_resource` / `WriteCondition`, `CalDavAccount::allow_write`, the
    conflict dialog this item asked for (`CalDavConflictDialog`, three answers and
    no *merge*), and the `UID`/`RECURRENCE-ID` round-trip the resource
    serialization needs are all in the tree with tests; `todo/group-x-caldav.md`
    #160 and `docs/context/caldav.md` now describe that state rather than denying
    it. What is left is the part no test can stand in for: **nothing in the CalDAV
    stack has ever spoken to a real server.** Still **blocking for the whole
    calendar half of this group**, and still riskier than its size.
    - [x] 🤖 Automated test — a create sends `If-None-Match: *` and an update
      `If-Match`; a write with no known ETag is **refused** rather than sent
      unconditionally (`services::caldav::an_update_with_no_known_etag_is_refused…`);
      the local gate needs both the user's opt-in and the server's
      (`commands::caldav::a_write_needs_both_the_users_opt_in_and_the_servers`);
      the store-level gate and the refused-delete rejection
      (`src/__tests__/CalDavPushGate.test.ts`).
    - [ ] 🖐️ Manual test — Radicale in a container + Thunderbird: create/edit/
      delete an event and a task from Eldrun and see them in Thunderbird; a
      concurrent edit from Thunderbird surfaces as a named conflict rather than
      being overwritten; a recurring series' "this occurrence only" edit
      round-trips.

170. **Generic remote URL publishing — Group P #79's one open bullet.**
    `git remote add/set-url origin <url>` + `git push -u origin <branch>`, with
    no host CLI, routed through the existing `PublishSite` / `origin_site` logic
    so `describe_mirror_guard`'s stale-mirror refusal applies. `git_publish.rs:69`
    currently rejects anything that is not GitHub or GitLab, and
    `git remote add origin` appears nowhere in the tree. **Prerequisite for
    #189**; build once and it serves self-hosted Gitea/Forgejo/bare-SSH alike.
    The GitHub *and* GitLab `Provider` dispatch is already shipped
    (`commands/git_publish.rs:57-69`) — do not rebuild it.
    - [ ] 🤖 Automated test — URL validation accepts `ssh://`, `git@host:path` and
      `https://`, rejects the shapes `validate_clone_url` rejects; publishing
      flips `git_type` to `remote-private`.
    - [ ] 🖐️ Manual test — publish a local project to a bare repo in `/tmp` and
      confirm the history with `git log` on the bare repo.

171. **Compare-and-swap on `calendar.json` writes.** `write_data`
    (`commands/calendar.rs:44-51`) is whole-file read-modify-write with no
    revision check, so **two Eldrun windows already lose the loser's edit
    silently, today, on one machine** — the board writes on every drag, from a
    second window as well. Add a per-record `rev` and make writes CAS. Worth
    doing on its own merits and a hard prerequisite for anything multi-writer.
    - [ ] 🤖 Automated test — two interleaved read-modify-write sequences: the
      second write is rejected and retried against fresh state rather than
      clobbering.
    - [ ] 🖐️ Manual test — two windows, same board, drag a card in each within a
      second; neither edit vanishes.

172. **`fsync` in `write_json_atomic`.** `storage.rs:36-50` does `fs::write(tmp)`
    then `fs::rename(tmp, path)` with **no `sync_all()` on either the file or the
    parent directory**, so the rename can be ordered ahead of the data. An
    accepted trade on a desktop; a data-loss path on a machine defined by being
    unplugged rather than shut down. **Must land before any Eldrun-authored JSON
    is ever written server-side**, and it is a two-line change worth making
    regardless.
    - [ ] 🤖 Automated test — the write path calls `sync_all` on the temp file and
      on the parent directory handle before returning (assert via a seam, not by
      pulling the power).
    - [ ] 🖐️ Manual test — n/a beyond "nothing regressed"; correctness here is not
      observable without a crash rig.

---

### Z.1 — Provisioning, identity, connectivity (#173–#178)

173. **The provisioning script.** `scripts/eldrun-server-setup.sh`, POSIX `sh`,
    **idempotent and re-runnable**: create the service user and
    `~/eldrun-server/{repos,radicale,state}`, install and enable `radicale`
    **bound to `127.0.0.1`**, seed its config + rights file, write an
    `authorized_keys` entry, `flock`-guard `catalog.json` from day one (two people
    creating a project simultaneously is a real race and retrofitting it is worse),
    and print a JSON summary. **Checked in** (so CI can shellcheck one copy) and
    `include_str!`'d — never a Rust string literal. This is the most dangerous
    artifact in the group: it runs privileged, and a half-applied provision the
    user then re-runs the wizard against is the failure that leaves someone with a
    broken Pi and no error.
    - [ ] 🤖 Automated test — shellcheck in CI; the parsers for its JSON summary
      are pure Rust unit tests in `services/eldrun_server.rs` (the
      `slurm.rs`/`hpc_ws.rs` convention).
    - [ ] 🖐️ Manual test — run it twice on a fresh Pi; the second run changes
      nothing and reports success. Run it against a half-provisioned box and it
      completes rather than erroring.

174. **Backend RPC surface.** New `services/eldrun_server.rs` (embedded script,
    slug validation, **pure** parsers for `status` / `catalog` output — unit-tested
    in isolation) and `commands/eldrun_server.rs` (`_status`, `_list_repos`,
    `_create_repo`, `_catalog`, `_ship_setup_script`, `_invite_export/_import`),
    all over the existing `run_remote_script` / `remote_command`
    (`services/ssh_exec.rs:701,273`). New `schema/eldrun_server.rs` persisted at
    `<state_dir>/eldrun_servers.json`. **No command takes a filesystem path** (the
    `mail.rs`/`browser.rs` boundary rule), and **every struct carries
    `#[serde(flatten)] extra`** — clients and server will be at mixed versions
    permanently, so the `CALENDAR_VERSION` rule applies with more force here than
    anywhere: fields are additive-only and the server's `VERSION` is **displayed,
    never branched on**.
    - [ ] 🤖 Automated test — status/catalog parsers against fixture output
      including a truncated and a garbage reply; a slug with `..`, `/` or a NUL is
      rejected; an unknown field in a server reply round-trips through `extra`
      rather than being dropped.
    - [ ] 🖐️ Manual test — each verb against a real provisioned server.

175. **Person/device identity and invite codes.** `schema/hub.rs`:
    `Person{id, display_name, devices}`, `Device{id, label, ed25519_pub, added_at,
    last_seen, trust}` where `trust` reuses `SignerTrust::{Known, Verified}`
    (`services/mail_pgp.rs:117,126`) — **the PGP stack's UX model, not its crypto**:
    the `Known` → explicit "I compared the fingerprint" → `Verified` promotion
    (`mail_pgp.rs:34,246-248`) is exactly the right shape for approving a device.
    Device keypair via `ssh-keygen -t ed25519` into `<state_dir>/hub/<server-id>/`;
    fingerprints reuse `ssh_common`'s existing `ssh-keygen -l` parser
    (`:1625,:1646`). The invite code encodes
    `fingerprint ‖ invite-id ‖ secret ‖ checksum`, is **single-use and time-boxed**,
    and the client **pins the host key from the code** — strictly stronger than the
    TOFU path, which is why "type a hostname to enrol" must **not** be offered.
    Its human-readable part reveals a fingerprint and an opaque id and **never a
    display name or hostname**, because the code gets pasted into chat.
    The server's `authorized_keys` is generated from this table with
    `command=`/`restrict`; revoking a device is one line removed plus a
    ControlMaster sweep.
    - [ ] 🤖 Automated test — keypair round-trips; an invite encodes/decodes;
      an expired invite, a reused invite and a single flipped character are each
      rejected; revoking one device leaves the person's other devices valid.
    - [ ] 🖐️ Manual test — two machines, two device keys, one person; revoke one
      and confirm the other still syncs and the revoked one is refused.

176. **The Team settings panel and setup wizard.** Add `"team"` to
    `SettingsPanelKind` (a closed union at
    `src/components/layout/SettingsPanel.tsx:659`) plus a `.settings-nav-item`.
    Settings rather than the project dialog, for `MachinesIndicator`'s reason: **a
    server is machine-wide and the projects on it come and go.** Composes
    `RemoteProjectSection` + `useRemoteBrowse` + `TerminalSignInToggle` +
    `runInstallInTab` (`src/lib/installCommand.ts:69`) and **adds no login
    machinery of its own** — `SavePasswordRow` off `useSavedCredentialSource`
    verbatim (opt-in, **default off**, sends `true | null` and never bare `false`,
    4 s keychain bound, locked-keyring banner). Provisioning ships the script over
    the pooled SFTP and opens a **root-terminal tab** running it — not
    `curl … | bash` (we have nowhere to host it and piping the internet into a root
    shell is not a thing to teach), and not `run_remote_script`, because
    provisioning is interactive and privileged and must not be headless. Canonical
    chrome only (`styles/themes.css:11829`); **no presets, ever** — the rule
    `CalDavAccountDialog` already states, since this repo is public and a preset
    list could only name institutions. Carries `UntestedTag`.
    - [ ] 🤖 Automated test — the panel renders for `"team"`; the save-password row
      never emits bare `false`; a portaled dialog sets an explicit `color`.
    - [ ] 🖐️ Manual test — full wizard against a fresh Pi, including first-contact
      `HostKeyConfirmDialog` and the locked-keyring banner.

177. **Register the server as a machine, tagged so nothing sweeps it.** A server
    *is* a machine: add it to the global machines list and tag it `careful_hosts`
    (`schema/settings.rs:330`) on registration so no `du -ak` census, GPU probe,
    monitor poll or lockstep loop ever dials it — the existing dial policy
    (`services/hpc_mode.rs:165`) then enforces this inside the argv builders rather
    than relying on the UI. Extend `MachineIo`/`GlobalMachine`
    (`commands/global_machines.rs:19-45`) with an optional `eldrun_server: bool`;
    that export format **already** carries host/port/label and deliberately **no
    id, no `auto_connect` and no `user`**, built for "share this host list with
    colleagues who each log in as themselves" — **it is the invite file, and this
    is the single highest-leverage reuse in the group.** Consider a distinct
    `server` role that hides run-host selection entirely, since the UI will
    otherwise cheerfully offer to open a run tab on the Pi.
    - [ ] 🤖 Automated test — a server-tagged host is skipped by the background
      probe argv builders; export omits `user` and any secret; import round-trips.
    - [ ] 🖐️ Manual test — register a server, confirm no background traffic in
      `journalctl` on the Pi over an idle hour.

178. **The SSH loopback forward for CalDAV.** Radicale binds `127.0.0.1:5232`;
    the client raises `ssh -O forward -L 127.0.0.1:<local>:127.0.0.1:5232` against
    the ControlMaster it already holds (plus `-O cancel` and a liveness probe), and
    the CalDAV account points at `http://127.0.0.1:<local>/` —
    `normalize_base_url` (`services/caldav.rs:467-482`) already honours a typed
    `http://` for exactly this case. **One credential for everything, no TLS, no
    PKI, and the Pi exposes exactly one port.** **Unix clients only** —
    Win32-OpenSSH has no ControlMaster (`todo/group-h-crossplatform.md:10-13` records the gap),
    so Windows reaches Radicale over the LAN/VPN directly. That must be a **stated
    capability, not a silent degrade**: the `browser_capabilities` precedent — ask
    the backend what is supported, hide the control where it is not, name the
    reason. **No cert-ignore hatch is added, here or anywhere** (invariant 4).
    - [ ] 🤖 Automated test — the forward argv is well-formed; cancel is issued on
      teardown; the Windows path reports unsupported with a named token rather than
      silently falling through.
    - [ ] 🖐️ Manual test — CalDAV sync succeeds through the forward with the Pi's
      port 5232 firewalled off from the LAN.

---

### Z.2 — Calendar and to-do over CalDAV (#179–#182)

179. **The Eldrun server as a CalDAV account.** No new sync engine: it *is* a
    CalDAV account, so it composes with Group X for free — same
    `caldav/accounts.json`, same sidebar rows, same `merge_caldav_calendar_at`,
    same `CalDavSyncHost` timer, and `allow_write` is already per-account so a
    read-only institutional calendar and a writable self-hosted one coexist with no
    new concept. Per-collection permission is **asked of the server**
    (`current-user-privilege-set`) and never inferred locally; `read_only` already
    defaults **true** on deserialize. In `CalendarSidebar.tsx:288-302` a team
    calendar is **the existing per-calendar sync row with a different badge** — do
    not build a second affordance. `Calendar.extra` makes `extra["team"]` additive.
    - [ ] 🤖 Automated test — a collection the server reports as read-only is
      read-only in Eldrun with no local configuration; a write to it is refused at
      the client *and* the refusal is surfaced, not swallowed.
    - [ ] 🖐️ Manual test — two people, two machines, one shared calendar: events
      and VTODO fields converge; each also has a private collection.

180. **Three-way merge on 412, and the conflict dialog.** Keep the row as the
    server last gave it (a *stored base* — `caldav_base` in `extra`, or a sidecar
    keyed by href). On a 412: re-fetch, merge base/mine/theirs **field-wise**,
    re-`PUT`. **Only fields both sides changed *differently* raise a dialog**, which
    turns the common case — Alice moves the room while Bob fixes the title — into
    silence. Keep-mine must re-read the ETag first (`caldav_resource_etag`,
    `commands/caldav.rs:656-670`) so an edit landing between question and answer
    conflicts again rather than being lost. This is the answer to the second
    question `docs/caldav_plan.md:490-499` asks and does not answer. **Known
    limitation to state in the UI, not to fix:** a "this occurrence only" edit
    rewrites the whole master resource, so a 412 on a recurring series means
    "something about this entire series changed elsewhere" — the merge helps but
    cannot fix the granularity, which is CalDAV's, not ours.
    - [ ] 🤖 Automated test — different-field edits merge with no dialog;
      same-field edits raise one naming both values; keep-mine re-reads the ETag.
    - [ ] 🖐️ Manual test — two machines, concurrent edits of one event, both cases.

181. **The timezone detector.** Every stamp is floating local wall-clock
    (`schema/calendar.rs:11-13`) and `parseIcsDate` **ignores `TZID` entirely**
    (`src/lib/ics.ts:133-159`), so `DTSTART;TZID=Europe/Berlin:20260801T140000`
    already lands as floating `14:00` regardless of the reader's zone. Invisibly
    correct for one person in one zone; **silently wrong across zones** — Alice in
    Berlin creates 14:00, Bob in Boston sees 14:00 and arrives six hours late, and
    nothing anywhere reports it. Ship a **detector, not a fix**: the server records
    each client's UTC offset at sync and the calendar banners on mismatch. Turns a
    silent wrongness into a visible one, which is this codebase's standing posture.
    **Real timezone support is deliberately deferred** (`tzid` per event would force
    every stamp consumer to convert — `calendarTime.ts`, `recurrence.ts` across DST,
    `expandEvents`, alarms, the grid, `occurrence_start` *as a key*, and the civil
    arithmetic at `schema/calendar.rs:808-900` — a multi-week project with a long
    DST bug tail touching the most-read code in the app). **Decide before #183:** a
    shared board full of wrong times is worse than no shared board.
    - [ ] 🤖 Automated test — two client offsets on one collection raise the
      mismatch state; one offset does not.
    - [ ] 🖐️ Manual test — set two machines to different zones and confirm the
      banner appears and names both.

182. **Migration of the existing single-user calendar.** Every user has a
    `~/.local/share/eldrun/calendar.json`; make it server-backed without loss, and
    make leaving the server give the data back. The migration must be **resumable
    and idempotent, keyed on UID**: if a bulk upload is interrupted between the
    `PUT` and `set_caldav_identity_at` (`commands/caldav.rs:552-555`), the row is on
    the server but unstamped and the next sync creates a **second local copy** —
    the create is `If-None-Match: *` so a re-run refuses server-side, but the local
    duplicate is real. Unreachable server must degrade to local-only cleanly.
    - [ ] 🤖 Automated test — an interrupted migration re-run produces no
      duplicates; a UID is never re-minted on a write; a row is stamped only after
      the server accepted.
    - [ ] 🖐️ Manual test — migrate a real calendar, kill the app mid-upload,
      re-run, and diff the result.

---

### Z.3 — The board overlay (#183–#187)

183. **The overlay service.** The native side channel for what CalDAV cannot
    carry — `column`/`rank`/`tags`/`subtasks`/`project_id`/`created`
    (`schema/calendar.rs:400-457`). An **append-only op log** over the same
    forced-command SSH RPC, with a **server-assigned monotonic `seq`** for ordering
    and `since=<seq>` incremental pull plus a snapshot fallback. **Payload rows stay
    opaque and unindexed server-side** — this is what keeps sealed payloads possible
    later (plan Q4), and once the server parses or indexes them, sealing is off the
    table forever. Per-collection opt-in, **same-server-only** (uploading metadata
    about your employer's VTODOs to your team's Pi is a leak however convenient),
    and it **must not read Radicale's collection directory** to learn what exists —
    the standing no-foreign-app-paths rule, and it would couple us to Radicale's
    on-disk layout. **The overlay needs no tombstones of its own**: a row's lifetime
    is subordinate to its UID's object, which is CalDAV's fact to assert, so GC is
    "prune rows whose UID the owning collection no longer has", triggered by an
    explicit client-reported 404 with count-based retention as the backstop.
    - [ ] 🤖 Automated test — a snapshot **does not** delete overlay rows for UIDs
      the server does not know (they may be local-only cards — the events/tasks
      asymmetry, one layer up); a too-old `seq` requests a snapshot rather than
      silently resyncing nothing.
    - [ ] 🖐️ Manual test — two machines, a day's worth of ops, convergence.

184. **The overlay client: HLC, LWW, and the rules that are not obvious.**
    Per-field LWW ordered by a **client HLC** (UTC epoch millis + logical counter +
    node id — and that does **not** violate the schema's no-UTC rule, which is about
    *displayed calendar data*; sync metadata is not displayed and must be absolutely
    ordered, and `SystemTime::now()` is in std so no crate is needed). Not vector
    clocks (grow with the user count, buy ordering nobody needs), not
    LWW-by-arrival (an offline client's stale edits would beat fresh ones), not bare
    wall-clock (skew). The rules:
    **`(column, rank)` is ONE atomic LWW unit** — splitting them puts a card in the
    right column at a meaningless position, which reads as corruption;
    **tags and subtasks are OR-Sets**, not LWW lists (an LWW list makes a concurrent
    add lose one and the user cannot tell which; `Subtask.id` is already stable and
    backfilled at `:296-307`, so it is the CRDT key for free);
    **reindex is a server op** (a whole-column renumber is not commutative, and
    per-card LWW across two concurrent renumberings interleaves into arbitrary
    order) and is **atomic** — the whole column moves at one `seq` or not at all;
    **an offline outbox replays with the ops' original HLCs**, never the reconnect
    clock; and **`CalendarTask.mail` is never synced** (it keys *that machine's*
    sealed store and snapshots a private subject line). Two clients inserting at the
    same index needs **no new machinery** — both compute the same midpoint and
    `column_order`'s `total_cmp().then(id)` tie-break (`commands/calendar.rs:209`)
    makes both replicas agree. Outbox state is surfaced as "N changes waiting to
    send"; failure is visible, never silent.
    - [ ] 🤖 Automated test — property tests: a permuted op set converges to one
      state (commutativity under HLC order) and applying any op twice is a no-op
      (idempotence, which `normalize` already demands of itself); `(column, rank)`
      never splits across a merge; `mail` never appears in an outbound op.
    - [ ] 🖐️ Manual test — two people drag cards on one board; a card dragged into
      Done on one machine reads complete in the other's Tasks view; a day offline
      reconciles without losing a tag or a subtask tick.

185. **Collection-scoped columns.** Sharing `(column, rank)` requires shared
    column ids. The seeded set has **stable slug ids** (`backlog/today/doing/done`,
    `schema/calendar.rs:266-285`) so default boards already agree — but a
    user-added column is a uuid that dangles on the peer, where `normalize` step 3
    **silently refiles the card to Backlog** (`:639-641`) and the peer watches it
    teleport with no error anywhere. Either columns become collection-scoped
    (recommended) or the board is shareable only at default columns. Note the
    coupling: **"a read never creates a board"** (`ensure_board` is write-path-only,
    `:552-561`) needs a server equivalent, or every member's first read mints a
    different column set.
    - [ ] 🤖 Automated test — a card in a column id the peer lacks is **not**
      silently refiled; a pull never seeds `task_columns` in a calendar-only user's
      file.
    - [ ] 🖐️ Manual test — add a column on one machine, place a card in it, and
      confirm the other machine shows it in that column rather than in Backlog.

186. **Assignee and attribution.** `assignee` as an overlay field (**not
    `ATTENDEE`** — iTIP is out of scope), rendered as an initials chip on
    `TodoCard` beside the existing project chip, picked in `TodoCardDialog` (the
    card has no room for a picker — the same reasoning that put step renaming in the
    dialog). It must merge as a **server-owned** field (overwritten), **not** like
    `column`/`rank` (preserved locally), or two people cannot reassign each other's
    cards. Plus "last moved by", and an activity feed **derived from the op log**,
    which costs nothing because the log already is the feed. Board filters stay
    unpersisted and per-person (`stores/todo.ts`), including a new "assigned to me".
    **`TodoIndicator`'s badge must count *your* cards, not the team's** — its whole
    rationale is "what today actually demands", and a team-wide overdue count never
    falls. Carries `UntestedTag`.
    - [ ] 🤖 Automated test — `assignee` is overwritten by the server on merge
      while `column`/`rank` are preserved; the indicator badge counts only the
      current member's cards.
    - [ ] 🖐️ Manual test — reassign a card from each machine in turn.

187. **The conflict case matrix and the replay harness.** A matrix in the style of
    [`docs/git_lockstep_case_matrix.md`](../docs/git_lockstep_case_matrix.md),
    **explicitly not trusted until run live** — that document records that **4 of 28
    cases were "reported green" by the unit tests and were wrong against a real
    host** (`:8-14`), every one of them a no-op computing to `Synchronized`.
    **Expect the same class here: a sync that transferred nothing and reported
    success.** Axes and the rows to write first are in the plan's §11; the
    highest-value single row is **"both layers in one gesture"** — a drag into Done
    writes `column`+`rank` *and* `percent`+`completed`
    (`commands/calendar.rs:277-293`). Two harnesses, both following
    `src-tauri/examples/lockstep_drv.rs` so a case exercises shipped code:
    deterministic in-process replay (N clients, no network) and live two-machine QA
    against a real Radicale.
    - [ ] 🤖 Automated test — the replay harness runs the matrix's mechanisable
      rows in CI.
    - [ ] 🖐️ Manual test — the full matrix live, two machines, results recorded in
      a `docs/eldrun_server_live_qa.md` the way lockstep's was.

---

### Z.4 — Shared projects, read-only (#188–#192)

188. **Bare repo hosting and the project catalog.** `repos/<slug>.git`, setgid,
    `sharedRepository=group`; `catalog.json` (`{slug, title, description,
    created_by, visibility}`) read and written through the forced command under
    `flock`. **The server is authoritative for a project's *existence*, never for
    its *destruction*:** a local clone is a working copy, deleting it locally never
    deletes the server's, and a project vanishing from the catalog **must never
    delete or reset a clone** — it becomes an ordinary local project. That is the
    `probe_error` wipe-safety rule `extend_project_to_remote` already enforces (a
    transient failure never licenses `reset --hard`), and disposal goes to the
    existing holding area (`paths.rs:385`). **A bare repo is also the backup story**:
    every collaborator's clone is a full copy of the history, which is the strongest
    argument for bare git over any database.
    - [ ] 🤖 Automated test — a catalog fetch failure never triggers a local delete
      or reset; concurrent `create_repo` calls both succeed or one cleanly fails,
      never a corrupt catalog.
    - [ ] 🖐️ Manual test — remove a repo from the server and confirm the member's
      clone survives as a local project with a stated reason.

189. **"Share on my server…" — one pill-menu entry.** Beside the existing publish
    entries; a `.project-dialog` that is 90% the publish dialog (server, repo name,
    role defaults for new members rendered from the **server's** answer — the
    `read_only` rule: ask, don't assume). On success: `git_type` →
    `remote-private` and `extra["shared"]` written onto the `ProjectEntry`
    (additive via `schema/projects.rs:16`'s `extra` flatten — the same
    migration-free move `compute_hosts` made). **The member's own identity in that
    entry is scrubbed on any export path**, exactly as `MachineIo` scrubs `user`:
    the server address is shareable, the credential is not. Depends on #170.
    Carries `UntestedTag`.
    - [ ] 🤖 Automated test — sharing sets `git_type` and `extra["shared"]`; an
      export of a shared project's entry contains no credential and no user.
    - [ ] 🖐️ Manual test — share a project, confirm the bare repo and catalog entry.

190. **"From my server" — a fourth import source, and the duplicate gate.** No new
    dialog: `ProjectDialog` already has folder / clone / fork, so add a fourth
    source listing the server's registry filtered to your memberships; everything
    downstream is the existing clone-then-import path. **`ProjectSite` must gain a
    server-hosted variant and `find_project_conflict` must know it** — Group O #152
    exists precisely to make "is this already a project" one gate, and if this is not
    decided before the phase ships, two people import the same server repo twice,
    with two mirrors and two lockstep states driving one server tree, and the
    duplicate gate will not catch it. The container row already defaults **on for an
    import**; for a shared project the argument is stronger and the default stays on.
    **Group O #58's security stage should be *set* by the join flow, not bypassed** —
    a project cloned from a colleague's server is precisely "code the user hasn't
    read"; do not build a parallel permission model.
    - [ ] 🤖 Automated test — a double-join is refused and offers to open the
      existing project, before any clone starts.
    - [ ] 🖐️ Manual test — two Eldrun profiles against one server: A shares, B joins
      and gets a working project; B joins again and is refused.

191. **Force-disable lockstep and byte-sync on a shared project, and say why.**
    The lockstep engine's correctness arguments all assume **one human** (plan §6.2,
    with citations): `detect_and_sync` follows the *peer's* checkout onto your
    working tree on a 12 s poll; `git clean -f -x` reasons about "residue **this
    install** created"; **`resolve` force-resets over the loser's uncommitted
    *tracked* work after checking only `ls-files --others`, with `dirty_tracked`
    computed and never consulted, and records nothing when the destroyed side is the
    host**; a dirty host becomes a permanent deadlock rather than a transient one;
    and `sync_push(force)` overwriting a colleague's file is unpriced and
    unrecorded. Byte-sync stays *safe* with N humans and becomes *useless* —
    permanently amber, because every base manifest is per-machine. So: a shared
    project sets `GitPeerState.enabled = false` **explicitly** (the existing rule is
    that lockstep is written as explicit per-project state, never
    `GitPeerState::default()`), byte-sync is off, and **the Share dialog states in
    one sentence that conflicts are resolved with git, the way you already do** —
    the single most important piece of copy in the feature. A merge UI is a non-goal.
    - [ ] 🤖 Automated test — a project with `extra["shared"]` cannot have lockstep
      or byte-sync enabled; the guard fails the test if deleted.
    - [ ] 🖐️ Manual test — two members commit on one branch and resolve by
      `pull --rebase` in a terminal; no Use-local/Use-remote prompt appears.

192. **Presence.** A heartbeat `{project_id, member, host_label, ts}` every ~30 s
    against a TTL'd server set, and a `👥 N` chip beside the existing category dots
    on the pill (`ProjectPill.tsx:2287-2297`) — N is *other* members online, hidden
    at 0 rather than showing `0`, `title` naming them. Server connectivity reuses
    `ConnLamp`'s four states (`stores/remoteStatus.ts:10`) with `busy` orthogonal;
    aggregate by status the way `RemoteConnMenu` already does rather than growing a
    row of near-identical dots, and **presence is a count, never a fifth colour**.
    **One poll per window, not per pill** — a `stores/presence` with
    `stores/hostSessions`'s refcounted-subscriber shape, since "sessions are a
    property of the host, not of the surface looking at one". **Advisory locking is
    deliberately not built**: the unit of conflict here is a commit and git reports
    it better and later; Eldrun does not own the editor (files open in `xdg-open`'d
    external apps), so a lock it cannot enforce would be routinely and invisibly
    violated; and the one case a lock would help — the long-running job — is already
    visible via `stores/hostBusy` and the Sessions view. Extend the existing busy
    signal to say *whose* session it is (the tmux name already carries
    `eldrun-<scope>--<uuid>`) instead. Carries `UntestedTag`.
    - [ ] 🤖 Automated test — a vitest over the pure "who is online" reduction
      (TTL expiry, self excluded, dedupe across a member's devices); one poll is
      shared by N mounted surfaces.
    - [ ] 🖐️ Manual test — open the project in a second install; the first reads
      `1` within an interval and clears within TTL.

---

### Z.5 — Writable shared projects — **GATED** (#193–#196)

> These four do not ship until #193, #194 and #195 all land. If #193 cannot be
> resolved, **writable project sharing does not ship at all** and read-only
> (#188–#192) is the end state — which the plan argues may simply be correct,
> the same conclusion `docs/context/caldav.md` reached for CalDAV push.

193. **Pin `core.hooksPath` for shared projects — close Group O #151's residual.**
    #151 mitigated `.git/config` by shape-based key stripping
    (`commands/git.rs:196,232,269`) but **explicitly left `.git/hooks/*`,
    `core.sshCommand` and `credential.helper` residual**, reasoning that they fire
    only on **user-initiated** Commit/Push/Checkout and "a repo's own hooks are a
    feature" (`todo/group-o-security.md:398-411`). **That premise is false under multi-user:
    the hooks are someone else's, and Commit/Push/Checkout is what collaboration
    consists of.** A hook is a file in a well-known directory, not a config key, so
    no denylist reaches it. Fix: pin `core.hooksPath` to an empty, Eldrun-owned
    directory for shared projects as a per-invocation `-c`, threaded through
    `hardened_git_command_in` (`:269`) so every existing call site inherits it. The
    named cost: a shared repo's legitimate hooks are inert — the same shape as the
    Git-LFS cost the config sanitizer already accepts. **There is no third answer**;
    a hook is an arbitrary script so no value-level allowlist exists, and "trust
    your collaborators" is not a mechanism.
    - [ ] 🤖 Automated test — bidirectional, in #151's own style
      (`a_repos_own_config_cannot_run_a_program_on_the_host`): plant a hook in a
      shared project and assert it does not fire on commit, push or checkout.
    - [ ] 🖐️ Manual test — plant a hook from machine 2 and confirm nothing runs on
      machine 1.

194. **The agent-surface review gate.** `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
    `.claude/settings.json` and `.claude/skills/**` all steer an AI agent, and
    Eldrun **scaffolds and git-tracks `.claude/settings.json`** (`commands/projects.rs:2229`,
    asserted `:3877-3879`) — so it travels between collaborators **by design**, and
    a skill arriving via sync bypasses the Skills Library preview entirely (#155).
    **Nothing today reviews an incoming change to any of it.** Record a digest of
    that file set in `<state_dir>/sessions/<project id>/`; a changed digest **blocks
    the next agent spawn** in that project until the user has seen the diff, and the
    decision is hash-keyed so it re-asks when the bytes change again. This is Group
    O #143's shipped `spec_source_hash` / `NeedsConfirmation` machinery applied to
    the file set that steers the agent instead of the one that builds the image, and
    the dialog must name **who** changed it, not just what. Safe default after a
    change: **Plan** mode for the first agent tab (#87) — noting the known gap that
    Codex is absent from the capability table and gets no Plan floor. **Open
    question (plan Q9):** per-change review is safe but noisy and
    `docs/sandbox_hardening_plan.md` warns a per-repo confirmation "decays to a
    reflex click"; per-author is the current lean.
    - [ ] 🤖 Automated test — mirroring #143's
      `set_project_sandbox_decline_sticks_until_dockerfile_changes`: a decline
      sticks until the bytes change; plus a tripwire that the digest is read from
      the state dir and **never** from the project tree.
    - [ ] 🖐️ Manual test — machine 2 edits `CLAUDE.md`; machine 1's next agent spawn
      is blocked pending a diff.

195. **Container-mandatory, with an explicit refusal.** A writable shared project
    runs in a container or it does not run. Where containers are unavailable —
    Windows (`commands/terminal.rs:292-293` refuses outright) or a remote project
    (`services/sandbox.rs:505-512` forces `sandbox` off) — collaboration is
    **refused with a named reason**, never silently downgraded. This **conflicts
    with Group O #147**, whose conclusion ("warn, don't refuse", because refusing
    would break projects extended from a container-toggled local one) is correct for
    solo use and wrong for a writable shared project. Both can coexist: **warn if
    solo, refuse if shared.** Also raises the severity of two existing items:
    #146 (a repo-planted `.venv`, `commands/python.rs:132-158`, stops being "a repo
    I cloned once" and becomes "a directory another person writes to continuously" —
    ask-once-per-project becomes the fix, not a nicety) and **#145** (cross-project
    *read* of `~/.claude/projects` is still open after the write-narrowing at
    `services/sandbox.rs:1423-1459`; under sharing, a container running a
    collaborator's code reads **your every other project's conversation history** —
    that moves it from a confidentiality nice-to-have to a real leak, and it should
    be reprioritised).
    - [ ] 🤖 Automated test — a shared project on a container-unavailable platform
      refuses with a named reason rather than spawning; a solo project on the same
      platform still warns and proceeds.
    - [ ] 🖐️ Manual test — attempt a writable shared project on Windows and confirm
      the refusal names why.

196. **Shared-host hazard guards, and one stale doc.** Only needed if a shared
    *work* host mode is ever wanted, but each is a real hazard today:
    **`remote_kill_all_jobs` is machine-wide** — `tmux kill-server`
    (`commands/ssh.rs:753-775` → `services/ssh_exec.rs:347`) ends every session, every
    project, **every user**, and it is offered from the header Machines menu;
    **a shared tmux session evicts the other person** — the wrap is
    `tmux new-session -A -D` and `-D` detaches any other client, so two people take
    turns kicking each other out silently (`filter_sessions_for_project` already
    makes the Sessions *view* multi-user-aware; the *attach* is not);
    **`resolve` has no `dirty_tracked` guard** (`git_peer.rs:2859-2882`) — a genuine
    single-user hazard too, and worth fixing regardless, since the value is computed
    and simply not consulted. Build the guards **structurally**, in the same
    three-guard style `ComputeHost.shared_fs` uses, so deleting one fails a test.
    **Also fix the stale doc:** `docs/context/tmux_sessions.md` still claims
    `remote_disconnect` / `remote_disconnect_all_hosts` end every tmux session on the
    host; `commands/remote.rs:16-22` records that this was **removed** precisely
    because it destroyed sessions on a plain project switch. Fix it before anyone
    reasons about shared-host behaviour from the doc.
    - [ ] 🤖 Automated test — one test per guard, each failing if the guard is
      deleted; `resolve` refuses when the destination has dirty tracked files.
    - [ ] 🖐️ Manual test — two members on one host; neither can silently end the
      other's session.

---

### Z.6 — Cross-cutting (#197–#199)

197. **i18n — budget it as work, not as a tidy-up.** `src/lib/i18n.ts` is a single
    ~21.5k-line file; `const en` (`:46`) is the source of truth and
    `TranslationKey = keyof typeof en` (`:4379`), with
    `src/__tests__/i18n.test.ts` enforcing full parity across en/de/es/fr/it —
    missing keys (`:58`), extra keys (`:71`) and placeholder mismatches (`:91`) all
    fail the suite, **which now runs in CI** (Group Y #161). Realistic estimate for
    this group: **60–90 new keys × 5 = 300–450 entries**, all in one file. **i18n
    runs inside each phase, never after it.** One saving grace that must be
    honoured: **the server speaks tokens, the frontend speaks sentences** — the
    `web_safety::REASON_TOKENS` + `lib/browser.ts` `reasonPhrase` pattern, with a
    tripwire test reading the token list out of the Rust source. **Server error
    reasons must be a closed token set, never prose.**
    - [ ] 🤖 Automated test — the existing parity suite passes; a new tripwire
      asserts every server reason token has a frontend phrase.
    - [ ] 🖐️ Manual test — switch languages with the Team panel open.

198. **`docs/context/eldrun_server.md`.** The *why* doc, per the root `CLAUDE.md`
    convention: the invariants (plan §8 — 24 of them, each with its reason), the
    threat model, and the two rules that are easiest to break by accident — **the
    server is the only authority on permission** and **nothing on the unattended
    path may depend on the OS keychain**. Also record, as a second deliberate
    exception beside the `agent_session` hooks, whichever way plan **Q2** is decided
    (Eldrun authoring a Radicale config vs. the never-manipulate-another-app's-config
    rule — the two standing rules genuinely collide and one must be given a
    documented exception). Add the row to `CLAUDE.md`'s topic-doc table.
    - [ ] 🤖 Automated test — n/a (documentation).
    - [ ] 🖐️ Manual test — n/a.

199. **The access log.** Append-only, `(timestamp, person_id, device_id, verb,
    resource_id, result)` and **nothing else** — no titles, no card text, no paths
    beyond a resource id, and **no IP addresses** (which `scripts/privacy-check.sh:56`
    would flag in any fixture anyway and which tell you nothing on a home LAN).
    Bounded retention (90 days), pruned on write, the bucket-and-prune shape
    `schema::usage_stats` already uses. Two rules make it defensible: it is
    **symmetric** (each person reads the log of their own actions; a resource owner
    reads the log for their resources; **nobody gets a server-wide view of
    everyone**) and it is **not disable-able** (a log a user can turn off is
    worthless as an audit trail and worse than none as a promise), so it is kept
    small enough to be uncontroversial and stated at enrolment. **The privacy cost is
    named, not minimized: this is the first place in Eldrun where one person's
    activity becomes legible to another.** It must **never** feed usage stats, never
    leave the server, and never enter the daily recap — that feature reads local
    sources *at their source* precisely so they cannot drift, and a server-sourced
    counter would turn a local-only feature into a network one.
    - [ ] 🤖 Automated test — a non-owner cannot read another person's rows;
      retention prunes; no field outside the six-tuple is ever written.
    - [ ] 🖐️ Manual test — confirm the daily recap is unchanged with a server
      configured.

---

### Privacy checklist for this group (public repo)

`scripts/privacy-check.sh` flags, **in added lines**: email-shaped strings
(`:52`), **any dotted quad** (`:56` — including `127.0.0.1`, and including
RFC-5737 documentation addresses), `password[:=]` / `secret[:=]` / `api_key[:=]`
(`:53-54`), private-key headers and `ssh-rsa AAAA` (`:54-55`), and `$USER`/`$HOME`
unless `PRIVACY_CHECK_SKIP_IDENTITY=1` (`:58-61`); only `noreply` is whitelisted
(`:80`). This group must never ship:

- **A default server hostname, mDNS name, IP or port.** The address comes from the
  invite code or the user's typing, always. `hpc_ws.rs` is the model: the host is
  *asked* what it offers, and the only site-shaped list is the names of variables
  to probe.
- **Example configs naming real people.** Seed from `$USER` at runtime; the display
  name field starts empty. No `alice`/`bob` fixture that is actually a colleague.
- **Fixtures with addresses.** Use `.invalid` hostnames (`server.invalid`,
  `peer.invalid`) and **no literal IPs at all**. The loopback-forward code and its
  docs will trip `:56` — reviewable and fine (`openvpn.rs` already carries
  `127.0.0.1` for its management socket), but every *doc example* uses
  `server.example` / `<host>` placeholders, never a numeric address.
- **Fixture device keys** must be freshly generated throwaway Ed25519 with a
  comment of `test` — never a real `known_hosts` line, never anything matching
  `ssh-rsa AAAA`.
- **A display name or hostname in the invite code's human-readable part** — it gets
  pasted into chat.
- **A second `git_token`.** That one is still plaintext in `settings.json`
  (`schema/settings.rs:27`) and now genuinely read (`commands/git_hosting.rs:142`)
  despite `services/git_credentials.rs` existing to hold it. Every server secret
  goes to a key file or the keychain, **never** to `settings.json`.
