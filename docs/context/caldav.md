# CalDAV accounts — what the feature actually protects

Phases 0–2 of [`docs/caldav_plan.md`](../caldav_plan.md) are implemented:
protocol plumbing, accounts + discovery + subscribe, and scheduled read-only
sync. Phase 3 (push) is not, and is gated on two questions the plan asks and
does not answer — see the last section.

Nothing here has run against a real CalDAV server. The parsers and the merge
are fixture- and unit-tested; the transport has never spoken to anything.

## The one distinction the whole design rests on

There are two ways a calendar can come from somewhere else, and they are not
variants of one feature:

- **`Calendar.source_url`** (already shipped) is an *anonymous, unauthenticated
  ICS feed*, refreshed by a manual click. `replace_calendar_events_at` deletes
  every row under the calendar and re-inserts a freshly parsed set with **fresh
  ids**, and that is fine — a feed carries no identity the store can trust, and
  the only trigger is a click.
- **A CalDAV account** is a login on a server the user depends on for work,
  synced *unattended, on a timer*.

The second cannot make the first's trade. `CalendarTask.column`/`rank`/`tags`/
`subtasks`/`project_id`/`mail` are the to-do board's own state, have no CalDAV
representation, and a wholesale replace would silently evict every
CalDAV-sourced card from wherever the user dragged it — every five, or fifteen,
minutes. That is not a rough edge; it makes the board unusable for anything
CalDAV-backed.

So the feature is built on **identity, not replacement**. A CalDAV resource has
a URL the server hands back unchanged next time; it is stored as `caldav_href`
in the row's `extra` flatten, and `merge_caldav_calendar_at`
(`commands/calendar.rs`) reconciles on it:

| Case | Event | Task |
|------|-------|------|
| Matched (href present in the fetch) | overwrite server fields, keep the id | overwrite server fields, keep the id **and all board state** |
| New | create (fresh id) | create — `normalize` already files an unplaced card |
| Explicit `404` from the server | delete | delete |
| Absent from a **full** listing | delete | **keep** |
| Absent from an **incremental** report | keep | keep |

The two "absent" rows are the only judgement calls, and both are deliberate. An
incremental (`sync-collection`) reply *omits* everything unchanged, so treating
absence as deletion there would empty the calendar on the first quiet interval.
A full `calendar-query` is authoritative about events — but a VTODO can vanish
from one because it was deleted **or** because the server stopped returning
completed-and-old todos by its own default filter, and those two are
indistinguishable from the client. Guessing wrong destroys a card, so tasks are
not deleted on absence alone. The plan's own answer stands: only an explicit
`404` for that specific href deletes a task.

One more subtlety: a single resource can hold several components — a recurring
event's master plus its `RECURRENCE-ID` overrides, because CalDAV has no
separate occurrence object. So rows are matched **within** an href group, by
position, and that is why the frontend hands the backend
`CalDavParsed { href, etag, events, tasks }` groups rather than one flat list.

## Why a sync is two commands

`caldav_fetch` speaks the protocol and hands back each resource's iCalendar
text **unparsed**; the frontend runs it through `src/lib/ics.ts`; `caldav_apply`
reconciles and writes. That is the same seam `calendar_fetch_ics` +
`calendar_replace_events` already has, for the same reason: `ics.ts` is the only
parser in this codebase that understands folding, escaping, `RRULE` and
`VALARM`, and it is the one with tests for all four. A second implementation in
Rust would be two parsers that can disagree about the same feed.

The Rust side therefore has exactly one job — speak WebDAV — and one new
dependency, `roxmltree`, for the multistatus documents. Everything outgoing is a
string template, because there are six of them.

## Where the account plumbing lives, and why not in `calendar.json`

`caldav/accounts.json` (schema `schema/caldav.rs`) holds the account, the
username, and a per-collection sync cursor. `calendar.json` holds only a pointer
(`caldav_account_id` + `caldav_href` on the `Calendar` row) and the synced rows
themselves.

`source_url` rides `Calendar`'s `extra` flatten because it names nothing that
needs protecting and carries no cursor. An account is different: it is read by
`calendar_load` on every calendar-tab mount, and it is the file that gets
exported and inspected alongside a calendar. Sync bookkeeping and a login name
have no business there. This is the same split `MailAccounts` draws against the
mail index.

The consequence worth stating: **every existing consumer of
`CalendarEvent`/`CalendarTask` needed zero changes.** The grid, month view,
agenda, alarms, ICS export and the to-do board already do not know or care where
a row came from.

## Credentials, and the things that are not new

No fourth credential mechanism: same OS keychain, same
`services::remote_credentials`, same opt-in-default-off, same `true | null`
(never bare `false`) remember argument, same "unreadable is not absence"
tri-state, same `SavePasswordRow` off `useSavedCredentialSource`. The key is
`caldav:<user>@<host>` — **server target, not Eldrun account id**, matching
`ssh_account`/`mail_account`, so two accounts pointed at one login share one
entry instead of disagreeing about whether a password is saved. Only the origin
goes into the key, because discovery routinely resolves a longer URL than the
one the user pasted and a path-keyed entry would fork in two on the first sync.

The SSRF machinery (`reader_hop_allowed`, `resolve_hop`, DNS pinning) is
deliberately **not** applied. It exists because a reader-mode or ICS-subscribe
URL is content someone else handed the user; a CalDAV base URL is one they typed
for an account they are setting up, exactly like `MailServer.host` — mail does
not run its IMAP host past the reader's hop judge either. Someone pointing this
at `https://localhost:5232` for a self-hosted Radicale is not an attack. What
*is* kept: a redirect cap, a body cap, no cookie store, no `Referer`, no
cert-ignore hatch.

## What a scheduled sync costs

The cheap check first: `getctag` is one small `PROPFIND`, and an unchanged one
means nothing is fetched at all. When the server offers RFC 6578,
`sync-collection` returns only what changed (plus `404` stubs for deletions);
when it does not, or the token has expired, the fallback is a full
`calendar-query`, which is what every pre-6578 server has always been on. A
manual *Sync now* passes `force`, skipping the ctag check — a user who just
fixed something on the server should not be told "nothing changed" by a token.

A failure is **visible**: the sidebar row shows an amber `!` carrying the
backend's own sentence. This is mail's rule, and the case it exists for is
specific — an account whose password was never saved, or a keyring that is
locked, fails every unattended sync after a relaunch, and a calendar that
quietly stops updating looks exactly like a calendar with nothing new in it.

## Why Phase 3 (push) is not here

Two open questions, both from the plan, neither answerable in code:

1. **Is write access even wanted against an institutional calendar?** A push
   bug that double-books or corrupts a shared work calendar has a materially
   bigger blast radius than the same bug against a personal one. Shipping
   read-only as the end state for such an account, and reserving push for a
   self-hosted server where the user is the sole stakeholder, may simply be
   correct.
2. **The conflict UX is undesigned.** `If-Match` → `412` is the detection
   mechanism, not an answer to what the user sees and does when another client
   changed the same resource. A recurring series makes it worse: a
   single-occurrence edit is, on the wire, a rewrite of the *whole* master
   resource, so a conflict there means "something about this entire series
   changed elsewhere".

What is in place for the day it lands: `CalDavCalendarRef.read_only` is
per-collection and comes from the server's own
`current-user-privilege-set` — a collection someone else shared with you is
legitimately read-only *to you*, and that is a fact to ask for rather than infer
from "push shipped". A server that reports no privileges leaves the field
`false`: an unasserted unknown, not a claim in either direction.
