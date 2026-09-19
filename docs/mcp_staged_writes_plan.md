# Staged writes for the root MCP tools — plan

A root agent's calendar and board tools write straight into `calendar.json`
today, and the window pushes the row to CalDAV a moment later. This plan puts a
copy between the agent and the real store: the agent works on **its own copy**,
every write becomes a **proposal**, and a proposal reaches the real calendar,
board or mailbox only after **you approve it in the window**.

Status: calendar/board first cut implemented; live QA pending. Implementation
and limits: [`context/root_console.md`](context/root_console.md#staged-writes).
Per-tab tokens are shared with [`mail_mcp_plan.md`](mail_mcp_plan.md). Its newer
reader-class design supersedes the read-taint latch below; mail draft integration
and reader marking remain deferred until those tools exist. Calendar visibility
scoping remains a separate read-gate feature. The sections below record the
original design; the implementation also captures first-move board metadata and
checks calendar routing/access as approval preconditions.

---

## What it is, and what it is not

Two gates, one per direction:

| Gate | Direction | Mechanism |
|---|---|---|
| **Read gate** | store → agent | What enters the agent's copy is scoped and opt-in. Calendars and board: per-calendar visibility. Mail: `mail_mcp_plan.md` — no agent with open network reads mail at all; only a contained reader (a VM project behind the allowlisting proxy) does, per-account opt-in, text only, no URLs. |
| **Write gate** | agent → store | Tools write to a per-tab sandbox copy. Each write is recorded as a proposal. Only a Tauri command — which an agent cannot call — applies a proposal to the real store. |

The write gate protects **integrity and outbound actions**: nothing is deleted,
rescheduled, pushed to a CalDAV server or sent without you. It does **not**
protect confidentiality. The copy holds real data, and a root agent has a shell
and the network (`agent_fence` is filesystem-only), so an injected agent can
still leak what it read. That fight belongs to the read gate: for mail it is
settled by `mail_mcp_plan.md`'s contained reader; for the calendar and board a
root agent still reads them with the network in reach, as it does today. The
copy in this plan must never be described as making reads safe.

The read gate is meaningful because the fence already hides `$HOME`: a fenced
root agent cannot open `calendar.json` or the mail store directly, so the MCP
tools are its only door. An agent you chose to run unfenced can read and write
those files itself — the known limit `root_console.md` already states, and this
plan does not change it.

---

## Decisions

### 1. A sandbox copy for the agent's view, a proposal log for the apply

Both halves are needed, and they are different things:

- **The copy gives read-your-writes for free.** Every store tool already takes
  its file through `Stores { calendar: &Path, .. }`. Pointing that path at
  `<state_dir>/root_mcp/sandboxes/<tab>/calendar.json` makes every existing
  tool a sandbox tool with no change to the tool bodies: an agent that adds a
  card and then moves it sees its own card.
- **The copy is never synced back.** Diffing a stale copy against a store you
  kept editing is a merge problem. Instead each write's `Change` rows — which
  the tools already return for the window — are recorded as a **proposal**:

  ```
  Proposal { id, tab, tool, args, created,
             rows: [{ kind, op, pre: Option<Value>, post: Value, local }],
             reader: bool, status }
  ```

  `pre` is the row as the sandbox held it before the call (`None` for a
  create). `post` is the `Change.row`. `tool` and `args` are kept for display
  and audit only, never re-executed: `todo_add` mints an id, and a re-run would
  mint a different one than later proposals refer to.

### 2. Apply is a precondition check, not a merge

Approving proposal *P* applies its rows to the real `calendar.json` through one
new helper, `commands::calendar::apply_change_at(path, change)`, under this
rule per row:

- `pre == None` → the id must not exist in the real store.
- `pre == Some(row)` → the real row must equal `pre`, ignoring fields the
  window itself rewrites on sync (`caldav_etag`, and whatever else the CalDAV
  merge touches — enumerate them in one `const`, tested).

All rows pass or none is written (the atomicity `calendar_move_events` already
has). A failed precondition marks the proposal **conflicted**; it is never
force-applied. The user sees "this entry changed since the agent looked at it"
and can discard it; the agent sees the same on its next call and may
re-propose.

After a successful apply the command emits the same `root-mcp-changed` events
the tools emit today, so the overlay host's merge and the CalDAV push are
untouched. A read-only calendar is still refused at proposal time, before
anything is staged.

### 3. The sandbox is rebuilt, not maintained

Before each tool call: if the real file's content hash differs from the one
the sandbox was built from, rebuild it — copy the real file, then apply every
still-pending proposal of that tab in order under the rule in §2. A proposal
that no longer applies becomes conflicted. The tool result then carries a
note (`"dropped_proposals": [...]`) so the agent is not left believing in a
change that will never land.

Rejecting a proposal is the same path: drop it, rebuild, and any later
proposal that depended on it (touches the same id, `pre` no longer matches)
falls out as conflicted. No dependency graph is stored.

### 4. Approval binds to what you saw

The review card shows the real rows, not the agent's summary: for an update, a
field-by-field before/after from `pre`/`post`; for a delete, the whole row;
for a board move, the card and its new column only (the reindexed siblings are
folded into "and N cards reordered"). Text goes through the same
`strip_invisible` `mail_mcp_plan.md` §4 introduces, so a bidi or zero-width
title cannot make the card say something other than what is written.

`root_mcp_review_apply { id, digest }` carries a digest of the proposal's rows
as rendered. The backend recomputes it and refuses a mismatch, so a proposal
cannot change between your look and your click. Proposals are immutable
anyway: an agent "editing" a pending change creates a new proposal on top.

An event in a CalDAV-backed calendar says so on its card ("will be pushed to
*Work*"): the server may act on it (a scheduling server can mail attendees
held in the row's preserved `extra`), and that is an outbound effect.

### 5. The gate lives where the agent cannot reach

- `root_mcp_review_list`, `_apply`, `_reject`, `_apply_all` are **Tauri
  commands**. An agent cannot make Tauri calls; that is the same boundary
  `mail_draft_send` relies on.
- No MCP tool approves, applies, lists other tabs' proposals or changes the
  review level. A tripwire test pins that no tool name contains `approve`,
  `apply`, `review` or `confirm`, in the `no_command_takes_a_path` style.
- The agent gets one read-only tool, `proposals_list`, scoped to its own tab:
  id, tool, status (`pending` / `applied` / `rejected` / `conflicted`). It
  needs that to answer "did my change land?" truthfully.
- Never the phone. Root is not in `mobile_control`'s catalog, and approval does
  not become a phone route in this plan.
- The sandbox and the proposal log live under `<state_dir>`, which the fence
  hides. They are written by the backend only.

### 6. Review level: a setting, conservative by default

`settings.root_mcp_review` (`Option<String>`, unset = `"all"`):

| Level | Behaviour |
|---|---|
| `all` (default) | Every write is a proposal. |
| `destructive` | Tools with `destructiveHint` are proposals. Additive tools (`todo_add`, `todo_move`, `todo_complete`, `todo_reopen`, `calendar_add_event`, `calendar_create`) apply at once and land in the review log as **applied, with Undo** (undo = apply the inverse rows under §2's rule). |
| `off` | Today's behaviour: direct writes, no sandbox. |

The level reads `tool_annotations`, not a second list, so a new tool is
classified by the hint its author already sets. `destructive` exists because a
gate that asks about every card move trains you to click through it; `all` is
the default because that is what was asked for, and the step down is one
deliberate setting. Read per request, like `root_mcp`, so it needs no restart.

### 7. Mail: the draft is the proposal

Mail gets no sandbox copy — the store is sealed, large, and a copy of it would
be a second plaintext mailbox. `mail_mcp_plan.md` already is this design for
mail: the agent reads through a scoped, enveloped door and **writes drafts
only**; pressing Send in the composer is the approval, bound to exactly what
the composer shows. This plan adds two things to it:

- Agent drafts appear in the **same review surface** as calendar and board
  proposals (a row that opens the composer), so there is one place to look.
- Later, and only if wanted: `mail_propose_flag` / `_move` / `_delete` as
  proposals applied by the existing Tauri mail commands, with the precondition
  "message still in that folder under that UID validity". Not in the first
  cut; `mail_mcp_plan.md`'s "no such tool exists" stands until then.

**The contained reader always stages.** `mail_mcp_plan.md` gives each token a
caller class. A root tab never reads mail, so its writes follow the review
level in §6. A `Reader` — the one caller that has seen a stranger's text — is
served the calendar and board write tools only through this plan, with the
level **forced to `all`**: every write, additive ones included, is a proposal
with `reader: true`, and its card reads *"proposed by an agent that reads mail
from outside"*. `off` and `destructive` cannot lower it. Until this plan is
built, the reader has no calendar or board write tool at all.

The reader's sandbox is built and kept on the host like any other; only the
tool calls cross into the VM.

### 8. Per-tab identity is the prerequisite

A sandbox per tab needs the request to say which tab it is, and today every
root agent shares one process-wide token. This is step 1 of
`mail_mcp_plan.md` ("Per-tab tokens"), unchanged: mint a token per root-agent
spawn, keep a token → tab map beside `Runtime`, drop the entry in
`on_tab_gone`. The map's value is `{tab, class}`; the `local_token` distinction
(`root_mcp_local_only`) becomes two of the classes, and `Reader` a third. Whichever plan is built first
builds this.

Tab close: the sandbox directory is deleted; **pending proposals stay** in the
log until you decide them, marked "from a closed tab". The tab id is the PTY id
(`root:…`), stable across `--resume`, so a resumed agent finds its proposals
again under a fresh token.

---

## Files

Backend:

- `src-tauri/src/services/root_mcp_review.rs` (new, `AppHandle`-free): the
  `Proposal` schema, the log at `<state_dir>/root_mcp/proposals.json`
  (capped: 200 decided entries kept, pending never evicted), sandbox
  build/rebuild, `pre` capture, the precondition rule, digest, undo rows,
  review-level classification from `tool_annotations`.
- `src-tauri/src/services/root_mcp.rs`: per-tab token map; `handle_message`
  gains the caller's tab; `call_store_tool` runs against the sandbox path and
  hands its `Change`s to the review service instead of returning them as
  `Effects` when the level says stage; `proposals_list` tool; tool results gain
  `"staged": true, "proposal": id` so the agent words its answer correctly
  ("proposed", not "done"); the `initialize` instructions say the same.
- `src-tauri/src/commands/calendar.rs`: `apply_change_at`.
- `src-tauri/src/commands/root_mcp.rs`: the four review commands; emits
  `root-mcp-changed` on apply and a new `root-mcp-review-changed` (count only)
  whenever the log changes.
- `src-tauri/src/commands/terminal.rs`: per-spawn token; sandbox cleanup in
  `on_tab_gone`.
- `src-tauri/src/schema/settings.rs`: `root_mcp_review`.
- `src-tauri/src/lib.rs`: register commands.

Frontend:

- `src/stores/rootReview.ts` (new, small): pending list + count, fed by
  `root-mcp-review-changed`.
- `RootOverlay.tsx`: a review strip in the console — pending cards with
  Approve / Reject, "Approve all (N)" that still shows every card, the applied
  log with Undo, conflicted cards with Discard. Reuses the shared dialog/menu
  scheme; no new treatment.
- The header: the console's ⚿ badge gains a pending count, so a proposal made
  while the console is closed is not silently waiting. No toast that steals
  focus.
- Settings, under the existing root MCP switches: the review level.
- `src/lib/i18n.ts`: every string; `UntestedTag` on the strip and the setting.

Docs (when built): `docs/context/root_console.md` gains a "Staged writes"
section; both file maps get their rows. `mail_mcp_plan.md` already points here
from its caller-classes and drafts sections.

---

## Tests

- **Isolation.** After any write tool under `all`, the real `calendar.json` is
  byte-identical; the sandbox differs; a second tab's sandbox does not.
- **Read-your-writes.** `todo_add` then `todo_move` on the minted id works
  inside one tab and yields two proposals.
- **Apply.** Approving both in order produces the same real file as running
  the two tools directly under `off` — table-driven over every write tool, so
  the staged and direct paths cannot drift.
- **Preconditions.** Edit the real row between propose and approve → conflicted,
  real file untouched. Same for a create whose id now exists, and for a delete
  of a row that is gone. A CalDAV sync that only rewrote `caldav_etag` does
  **not** conflict.
- **Atomicity.** A `calendar_move_events` batch with one stale row writes
  nothing.
- **Rebuild.** Reject the add → the dependent move becomes conflicted and the
  next tool result reports it under `dropped_proposals`.
- **Digest.** `apply` with a stale digest is refused.
- **Levels.** Under `destructive`, the auto-applied set equals the
  non-`destructiveHint` write tools exactly; Undo restores the prior bytes;
  Undo after a later user edit conflicts instead of clobbering.
- **Tripwires.** No tool name contains `approve`/`apply`/`review`/`confirm`;
  `proposals_list` returns only the caller's tab.
- **Persistence.** The log round-trips; an unknown `status` from a future
  version survives a load/save.
- **Reader.** (Once the contained reader exists.) A `Reader` token's `todo_add`
  stages with `reader: true` at every review level, `off` included, and the real
  store stays byte-identical.
- Vitest: the strip renders before/after from `pre`/`post`, folds reindex
  rows, and disables Approve on a conflicted card.

---

## Order of work

1. **Per-tab tokens** (shared with `mail_mcp_plan.md` step 1).
2. `apply_change_at` + the review service: schema, log, sandbox build/rebuild,
   preconditions, digest. Pure, tempdir-tested, no window.
3. Wire `root_mcp` to stage under the level; `proposals_list`; result wording.
4. Review commands and events.
5. Frontend: store, strip, badge count, setting, i18n, `UntestedTag`.
6. `destructive` level with Undo.
7. Docs, file-map rows, the TODO item with its QA steps,
   `npm run backend:stale`.
8. *With or after `mail_mcp_plan.md`:* agent drafts in the review strip; the
   reader's always-staged writes. *Later still:* mail flag/move/delete proposals.

Steps 1–4 and 6 need a restart to reach a running window; 5 hot-reloads but has
nothing to show before them.

## Live QA, once built

- Ask a root agent to add an event: the calendar does not show it; the ⚿ badge
  counts 1; the agent says "proposed". Approve: it appears and a CalDAV
  calendar pushes it.
- Ask it to add a card and move it to *Doing*: two cards in the strip; approve
  both; the board matches.
- Ask it to delete an event, then edit that event yourself before approving:
  the card turns conflicted and Approve is unavailable.
- Reject the add from a fresh add-then-move pair: the move falls out as
  conflicted, and the agent reports it on its next call.
- Two root tabs: a proposal from one is invisible to the other's
  `proposals_list`.
- Close the tab with a proposal pending: the card stays, marked as from a
  closed tab, and still applies.
- Set the level to `destructive`: an add lands at once with Undo in the log; a
  delete still waits. Set it to `off`: behaviour is today's.
- Give an event a title with a bidi override: the card shows it inert.

## Open questions

- **Which fields does the CalDAV merge rewrite on a row?** The
  ignore-on-compare list in §2 has to be read off `services/caldav.rs` and the
  window's merge, not guessed. Too short and every sync conflicts every pending
  proposal; too long and a real remote edit is overwritten.
- **Should the read gate for calendars ship in the first cut?** A per-calendar
  "visible to agents" flag is cheap (filter at sandbox build), but it is a
  second feature; the write gate stands without it.
- **Default level.** `all` is proposed. If it proves noisy in daily use,
  `destructive` is the intended resting place — decide after a week with it,
  not before.
