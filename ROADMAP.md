# ProjectEldrun — Roadmap

Reviewed **2026-09-15** against **v0.1.68**. This file records direction and
sequencing; [STATUS.md](STATUS.md) describes the implementation and verification
limits. Concrete tasks live in [TODO.md](TODO.md) and [`todo/`](todo/).

## Implemented Foundation

The Rust/Tauri migration is complete. Project/box desktop contexts, tiling and
pop-out tabs, agent resume, remote SSH/SFTP with Git lockstep and byte-sync,
Docker/VM runtimes, mail/calendar/CalDAV, native viewers, and Eldrun Mobile are
implemented. Windows and macOS have native integration and CI packaging.

Recent work adds the per-project prompt chart, draft board, scheduling and
completion-gated chains, CLI-hook activity, model-aware prompt history, Mobile
Focus transcripts, file sharing to the phone, and print job previews. These are
part of the current baseline; their remaining work is verification and hardening.
The agent's permission mode stays under its own CLI's control.

## Next: Verify and Stabilize the Existing Workflows

1. **Project and session continuity.** Exercise switching projects and boxes,
   detached-window parking/redocking, resize/paste/exit, per-tab Claude/Codex
   resume, continue-latest limits for other CLIs, and remote tmux reconnects.
   Confirm files, app defaults, and time tracking follow the chosen scope.
2. **Prompt delivery.** Live-test draft creation and multi-select moves, schedule
   edits, prefix commands/model choices, closed tabs, missed occurrences, and
   after-links. Check that decisions and new turns postpone follow-ups and that
   hook-free agents' idle heuristic behaves predictably. Schedules currently
   depend on the desktop window being open.
3. **Connected features.** Validate CalDAV pull/push conflicts against a server,
   mail encryption and VPN-gated accounts, Mobile pairing/lock/revocation,
   reconnects after desktop updates, Focus fallback, outbox, and gated writes.
   Verify the opt-in browser live window's permission and IPC boundaries.
4. **Hardware-dependent features.** Run the Deck presenter with a second display,
   printer submission/queue tracking, a real VM boot, and HPC/SLURM workflows on
   a cluster. Test Windows/macOS integrations and KDE Wayland on real desktops.

Track results per item in the existing groups, and remove an `UntestedTag` only
after user confirmation. See [verification](todo/group-y-verification.md),
[sessions](todo/group-f-session.md), [remote/HPC](todo/group-g-remote.md),
[mail](todo/group-j-mail.md), [CalDAV](todo/group-x-caldav.md),
[presenter](todo/group-v-presenter.md), and
[Mobile acceptance work](docs/eldrun_mobile_agent_plan.md).

## Reliability and Maintenance

- **Runtime and security:** continue PTY/process cleanup, fence/credential
  boundary checks, durable session metadata, and explicit handling of stale
  packaged backends/PWA bundles. Keep Git lockstep and byte-sync ownership
  separate; retain file-backed local-loss notices for destructive background
  moves. See [runtime](todo/group-i-runtime.md) and
  [security](todo/group-o-security.md).
- **Measured responsiveness:** measure UI and remote-probe costs before widening
  polling or adding visual work. Preserve visible-only viewer/terminal work,
  panel snapshots, Fast mode, and Energy Saver; examine remaining background
  sync/lockstep costs. See [performance](todo/group-u-performance.md).
- **Maintainability:** split the largest viewer, tab-store, and project-command
  modules in focused changes behind the existing CI gates. Keep desktop and
  Mobile type-checks, tests, lint/clippy, and the privacy scan mandatory.
  Broad Rust formatting remains deliberately deferred.

## Product Follow-ups

- **Prompt Universe — planned, not built.** Add a global cross-project agent/job
  overlay using the existing project-cloud UI and prompt/activity stores. The
  current prompt chart remains scoped to one project or box. See the
  [Prompt Universe plan](docs/prompt_universe_plan.md).
- **Git hosting:** GitHub and GitLab publishing already ship. A generic remote
  URL flow and reducing the dependence on provider CLIs remain follow-ups.
  See [hosting](todo/group-p-hosting.md).
- **Local agents and models:** finish driver discoverability and restore
  behavior, and separate the local-runtime interface from Ollama assumptions.
  The smart/native shell is still research, not an implemented replacement for
  the PTY. See [local agents](todo/group-s-agents.md) and
  [smart shell](todo/group-t-shell.md).
- **Viewers and presenter:** continue the open editing, performance, and
  presentation work after acceptance checks. Remaining Office formats still
  open externally. See [viewers](todo/group-m-viewers.md) and
  [presenter](todo/group-v-presenter.md).

## Spare-Capacity Backlog

A lookup for weeks with agent budget left over: self-contained improvements
that are worth doing but gate nothing above. Pick from the top of a group;
each entry names where the work lives. Add new groups below as they come up.

### Text viewer autocomplete (#45, `FileViewerPane.tsx` + `commands/ollama.rs`)

Today: a debounced (600 ms) ghost from whichever Ollama model is loaded, via
`/api/chat` with a BEFORE/AFTER prompt, Sentence/Block/Scope modes, hand-picked
reference files, and Tab / → / Esc to accept, walk, or dismiss.

1. **Bound the window sent.** `requestCompletion` sends the whole draft on
   either side of the caret on every pause; a long `.tex` file costs a full
   prompt evaluation each time. Send a caret-centred window (e.g. ~4 k chars
   before, ~1 k after, cut on line boundaries) so latency stops scaling with
   file size.
2. **Native fill-in-the-middle for FIM models.** Coder models (qwen2.5-coder,
   codegemma, starcoder2, deepseek-coder) complete far better through
   `/api/generate` with `suffix` than through a chat instruction. Detect
   insert capability per model and keep the chat path as the fallback.
   This removes most of the need for `clean_completion`'s preamble and fence
   stripping.
3. **Cancel for real.** Aborting only drops the result. The blocking
   `ollama_http` call still runs to its `num_predict` cap, so fast typing
   queues stale generations inside Ollama. Close the socket on abort, or move
   the request to a cancellable task.
4. **Stream into the ghost.** Show tokens as they arrive instead of after the
   full reply. This matters most for Block and Scope modes (256+ tokens).
5. **Type-through keeps the ghost.** Any keystroke dismisses the suggestion,
   and the next one comes 600 ms later. If the typed characters match the
   start of the ghost, consume them and keep the rest.
6. **Drop the per-request model lookup.** Every trigger first calls
   `list_ollama_models_detailed`. Cache the loaded set briefly, or refresh it
   when the 🧠 menu changes it.
7. **Automatic context.** Beyond the manual picker: the files open in other
   tabs, files the current one imports or `\input`s, and for LaTeX the
   document's `\label` / bib keys. Keep it capped by the existing
   `MAX_CONTEXT_*` budget.
8. **Prose awareness.** For Markdown/LaTeX/plain text, tell the model to keep
   the document's own language, so a German paragraph is not continued in
   English. Add a stop at a line or sentence end in Sentence mode.
9. **Smaller wins.** Accept one line at a time (next to →'s word walk). Cycle
   2–3 candidates. A cache keyed on the prefix tail, so undo/redo and
   re-visiting a caret do not re-query. Local-only accept/dismiss counters
   (`usage_stats`) to judge which mode and model are worth it.

### Mail AI (Group Q #203–#208, `services/mail_ai.rs`, `MailAi*.tsx`)

Today: loopback-only Ollama; on-demand summary, event and to-do extraction,
draft-from-notes in the composer, and subject/sender/preview triage into
Important/Urgent at sync. All of it is per-account opt-in and untested live.
Every idea below has to keep the Group Q invariants: loopback only, nothing
decrypted persisted, review before create, and a model verdict never shown as
a filter hit.

1. **Live QA first.** Run the five checks in `todo/group-q-mail-ai.md` and
   remove the tags. Most of the items below tune prompts, and that only makes
   sense against real mail.
2. **Thread-aware summary.** Summarize the whole conversation (the thread the
   message belongs to), not the one message, and lead with the open question
   or request addressed to the user.
3. **Suggested replies.** From the open message, offer 2–3 one-line reply
   intents ("accept", "decline politely", "ask for the agenda") that feed the
   existing *Draft from notes* path. The same rule holds: it fills the
   composer, never sends.
4. **Reply in the sender's language.** Detect the original's language and draft
   in it by default. Add tone presets (formal / friendly / short) and a
   per-account signature and name for the draft.
5. **Rewrite a selection in the composer.** Shorten, make it more formal, fix
   grammar. Reuse the grammar role's model and the editor's
   `GRAMMAR_SYSTEM`-style JSON so it is one mechanism, not two.
6. **Triage quality.** Add a per-account "who matters" hint (VIP senders or
   domains) to the classify prompt. Let the user correct a verdict
   ("not urgent"), and keep recent corrections as few-shot examples. Show the
   `priority_reason` inline in the list, not only in the message.
7. **Deadline and action digest.** A local "needs a reply / has a deadline"
   view across the inbox, built from the same extraction prompts. It feeds the
   daily recap and the to-do board's intake column with review before create.
8. **Multiple events and attachments.** Extract more than one event per mail
   (conference programmes, schedules), and read `.ics` attachments directly
   instead of asking the model. Summarize a PDF attachment's text with the
   same ephemeral rule.
9. **Search by meaning.** Local embeddings of subject+preview (an
   embedding-role model is already a refusal case here, so the role split
   exists). They must live inside the sealed store, never as plaintext.

## Longer-Term Direction

- **Eldrun Server — plan only.** Shared calendar/board and project collaboration
  would use provisioned SSH, CalDAV, and bare Git repositories. Recheck the
  plan's older prerequisites against current storage/CalDAV code before starting;
  writable project sharing remains gated on the documented Git trust boundary.
  See [server tasks](todo/group-z-server.md) and the
  [server plan](docs/eldrun_server_plan.md).
- **Broader desktop integration.** Linux X11 remains the reference. Validate the
  implemented KDE Wayland, Windows, and macOS backends before claiming parity
  from real use. Other Wayland compositors still need their own backends; macOS
  app-level parking has platform limits. See [platform work](todo/group-h-crossplatform.md)
  and [workspace work](todo/group-c-workspace.md).
- **Complete project context.** Extend the existing terminal/file/app/machine
  context with richer notes, task metadata, and workflow state. Pluggable
  compositor backends and an eventual Eldrun-native compositor remain long-term
  direction, not current delivery commitments. See [VISION.md](docs/VISION.md).
