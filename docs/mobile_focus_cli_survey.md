# Mobile Focus: what each agent CLI draws

A survey of the agent CLIs Eldrun offers (`src/components/tabs/newTabItems.ts`
`AGENT_ITEMS`), taken 2026-09-15, for the phone's **Focus** view
(`mobile-web/src/terminal/`): what each CLI puts on the screen, whether that
screen can be read at all, and where the conversation is stored when it cannot.

Focus reads an agent tab two ways. From the **screen** — `readableScreen` →
`inputFrameStart`/`sessionStatus` (`statusLine.ts`) → `chatTurns`, with
`agentModes` for the mode sheet and `selectPrompt` for dialogs — and from the
**stored session** (`src-tauri/src/services/agent_transcript.rs`), which today
reads Claude Code and Codex only. A full-screen (alternate-screen) TUI has no
scrollback, so for it the stored session is the only route.

Everything below was read out of published bundles, wheels, binaries' strings
and source trees — **nothing was run live**. Tags: **S** read in source or the
bundle, **D** docs/changelog, **U** unknown. Treat every screen shape as
unverified until a capture of a real tab agrees.

## Before any of it matters: which tabs reach the phone

`services/mobile_control/discovery.rs::resumable` lists an agent tab only when
it has a `session_id` **and** its command is one of `claude codex qwen opencode
copilot cursor-agent grok gemini agy vibe` (or it carries its own resume args).
Aider, Goose, Crush, Kimi, Pi, Amp, mini and the rest never appear on the phone
until that gate widens. The screen parsers still serve the desktop's
last-prompt line (`src/lib/agentPromptEcho.ts`) for every agent.

Families in `agentModes` are matched on `agent_label`, which is the tab's
**label** — renamable by the user. `SavedTab.cmd` is already read by discovery;
publishing it on `PublicTab` would let the phone match on the command instead.

## Where each CLI stands

| CLI (`cmd`) | Latest seen | Screen | Focus from the screen | Best further route |
|---|---|---|---|---|
| Codex (`codex`) | 0.154.0 stable; 0.155.0-alpha.7 | inline (ratatui) | echo `›`, footer, modes; answers `•` stay plain | rollout already read |
| Gemini CLI (`gemini`) | 0.60.0 (0.56.0 installed) | inline (`ui.useAlternateBuffer` false) | echo `>`, answers `✦`, **mode from the row above the box** | chat JSONL reader |
| Qwen Code (`qwen`) | 0.23.4 | **alt screen by default** (`ui.useTerminalBuffer`) | only with `"ui":{"useTerminalBuffer":false}`; answers `◆︎` | chat JSONL reader |
| Antigravity (`agy`) | 1.2.3 | picked at first run (`altScreenMode`) | glyphs U | `history.jsonl`, prompts only |
| Grok (`grok`) | xAI Grok Build 1.0.32; `@vibe-kit/grok-cli` 0.0.34 (stale) | Grok Build: alt screen in plain tmux; `--minimal` / `--no-alt-screen` inline | none | launch flag, then a capture |
| Kiro (`kiro`) | `kiro-cli` 2.21.4 — the binary is **`kiro-cli`** | inline | glyphs U; `NN% context used` | `data.sqlite3` `conversations_v2` |
| Mistral Vibe (`vibe`) | 2.25.4 | alt screen (Textual) | none | `messages.jsonl` reader |
| OpenCode (`opencode`) | 1.18.31 | alt screen; **`--mini` writes scrollback** | `--mini` **is read** (2026-09-18): echo `›`, tools dropped, chips | SQLite `opencode.db` |
| Crush (`crush`) | 0.94.2 | alt screen, always | none | SQLite `.crush/crush.db` |
| Kimi Code (`kimi`) | `@moonshot-ai/kimi-code` 0.43.1 | inline | **echo `✨`, answers `●`** | `wire.jsonl` reader |
| Pi (`pi`) | `@earendil-works/pi-coding-agent` 0.85.1 | inline | echo is a background box with no glyph | session JSONL tree; `--session-id` |
| Copilot (`copilot`) | 1.0.83 (0.0.393 installed) | alt screen, always | none | `events.jsonl` reader |
| Cursor agent (`cursor-agent`) | 2026.08.11 | inline Ink; review views alt | `│ → │` box not recognized | encrypted blob store — none |
| Aider (`aider`) | 0.86.2 | inline | `> ` echo; multi-line splits | `.aider.chat.history.md` |
| Cline (`cline`) | 3.0.62 | alt screen (`OTUI_USE_ALTERNATE_SCREEN=0` for main) | none | `*.messages.json` |
| Goose (`goose`) | 1.50.1 | inline | `> ` prompt | SQLite `sessions.db` |
| Plandex (`plandex`) | 2.2.1, wound down | REPL inline, streaming alt | none | none (server Postgres) |
| Amp (`amp`) | `@ampcode/cli` (renamed) | alt screen | none | `amp threads markdown <id>` |
| OpenClaw (`openclaw`) | 2026.9.4 | inline (pi-tui) | glyphs U | none (own SQLite, keyed by agent) |
| OpenHands (`openhands`) | 1.16.0, unmaintained | alt screen (Textual) | none | `events/*.json` |
| mini-SWE-agent (`mini`) | 2.4.6 | inline | `> ` shared with its confirm prompt | none (trajectory written at exit) |
| SWE-agent (`sweagent`) | 1.1.0 | batch, no chat | n/a | n/a |
| Mentat (`mentat`) | 1.0.19, archived | alt screen (Textual 0.47) | n/a | `~/.mentat/logs/transcript_*.log` |
| GPT Engineer (`gpte`) | 0.3.1, archived; needs Python < 3.13 | plain prompts | n/a | n/a |
| Qoder (`qoder`) | `@qoder-ai/qodercli` 1.1.53 | inline (Gemini derivative) | `> ` echo; strings obfuscated | U |
| Meta Muse Code (`muse`) | 1.3.0 installed | U | U | `session.jsonl` reader |

## What Focus reads now (2026-09-15)

- `chatTurns`: message bullets `⏺ ● ✦ ◆︎` (Claude Code, Kimi Code, Gemini CLI,
  Qwen Code) and the `✨` prompt echo, which counts only for a tab whose label
  names Kimi Code — on anyone else's screen `✨` opens ordinary output. Codex's
  `•` stays plain on purpose — it opens tool calls and progress lines as well
  as answers. `❯` is **not** an echo marker for anybody in this table: it is
  the highlight cursor a select dialog draws, so an unnumbered picker row
  (`❯ Opus 4.1`, a `/resume` entry) used to read as the user's own prompt.
  A bubble also stops at the first row a prompt's indent cannot mean (a `⎿`
  or `└` result gutter, a bullet, a frame stroke, an indented footer), and an
  echo followed by a footer row, or holding the box's own placeholder
  (`Try "…"`, `Type your message or @path/to/file`), is the input box rather
  than something submitted — only the live tail is cut by `inputFrameStart`,
  while a frame left in the scrollback reaches a history chunk whole.
- `statusLine`: a `*` input line with a draft counts only beside the word YOLO
  (Qwen prints it under the box, Gemini over it), so a markdown bullet at the
  bottom of an unrecognized screen is no longer cut as the input box. Gemini's
  approval mode is read from the row above the box and that row is cut with
  the frame. `ctx` labels a context figure.
- `agentModes`: a Gemini family — `default` (silent), `accept edits`, `plan`
  on Shift+Tab, `yolo` on Ctrl+Y.

### OpenCode's minimal interface (2026-09-18)

`opencode --mini` is the first family read from something other than an input
box: it draws none. `mobile-web/src/terminal/openCodeMini.ts` holds every shape
below, each read off captures of a live 1.18.31 session replayed through the
phone's own emulator at 60/80/100 columns — the first entry in this survey that
is not source-only. All of it is scoped to a tab whose label names OpenCode.

- **The frame** is its status row, ` BUILD  223.0K (21%) · ctrl+p cmd`, always
  the last non-blank row: the agent in capitals, then a notice slot (`model
  union-alpha`, `no variants available`, the `■⬝⬝⬝ esc interrupt` progress
  while it works), the tokens used and the key hint. The input box above it —
  blank rows, or the `Ask anything…` placeholder — is cut with it.
- **The chips**: mode is that agent name; context is the `(21%)`; the model
  comes from the turn footer `▣ Build · Muse Spark 1.3 Free · 6.2s`, the only
  place a mini session prints a display name, or from the status row's notice
  right after a switch.
- **Dropped**: the banner `█▀▀█  OpenCode`, the turn footer, and tool calls
  (`→` read/edit/list/bash/skill, `✱` glob and grep, `◈` web search, `%
  WebFetch`, `✗` refused, `# … Task`). Kept: the bash tool's `$ cmd` and its
  output, and `Thinking:` rows.
- **It wraps its own rows**, so nothing marks a continuation: a block runs from
  its marker row to the next blank row, and the wrapping is undone against the
  pane's column count so the phone re-wraps at its own width. A break is only
  undone when the wrap explains it, and the seam is read from what the wrap did
  with the space (kept past the hanging indent → space; a long token broken at
  `/`, `-` or `.` → nothing).
- **No key switches its agent**: `agent.cycle`/`agent.cycle.reverse` (Tab,
  Shift+Tab) and the `<leader>` binds belong to the full-screen TUI and do
  nothing in mini, whose ctrl+p palette offers "Switch model" and "Variant
  cycle" only. The family is `fixed` — the sheet is a readout, and the agent is
  chosen at `--agent` time.
- **No `/model`** either: the slash commands are `/editor /exit /init /new
  /review /skills`, so `/model` would be submitted as a prompt. The chip opens
  the picker through the palette (ctrl+p, `model`, Enter) and a tap answers it
  by typing (ctrl+u, the row's label, Enter) — its highlight is drawn in colour
  alone, which is deliberately not read.
- Still open: model **variants** (ctrl+t) are OpenCode's reasoning-effort
  equivalent and have no chip; the SQLite reader below would give Focus a
  history reaching past the pane's scrollback.

## Screen shapes not handled yet

Each needs a live capture before a pattern is written.

- **Aider** — continuation rows repeat `> ` (one bubble per row today); mode
  prefixes `ask> ` `architect> ` `help> ` `context> ` `multi> `; confirms
  `<Q> (Y)es/(N)o[/(A)ll][/(S)kip all][/(D)on't ask again] [Yes]: `; noise rows
  `Tokens: … sent, … received. Cost: …`, `Applied edit to …`, `Commit <hash> …`.
- **mini-SWE-agent** — `Execute N action(s)? Enter to confirm, type comment to
  reject, or /h …` then a bare `> ` (looks like the input line); agent turns
  `mini-swe-agent (step N, $X):`; modes by `/c` `/y` `/u`.
- **Cursor agent** — bordered `│ → … │` input; footer `Plan (shift+tab to
  cycle)` / `Ask`; dialogs `Run this command?` with `Run (once) (y)` rows.
- **Goose** — tool blocks `  ────` + `  ▸ <tool> <extension>` + 4-space rows;
  context bar `━━╌╌ 12% 24k/200k` (strokes, stripped by `readableScreen`);
  modes by `/mode auto|approve|smart_approve|chat`.
- **Grok Build** — dialog rows `1 (●) Allow once` (digit before the marker);
  modes `default ask auto always-approve` + plan on Shift+Tab; `NN% ctx`.
- **Kimi Code** — footer `context: 42% (84k/200k)`, modes `Ask When Needed`
  (yolo) / `Never Ask` (auto); Shift+Tab toggles plan only.
- **Codex 0.155** — the recap divider becomes `  ↳ Recap: …` with a hanging
  indent; a streaming answer may end mid-sentence on the last row.
- **Pi** — a prompt is a background-coloured box wrapped in OSC 133 `A`/`B`
  zone markers; only those (or the background colour) mark a user turn.
- **Qwen Code on the alt screen** — the Focus notice could name the
  `useTerminalBuffer` setting.

## Stored-session readers (backend follow-up)

Each would be an arm of `agent_transcript.rs`, answering the same
prompt/answer entries. Record shapes are **S** unless marked.

- **Gemini CLI** — `~/.gemini/tmp/<projectId>/chats/session-<ts>-<id8>.jsonl`
  (`<projectId>` from `~/.gemini/projects.json`). First line carries
  `sessionId`, `projectHash`, `startTime`; messages
  `{type:"user"|"gemini"|"info"…, content: Part[]|string, toolCalls?, thoughts?}`.
  The tab passes `--session-id`, so the file is found by the id's first 8.
- **Qwen Code** — `~/.qwen/projects/<cwd, [^A-Za-z0-9]→"-">/chats/<sessionId>.jsonl`;
  user `{type:"user", message:{role:"user", parts:[{text}]}}`; assistant shape U.
- **Kimi Code** — `~/.kimi-code/sessions/wd_<slug>_<sha256(cwd)[:12]>/<id>/agents/main/wire.jsonl`;
  prompt `type=="turn.prompt" && origin=="user"` (`input[].text`); answer
  `type=="context.append_message"` with `message.role=="assistant"`; honour
  `context.undo` / `context.clear`.
- **Pi** — `~/.pi/agent/sessions/--<cwd encoded>--/<ts>_<uuid>.jsonl`; header
  `{type:"session", version:3, id, cwd}`; entries
  `{type:"message", id, parentId, message:{role, content}}` form a **tree** —
  walk `parentId` back from the last entry. `--session-id <uuid>` fixes the id.
- **Mistral Vibe** — `$VIBE_HOME/logs/session/session_<ts>_<id>/{meta.json,messages.jsonl}`
  (home default U); match `meta.environment.working_directory`; prompt
  `role=="user" && !injected`; answer `role=="assistant"` with `content`.
- **OpenCode** — SQLite `~/.local/share/opencode/opencode.db` (WAL; open
  read-only): `session.directory == cwd`, `parent_id IS NULL`, newest
  `time_updated`; `message.data.role`; `part.data` `type=="text" && !synthetic`.
- **Crush** — SQLite `<project>/.crush/crush.db`: newest root `sessions`;
  `messages.parts` `[{type:"text", data:{text}}…]`; role values U.
- **Goose** — SQLite `~/.local/share/goose/sessions/sessions.db`:
  `sessions.working_dir == cwd`; `messages(role, content_json)`; content shape U.
- **Aider** — `<git root>/.aider.chat.history.md`, last `# aider chat started
  at` section; `#### ` lines are the prompt, `> ` lines tool output, the rest
  the answer.
- **Copilot** — `session-state/<id>/events.jsonl` under `$COPILOT_HOME` or `~`
  (exact path partly U); `user.message` / `assistant.message` `data.content`.
- **Meta Muse Code** — `~/.local/share/muse/sessions/<Y>/<M>/<D>/<uuid>/session.jsonl`;
  prompt `payload.event.kind=="started"` (`prompt`), answer
  `assistant_message_committed` (`text`).
- **OpenHands** — `~/.openhands/conversations/<id>/events/event-*.json`,
  `MessageEvent` with `source` user/agent; mapping a conversation to a cwd U.

mini-SWE-agent and OpenHands both file tool observations under the `user`
role, so a reader must never take `user` alone for a prompt.

## Registry and checklist drift found

- Kiro's binary is `kiro-cli`, not `kiro`.
- Kimi's install script installs the deprecated Python kimi-cli; Kimi Code is
  `code.kimi.com/kimi-code/install.sh` (still `kimi`). Kimi has `-c` / `-S`.
- Pi moved to `@earendil-works/pi-coding-agent`; it has `-c`, `--session`,
  `--session-id`. Crush has `-C` / `-s`.
- Amp's npm package is now `@ampcode/cli`.
- Two CLIs install as `grok`; both use `~/.grok`.
- Mentat, GPT Engineer and Plandex are archived or wound down; SWE-agent is
  batch-only; OpenHands CLI says it is no longer maintained.
