# Mail MCP: "draft a mail to X with project file f attached"

Status: plan, reviewed 2026-09-24 (one security review, one design review;
their required changes are folded in below). Extends `docs/mail_mcp_plan.md`
(§Drafts: **No attachments**, recipients never from a root agent) and
`docs/context/root_console.md` §Mail. This document says which rules move,
how far, and why the result is still a gate the user can hold.

## The ask

From a root tab (`Caller::Agent`, a cloud CLI in the root console with the
Eldrun MCP), the user wants to say:

> write a mail to X, attach `thesis/out/paper.pdf`

and get a draft in Eldrun's composer that already carries the file and shows
the suggested recipient. The user still adds the address and presses Send.

Three things stand in the way today:

1. **The root fence hides in-home projects.** `agent_fence::roots_for_scope(None)`
   binds only `~/eldrun/root` read-write; `$HOME` is an empty tmpfs (projects
   outside `$HOME` are visible through the `--ro-bind / /`). A root agent
   cannot list or search a project under `~/eldrun/projects`, so it cannot
   name the file.
2. **Agent drafts have no attachments, by rule.** The tool has no argument,
   `mail_draft_update` clears `staged` on every write, and
   `MailStore::change_agent_draft` refuses a draft whose `staged` is non-empty.
   Tests pin it: `no_mail_tool_takes_a_path_a_file_a_bcc_or_a_url`,
   `a_root_tabs_draft_is_marked_empty_handed_and_never_addressed`, the
   `!next.staged.is_empty()` check in the store.
3. **A root tab's draft has no recipient.** `apply_recipients` refuses `to`/`cc`
   from a caller that cannot read mail.

The attack all three defend against: injected text (a git log, a README, a
mail body) makes the agent attach `~/.ssh/id_ed25519` or the mail store,
addressed to the attacker, and the user presses Send without reading. Every
change below must leave that attack no better off.

## Threat model

- Everything inside a project folder is attacker-controlled (`AGENTS.md`). A
  root agent that reads projects reads untrusted text from all of them; a
  reference it hands Eldrun may be one an attacker composed.
- Eldrun (the MCP process) is **not fenced**. Any path-shaped argument makes
  Eldrun read on the agent's behalf. The project's own rule, stated for the
  `.ics` import: Eldrun never reads what the calling tab's fence hides. So
  attaching is only offered where the tab could read the file itself.
- The agent never receives file bytes back. Exfiltration needs a recipient
  and a Send, so the load-bearing gates are **the agent never sets a
  recipient** and **the reviewed set is exactly what is sent**.
- A root agent has the open network. Once it can read every project, one
  poisoned project can reach the others through it. That is the cost of
  Phase 0, and why it is a switch, default off.
- `Reader` (VM) and `LocalModel` tabs get no attachments at all.

## Design

### Phase 0 — the root fence exposes projects read-only (switch, default off)

Setting `root_fence_projects_readable: Option<bool>` (accessor like
`agent_fence_paths`; default **off**). When on, at a root-scope spawn
(`scope_id.is_none()`), every local project's `directory`, each box folder and
each remote project's local mirror is added **read-only**.

- Mechanism: **not** through `roots_for_scope` — every root it returns becomes
  a read-write `--bind`. Add `root_project_read_only_paths(settings, projects,
  boxes)` whose result is appended to the read-only channel: `extra_ro`
  (`--ro-bind-try`) on Linux and `readable` on macOS. Masks are spliced after
  all binds (`mask_private_state`), so the state dir and credential masks
  still win; a default mirror under `<state_dir>/remote-projects/` stays
  masked, as today.
- Project scopes are untouched; `compute_fence_roots` for a project id keeps
  returning only that project's roots plus its boxes.
- Recorded at spawn into the root MCP `Session` (like the token), as
  `projects_grant`: the exact paths the fence bound (`Paths`), nothing
  (`Hidden`), or everything for an unfenced agent (`All`). Attach refuses a
  root outside the recorded paths, so a project added after the tab started
  needs a new root tab. Phase 1 reads that record, never the live
  setting: the tab's own fence is what matters, and a flag flipped later must
  not change what Eldrun reads for a running tab. When the global fence is
  off (the agent is unfenced), the record is `true`: it already sees
  everything.
- Surfaces: the Settings fence sub-panel (label + help explaining the
  widening); `root_mcp_status` and its TS type carry `projects_readable`.
- Docs: `docs/context/root_console.md:185` (root fence roots) gains the
  exception and says why it is a widening; `docs/context/agent_authority.md`
  §fence gets one sentence.
- Follow-up, not now: a per-project "visible to the root agent" opt-in would
  be a better shape than one global switch.
- Fence test asserts on planner args (like
  `git_control_files_are_rebound_read_only_after_the_root_grant`): flag on
  → project dirs appear as `--ro-bind-try` and never as `--bind`; flag off →
  absent; a project scope is unchanged either way.

### Phase 1 — `attach` on `mail_draft_create` / `mail_draft_update`

**Argument** (schema for `Caller::Agent` only; absent for `Reader` and
`LocalModel`, and the draft functions themselves refuse it for those callers
because `root_mcp_mail::call` validates nothing):

```json
"attach": {
  "type": "array", "maxItems": 5,
  "items": { "type": "object",
    "properties": {
      "project": { "type": "string", "maxLength": 200, "description": "Project id or name (projects_list)." },
      "path":    { "type": "string", "maxLength": 1024, "description": "Path inside that project, forward slashes, no `..`." }
    },
    "required": ["project", "path"] }
}
```

`root_mcp_security::validate` ignores `maxItems`, so the ≤ 5 cap is enforced
in the service. Replace semantics on update: the list given is the agent
staged set the draft has; an omitted `attach` leaves it alone; `attach: []`
removes it. No content argument, no URL, no absolute path.

**Precondition.** `Session.projects_readable` must be true, else refused with
a message naming the Settings switch. With the record false Eldrun would read
what the tab cannot, and the `.ics` rationale forbids exactly that. Windows:
`attach` is refused with a named reason on this landing (no fence exists
there and no `openat`); a handle-based reparse-point check is a filed
follow-up.

**Resolution — the same-roots rule.** Eldrun attaches what a *fenced tab of
that project* could read, and no more:

1. `project` resolves through `projects.json` (id, else unique name), the
   trusted list. Unknown → the same "unknown project" `projects_git_status`
   gives.
2. Roots = `agent_fence::compute_fence_roots(boxes, projects, id, local_only
   = true)` **with the `roots_for_scope` override applied**: a remote project's
   first root is `remote_sync::mirror_dir(id)`, never its remote `directory`
   string read on the local disk (a legacy remote project without a `mirror`
   key would otherwise resolve to, typically, the user's home).
3. Refuse any root that is `/`, is `$HOME` or an ancestor of it, or lies
   inside the state dir (the fence masks those; same-roots must not be wider
   than the fence).
4. `path` is split on `/`; empty, `.`, `..` components, backslashes, NUL and a
   leading `/` are refused before any I/O.
5. Open by walking components from the root with `openat(O_NOFOLLOW |
   O_DIRECTORY | O_CLOEXEC)` per directory and a final `openat(O_NOFOLLOW |
   O_NONBLOCK | O_CLOEXEC)`; `fstat` → `S_ISREG` else refuse (a FIFO must not
   block the handler); read from the fd with the read capped at `MAX + 1`
   bytes. No `canonicalize`, no `metadata` on a path string: no window
   between check and read, and a symlink at any component, even one pointing
   back inside the project, is refused.
6. Masks on top: anything under `private_state_paths()`, any `.git/`
   directory contents. A secret-shaped basename denylist (`.env*`, `*.pem`,
   `*.key`, `id_rsa*`/`id_ed25519*`/`id_ecdsa*`, `*.p12`, `*.pfx`, `.netrc`,
   `.npmrc`, `.pypirc`, `credentials*`, `.git-credentials`, `*.kdbx`,
   `*token*`, `*secret*`) refuses with the reason named. The denylist is
   defence in depth only (a writer in the project copies `.env` to
   `notes.txt`); the docs must not list it as a defence.
7. Caps: ≤ 5 files per draft, each ≤ `MAX_STAGED_BYTES` (20 MiB, the
   composer's cap; move the constant out of `commands/mail.rs` into
   `schema::mail` or `mail_store` so the service does not import commands),
   ≤ 25 MiB per draft, and **≤ 100 MiB of agent-staged bytes per tab across
   its drafts** (an injected loop must not fill the disk). Over → refused,
   nothing staged.
8. Bytes are copied into the outbox at call time (sealed, 0600). Send reads
   the copy, never the project. The reply carries `filename`, `size`,
   `sha256` per file; no bytes.

Filename: basename through `mail_sanitize::sanitize_attachment_name`; MIME
from `mime_guess` on the sanitized name, as `mail_attach_pick` does.

**Store.** The `staged` table gains two columns with the additive migration
pattern already used: `origin TEXT NOT NULL DEFAULT ''` (`''` → `None`) and
`source TEXT NOT NULL DEFAULT ''` (`<project name>/<relative path>`, shown on
the chip so `paper.pdf` from project B is not mistaken for A's).
`StagedAttachment` (Rust and `src/types/mail.ts`) gets `origin?` and
`source?`; old rows and old draft JSON round-trip via serde defaults. The
**table is the truth** for Send; the draft JSON mirrors it so replace
semantics can diff `before.staged`. An origin living only in draft JSON
would be lost on the first composer save, which clears `draft.origin`.

New `MailAccess` method `change_draft_files(before, after, add:
Vec<NewStagedFile>, remove: &[staged_id]) -> Result<Vec<StagedAttachment>>`
(default impl for the fixture) backed by **one** store method that, under one
`conn` lock: CAS-compares the draft JSON → refuses if any *table* row of this
draft has `origin != "agent"` (a user picked a file into it; the agent is out)
→ writes sealed files → upserts rows → deletes removed rows and files →
upserts the JSON. `change_agent_draft`'s invariant becomes "every table row
of an agent draft is agent-origin". `mail_draft_delete` (the agent's) removes
the outbox dir like `delete_draft` does.

**Send is bound to the reviewed set in the backend.** `mail_draft_save` does
its `store.staged()` read and `save_draft()` under one lock. `mail_draft_send`
takes `stagedIds: string[]` and, under the same lock and before building the
message, refuses when the set differs from `store.staged(&id)` or when the
draft's `origin` is still set (never saved by the composer). The composer
compare below is the visible half; this is the load-bearing half.

### Phase 2 — a suggested recipient, never an address

The agent may pass `suggested_to: string[]` (≤ 5, syntax-validated, Agent
only). It is stored on the draft as `suggested_to`, **never** copied into
`to`, never read by `mail_draft_send`, and the composer renders it as an
"agent suggests: X — Add" pill. Adding is a click; a click is an action, a
re-read is not. `bcc` stays non-existent, `to`/`cc` stay refused for a root
tab, `mail_drafts_list` does not echo suggestions (no oracle).

Rejected: a "known correspondent" rule (address occurs on any message in the
account). One spam mail makes the attacker a correspondent, and the lookup is
an oracle for a caller class defined as never reading mail.

### Composer and review panel (the gate the user holds)

Today the composer starts `staged` as `[]` and never loads it from the draft,
while Send attaches `store.staged(id)`; an agent file would be sent unseen.

- `mail_agent_drafts` fills `staged` from the table; the composer seeds from
  `draft.staged` and renders agent-origin rows as distinct chips: the chip
  text is `source` (project/relative path), a small "agent" mark,
  `UntestedTag`, the same remove ✕.
- Preview: lift the received-mail attachment preview rendering out of
  `MailMessageView.tsx` into a shared piece (copy the working sibling) and add
  `mail_staged_preview(draftId, stagedId)` that decrypts the outbox copy with
  the same type and size caps.
- `doSend` compares the ids in the `staged` closure captured before the save
  with `saved.staged` returned by `mail_draft_save`, and returns with a
  visible i18n message before calling Send when they differ; then calls
  `mail_draft_send` with those ids. `mail_attach_pick` on an agent draft
  stages user rows without a save; the agent's next write then fails through
  the table check.
- Suggested-recipient pill as above.
- The agent-draft row lives in `MailPane.tsx` (`mail-agent-draft-row`), not
  `RootOverlay`: the row text carries attachment count and "suggests N
  recipients" so the difference from a plain draft is visible before opening.

### Tool descriptions and instructions

`draft_note`: "Only the user can send it. Files are attached from projects
only, by project and path, copied when you ask, and shown to the user with
their source before sending; recipients are suggestions the user adds." The
server `instructions` string gains one sentence on the same-roots rule so the
agent does not try `~/...`.

### Tests

- Rename `no_mail_tool_takes_a_path_a_file_a_bcc_or_a_url` to state the new
  rule; it recurses into `items.properties` and asserts `path` appears only
  under `attach`, for `Agent` only; top-level keys still exclude `file`,
  `attachment`, `bcc`, `url`, `content`, `base64`.
- `a_root_tabs_draft_is_marked_empty_handed_and_never_addressed` keeps "no
  to/cc/bcc, no reply"; the empty-`staged` half becomes the table below.
- Same-roots table (temp `projects.json`/`boxes.json`/tree pointed to by
  `stores.projects`/`stores.state`, drive `call`, assert on the fixture's
  recorded files): plain file OK; `..`, absolute, backslash, NUL → refused
  before I/O; symlink out → refused; symlink in → refused; symlinked
  directory component → refused; FIFO → refused; `.git/config` → refused;
  `.env`, `id_ed25519`, `foo.pem` → refused by name; over-cap → refused,
  nothing staged; 6 files → refused; per-tab byte cap → refused; unknown
  project → unknown project; box sibling root → OK; a non-box project naming
  another project's file → refused; legacy remote project without `mirror`
  → mirror dir, never the remote path; root at `$HOME` → refused;
  `projects_readable == false` → refused naming the switch.
- Content pinned at call time (`mail_store` test): stage, overwrite the
  source, send-time bytes equal the staged copy.
- Store: agent write against a draft holding a user-origin row → refused;
  CAS with a concurrent composer save → agent write fails; agent delete
  removes the outbox dir; old `staged` rows load with `origin: None`.
- `mail_draft_send` with a stale `stagedIds` → refused; with `origin` still
  set → refused.
- Reader / LocalModel: `attach` and `suggested_to` absent from schema and
  refused when sent.
- Phase 2: `suggested_to` stored, `to` empty, `mail_drafts_list` does not
  echo it, syntax-invalid entries refused.
- Frontend (vitest): composer renders agent chips from `draft.staged` with
  `source`; Send aborts on id mismatch; the suggestion pill adds on click;
  `MailPane` row text carries counts; `UntestedRegistry.test.ts` call sites.
- Fence planner args as in Phase 0.

### Docs, register, QA, i18n

- `docs/mail_mcp_plan.md` §Drafts: replace the **No attachments** bullet and
  amend the recipients bullet; §Tests: the renamed test. Edit those ranges
  only (`rg -n`, never read whole).
- `docs/context/root_console.md`: fence-roots exception (§token boundary
  paragraph), §Mail bullets for `attach`, `suggested_to`, the send binding.
- `docs/context/agent_authority.md` §fence: one sentence.
- `docs/filemap_backend.md` rows: `root_mcp_mail.rs`, `mail_store.rs`,
  `agent_fence.rs`, new `mail_attach.rs` if created; `docs/filemap_frontend.md`
  row: `MailComposeDialog.tsx`, the shared preview piece. One line each.
- `src/lib/untested.ts` rows: `mail.agentAttachmentChip`,
  `mail.agentSuggestedRecipient`, `settings.rootFenceProjects`.
- `todo/group-q-mail-ai.md`: QA item with 🖐️ platform pairs.
- `src/lib/i18n.ts` (English holds every key): chip mark, Send-abort message,
  suggestion pill, setting label and help, refusal reasons that reach the UI.
- After backend edits: `npm run backend:stale` and report its result. If the
  phone shows the flag, `npm run mobile:bundle`.

## Out of scope

- Attaching from `~/eldrun/root` or any non-project path.
- A `projects_search` MCP tool: with Phase 0 on, the agent uses its own tools.
- Sending, scheduling a send, changing `mail_draft_send`'s user gate beyond
  the `stagedIds` binding.
- Reader or local-model attachments; Windows attach (refused, follow-up).
- A per-project "visible to the root agent" opt-in (follow-up).
