## Group S — Local Agents via Ollama Integrations (`ollama launch`)
*New feature. Generalizes the existing single "Local Model" tab (Mistral `vibe`)
into a family of local, Ollama-backed agent tabs — Claude Code, Hermes, OpenClaw,
OpenCode — that behave exactly like the vibe local-agent tab does today (per
active local model, `kind: "local_agent"`, same persistence/rehydrate path).*

**Status (reconciled 2026-07-28): #72, #73 and #75 are shipped** — the group was
built backend-first as `LOCAL_DRIVERS` in `commands/ollama.rs` and every box had
been left unticked. Genuinely open: **#78** (nothing surfaces this anywhere, so
the feature is invisible), **#77** (a real `RESUMABLE_AGENTS` collision, see
below), and the #74/#76 remainders.

*Files (as built): `src/components/tabs/TabBar.tsx`, `src/components/tabs/NewTabMenu.tsx`,
`src-tauri/src/commands/ollama.rs` (`LOCAL_DRIVERS`), `src/stores/tabs.ts` (`cmdToKind`,
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

72. **Generalize `local_agent` into a multi-agent registry.** ✅ Implemented ·
    🧪 Awaiting live QA. Introduce a single
    source of truth, e.g. `LOCAL_AGENTS: { id, label, launch, endpointNote,
    resumable }[]` in `src/stores/tabs.ts` (exported), with rows for `claude`,
    `hermes`, `openclaw`, `opencode` (launch via `ollama launch <id>`), and the
    existing `vibe` flagged `special: true` so it keeps its `prepare_local_agent`
    path. Spawn shape for the new ones: `addTab({ cmd: "ollama",
    args: ["launch", id, "--model", model], kind: "local_agent",
    label: <model> })`. Keep `kind: "local_agent"` so all the existing tiling,
    activity-spinner, and persistence wiring applies untouched.
    - **Shipped as `LOCAL_DRIVERS` in the *backend*** (`commands/ollama.rs:2211`),
      not `LOCAL_AGENTS` in `tabs.ts` — the frontend reads it over IPC (#73).
      Roster drifted from the plan: `hermes` was **dropped**, `codex` and `droid`
      **added**; rows are claude, codex, opencode, droid, openclaw. `vibe` kept
      its separate path as specified.
    - [x] 🤖 Automated test — `commands/ollama.rs:2469-2490` covers the registry
      rows and argv construction.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

73. **Backend: `local_launch_argv` + ensure-running command.** ✅ Implemented ·
    🧪 Awaiting live QA. Add a pure helper
    in `commands/ollama.rs`, `local_launch_argv(integration, model) ->
    Result<Vec<String>, String>`, that (a) checks `integration` against an
    allowlist of supported `ollama launch` ids, (b) runs the existing
    `validate_model_name(model)` (reuse — guards the argv), and (c) returns
    `["launch", <id>, "--model", <model>]`. Expose a thin command
    `prepare_local_launch_agent` that calls `ensure_ollama_running` then returns
    the argv (mirrors `handleOllamaModel`'s `ensure_ollama_running` step).
    Register in `lib.rs`.
    - **Shipped under different names:** `prepare_local_launch`
      (`commands/ollama.rs:2324`) and `list_local_drivers` (`:2295`), plus
      `fallback_spec` (`:2273`) for drivers `ollama launch` doesn't cover.
      Registered at `lib.rs:1103-1104`. `validate_model_name` is reused as
      planned (`:2325`). **Deviation:** `ensure_ollama_running` is *not* folded
      into the command — the frontend calls it first (`TabBar.tsx:617`).
    - [x] 🤖 Automated test — `commands/ollama.rs:2469-2490` covers allowlist
      acceptance and rejection of unknown ids / injection-y model names.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

74. **`cmdToKind` + spawn path for `ollama launch` tabs.** Teach
    `cmdToKind` (tabs.ts) that `cmd === "ollama"` with a `launch` first-arg maps to
    `local_agent` (today it only knows `claude|codex|gemini|vibe`). Confirm the PTY
    spawn in `terminal/mod.rs` inherits a PATH that includes `~/.local/bin`
    (agents `ollama launch` installs land there — same concern as vibe); add it to
    the spawn env if missing. No `VIBE_HOME` injection for these (only `vibe`).
    - **PARTIAL.** PATH augmentation is done (`src-tauri/src/paths.rs:87`), and
      the spawn path works because these tabs carry `kind: "local_agent"`
      explicitly at creation (`TabBar.tsx:631`). Still missing: `cmdToKind`
      (`src/stores/tabs.ts:3965-3978`) takes **no args** and has no
      `ollama`→`local_agent` row, so the mapping only fails on *restore* —
      currently moot because these tabs aren't restorable (see #77).
    - [ ] 🤖 Automated test — `cmdToKind("ollama", ["launch","claude",…])` →
      `"local_agent"`; unchanged for plain `ollama`/`bash`.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

75. **Picker UI: choose which local agent runs the active model.** ✅ Implemented ·
    🧪 Awaiting live QA. Today the
    add-tab menu / `LocalModelMenu` launches exactly one runtime (vibe). With ≥5
    options, add a submenu: "Local Agent ▸ [Claude Code · Hermes · OpenClaw ·
    OpenCode · Mistral (vibe)]", each launching the **active** `settings.ollama_model`
    via the matching path. Reuse the existing reveal/close + status-lamp scaffold
    in `LocalModelMenu.tsx`; gray out entries when `ollama_status` isn't
    "loaded"/"idle". Optionally persist a `settings.default_local_agent`.
    - **Shipped in the +/new-tab menus** (`TabBar.tsx:223-228,614-636`,
      `NewTabMenu.tsx:95-103,190-212`), **not** in `LocalModelMenu.tsx`.
      Gating uses the backend's per-driver `available` flag rather than
      `ollama_status`. `settings.default_local_agent` was **not** built — that
      clause stays open.
    - [x] 🤖 Automated test — picker rows follow `list_local_drivers`; selection
      dispatches `prepare_local_launch` (argv) vs the vibe env path.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

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
    - **PARTIAL.** claude / codex / opencode / droid / openclaw are wired
      (`commands/ollama.rs:2212-2256`, `commands/agents.rs:122-128,168-174`).
      **`hermes` is absent everywhere** — decide whether to add it or drop it
      from this item. The `--config`/`--yes` decision is still unrecorded for
      every agent except the OpenClaw bullet below.
    - [ ] 🤖 Automated test — table test: each id → expected argv + endpoint note.
    - [ ] 🖐️ Manual test — each agent opens, sees the model, completes one edit.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

77. **Persistence / resume parity (follow-up).** Start at **vibe parity**: these
    `local_agent` tabs are **not** resumable (dropped on relaunch like vibe today),
    so `isRestorableTab` stays false for them — no change needed beyond confirming
    they aren't accidentally caught by `RESUMABLE_AGENTS`. Track real resume as a
    later step: `ollama launch codex --restore` exists, Claude Code has its own
    `--resume`; map these into `RESUMABLE_AGENTS`/backend `resolve_*_session` only
    after the live-session hook story (Group F #39d) is confirmed per agent.
    - **⚠️ Concrete collision, not hypothetical.** `RESUMABLE_AGENTS`
      (`src/stores/tabs.ts:4043-4057`) contains `opencode`, `codex`, `qwen`…,
      and `isResumableAgentTab` (`:4073`) matches on `kind === "local_agent"`.
      An `ollama launch` tab is safe (its `cmd` is `"ollama"`), but a
      **fallback** driver tab spawns with `cmd: "codex"` / `"opencode"` —
      exactly the ids in that list. This is the "confirm they aren't
      accidentally caught" case, and it currently **fails**. No test asserts the
      persist filter drops them.
    - [ ] 🤖 Automated test — a launched `local_agent` tab for each new id is
      filtered OUT by the persist filter (matches vibe), **including the
      fallback spawn shape**.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

78. **Discoverability in the Ollama panel.** In `SettingsSubPanels.tsx` (Ollama
    panel), add a short "Local agents" section listing the supported `ollama
    launch` integrations with one-line descriptions + the 64k-ctx / tool-calling
    caveat, and a note that they auto-install on first launch (so, unlike vibe,
    no separate "Install …" button is required). Link the picker to it.
    - [ ] 🤖 Automated test — n/a (static copy) or a render smoke test.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

200. **The GPU is not something to be assumed.** ✅ **Done** (2026-07-29).
    Ollama ≥0.32 **drops integrated GPUs by default** ("dropping integrated GPU;
    to enable, set `OLLAMA_IGPU_ENABLE=1`"), so an update silently moved every
    model on an APU machine onto the CPU with nothing in the API to say so but a
    `size_vram` of 0 — which is also exactly what a model too large to fit looks
    like. Three parts, all shipped:
    - `ensure_ollama_running` sets `OLLAMA_IGPU_ENABLE=1` on the server **Eldrun
      itself** spawns (an explicit value in the environment is left alone — a
      user who set `0` meant it). A systemd-managed server is out of reach from
      app code and needs the drop-in the notice offers.
    - `load_ollama_model` takes a `device` (`auto`/`gpu`/`cpu` → `num_gpu`
      omitted/`999`/`0`); the 🧠 menu's "Load into memory" rows show **GPU** and
      **CPU** buttons whenever the machine has any GPU at all, and the single
      Load button only when it has none. Verified against the live server:
      `num_gpu: 0` → `size_vram: 0`, `num_gpu: 999` → full offload.
    - `ollama_gpu_status` diagnoses the gate and offers the systemd drop-in
      through `runInstallInTab`. It requires **four** facts to line up
      (`model_on_cpu` ∧ `gpu_present` ∧ `integrated_only` ∧ the installed server
      still offering the flag, read from its own `ollama serve --help`) before
      `igpu_dropped` is set, because blaming a setting for an ordinary
      out-of-VRAM would send the user to reconfigure a system service for
      nothing.
    - [ ] 🤖 Automated test — `LoadDevice::num_gpu` mapping, and that the
      diagnosis stays false when only some of the four facts hold.
    - [ ] 🖐️ Manual test — the notice itself has never rendered (the machine it
      was found on was fixed before the UI existed); the CPU/GPU buttons are
      verified at the protocol level only.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

201. **The runtime is not something to be assumed either.** Ollama is not a
    choice Eldrun made; it is a fact wired into 33 `#[tauri::command]`s across
    `commands/ollama.rs` (4 350 lines), 18 `invoke` sites in `src/`, four
    `settings.json` keys, and a literal `TcpStream::connect("127.0.0.1:11434")`
    in `ollama_http` (`:54`). Surveyed 2026-07-29. **The verdict is not
    "switch"** — it is that the *assumption* is now more expensive than a seam
    would be, and that one alternative fixes a defect this repo has already
    documented.

    **Why Ollama stays the default.** `ollama launch` is the whole premise of
    #72–#78: it installs a coding agent, wires it against a local endpoint and
    runs it, and **nothing else in the field does this**. llama.cpp, LM Studio,
    Lemonade and Jan all *serve* models; none of them stands up an
    Anthropic-compatible endpoint and configures Claude Code, Codex, OpenCode
    and Droid against it. Replacing Ollama outright would delete this group.

    **Why a seam is worth having anyway.** Three separate pressures, only the
    third of which is speculative:
    - **The iGPU, i.e. #200.** That item exists because Ollama ≥0.32 drops
      integrated GPUs by default and the remedy is an environment variable plus
      a systemd drop-in the user has to be talked through. llama.cpp's **Vulkan**
      backend and AMD's **Lemonade** (open source, AMD-co-developed, llama.cpp
      via Vulkan/ROCm, and NPU offload through ONNX Runtime GenAI on Ryzen AI
      300-series) treat an APU as a first-class target rather than as something
      to be re-enabled. On the machine #200 was found on, this is not a
      preference — it is the difference between the GPU being used and not.
    - **Model management is no longer the differentiator.** `llama-server` now
      has **router mode**: several models in isolated child processes, on-demand
      load, LRU eviction, one OpenAI-compatible endpoint, auto-discovery of the
      `~/.cache/llama.cpp` tree. `llama-swap` does the same as a proxy in front
      of llama.cpp/vLLM/TabbyAPI. The thing Ollama was actually better at is
      upstream now.
    - **Direction of travel.** Reported through 2026: a closed-source desktop
      GUI (later relicensed), a pivot toward hosted proprietary models, a $65M
      Series B, and repeated CVEs including one in the GGUF loader rated 9.1.
      None of this breaks Eldrun today, and none of it should be treated as
      settled fact without checking — but a hard dependency with no seam is how
      a vendor's roadmap becomes ours.

    **Explicitly out of scope:** vLLM (multi-user GPU serving — the wrong shape
    for a desktop app), MLX (Apple-only, and Ollama already uses it there), and
    LM Studio (proprietary, GUI-first; Eldrun already owns the UI, so the `lms`
    CLI would buy only a second model manager).

    Four parts, in increasing size. **201a is independent and worth doing on its
    own** — do not let it wait on the rest.

    **201a — `ollama_host` is a setting that does nothing.** ✅ **Done**
    (2026-07-29). It was declared (`schema/settings.rs`) and read by **no code on
    either side**, while `ollama_http` connected to the literal
    `127.0.0.1:11434` — so anyone running Ollama on another port or in a
    container had a field in `settings.json` that was silently ignored. Now
    `resolve_ollama_addr` (pure, tested) is the single answer to "where is the
    server", read on every call (a settings write is not an event this module
    hears) and honoured by the transport, the pull streamer, the reachability
    probe, `ensure_ollama_running` and the `vibe` provider's `api_base`.
    Four decisions are the fix rather than incidental to it:
    - **`https://` is an error, never a downgrade.** This transport is a raw
      `TcpStream` speaking HTTP/1.0; connecting in the clear to an address the
      user wrote as TLS would put their prompts on the wire while the setting
      says otherwise. Refused with a sentence.
    - **A non-loopback host needs `ollama_allow_remote_host` (new, default
      false).** Two keys rather than one, because they are different decisions:
      another *port* is still local inference, another *host* means every prompt
      and every file an agent reads leaves this machine. Judged on the literal
      that was typed, never on what it resolves to.
    - **`ensure_ollama_running` only starts a server it could own.** A remote
      endpoint is refused with its address rather than answered by silently
      spawning a *local* server the caller was never pointed at; the systemd
      branch runs only for the default address (the unit binds what the unit
      says, so starting it to satisfy a request for 11500 reports success for
      the wrong server); and a spawned `ollama serve` gets `OLLAMA_HOST`, or a
      non-default port would bind 11434 and then time out being waited for.
    - **The connect is bounded (`OLLAMA_CONNECT_TIMEOUT`, 4 s).** Making a remote
      host reachable at all is what made this necessary: a bare
      `TcpStream::connect` at a host that is off or mistyped blocks on the
      kernel's TCP retries for over two minutes. Loopback refuses instantly and
      never reaches the bound, so the default configuration is untouched.

    Two things this turned up and one it deliberately does not do. `ollama
    --version` is **not** pointed at `ollama_host` — that was tried, and it costs
    the documented "`check_remote: false` touches no network" property *and*
    2 minutes per call against an unreachable host; the version wanted there is
    the installed binary's, and `parse_version` already scans past the
    server-unreachable warning. And with an unreachable **remote** host each
    local-model read costs up to 4 s per request (a `list_local_drivers` makes
    two), which is bounded and noticeable — one more reason that path is opt-in.
    Still **not** covered, and belonging to 201b/201d rather than here: the
    `ollama launch` argv handed to a PTY carries no `OLLAMA_HOST`, so a local
    agent tab still wires itself against the default endpoint; and there is no
    UI for either key — both are edited in `settings.json`.
    - [x] 🤖 Automated test — `commands::ollama::tests`, seven cases:
      unset/blank is byte-for-byte the old address, ports and `http://` and
      bare-`:port`/`11500` and `0.0.0.0`/IPv6 spellings, `https://` refused,
      remote refused without the opt-in and accepted with it, a header-injecting
      host refused, and `addr_is_loopback` for the ensure-running gate.
    - [ ] 🖐️ Manual test — verified live against a second `ollama serve` on
      11500 via `ELDRUN_STATE_DIR` + `examples/ollama_probe.rs` (2026-07-29):
      the configured port returns that server's own model list (a different set
      from the systemd server's, which is the proof it did not fall back), a
      port with nothing listening reports `not_running` instead of quietly
      reaching 11434, and both refusals surface their sentence.
      - [x] ✅ Works
      - [ ] ❌ Doesn't work

    **201b — name the seam.** A `LocalRuntime` trait over the ~6 questions Eldrun
    actually asks: is it up, list models, model capabilities, load/unload,
    what is resident, pull. Ollama becomes the first implementation, not the
    only shape. Deliberately **do not** abstract what is genuinely Ollama's —
    `ollama launch`, the registry manifest-digest update check, the systemd
    drop-in, `OLLAMA_IGPU_ENABLE`: a runtime that cannot do those must *say so*
    (the `LocalDriverInfo.available` pattern), never pretend. Note the honest
    cost up front so nobody underestimates it: the settings keys, the command
    names, `src/lib/localDrivers.ts`, `stores/ollamaAutoload.ts` and the 🧠 menu
    are all *named* `ollama`, so this is a rename as much as a refactor.
    Persisted keys stay as they are — new fields are additive, or every existing
    `settings.json` needs a migration for a feature nobody asked for yet.
    - [ ] 🤖 Automated test — the Ollama implementation reproduces today's
      behaviour command-for-command; a driver reporting no `launch` support
      empties the local-agent group with a reason rather than silently.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

    **201c — a second implementation, as the proof the seam is real.**
    **Lemonade first**, for two reasons that are not "it is newer": it answers
    #200's actual defect, and it exposes **Ollama-compatible** endpoints
    alongside OpenAI- and Anthropic-compatible ones, so it can be tested behind
    the existing transport before any of it is generalized. `llama-server`
    router mode second, as the no-vendor option. Verify the Linux install path
    and the Vulkan/iGPU claim on this machine before committing to either —
    both are third-party claims at this point, not measurements.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test — a model loads onto the 890M **without** the
      `OLLAMA_IGPU_ENABLE` drop-in, and `ollama_gpu_status`'s equivalent reads
      it as on-GPU.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

    **201d — the picker, and what it must admit.** A runtime selector in the
    Ollama settings panel (which #78 is already opening up), plus the sentence
    the local-agent group needs: with a non-Ollama runtime selected, the
    `ollama launch` agents are **not available**, and the menu has to say which
    of the two reasons emptied it — exactly the distinction
    `needs_tools_unsupported` already draws for a model that lacks `tools`.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

    **Priority: below #74/#76/#77/#78.** Those finish a feature that is
    currently invisible and carry a known `RESUMABLE_AGENTS` collision; this one
    buys optionality. 201a was the exception — a defect, small, and a
    prerequisite for the rest — and is done.

202. **A capable model is not a suitable one.** ✅ **Shipped** (2026-07-29),
    unverified in the UI. Reported: Codex and Claude Code on a local model
    answer a trivial prompt with nonsense, while Mistral/vibe on the same model
    is fine. Measured on `qwen3-coder:latest` (`tools`, no `thinking`): the
    plain Ollama chat endpoint answers `"test"` sensibly in 27 tokens / 3.0 s,
    while the exact launch line `prepare_local_launch` builds for Codex put
    **5128 tokens** of harness in front of the same model, which then ran away
    past **4100 tokens** without stopping. So the defect is not a missing
    capability — it is the *weight of the agent's own prompt*, which no
    `/api/show` field reports.
    - The proposed fix, gating these drivers on the `thinking` capability, was
      **rejected as measured**: on the reporting machine no installed model
      carried both `tools` and `thinking` (`qwen3-coder`/`llama4` have tools and
      no thinking; `deepseek-r1` has thinking and no tools, so the existing tool
      gate already withholds it). Gating on `thinking` would have removed Codex
      and Claude Code from the 🧠 menu for **every** model present rather than
      steering anyone to a better one. Claude Code is also the control that
      rules out the wire protocol: it has no fallback, so it *always* goes
      through `ollama launch` (`wire_api = "responses"`) while Codex on a
      non-thinking model is forced onto the direct `--oss` path — two
      transports, same complaint.
    - Shipped instead: `LocalDriver::heavy_harness` → `LocalDriverInfo` → a `⚠`
      with a sentence on the row in both the **+** menu and the tab-bar menu
      (`AddMenuEntry.caution`, which cautions without disabling — `available`
      stays the only field that withholds a row). True for all five
      `LOCAL_DRIVERS`, because all five are coding-agent CLIs written against
      hosted frontier models; a driver built for local models sets it `false`,
      which is what `vibe` would do if it were ever moved into that registry.
    - [ ] 🤖 Automated test — the flag survives `list_local_drivers` for an
      *unavailable* driver too (the menu must not be the thing that decides a
      hidden row's caution), and a `false` row renders no caution.
    - [ ] 🖐️ Manual test — the `⚠` renders and reads correctly in both menus and
      in all five languages; the tooltip is reachable (it is `title` + an
      `aria-label`, on a `<span>` inside a `<button>`).
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
    - Left undone deliberately, both offered and declined: promoting vibe as the
      recommended local driver, and stripping the user's own MCP servers from a
      local Codex tab via `-c mcp_servers={}`. The second is a real lever — a
      local Codex tab inherits `~/.codex/config.toml`, so declared MCP tool
      schemas are inside that 5128-token prompt — and is worth its own item if
      the caution turns out not to be enough.

---

203. **Manage CLIs is two lists, not one.** ✅ **Shipped** (2026-08-31). The
    panel rendered every CLI in the registry as a full install card, sorted
    installed-first, so the handful of entries anyone manages (enable, remove,
    reinstall, schedule) sat above a dozen cards nobody had asked for and the
    list only gets longer as agents are added. It is now two `SettingsSection`s
    over one card renderer — **Installed**, always listed, and **Available to
    install**, which shows *nothing* until a query is typed into its search box
    (matched on the label, the id and the binary name, since a CLI is looked for
    by whichever of the three the user happens to know). The empty states are
    stated rather than blank: a count + "type a name" with no query, a named
    miss for one that matches nothing, and "everything is installed" when the
    catalog is exhausted.
    - [ ] 🖐️ Manual test — both sections render, the search finds a CLI by
      label/id/bin, an install from a search result moves the card to
      **Installed** on the next refresh, and the three empty states read
      correctly in all five languages.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

204. **Agent fence — confine local agents to their project or box.** ✅
    **Implemented 2026-08-31; automated coverage added; live QA pending.**
    Default-on Linux `bubblewrap` boundary for agent/local-agent tabs, with a
    global toggle + read-only toolchain allowlist and per-project
    inherit/off/on override. The backend owns the decision, fails closed when
    bubblewrap cannot actually create a namespace, and computes project roots
    plus the union of every box membership. Container agents keep their
    container boundary; remote-host/macOS/Windows cases are named as not
    enforced. Filesystem only (network shared). See
    `docs/context/agent_authority.md` and `services/agent_fence.rs`.
    - [x] 🤖 Automated test — bwrap argv ordering/binds, decision matrix,
      override precedence, plain/multi-box/box-scope roots, agent-native
      add-dir flags + idempotence, multi-root transcript rw classification,
      frontend pill states/status reasons and settings-path round-trip.
    - [ ] 🖐️ Manual test after a deliberate backend restart:
      - [ ] Fenced Claude starts at all (fixed 2026-08-31: the fence now binds
        the binary's symlink-chain dirs, e.g. `~/.local/share/claude/versions`,
        instead of dying with `bwrap: execvp claude: No such file or directory`).
      - [ ] Fenced Claude starts **logged in**, no per-tab login/onboarding
        (fixed 2026-08-31: `~/.claude.json` staged as a filtered per-project
        copy — login/onboarding kept, foreign projects' history/allowedTools
        stripped, writes die with the stage; containers get the same mount).
      - [ ] Plain local Claude: `~/.ssh` and another project are absent; edits
        inside its project work; `/rename`/SessionStart resume survives respawn.
      - [ ] Repeat the boundary/edit check in Codex and Gemini.
      - [ ] Member A's agent can list/edit member B and the box folder; a
        box-scoped agent can do the same; native add-dir flags are present.
      - [ ] Pill cycles default → off → on; off lets a newly respawned agent see
        the ordinary home while existing tabs remain unchanged.
      - [ ] Remote project says “not enforced: remote host” and still spawns.
      - [ ] Container project skips the fence and keeps the container boundary.
      - [ ] Missing bubblewrap gives the readable fail-closed error and the
        install row; after install/recheck the row disappears.
      - [ ] A shell tab in the same project remains unfenced.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work

- [ ] **Shift+Tab reaches a Codex tab.** xterm.js has no kitty keyboard
  protocol and no `modifyOtherKeys`, so Shift+Tab left it as the legacy backtab
  `ESC [ Z` — which codex-cli 0.151.0 does not bind to anything, so the key was
  inert in every Eldrun Codex tab while its own footer advertised "shift+tab to
  cycle". Fixed 2026-08-31: `terminalControl.shiftTabForAgent` re-encodes it as
  the CSI-u form `ESC [ 9 ; 2 u` for Codex panes only (Claude/Qwen read the
  backtab), on the desktop pane and on Eldrun Mobile's mode walk alike. Verified
  in a bare PTY: `ESC [ Z` changed nothing, `ESC [ 9 ; 2 u` stepped the mode.
  QA:
      - [ ] Shift+Tab in a Codex tab steps to Plan mode and back.
      - [ ] Shift+Tab in a Claude tab still cycles its own modes.
      - [ ] Shift+Tab in a plain shell tab still sends a backtab (readline
        completion, `less`, an ncurses form).
      - [ ] The phone's mode chip lands on the mode it was asked for.
      - [ ] ✅ Works
      - [ ] ❌ Doesn't work
