## Group S — Local Agents via Ollama Integrations (`ollama launch`)
*New feature. Generalizes the existing single "Local Model" tab (Mistral `vibe`)
into a family of local, Ollama-backed agent tabs — Claude Code, Hermes, OpenClaw,
OpenCode — that behave exactly like the vibe local-agent tab does today (per
active local model, `kind: "local_agent"`, same persistence/rehydrate path).*

*Files: `src/components/tabs/TabBar.tsx` (`AGENT_ITEMS`, `handleOllamaModel`),
`src/components/layout/LocalModelMenu.tsx`, `src/stores/tabs.ts` (`cmdToKind`,
`RESUMABLE_AGENTS`, `isRestorableTab`), `src/components/layout/CenterPanel.tsx`
(local_agent rehydrate), `src/components/layout/SettingsSubPanels.tsx` (Ollama
panel), backend `commands/ollama.rs`, `terminal/mod.rs`, `lib.rs`.*

**Key enabler — already on disk.** The installed `ollama` (≥0.30.x) ships
`ollama launch <integration> [--model <model>] [--config] [-- <extra>]`, which
**installs the agent if missing, configures it against the local Ollama endpoint,
then launches it**. `ollama launch --help` lists (among others): `claude`
(Claude Code), `hermes`, `openclaw`, `opencode`, plus `codex`, `copilot`, `cline`,
`qwen`, `droid`, `kimi`, `pi`. This removes the bespoke per-agent config the vibe
path needs (`prepare_local_agent` writing `VIBE_HOME/config.toml`): for these
agents Eldrun just spawns `ollama launch <id> --model <model>` in a PTY. `vibe`
is **not** an `ollama launch` integration, so it keeps its current dedicated path
unchanged; the new agents are additive.

**Prerequisites & caveats (document in the Ollama panel + per item):**
- Every one of these needs Ollama to actually **load** a model. The dev machine's
  Ollama install is currently broken (missing `llama-server` runner) — none will
  work until that's reinstalled. Gate the UI on `ollama_status` ("loaded"/"idle")
  and surface the broken-runner message (`friendly_ollama_error`).
- These are **agentic** (file edit / bash / tool calls); they need a tool-calling
  model and a **≥64k context window**. `ollama launch` configures `num_ctx` for
  the chosen model; recommend `qwen2.5-coder`/`qwen3*` in the picker, warn on tiny
  models.
- Endpoint differences are handled by `ollama launch`, but note them: Claude Code
  uses Ollama's **Anthropic Messages API** compat (`ANTHROPIC_BASE_URL=
  http://localhost:11434`, `ANTHROPIC_AUTH_TOKEN=ollama`) — this **supersedes** the
  earlier "needs a LiteLLM proxy" note; Hermes/OpenCode use `/v1`; OpenClaw uses
  the **native** `/api/chat` (its `/v1` tool-calling is unreliable). OpenClaw is a
  messaging-gateway agent more than a pure coding agent — include it as requested
  but rank it lowest.

72. **Generalize `local_agent` into a multi-agent registry.** Introduce a single
    source of truth, e.g. `LOCAL_AGENTS: { id, label, launch, endpointNote,
    resumable }[]` in `src/stores/tabs.ts` (exported), with rows for `claude`,
    `hermes`, `openclaw`, `opencode` (launch via `ollama launch <id>`), and the
    existing `vibe` flagged `special: true` so it keeps its `prepare_local_agent`
    path. Spawn shape for the new ones: `addTab({ cmd: "ollama",
    args: ["launch", id, "--model", model], kind: "local_agent",
    label: <model> })`. Keep `kind: "local_agent"` so all the existing tiling,
    activity-spinner, and persistence wiring applies untouched.
    - [ ] 🤖 Automated test — registry has the 4 agents + vibe; each non-vibe row
      builds argv `["launch", id, "--model", m]`.
    - [ ] 🖐️ Manual test

73. **Backend: `local_launch_argv` + ensure-running command.** Add a pure helper
    in `commands/ollama.rs`, `local_launch_argv(integration, model) ->
    Result<Vec<String>, String>`, that (a) checks `integration` against an
    allowlist of supported `ollama launch` ids, (b) runs the existing
    `validate_model_name(model)` (reuse — guards the argv), and (c) returns
    `["launch", <id>, "--model", <model>]`. Expose a thin command
    `prepare_local_launch_agent` that calls `ensure_ollama_running` then returns
    the argv (mirrors `handleOllamaModel`'s `ensure_ollama_running` step).
    Register in `lib.rs`.
    - [ ] 🤖 Automated test — `local_launch_argv` accepts known ids + valid model,
      rejects unknown id and injection-y model names (extend the existing
      `validate_model_name` tests).
    - [ ] 🖐️ Manual test

74. **`cmdToKind` + spawn path for `ollama launch` tabs.** Teach
    `cmdToKind` (tabs.ts) that `cmd === "ollama"` with a `launch` first-arg maps to
    `local_agent` (today it only knows `claude|codex|gemini|vibe`). Confirm the PTY
    spawn in `terminal/mod.rs` inherits a PATH that includes `~/.local/bin`
    (agents `ollama launch` installs land there — same concern as vibe); add it to
    the spawn env if missing. No `VIBE_HOME` injection for these (only `vibe`).
    - [ ] 🤖 Automated test — `cmdToKind("ollama", ["launch","claude",…])` →
      `"local_agent"`; unchanged for plain `ollama`/`bash`.
    - [ ] 🖐️ Manual test

75. **Picker UI: choose which local agent runs the active model.** Today the
    add-tab menu / `LocalModelMenu` launches exactly one runtime (vibe). With ≥5
    options, add a submenu: "Local Agent ▸ [Claude Code · Hermes · OpenClaw ·
    OpenCode · Mistral (vibe)]", each launching the **active** `settings.ollama_model`
    via the matching path. Reuse the existing reveal/close + status-lamp scaffold
    in `LocalModelMenu.tsx`; gray out entries when `ollama_status` isn't
    "loaded"/"idle". Optionally persist a `settings.default_local_agent`.
    - [ ] 🤖 Automated test — picker renders one entry per `LOCAL_AGENTS` row;
      selecting one dispatches the right spawn (argv vs vibe env).
    - [ ] 🖐️ Manual test

76. **Per-agent wiring — Claude Code, Hermes, OpenClaw, OpenCode.** With #72–#75 in
    place each is one `LOCAL_AGENTS` row, but verify per agent: `claude` →
    `ollama launch claude --model <m>` (Anthropic-compat, no `/v1`); `hermes` →
    `ollama launch hermes --model <m>` (`/v1`, raises ctx); `opencode` →
    `ollama launch opencode --model <m>` (`/v1`, writes `~/.config/opencode/
    opencode.json`); `openclaw` → `ollama launch openclaw --model <m>` (native
    `/api/chat`). First launch may run an interactive `ollama launch` setup —
    decide per agent whether to pass `--config`/`--yes` (e.g. `droid --config`
    "does not auto-launch"). Tab label e.g. `Claude Code · <model>`.
    - **OpenClaw wired.** Added as a launch-only `LOCAL_DRIVERS` row in
      `commands/ollama.rs` (`ollama launch openclaw --model <m>`, no fallback —
      `ollama launch` installs+wires the gateway). Also registered as a standalone
      installable agent in `commands/agents.rs` (`npm install -g openclaw`, bin
      `openclaw`) and in `AGENT_ITEMS`/`AGENT_CMDS` so it appears in the regular
      agent add-menu. Resume parity deferred to #77 (dropped on relaunch like vibe).
    - [ ] 🤖 Automated test — table test: each id → expected argv + endpoint note.
    - [ ] 🖐️ Manual test — each agent opens, sees the model, completes one edit.

77. **Persistence / resume parity (follow-up).** Start at **vibe parity**: these
    `local_agent` tabs are **not** resumable (dropped on relaunch like vibe today),
    so `isRestorableTab` stays false for them — no change needed beyond confirming
    they aren't accidentally caught by `RESUMABLE_AGENTS`. Track real resume as a
    later step: `ollama launch codex --restore` exists, Claude Code has its own
    `--resume`; map these into `RESUMABLE_AGENTS`/backend `resolve_*_session` only
    after the live-session hook story (Group F #39d) is confirmed per agent.
    - [ ] 🤖 Automated test — a launched `local_agent` tab for each new id is
      filtered OUT by the persist filter (matches vibe).
    - [ ] 🖐️ Manual test

78. **Discoverability in the Ollama panel.** In `SettingsSubPanels.tsx` (Ollama
    panel), add a short "Local agents" section listing the supported `ollama
    launch` integrations with one-line descriptions + the 64k-ctx / tool-calling
    caveat, and a note that they auto-install on first launch (so, unlike vibe,
    no separate "Install …" button is required). Link the picker to it.
    - [ ] 🤖 Automated test — n/a (static copy) or a render smoke test.
    - [ ] 🖐️ Manual test

---
