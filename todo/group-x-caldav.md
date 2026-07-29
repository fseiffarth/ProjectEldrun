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

160. **Two-way sync (Phase 3) — built, never live-tested.** `PUT`/`DELETE`
    conditional on `If-Match` (`If-None-Match: *` to create), a `412` carried as
    a **value** (`CalDavWrite.conflict`) rather than an error, and whole-*resource*
    serialization so a recurring series' occurrence overrides travel with their
    master. The plan's two open questions were answered by asking rather than
    deciding: `CalDavAccount.allow_write` is per account and **defaults false**
    (an untouched account behaves exactly as Phases 1–2 did), and the conflict UX
    is `CalDavConflictDialog` — keep mine / use the server's / decide later, and
    deliberately no *merge*. `read_only` stays per collection and is still the
    server's answer, now re-askable via `caldav_refresh_access`.

    Two things push forced elsewhere: `UID` and `RECURRENCE-ID` now round-trip
    through `lib/ics.ts` (without the first a push creates a second copy of every
    appointment; without the second a series pushes back as two masters), and
    `serializeIcs` writes a locally-authored series' `overrides[]` — which fixes
    the **file export**, silently dropping occurrence edits since it was written.
    - [x] 🤖 Automated test — the write gate (`CalDavPushGate.test.ts`: no
      account / no opt-in / server-side read-only all reach no network; a refused
      **delete** rejects rather than letting the local delete through), the
      resource body (`CalDavPush.test.ts`: one UID per resource, master-first,
      overrides emitted, board state never serialized), the unconditional-write
      refusal (`services::caldav::an_update_with_no_known_etag_is_refused…`), and
      the local gate (`commands::caldav::a_write_needs_both_the_users_opt_in_and_the_servers`).
    - [ ] 🖐️ Manual test — Radicale in a container + Thunderbird: create/edit/
      delete an event and a task from Eldrun and see them in Thunderbird; a
      concurrent edit from Thunderbird surfaces as a named conflict rather than
      being overwritten; a recurring series' "this occurrence only" edit
      round-trips. **Nothing in the CalDAV stack has ever spoken to a real
      server**, so this is riskier than its size.

161. **Look at an `.ics` before importing it — built, never live-tested.**
    `lib/icsSafety.ts` reports what a picked file contains (`PROCEDURE`/`EMAIL`/
    `AUDIO` alarms, `ATTACH`, non-`http(s)` links, `METHOD:REQUEST`, bidi-disguised
    titles, endless sub-daily `RRULE`s, never-imported component kinds) and
    `IcsImportReviewDialog` shows it before anything is written. Explicitly **not**
    a scanner — an `.ics` cannot run anything here — but every one of those is
    dropped or cleaned in silence today, and the dialog is the difference between
    "Eldrun ignored it" and "you knew it was there". Raised only when there is
    something to say, so an ordinary export still imports in one click.
    - [x] 🤖 Automated test — `IcsSafety.test.ts`, both directions: every finding
      is detected, and an ordinary calendar export (including a `LOCATION: Room 3:
      Building B`) produces **none**, since a report that flags every file is a
      dialog nobody reads.
    - [ ] 🖐️ Manual test — import a hand-built hostile `.ics` and check the
      dialog names each finding and says what happens to it.

162. **The CalDAV password no longer follows a redirect off its own host.**
    `dav_request` follows hops itself (reqwest's policy would turn a `PROPFIND`
    into a `GET` on a 302), which meant reqwest's cross-origin header stripping
    was not in play and `basic_auth` was re-attached on **every** hop — so a
    hostile or compromised server at the configured URL could bounce the client
    anywhere and be handed the calendar password. `credentials_may_follow` now
    allows the same origin, or a subdomain over TLS (RFC 6764's `.well-known`
    shape), and nothing else; an `https→http` hop is refused outright rather than
    merely stripped.
    - [x] 🤖 Automated test — `services::caldav::credentials_*` (same origin,
      the well-known subdomain hop, a foreign host, a sibling host, a TLS
      downgrade, and suffix-vs-substring matching).
    - [ ] 🖐️ Manual test — a server that redirects `.well-known/caldav` to its
      DAV subdomain still sets up; one redirecting to another domain refuses with
      the "set the account's URL to that address" sentence.
