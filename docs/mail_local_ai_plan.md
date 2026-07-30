# Local-Model Mail Assistant — plan

Five opt-in mail features driven by a **local** Ollama model: summarize an
incoming message, auto-file it into Important/Urgent, formalize a reply from
rough notes, and extract a calendar event or a to-do card from it. This is the
consumer that Group J's **#202** reserved — the 🧠 menu's **Mail** role tag has
shipped for months (`MODEL_ROLES` in `LocalModelMenu.tsx`, `pending: true`) with
nothing reading it. Building these features is what makes that tag live.

Group: **Q** (`todo/group-q-mail-ai.md`, items #203–#208).

---

## The one invariant that shapes everything: the AI path never touches the internet

The mail *transport* (IMAP/SMTP) uses the network — unavoidable. Every **AI**
feature here runs only against a **loopback** Ollama and nothing about a message
ever leaves the machine.

- A shared helper, `mail_ai::chat`, resolves the endpoint and **refuses any
  non-loopback host — even when the global `ollama_allow_remote_host` is
  `true`.** The general `commands::ollama::ollama_http` permits a remote host
  behind that opt-in; the mail-AI helper is deliberately *stricter than the
  setting*, because "classify my mail on someone else's box" defeats the whole
  point. A non-loopback resolution makes the feature unavailable with a stated
  reason, never a silent remote call.
- No web fetch, no image proxy, no link resolution inside any prompt. The only
  input is what the local store already holds.
- Each toggle's copy says so: *"runs entirely on this machine; nothing about
  your mail leaves it."*

`host_is_loopback` already exists in `commands::ollama`; the helper reuses it and
short-circuits before dialling.

---

## Shared foundation (#203)

- **`mail_ai::chat`** — a thin wrapper over the existing `/api/chat`
  (`stream:false`, a `system` + `user` message, bounded `num_predict`, low
  temperature) that (a) resolves the model from `ollama_roles["mail"] ??
  ollama_model`, (b) enforces loopback, (c) refuses an **embedding-only** model
  (Ollama says `embedding` without `completion`) with a "load a completion
  model" reason, and (d) maps an unreachable server to the existing
  `not_running` sentinel every 🧠 surface already branches on. Absent/empty
  capabilities read as *unknown → allow*, matching `model_capabilities`.
- **Live Mail chip** — drop `pending: true` (and the `roleNotWired` tooltip
  clause) from `MODEL_ROLES` once a consumer exists.
- **"Mail AI (local)" settings section** — a new sub-panel (under the Mail /
  Ollama settings) holding the five toggles below, each **default off**, each
  gated additionally by `mail_client` and a resolvable loopback mail-role model.
  Off is the honest default: every one of these runs a model over message
  content, which is a thing to opt into rather than inherit.

### Settings fields (all `Option<bool>`, default off / absent)

| Field | Feature | Read where |
|-------|---------|-----------|
| `mail_ai_summarize` | 1 | frontend (`MailMessageView`) |
| `mail_ai_autoclassify` | 2 | **backend `sync_inner`** + frontend |
| `mail_ai_formalize` | 3 | frontend (`MailComposeDialog`) |
| `mail_ai_calendar` | 4 | frontend |
| `mail_ai_todo` | 5 | frontend |
| `mail_ai_auto_create` | 4 + 5 | **backend** (the "no review step" opt-in; default off) |

Per the `mail_client` precedent, the user-triggered commands are **not** refused
in the backend when their flag is off — a renderer that could invoke them could
equally flip the setting, so a second gate would buy nothing. The exceptions are
the two flags a background pass reads: `mail_ai_autoclassify` and
`mail_ai_auto_create`, which *are* checked in the sync path because there is no
UI in the loop to gate them.

---

## Feature 1 — Summarize incoming mail (#204)

- **`mail_summarize(message_id, state)`** → fetch the message body text (reuse
  `mail_body`'s decode + sanitize path), truncate to a byte cap, run a
  "summarize in ≤N bullet points, no preamble" prompt, return plain text.
- **Ephemeral by design.** Decrypted plaintext is never written to disk
  (`docs/context/mail_encryption.md`): the summary is derived from the body and
  is held in frontend state per open, never persisted. (A sealed `summary`
  column is a possible later optimization; leading with ephemeral keeps the
  encryption invariant trivially true.)
- **UI:** a "Summarize (local)" control in `MailMessageView`, on-demand.
  An "auto-summarize on open" sub-option is a cheap add-on once the button works.

## Feature 2 — Auto-classify → Important / Urgent (#205)

- **In `sync_inner`, new inbox messages only, *after* the keyword-filter pass**
  (mail.rs:1756) — so an explicit user keyword rule always wins and only
  still-unmarked messages reach the model. Reads **subject + sender + stored
  preview snippet only**, never a per-message body download (the same constraint
  `MailFilterField::Preview` documents). Gated by `mail_ai_autoclassify` read in
  the sync.
- **Must not masquerade as a keyword filter.** The schema doc is explicit that a
  model classifier is "a separate, later thing [that] must not be able to
  masquerade as [the manual filters]." So classification carries **distinct
  provenance**: a mail-DB schema bump adds `priority_source`
  (`user | filter | model`) and `priority_reason` (the model's one line),
  **sealed** under the store key like every other value. The UI then says
  *"marked Urgent by the local model: '…'"* vs the filter's *"rule Billing"*.
- **A model failure never fails a sync.** Model down / slow / absent → skip
  silently; cap messages-per-sync; per-message timeout. The classifier is
  best-effort filing, not a sync precondition.
- **`mail_ai_classify_apply(dry_run, account_id?, limit?)`** — the manual
  counterpart, mirroring `mail_filters_apply`, for a "what would this catch"
  preview and a re-run over recent mail. Returns a report distinguishable from
  the filter report (its own source label), never the `MailFilterReport` shape.

## Feature 3 — Formalize a reply from my notes (#206)

- **`mail_formalize_reply(notes, message_id?, account_id, tone?, state)`** →
  optional original body as context + the user's rough notes → a formal reply
  body. **Never sends.** It only returns text the composer drops into
  `body_text`; the user reviews and sends explicitly, matching the composer's
  existing all-explicit posture (Sign/Encrypt never sticky, attach is a backend
  pick, no silent anything).
- **UI:** a notes textarea + "Draft from notes" button in `MailComposeDialog`.

## Feature 4 — Calendar entry from email (#207)

- **`mail_extract_event(message_id, state)`** → the model returns **JSON**
  `{ title, start, end?, all_day, location?, confidence }`. The prompt is
  anchored on the message's own `Date` header **and** today's date so relative
  phrasing ("next Tuesday 3pm") resolves; the model is never trusted as the
  clock — output is parsed defensively and a low-confidence / unparseable result
  yields **no event**.
- **Review-before-create is the default.** Extraction runs automatically; the
  result **pre-fills the existing `EventDialog`** for one confirming click,
  reusing its repeat/reminder/conference-link detection. This matches the app's
  standing rule that mail must never quietly write to the user's own data.
- **Full automation is opt-in (`mail_ai_auto_create`, default off).** With it on,
  a high-confidence event is created without the dialog — tagged with its mail
  provenance and trivially deletable. Writing `calendar.json` is **local /
  offline**; if that calendar is CalDAV-backed, the user's *existing* sync pushes
  it later, exactly as it would a hand-made event — not this feature's network.

## Feature 5 — To-do card from email (#208)

- **`mail_extract_task(message_id, state)`** → JSON `{ title, due?, priority? }`,
  same date-anchoring and defensive parse.
- **Reuses the existing `taskFromMail` builder** (`lib/todoBoard`, already the
  to-do mail rail's manual convert), so an AI card and a hand-made card are the
  same kind of card — filed into the board's first column, carrying the mail
  link. Same **review-by-default / `mail_ai_auto_create` opt-in** posture as
  feature 4.

---

## Invariants recap

Loopback-only AI (stricter than `ollama_allow_remote_host`) · no web access in
any prompt · path-free commands (respect `no_command_takes_a_path`) · no
decrypted plaintext to disk (ephemeral summaries; sealed provenance) · the model
classifier is visibly distinct from keyword filters · calendar / to-do default
to **review-before-create**, full automation opt-in and off by default · a model
failure never fails a sync · embedding-only / absent model → a "load a local
model" hint, not an error · an `UntestedTag` on every new surface.

## Verification

`cargo test` (pure helpers: prompt builders, JSON extractors, date anchoring,
classify / event / task parsers, provenance round-trip, loopback-refusal) ·
`npm test` · `npm run lint` · clippy · `privacy-check.sh`. **No live run** —
Claude cannot launch Eldrun; results reported from the automated gates only and
every feature stays `untested` until the user runs it.

## Implementation split

Five agents map to the five features; **#203 (the `mail_ai` helper + live Mail
chip + settings section) is the shared prerequisite** one agent lays down first.
Features 4 and 5 share the "extract JSON → prefill an existing dialog" pattern
and can pair up.
