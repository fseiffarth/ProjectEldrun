## Group Q — Local-Model Mail Assistant (on-device) · 🚧 Planned

*Five opt-in mail features driven by a **local** Ollama model: summarize a
message, auto-file it into Important/Urgent, formalize a reply from rough notes,
and extract a calendar event or a to-do card from it. This is the consumer that
Group J's **#202** reserved — the 🧠 menu's **Mail** role tag
(`MODEL_ROLES` in `LocalModelMenu.tsx`) ships with `pending: true` and nothing
reading it. The model is `ollama_roles["mail"] ?? ollama_model`.*

*The load-bearing invariant: the **AI path never touches the internet**. Mail's
own IMAP/SMTP transport does, but every prompt here runs against a **loopback**
Ollama and refuses a non-loopback host **even when `ollama_allow_remote_host` is
true** — stricter than the setting on purpose. No web fetch / image proxy / link
resolution inside any prompt; the only input is what the local store already
holds. Design + full rationale: [`docs/mail_local_ai_plan.md`](../docs/mail_local_ai_plan.md);
the store/encryption invariants it must honour:
[`docs/context/mail_encryption.md`](../docs/context/mail_encryption.md).*

*Files: new `src-tauri/src/services/mail_ai.rs` (the loopback-only `/api/chat`
helper + prompt builders + defensive JSON parsers) and its commands in
`src-tauri/src/commands/mail.rs` (path-free, respecting `no_command_takes_a_path`);
`sync_inner` classify hook + a `priority_source`/`priority_reason` schema bump in
the mail store; `src-tauri/src/schema/settings.rs` (five `mail_ai_*` flags +
`mail_ai_auto_create`); `src-tauri/src/lib.rs` (`generate_handler!`). Frontend
`src/components/mail/{MailMessageView,MailComposeDialog,MailList}.tsx`,
`src/components/layout/LocalModelMenu.tsx` (drop `pending`),
`src/components/layout/SettingsPanel.tsx` (the "Mail AI (local)" section),
`src/lib/todoBoard.ts` (reuse `taskFromMail`), `src/lib/i18n.ts`,
`src/styles/themes.css`.*

203. **Shared foundation.** `services/mail_ai.rs`: `mail_ai::chat` — a wrapper
    over the existing `/api/chat` (`stream:false`, system+user, bounded
    `num_predict`, low temperature) that resolves the mail-role model, **enforces
    loopback** (reuse `host_is_loopback`, refuse a remote host regardless of
    `ollama_allow_remote_host`), refuses an **embedding-only** model with a
    "load a completion model" reason, and maps an unreachable server to the
    `not_running` sentinel. Empty/absent capabilities read as *unknown → allow*.
    Make the 🧠 **Mail** chip live (drop `pending: true` + the `roleNotWired`
    tooltip clause). Add the **"Mail AI (local)"** settings section holding the
    five toggles — all `Option<bool>`, **default off**, each gated by
    `mail_client` + a resolvable loopback mail-role model. Prerequisite for
    #204–#208.

204. **Summarize incoming mail.** `mail_summarize(message_id)` → fetch body text
    (reuse `mail_body`'s decode/sanitize path), truncate, prompt for ≤N bullet
    points, return plain text. **Ephemeral** — never persisted (decrypted
    plaintext to disk is forbidden); held in frontend state per open. UI: a
    "Summarize (local)" control in `MailMessageView` (on-demand;
    auto-on-open a later sub-option). Toggle `mail_ai_summarize`.

205. **Auto-classify → Important / Urgent.** In `sync_inner`, **new inbox
    messages only, after the keyword-filter pass** (mail.rs:1756), reading
    **subject + sender + preview snippet only** (never a body download). Must
    **not masquerade as a keyword filter** (schema doc mandate): a mail-DB bump
    adds `priority_source` (`user|filter|model`) + `priority_reason`, **sealed**,
    so the UI can say *"marked Urgent by the local model: '…'"*. A model failure
    **never fails a sync** (skip/cap/timeout). `mail_ai_classify_apply(dry_run…)`
    is the manual "what would this catch" counterpart, mirroring
    `mail_filters_apply` but with its own source-labelled report. Toggle
    `mail_ai_autoclassify` (read in the backend sync).

206. **Formalize a reply from notes.** `mail_formalize_reply(notes,
    message_id?, account_id, tone?)` → optional original body as context + rough
    notes → a formal reply body. **Never sends** — only fills the composer's
    `body_text` for explicit review/send. UI: a notes textarea + "Draft from
    notes" button in `MailComposeDialog`. Toggle `mail_ai_formalize`.

207. **Calendar entry from email.** `mail_extract_event(message_id)` → JSON
    `{ title, start, end?, all_day, location?, confidence }`, prompt anchored on
    the message `Date` **and** today so relative phrasing resolves; parsed
    defensively (low confidence / unparseable → no event). **Review before
    create is the default**: pre-fill the existing `EventDialog` for one
    confirming click. **Full automation is opt-in** (`mail_ai_auto_create`,
    default off) — a high-confidence event created without the dialog, tagged
    with mail provenance and deletable. Writing `calendar.json` is local/offline.
    Toggle `mail_ai_calendar`.

208. **To-do card from email.** `mail_extract_task(message_id)` → JSON
    `{ title, due?, priority? }`, same anchoring/defensive parse. **Reuses
    `taskFromMail`** so an AI card is the same kind of card as a hand-made one
    (board's first column, carries the mail link). Same **review-by-default /
    `mail_ai_auto_create` opt-in** posture as #207. Toggle `mail_ai_todo`.

**Verification:** `cargo test` (pure helpers — prompt builders, JSON extractors,
date anchoring, classify/event/task parsers, provenance round-trip,
loopback-refusal), `npm test`, `npm run lint`, clippy, `privacy-check.sh`. **No
live run** (Claude cannot launch Eldrun); every feature stays `untested` until
the user runs it, and each new surface carries an `UntestedTag`.
