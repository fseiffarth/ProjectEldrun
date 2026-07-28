## Group X — CalDAV Accounts (read-only sync) ✅ Done · 🧪 Untested against a real server

*Real CalDAV: a calendar backed by a server the user has an **account** on —
typed base URL, username, password — synced on a schedule or on demand. The
mail-account shape, not the `Calendar.source_url` shape: that one stays exactly
as it is and is still the right tool for an anonymous read-only feed somebody
shared with you. Design + phase gating: [`docs/caldav_plan.md`](../docs/caldav_plan.md);
the invariants that make it worth having: [`docs/context/caldav.md`](../docs/context/caldav.md).*

*Files: new `src-tauri/src/services/caldav.rs`, `src-tauri/src/schema/caldav.rs`,
`src-tauri/src/commands/caldav.rs`, `merge_caldav_calendar_at` in
`src-tauri/src/commands/calendar.rs`, `caldav_account` in
`src-tauri/src/services/remote_credentials.rs`, `src-tauri/src/lib.rs`
(`generate_handler!` + managed state), `roxmltree` in `Cargo.toml`; frontend new
`src/types/caldav.ts`, `src/lib/caldav.ts`, `src/stores/caldav.ts`,
`src/components/calendar/CalDavAccountDialog.tsx` + `CalDavSyncHost.tsx`,
`src/components/calendar/{CalendarPane,CalendarSidebar}.tsx`,
`src/components/layout/AppShell.tsx`, `src/lib/i18n.ts`, `src/styles/themes.css`.*

156. **Protocol plumbing (Phase 0).** `services/caldav.rs`: the six fixed XML
    request bodies (principal / calendar-home-set / collection listing +
    minimal fallback / `calendar-query` / `calendar-multiget` /
    `sync-collection`) and a `roxmltree` multistatus parser. Hand-rolled on
    `reqwest` rather than a CalDAV crate — the Rust landscape is unmaintained
    or WebDAV-generic, and a `PROPFIND` body is a five-line template.
    Deliberately **not** routed through `browser_engine`'s SSRF machinery: a
    CalDAV base URL is user-typed for an account they are setting up, the same
    posture `MailServer.host` already has. Redirects are capped, the body is
    capped, TLS is the shared rustls + OS-trust-store stack with no
    cert-ignore hatch.
    - [x] 🤖 Automated test — RFC-shaped fixtures: a home listing keeps only
      calendar collections, a `404` propstat reads as an absent property (not
      present-and-empty), a `sync-collection` reply yields resources plus
      `404` deletion stubs, an etag with no data survives for the multiget
      pass, privileges decide read-only while silence asserts nothing, and an
      HTML login page fails loudly instead of importing zero events.
    - [ ] 🖐️ Manual test — against a locally-run Radicale/Nextcloud **before**
      ever pointing it at an institutional account.

157. **Accounts, discovery, subscribe (Phase 1).** `caldav/accounts.json` +
    `caldav_accounts_list`/`_account_upsert`/`_account_delete`/
    `_password_state`/`_forget_password`/`_discover`, mirroring the `mail_*`
    account surface down to `{account, saved, save_error}`. Credentials are
    **not a fourth mechanism**: same keychain, same `remote_credentials`, same
    opt-in-default-off, same `true | null` remember argument, keyed by server
    target (`caldav:<user>@<host>`) so re-adding an account finds the password
    already there. `CalDavAccountDialog` is `MailAccountDialog`'s structural
    twin plus the find-then-pick step CalDAV needs; a ticked collection
    becomes an ordinary read-only `Calendar` in the sidebar.
    - [x] 🤖 Automated test — the store mints ids and replaces in place, holds
      no secret, keys the keychain by target rather than account id, coerces
      `remember: false` to `None`, and round-trips a subscription's cursors.
    - [ ] 🖐️ Manual test

158. **Identity-based reconciliation.** `merge_caldav_calendar_at` — the one
    genuinely new piece of logic. `replace_calendar_events_at` cannot be
    reused: it re-mints ids on every refresh, which for an unattended sync
    would evict every CalDAV-sourced card from the to-do column the user
    dragged it into, every time the timer fires. Rows are matched on
    `caldav_href` and merged field by field; a task keeps
    `column`/`rank`/`tags`/`subtasks`/`mail`/`project_id`/`created`. Explicit
    `404`s delete; absence from a full listing deletes an *event* only (a
    VTODO can vanish because the server filtered it); absence from an
    incremental report deletes nothing.
    - [x] 🤖 Automated test — a second sync updates the title and percent
      while keeping column/rank/tags/subtasks; a new row is placed by
      `normalize`; an explicit deletion removes both kinds; absence deletes an
      event but never a task; an incremental report deletes nothing; a row
      with no `caldav_href` is never pruned; a master+override resource
      matches positionally and shrinks correctly.
    - [ ] 🖐️ Manual test

159. **Scheduled sync + visible failure (Phase 2).** `sync_interval_min` drives
    `CalDavSyncHost` (mounted at the shell, renders nothing, starts no timer
    until an account exists, first tick a whole interval after mount, explicit
    `0` means manual-only). The backend's ctag check is what keeps a short
    interval cheap — an unchanged collection costs one small `PROPFIND`, and
    `sync-collection` is used when the server offers a token, falling back to
    a full `calendar-query` when it does not. A failed sync shows as an amber
    `!` on the sidebar row carrying the backend's own words, mail's rule: a
    quietly stale calendar looks exactly like one with nothing new in it.
    - [x] 🤖 Automated test — `parseChanges` groups by resource (a master and
      its `RECURRENCE-ID` override stay in one group), an empty body is
      reported rather than dropped, and `calendarSyncStatus` distinguishes
      never-synced from failed from not-CalDAV-at-all.
    - [ ] 🖐️ Manual test — including a wrong password after a relaunch, which
      is the case the amber `!` exists for.

160. **Two-way sync (Phase 3) — deliberately not built.** `PUT`/`DELETE` with
    `If-Match`, `412` as a named conflict, and whole-series serialization for
    a recurring event's "this occurrence only". Gated on two answers the plan
    asks for and does not have: whether write access is even wanted against an
    institutional calendar (the blast radius of a push bug on a shared work
    calendar is materially larger than on a personal one), and a design pass
    for the conflict UX — "detect a 412" is a mechanism, not an answer to what
    the user sees and does. The schema carries `read_only` per collection, and
    the server is *asked* for its privileges, so the day this lands the answer
    is per-collection rather than "the feature shipped".
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
