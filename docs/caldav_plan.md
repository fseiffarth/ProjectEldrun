# CalDAV accounts — the model, and the plan around it

Status (2026-07-28): **Phases 0–2 implemented, Phase 3 deliberately not.**
Protocol plumbing, accounts + discovery + subscribe with the identity-based
reconciliation, and scheduled read-only sync with visible failures are on
`develop`; two-way push is gated on this document's own open questions (write
access against an institutional calendar, and an undesigned conflict UX) and was
explicitly deferred rather than forgotten. **Nothing has run against a real
CalDAV server** — the parsers and the merge are fixture- and unit-tested, the
transport has never spoken to anything. What shipped, and the invariants worth
knowing before touching it, is summarized in `docs/context/caldav.md`; the text
below is the plan as written, kept as the record of the reasoning.

Companion feature, already shipped: **`Calendar.source_url`** — a calendar can
hold an anonymous, unauthenticated ICS feed URL and "Refresh from URL" replaces
that calendar's events/tasks in one write (`calendar_fetch_ics` →
`browser_engine::fetch_ics`, `calendar_replace_events` →
`replace_calendar_events_at`). That feature is the right shape for a link
someone hands you (TimeTree's export URL); it is the wrong shape for what this
plan is about.

## Goal

Real CalDAV support: a calendar backed by a server the user has an **account**
on — typed base URL, username, password — synced on a schedule or on demand,
with an eventual path to **two-way** sync (local edits pushed back, not just
server state pulled down). The concrete driver is the user's own university
calendar, which runs over CalDAV rather than a plain ICS link. As of
2026-07-28 the protocol shape is confirmed (see Open Questions): a well-known
open-source groupware CalDAV/CardDAV server, reachable over plain HTTPS with
**HTTP Basic Auth** — no SSO/SAML/Shibboleth in front of the DAV endpoint
itself, so Phase 1 as scoped below is reachable against it. The account's
exact base URL and username are per-user config, entered the same way a mail
account's IMAP host is — never hardcoded into this plan or the code.

**This is the mail-account shape, not the ICS-URL shape.** `MailAccount` is the
precedent to follow: a user-typed server, a password that is never persisted
without an explicit opt-in, a background check interval, multiple accounts.
`Calendar.source_url` is not — it is anonymous, unauthenticated, one-way by
design, and deliberately throws away board placement on every refresh because
a manual "refresh occasionally" click is the only trigger. A feature that syncs
continuously, authenticated, against a server the user depends on for work
cannot make the same trade — losing which column a card sits in every five
minutes would make the to-do board unusable for anything CalDAV-backed.

## CalDAV, briefly, for the parts this plan touches

CalDAV is WebDAV (HTTP `PROPFIND`/`REPORT`/`PUT`/`DELETE`/`GET` plus extra
XML properties and two `REPORT` bodies) layered under RFC 4791, with change
tracking from RFC 6578. The sequence a client actually runs:

1. **Discovery.** Either the user gives a full URL to their calendar
   collection directly (what most desktop clients' manual-setup path actually
   uses in practice), or discovery is attempted from a bare host: try
   `GET/PROPFIND /.well-known/caldav` (a redirect to the real base path is
   normal and expected), then `PROPFIND` on whatever that resolves to for
   `DAV:current-user-principal`, then `PROPFIND` on the principal URL for
   `CALDAV:calendar-home-set`. Both are `Depth: 0` requests with a tiny XML
   body naming the property wanted.
2. **Listing collections.** `PROPFIND` the calendar-home-set URL at
   `Depth: 1`, asking for `DAV:displayname`, `DAV:resourcetype` (to filter to
   actual calendar collections), `CALDAV:supported-calendar-component-set`
   (does this collection hold VEVENT, VTODO, or both), `CALDAV:calendar-color`
   (Apple/most clients' de-facto property, unstandardized but universal), and
   the two **change tokens**: `DAV:getctag` (an opaque "did anything in this
   collection change" string — old, near-universal, coarse) and
   `DAV:sync-token` (RFC 6578 — supports incremental diffs, newer, not every
   server has it).
3. **Fetching events.** Either `REPORT calendar-query` (a filtered fetch —
   "every VEVENT/VTODO", or a time-range) which returns a multistatus
   document with each resource's `href`, `getetag`, and `calendar-data`
   (the raw iCalendar text) inline — one round trip for the whole collection
   — or `REPORT calendar-multiget` (fetch specific hrefs you already know
   about, e.g. "refresh just these three that the sync-token says changed").
   A server that supports RFC 6578 answers `REPORT sync-collection` with only
   the hrefs that changed (plus deletions as 404 stubs) since a prior token,
   which is the efficient path; one that doesn't falls back to ctag-gated full
   `calendar-query` refetches.
4. **Reading/writing one event.** Plain `GET`/`PUT`/`DELETE` on the resource's
   own URL. Each carries `iCalendar` text as the body (one VEVENT or VTODO per
   resource, by convention — a resource can technically hold more but no
   client writes it that way and this plan won't either).
5. **Conflict detection.** Every `GET` returns an `ETag`; every write should
   carry `If-Match: <etag>` (create: `If-None-Match: *`). A `412 Precondition
   Failed` means someone else changed it since this client last read it — the
   one signal two-way sync needs to not clobber a change silently.
6. **Auth.** Basic Auth over TLS is what nearly every non-Google, non-SSO
   CalDAV endpoint speaks. Increasingly commonly that's not the account's
   primary password but an **app-specific/service password** minted in the
   provider's own settings (Nextcloud, Fastmail, and a growing number of
   institutional groupware backends all do this) — the setup UI should say so
   without assuming it, since we don't yet know which this particular server
   requires.

Nothing here is exotic; it's a fixed, small set of XML shapes. That is itself
an input into the dependency decision below.

## Dependency decision: hand-roll on reqwest, don't pull a CalDAV crate

`reqwest` (rustls, no OpenSSL, already the dependency mail and the browser
reader use) covers the entire transport half for free. What's missing is (a)
building six small, fixed XML request bodies and (b) parsing a WebDAV
multistatus response.

The Rust CalDAV-client crate landscape was checked and is thin: the couple of
crates that exist are either unmaintained (years-stale, sync-only, pre-dating
this project's async/tokio-rustls stack) or are generic WebDAV clients with no
CalDAV-specific request builders — meaning `calendar-query`/`sync-collection`
bodies and the calendar-specific properties would have to be hand-written on
top of them anyway, while additionally taking on a second HTTP-client
dependency to reconcile with the one already in the tree (a repeat of exactly
the trap `mail_pgp.rs` avoided with `sequoia-openpgp`: pulling in a
heavier/awkward-fit dependency for a small, well-specified piece of protocol
this codebase is fully capable of speaking directly). There is no CalDAV crate
here that earns its keep the way `mail-parser`/`async-imap` earn theirs for
IMAP — those are genuinely hard, security-sensitive parsers eating untrusted
bytes; a `PROPFIND` body is a five-line XML template with one variable.

**Recommendation: hand-roll**, on top of `reqwest` (already present) plus one
new, small, pure-Rust dependency for parsing the XML multistatus responses —
`roxmltree` (whole-document DOM, no `unsafe`, actively maintained, tiny; the
non-streaming model is fine here since a multistatus response is at most a
few hundred KB, not the multi-GB documents streaming parsers exist for).
Outgoing request bodies are built the same way `src/lib/ics.ts` builds ICS
text today — string templates with the one or two variables (a URL, a
time-range) escaped by hand — because there is exactly a handful of them and
templating avoids pulling in an XML *writer* crate for six fixed shapes.
Parsing stays on the Rust side (unlike ICS, which is parsed in the frontend):
a multistatus response is XML wrapping iCalendar text, and only the outer XML
needs a real parser — the inner `calendar-data` text is handed to the
**existing** `src/lib/ics.ts` parser unchanged, exactly as the ICS-refresh
feature already does. This keeps the parsing surface that has to understand
iCalendar's actual grammar (folding, escaping, `RRULE`, `VALARM`) in the one
place that already has it tested, and gives the new backend service exactly
one new job: speak WebDAV, then had the calendar text to the frontend the
same way the ICS path already does.

## Where CalDAV data lives: two files, one calendar model

Following the mail precedent directly: **account plumbing is a separate store
from calendar content**, exactly as `mail/accounts.json` (`MailAccounts`,
`MailAccount`) is separate from `calendar.json`. A new
`~/.local/share/eldrun/caldav/accounts.json` (schema `schema/caldav.rs`) holds:

```rust
pub struct CalDavAccount {
    pub id: String,
    pub label: String,
    pub base_url: String,        // what discovery resolved, or what the user pasted directly
    pub user: String,
    #[serde(default)]
    pub save_password: bool,     // opt-in, default false — the standing rule
    #[serde(default)]
    pub sync_interval_min: Option<u32>,  // None/0 = manual "Sync now" only
    pub calendars: Vec<CalDavCalendarRef>,  // which discovered collections are subscribed
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

pub struct CalDavCalendarRef {
    pub href: String,            // the collection's own URL — the stable key
    pub calendar_id: String,     // the Calendar.id this collection is synced into
    pub display_name: String,
    #[serde(default)]
    pub ctag: String,            // last-seen ctag, for the cheap "anything changed?" check
    #[serde(default)]
    pub sync_token: Option<String>,  // RFC 6578, when the server offers it
    #[serde(default)]
    pub read_only: bool,         // Phase 1 default; false once push lands for this account
}
```

Why not fold this into `Calendar`'s existing `extra` flatten the way
`source_url` does? Because `source_url` names *nothing that needs protecting*
— an unauthenticated feed URL is not a secret and there is no credential or
sync cursor tied to it. A CalDAV account carries a username, a sync cursor
per collection, and (via the keychain) a credential; that is account state,
not calendar-display state, and putting it in `calendar.json` would mean the
file that gets shared/inspected/exported alongside a calendar (or read by
`calendar_load` on every calendar-tab mount) also carries sync bookkeeping
nothing there needs. It is the same split `mail_encryption_plan.md` draws
between the mail index and `MailAccounts` — the plumbing that lets the feature
*connect* is not the content the feature *shows*.

**The events and tasks themselves stay in `calendar.json`**, as ordinary
`CalendarEvent`/`CalendarTask` rows under an ordinary `Calendar` entry — this
is the part that *is* shared with `source_url`. A CalDAV-backed `Calendar` row
carries a `caldav_account_id` + `caldav_href` pair in its own `extra` flatten
(mirroring how `source_url` already rides there), which is enough for the sync
engine to find "which account and collection does this calendar belong to"
without a second calendar-id namespace. Each synced `CalendarEvent`/
`CalendarTask` carries its own resource identity in `extra`:
`caldav_href` (the event/task's own resource URL — the only thing the server
recognizes) and `caldav_etag` (for `If-Match` on the eventual push path).
Reusing the flatten this way is exactly what it exists for
(`schema::calendar`'s own doc comment: "a newer or hand-edited file round-trips
without losing keys") and it means every existing consumer of
`CalendarEvent`/`CalendarTask` — the grid, month view, agenda, alarms, ICS
export, the to-do board — needs **zero** changes to render CalDAV-sourced data;
they already don't know or care where a row came from.

## The problem `source_url` doesn't have to solve: local-only fields

`replace_calendar_events_at` deletes every event/task under a calendar id and
re-inserts a freshly parsed set with **freshly minted ids**, on every refresh —
stated plainly in its own doc comment, and fine for a feature whose only
trigger is a manual click on an anonymous feed. It is not fine here:
`CalendarTask.column`/`rank`/`tags`/`subtasks`/`project_id` are the to-do
board's own state (`schema/calendar.rs`'s board-fields comment), have no
CalDAV representation, and a periodic background sync that wholesale-replaces
tasks would silently evict every CalDAV-sourced card from wherever the user
dragged it, every time the timer fires. That is a regression the ICS feature
never had to face because it never runs unattended.

The fix is **identity, not replacement**. `caldav_href` is the stable key a
`source_url` refresh never had (an ICS feed has no equivalent of a resource
URL the server will hand back unchanged next time — `replace_calendar_events_at`'s
own doc comment says as much: "a re-fetched feed carries no id of its own the
store can trust"). A CalDAV resource *does* carry one, so the sync engine can
and must reconcile by it:

- **Matched** (local row's `caldav_href` appears in the server's current set):
  overwrite only the server-owned fields (title, start/end, location, notes,
  rrule, status, `due`/`percent`/`completed` for a VTODO) and the `caldav_etag`;
  leave `column`/`rank`/`tags`/`subtasks`/`project_id`/`mail` untouched. This
  is a per-row field-level merge, not a delete-and-reinsert.
- **New** (server has an href with no matching local row): create it — a fresh
  `CalendarTask`/`CalendarEvent` with no board placement, which is exactly what
  `normalize()` already handles today for any newly-created task (files it into
  the board's fallback column, ranked in by due-date/priority — see
  `normalize_tasks`'s step 5/7). No special-case code needed there; the
  existing invariant already covers "a task with no placement gets one."
- **Gone** (local row's `caldav_href` is no longer in the server's set):
  delete the local row for an event. For a task this is genuinely ambiguous —
  a VTODO can disappear from a `calendar-query` because it was deleted *or*
  because some servers stop returning completed-and-old VTODOs by default
  filter — so Phase 1/2 (read-only) should **not** delete a task on this
  signal alone; flag it as an open question for Phase 3 (see below) rather
  than guess.

This reconciliation is the one genuinely new piece of logic the feature needs
beyond "speak the protocol and hand text to the existing ICS parser" — it is
the calendar-side analogue of `mail`'s "the mark the message carried is a
mark, not a move" reasoning: two things (server content, board placement) that
must be allowed to change independently without either overwriting the other.

## Phases

Ordered so each is shippable and testable on its own, and so the earliest
phase reuses as much of the already-shipped machinery as possible.

### Phase 0 — Protocol plumbing (no UI)

- `services/caldav.rs`: the XML request builders (principal PROPFIND,
  calendar-home-set PROPFIND, collection-listing PROPFIND, `calendar-query`
  REPORT, `calendar-multiget` REPORT, `sync-collection` REPORT when offered)
  and the multistatus response parser (`roxmltree`-based) that hands back
  `Vec<(href, etag, calendar_data)>` plus per-resource 404s (deletions).
  Pure, unit-tested against hand-written fixtures (RFC 4791's own worked
  examples plus a couple of real Nextcloud/Radicale response samples — cheap
  to obtain by standing up either locally, and exactly the "no live server in
  CI, fixtures instead" posture `mail_engine.rs`'s IMAP/SMTP parsers already
  use).
- Basic Auth request building; TLS via the same `rustls`/OS-trust-store stack
  mail and the browser reader already use — no cert-ignore escape hatch,
  matching the standing invariant.
- **Deliberately not routed through `browser_engine`'s SSRF machinery**
  (`reader_hop_allowed`/`resolve_hop`/DNS pinning). That machinery exists
  because an ICS-subscribe or reader-mode URL is content someone else handed
  the user — it may point anywhere, including at a metadata endpoint, and the
  backend fetching it needs the same discipline a browser's own SSRF defenses
  apply to a redirect chain. A CalDAV base URL is the opposite case: the user
  typed it themselves, for an account they are setting up on purpose, the same
  posture `MailServer.host`/`port` already have (mail's IMAP/SMTP connections
  don't run through the reader's hop-judging either — they just connect to
  the host the user configured). Redirects during discovery (the
  `.well-known` step, a `Location:` bounce to the real base path) are still
  bounded by a small hop cap for hygiene against a misconfigured/looping
  server, but there is no "is this a private/loopback address" judgment to
  make — the user configuring `https://localhost:5232` for a self-hosted
  Radicale instance is not an attack.
- **Exit criteria:** given a base URL + Basic Auth credentials, resolve the
  calendar-home-set and list its calendar collections (displayname, ctag,
  component types) — nothing user-visible yet, provable in a unit/integration
  test against fixtures and (manually) against a locally-run Radicale/Nextcloud.

### Phase 1 — Read-only CalDAV "subscribe" *(the stepping stone this plan recommends)*

This is the phase that answers "is a first cut worth doing before real
two-way sync" — yes, because it reuses almost everything already built for
`source_url` and adds only discovery + auth + the identity-based
reconciliation above.

- `schema/caldav.rs` + `caldav/accounts.json` (Phase 0's shapes, persisted).
- Backend commands, named to mirror the existing `calendar_*`/`mail_*`
  surfaces rather than inventing a new vocabulary:
  - `caldav_account_upsert`/`caldav_account_delete`/`caldav_accounts_list`
    (shape of `mail_account_upsert`/`_delete`/`mail_accounts_list` —
    `MailAccountSaved`'s `{account, saved, save_error}` return shape carries
    over unchanged, since it is the generic "what did the keychain actually
    do" answer, not mail-specific).
  - `caldav_discover(base_url, user, password)` — runs the principal +
    calendar-home-set + collection-listing chain once and returns the
    candidate collections for the account dialog's "pick which calendars to
    subscribe" step. The password here is never persisted by this call; it's
    the "Test connection" analogue of `mail_account_test`.
  - `caldav_password_state`/`caldav_forget_password` (shape of
    `mail_password_state`/`mail_forget_password`).
  - `caldav_sync(account_id, calendar_href)` — one collection, one round trip
    (ctag check → full or incremental REPORT → parse each `calendar_data`
    through `lib/ics.ts`'s existing parser via the same IPC shape
    `calendar_replace_events` uses today, except routed through the new
    reconciliation function below instead of `replace_calendar_events_at`).
- New reconciliation entry point, `sync_caldav_calendar_at` (backend,
  `commands/calendar.rs` or a new `commands/caldav.rs` that calls back into
  `commands::calendar`'s read/write helpers) implementing the matched/new/gone
  merge described above, in one atomic `calendar.json` write per sync — same
  discipline `replace_calendar_events_at` already has (one write, calls
  `normalize()` before persisting).
- **Credentials**: reuse `services::remote_credentials` exactly as mail does —
  keyed by server target (a CalDAV analogue of `MailProto`/`imap_key` — e.g.
  `caldav:<account_id>` or `caldav:<user>@<host>`, whichever collides less
  across re-added accounts; mail's own key scheme is the thing to copy, not
  reinvent), opt-in save (default OFF), the same `remember_secret`/
  `RememberOutcome` machinery, the same "unreadable is not absence" tri-state.
  No fourth credential-storage mechanism.
- **Frontend**: `CalDavAccountDialog.tsx` (mirrors `MailAccountDialog.tsx`
  structurally — base URL / user / password fields, a "Discover" button that
  calls `caldav_discover` and lists collections as checkboxes, `SavePasswordRow`
  off `useSavedCredentialSource` with new `read`/`forget` wrappers exactly as
  `MailAccountDialog` builds its own off the shared hook rather than
  hand-rolling a fourth copy of the tri-state). A subscribed collection
  appears in the sidebar as an ordinary `Calendar` row (`readonly: true` in
  this phase — server-authoritative, no local edit path yet, same as any
  read-only calendar already renders) with a small marker distinguishing it
  from a plain local or `source_url` calendar, and a manual "Sync now" beside
  the existing "Refresh from URL" affordance (they are visually the same kind
  of action — "go get the latest from wherever this came from" — so they can
  likely share UI chrome even though their backend paths differ).
- **Exit criteria:** add a CalDAV account, discover and subscribe to a
  calendar collection, pull its events/tasks into `calendar.json`, and a
  second sync updates changed events without touching any card's board
  column/rank/tags.

### Phase 2 — Scheduled sync

- `sync_interval_min` on `CalDavAccount` drives a background timer — the
  calendar analogue of `MailIndicator`'s `mail_check_interval_min` poll
  (same reasoning: gated so it costs nothing when no CalDAV account exists,
  ticks are a whole interval apart so the first check isn't at launch, and an
  explicit `0` means manual-only).
  Use the ctag (or `sync-token` when the server offers one) to skip the full
  `calendar-query` REPORT entirely when nothing changed — the cheap "is it
  worth doing the expensive read" check RFC 6578 exists for, and the fallback
  every server without it still gets for free.
- Surface sync failures the way `MailIndicator`'s amber `!` does for mail:
  an account whose password was never saved, or a keyring that's locked,
  fails every unattended sync after a relaunch exactly like mail's does, and
  needs the same visible "last sync couldn't reach the server" state rather
  than a quiet stale calendar.
- **Exit criteria:** a subscribed calendar updates itself on its own schedule,
  with no user action, and failures are visible rather than silent.

### Phase 3 — Two-way sync (push)

The larger lift, and the one this plan recommends treating as genuinely
separate scope rather than "Phase 1 plus a bit":

- A calendar's `readonly` flips to `false` for an account whose collection
  supports it (some server-side collections are legitimately read-only to the
  authenticated user — a shared/subscribed calendar someone else owns — so
  this must be asked of the server, not assumed from "the feature shipped").
- Local create/edit/delete on a CalDAV-backed row: `PUT` the whole resource
  with `If-Match: <caldav_etag>` (create: `If-None-Match: *`), `DELETE` with
  `If-Match`. A `412` is a genuine conflict — someone (another client, the
  web UI, a phone) changed the same resource since this app last read it —
  and must be surfaced to the user as a named conflict, never silently
  overwritten in either direction (mail encryption's own rule applies
  verbatim here: "a silent downgrade is the single worst thing a sync feature
  can do, because it looks exactly like success").
- **What actually gets pushed is the ICS-exportable subset only** —
  `column`/`rank`/`tags`/`subtasks`/`project_id`/`mail` have no VEVENT/VTODO
  representation and must never leave the machine via a CalDAV `PUT`, exactly
  as `lib/ics.ts`'s serializer already excludes them from file export today.
  This is not new policy, just the same boundary applied to a second output
  path.
- **Recurring events are the real complexity here.** A single-occurrence edit
  ("this event only") is, on the wire, a rewrite of the *whole* master
  resource with an added `VEVENT` carrying `RECURRENCE-ID` — there is no
  separate occurrence object in CalDAV to `PUT` individually. Eldrun's own
  `EventOverride`/`exdates` model already represents this shape internally
  (`schema/calendar.rs`), so the translation is mostly mechanical, but the
  push path has to serialize the *entire* series (master + all overrides +
  exdates) as one resource on every edit, and a conflict on that resource
  means "something about this whole series changed elsewhere," which is a
  coarser and more disruptive conflict than a single-event one. Budget real
  test time here rather than assuming it falls out of the single-event case.
- **Exit criteria:** create/edit/delete a CalDAV-backed event or task locally,
  see it land on the server (verifiable against a real Nextcloud/Radicale
  instance or via a second CalDAV client reading the same account), and a
  concurrent edit from elsewhere surfaces as a conflict rather than being
  overwritten.

### Phase 4 — Stretch, not required for a useful feature

- Multiple calendar collections per account beyond the first (mechanically
  simple once Phase 1's discovery step already lists all of them — mostly a
  matter of the account dialog letting more than one checkbox be ticked).
- `VALARM` round-trip fidelity against real servers (Eldrun's alarms already
  serialize to `VALARM` for file export; whether every CalDAV backend accepts
  that on `PUT` the same way is untested).
- CalDAV free/busy queries, iTIP scheduling (meeting invites/RSVP over CalDAV
  is its own protocol layer, `CALDAV:schedule-outbox`, and is out of scope —
  see below).

## Cross-cutting concerns

- **Credential storage is not a fourth mechanism.** Same OS keychain, same
  `services::remote_credentials`, same opt-in-default-off rule, same
  `true | null` (never bare `false`) remember argument, same tri-state
  saved/notSaved/unreadable — the SSH dialogs' `useSavedCredentialSource` is
  built precisely so a second credential kind (mail was the first) does not
  need to reinvent the 4-second bound or the locked-keyring banner.
- **App-specific passwords, unconfirmed for this server.** The setup dialog's
  copy should mention the possibility without assuming it — say "some CalDAV
  servers require an app-specific password rather than your normal one, check
  your provider's account settings if authentication fails" rather than
  building a UI that only has fields for a primary password and then failing
  opaquely.
- **No cert-ignore escape hatch**, matching the standing invariant every other
  TLS-using surface in this codebase holds to (mail, the browser reader): a
  self-signed cert on a self-hosted server is fixed by the machine's
  administrator adding it to the OS trust store, not by a checkbox here.
- **This is additive to `source_url`, not a replacement for it.** A
  TimeTree-style anonymous feed is still the right tool for "someone shared a
  read-only link with me," and nothing here changes that path.

## Testing

- Pure builders/parsers (XML request bodies, multistatus parsing, ctag/etag
  comparison, the matched/new/gone reconciliation) are unit-testable against
  hand-written fixtures with **no live server**, the same posture
  `mail_authres.rs`/`mail_engine.rs`'s parsers already take.
- `cargo test --manifest-path src-tauri/Cargo.toml` + `npx tsc --noEmit` per
  phase, as always.
- **Nothing here has run against a real server, and nothing should be assumed
  to work against one until it has.** The honest state mail encryption shipped
  in ("None of this has run against a real server or a real correspondent")
  applies identically. Manual QA path: stand up a personal CalDAV server
  locally (Radicale is a few minutes to run, Nextcloud's built-in calendar app
  a bit more) and validate discovery/pull/push/conflict against it — cheap,
  reproducible, and does not require touching the university's server at all
  — **before** ever pointing this at an institutional account.

## Open questions and risks

- **RESOLVED (2026-07-28) — auth scheme and backend.** The institution's
  own public IT documentation (findable from its central IT-services pages;
  turned out **not** to actually be network/login-gated as first assumed —
  that was a false read, it simply hadn't surfaced via generic web search)
  confirms: the groupware is **SOGo**, the DAV endpoint answers plain **HTTP
  Basic Auth** (personal-identity username + password — no alias accounts
  accepted for this purpose), and there is a documented, stable collection
  path pattern for a personal calendar rather than reliance on `.well-known`
  discovery alone. No SSO/SAML/Shibboleth sits in front of the DAV endpoint,
  so Phase 1 as scoped here is reachable — the embedded-login-webview
  fallback this bullet used to flag as a possible blocker is **not needed**
  for this server. SOGo-specific quirks worth testing against once Phase 0
  fixtures exist: it does implement `sync-collection` (good for Phase 2), but
  is known to be picky about exact `PROPFIND` property sets in some versions —
  worth a real round-trip test early rather than assuming RFC-4791-generic
  fixtures (Radicale/Nextcloud) transfer unchanged.
- **Which account to point at is still the user's to confirm.** A
  university-affiliated user can easily hold two distinct mailboxes: a
  central identity-provider account (the one this groupware calendar is
  keyed to) and a separate department/institute-run mailbox that may not be
  the same system at all — confirmed in this case by MX records alone
  (the two domains route to entirely different mail infrastructure). The
  base-URL-plus-username the setup dialog collects must be **whichever
  account the user actually wants synced**, entered by them at setup time
  exactly like a mail account's server field — never inferred from their
  email address or defaulted to one or the other.
- **Network reachability**: if the endpoint is only reachable from campus
  network / VPN, background sync needs the same honest "can't reach it right
  now" state mail's check-interval already has for an unreachable IMAP host,
  rather than treating a network failure as "nothing changed."
- **Is write access even wanted against an institutional calendar?** A push
  path that corrupts or double-books a shared work calendar is a materially
  bigger blast radius than the same bug against a personal one. It may be
  correct to ship Phase 1/2 (read-only pull) as the actual end state for an
  account like this, and reserve Phase 3 (push) for a personal/self-hosted
  CalDAV server (Nextcloud, Radicale) where the user is the sole stakeholder.
  Worth deciding deliberately rather than defaulting to "two-way because that's
  the eventual goal" once Phase 1 exists and the institutional account is live
  on it.
- **Conflict UX is undesigned.** Phase 3 needs an actual answer to "what does
  the user see and do when a `412` comes back," not just "detect it" — this
  plan states the detection mechanism (`If-Match`/`412`) but the dialog/banner
  itself needs its own design pass before Phase 3 starts.
- **Task deletion ambiguity** (server no longer returns a VTODO — deleted, or
  just filtered out by the server's own default query scope?) is flagged above
  under the reconciliation logic and needs a real answer — likely "don't
  delete a task on absence alone in Phases 1–2; only delete on an explicit
  404 from a targeted `GET`/`calendar-multiget` of that specific href" —
  before it's implemented, not decided in code.

## Out of scope

- OAuth2/SSO-fronted CalDAV of any kind (Google's own CalDAV interface is
  increasingly restricted and points toward OAuth; building for it is a
  separate, much larger effort than this plan's generic-RFC-4791 scope).
- CardDAV (contacts) — same protocol family, same server software in most
  cases, but a different data model and no driving need here.
- Calendar sharing/ACL management (who else can see or edit a collection) —
  server-side administration, not this client's job.
- iTIP scheduling (meeting invites, RSVP, `CALDAV:schedule-outbox`) — a
  separate protocol layer on top of plain CalDAV, non-trivial on its own.
- Free/busy queries.
