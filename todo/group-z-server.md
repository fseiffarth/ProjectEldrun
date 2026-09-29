## Group Z — Eldrun Server: one server, several users, thin clients

*Plan only; nothing is built. Design: [`docs/eldrun_hosted_plan.md`](../docs/eldrun_hosted_plan.md).
One Linux server runs every user's projects, terminals and agents. Desktop
browsers and the phone PWA are thin clients. Each user gets a daemon under
their own uid and signs in to their own agent CLIs (the admin may offer API
keys). A shared project is a bare hub repo with one clone per member. Mail,
calendar and todo are per user: mail is always private, a calendar or todo
list can be opened to other users, and the admin and each user can switch
each of the three off.*

*Rewritten 2026-09-29. The earlier sync-server design (a Pi with sshd,
Radicale and bare git repos; items #173–#199) was removed with its plan and
lives on in git history at `1441eb0e`. Only its design-independent
prerequisites remain below. Backlog items for the new plan's phases P0–P5 are
added here once §12 Q1, Q3 and Q4 are answered.*

---

### Z.0 — Prerequisites and pre-existing debt (#169–#172)

*Kept from the removed sync-server design because each is worth doing on its
own. #171 and #172 are H0 of [`docs/headless_owner_plan.md`](../docs/headless_owner_plan.md),
the desktop groundwork the hosted plan's P1 builds on.*

169. **Live-test the CalDAV push work.** *Code-complete as of 2026-07-29 (still
    uncommitted at time of writing).* `caldav_push` / `caldav_delete` /
    `caldav_resource_etag` / `caldav_refresh_access`, `put_resource` /
    `delete_resource` / `WriteCondition`, `CalDavAccount::allow_write`, the
    conflict dialog this item asked for (`CalDavConflictDialog`, three answers and
    no *merge*), and the `UID`/`RECURRENCE-ID` round-trip the resource
    serialization needs are all in the tree with tests; `todo/group-x-caldav.md`
    #160 and `docs/context/caldav.md` now describe that state rather than denying
    it. What is left is the part no test can stand in for: **nothing in the CalDAV
    stack has ever spoken to a real server.** Still riskier than its size, and
    a prerequisite for offering CalDAV on the server (plan Q7).
    - [x] 🤖 Automated test — a create sends `If-None-Match: *` and an update
      `If-Match`; a write with no known ETag is **refused** rather than sent
      unconditionally (`services::caldav::an_update_with_no_known_etag_is_refused…`);
      the local gate needs both the user's opt-in and the server's
      (`commands::caldav::a_write_needs_both_the_users_opt_in_and_the_servers`);
      the store-level gate and the refused-delete rejection
      (`src/__tests__/calendar/CalDavPushGate.test.ts`).
    - [ ] 🖐️ Manual test — Radicale in a container + Thunderbird: create/edit/
      delete an event and a task from Eldrun and see them in Thunderbird; a
      concurrent edit from Thunderbird surfaces as a named conflict rather than
      being overwritten; a recurring series' "this occurrence only" edit
      round-trips.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

170. **Generic remote URL publishing — Group P #79's one open bullet.**
    `git remote add/set-url origin <url>` + `git push -u origin <branch>`, with
    no host CLI, routed through the existing `PublishSite` / `origin_site` logic
    so `describe_mirror_guard`'s stale-mirror refusal applies. `git_publish.rs:69`
    currently rejects anything that is not GitHub or GitLab, and
    `git remote add origin` appears nowhere in the tree. Build once and it serves
    self-hosted Gitea/Forgejo/bare-SSH alike.
    The GitHub *and* GitLab `Provider` dispatch is already shipped
    (`commands/git_publish.rs:57-69`) — do not rebuild it.
    - [ ] 🤖 Automated test — URL validation accepts `ssh://`, `git@host:path` and
      `https://`, rejects the shapes `validate_clone_url` rejects; publishing
      flips `git_type` to `remote-private`.
    - [ ] 🖐️ Manual test — publish a local project to a bare repo in `/tmp` and
      confirm the history with `git log` on the bare repo.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

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
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

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
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
