# Help MCP — plan

The user asked for "a help MCP reachable from everywhere that can be asked
questions about Eldrun". This is the design and what was built. Rationale that
outlives the build goes in `docs/context/help_mcp.md`.

## What it is

A read-only MCP server, `eldrun-help`, answering from Eldrun's own user
documentation (`docs/help/*.md`, one topic per file). It knows nothing about
the user's projects, files, settings or state, and it does nothing: no writes,
no side effects, no reads from disk at call time.

Tools (`services::help_mcp::TOOLS`):

| Tool | Arguments | Returns (bounded) |
|---|---|---|
| `eldrun_help_search` | `query` (≤ 256 B), `limit` (1–10, default 5) | ranked `{id, title, section?, sectionTitle?, snippet (≤ 240 chars), score}` |
| `eldrun_help_read` | `topic_id` (≤ 64), `section?` (≤ 96) | markdown text, ≤ 16 KiB for a topic, ≤ 8 KiB for a section, `truncated`, the section list |
| `eldrun_help_topics` | — | every topic (≤ 200): id, title, keywords, sections |
| `eldrun_help_status` | — | version, build commit, OS/arch, topic count, which CLIs are wired |

Arguments are schema-checked with the root registry's validator
(`root_mcp_security::validate`): unknown fields refused, bounds enforced. An
unknown topic or section is a tool error naming the closest topics or the valid
section ids. Every reply is also capped at `root_mcp_security::MAX_RESPONSE`.

`eldrun_help_status` is justified because "which version am I on / does this
tab have the help tools" is a real support question, and every field is a
property of the binary (compile-time constants and `std::env::consts`), never
of the user: no paths, no settings, no installed-CLI probe (that would read the
user's machine; an agent can run `which` itself if it has a shell).

## The corpus

`build.rs` (`generate_help_corpus`) lists `docs/help/*.md`, sorts the names and
writes `OUT_DIR/help_corpus.rs` — one `include_str!` per file. The binary
serves exactly the docs it was built from. A missing directory yields an empty
corpus, not a failed build; `help_mcp::tests::real_corpus_parses` holds every
real file to the contract, so a malformed file fails `cargo test`, not the build.

Contract per file (owned by the corpus authors):

```
---
id: local-models            # == filename stem, kebab-case [a-z0-9-], ≤ 64
title: Installing local models
keywords: [ollama, model, gpu]
---
Intro text (optional).

## Section heading          # addressable as section id `section-heading`
Body …
```

Section ids are slugs of the heading (lowercase ASCII alphanumerics, `-`
between runs, a `-2` suffix on a repeat). A `##` inside a fenced code block is
text. Unknown front-matter keys are ignored for forward compatibility.

## Search

Deterministic BM25 (k1 1.2, b 0.75) over *units* — a topic's intro and each
`##` section — with the topic's title, keywords and id counted three times and
the section heading twice. Tokens are lowercase alphanumeric runs, a small
English stopword list dropped, a light plural stem (`models` → `model`,
`entries` → `entry`). Ties break on topic id, then section order. No new
dependencies; the index is built once (`OnceLock`) from the embedded corpus.

## Auth — a fourth, lowest-privilege identity

It rides the existing loopback listener (`commands::root_mcp`) and every check
it already makes before a body is read: HTTP/1.x only, no `Origin`, `Host`
exactly `127.0.0.1:<port>`, one bearer token compared in constant time, per-
session rate limit and permits, bounded body.

- New caller class `Caller::Helper`, new route `POST /mcp/help`. `path_serves`
  admits a help token only there, and no other class there.
- The four tool names are registered in `root_mcp_security::tool` with
  `family: "help"` and a `help` flag that serves **only** `Caller::Helper`;
  `ToolPolicy::serves(Helper)` is false for every root/reader/mail tool, and
  `Policy::serves(Helper)` is false, so a help token can never enter `/mcp`.
  Tests pin both directions (`registry_keeps_help_and_root_apart`).
- Tokens are minted per spawn (OS CSPRNG), live in memory only, and are
  revoked on tab exit, close, failed spawn (`SpawnTokenGuard`) and quit. They
  are listed in `tmux_local::SECRET_ENV` so a launcher script never writes one
  to disk.
- A tab can hold a help token *beside* its root, reader or schedule token: the
  token map replaces sessions per *lane* (helper / everything else), so one
  never revokes the other. Help sessions are left out of the MCP session
  access list (nothing to grant), refuse `set_access`, and do not keep a tab's
  review sandbox alive (`tab_active`).
- Help calls are not written to the in-memory audit ring: every agent tab may
  ask, and 500 rows of doc lookups would push the root tools' security records
  out. Admission failures (bad token, Origin, Host) are still audited.
- Global switch `Settings::help_mcp` — **absent = on** (the content is public
  and read-only). Read per spawn *and* per request, so switching it off also
  refuses tabs that already hold a token. An unreadable settings file answers
  off.

Known limit, inherited (`docs/context/root_console.md`): the token is in the
tab's environment, so any process the agent starts can call `/mcp/help` as the
tab. For this server that grants nothing beyond reading public docs.

## Wiring — "reachable from everywhere"

`root_mcp::apply_help_to_spawn`, called from `commands::terminal` for every
agent spawn, after the root/reader/schedule wiring and before any
ssh/docker/fence/tmux wrapping:

- **Claude** — joins the one variadic `--mcp-config` flag with its own inline
  JSON (`eldrun-help`, header `Bearer ${ELDRUN_HELP_MCP_TOKEN}` expanded by
  Claude from its env, never in argv), beside a root or schedule server.
- **Codex** — `-c mcp_servers.eldrun-help.url=…` and
  `…bearer_token_env_var="ELDRUN_HELP_MCP_TOKEN"`, prepended.
- **Local models (Mistral Vibe on Ollama)** — only a tool-tagged model
  (`ollama_mcp_models`), merged into `VIBE_MCP_SERVERS` / `VIBE_ENABLED_TOOLS`
  (the root and schedule wiring set those outright, so help runs last). An
  untagged model gets nothing: it cannot call tools.
- **Every other agent CLI** (Gemini, OpenCode, Copilot, …) gets the env pair
  `ELDRUN_HELP_MCP_URL` / `ELDRUN_HELP_MCP_TOKEN` only, until its CLI has a
  per-invocation way to name a server. Eldrun never writes another app's
  config (AGENTS.md), so no `gemini mcp add`.

Reach: every **local** agent tab — root or project, fenced or unfenced, tmux
or not, and a `local_only` tab of a remote project (it runs here). Bubblewrap
shares the host network namespace, so fenced tabs reach loopback.

Out of scope, honestly:

- **Remote-host and worker tabs** — the agent runs on the far host, whose
  loopback is not ours. It would need an ssh reverse tunnel per tab
  (`-R`), a new exposure of the listener to the remote host's users; schedule
  scoped this out for the same reason. A remote user can still ask a *local*
  tab.
- **VM and container tabs** — the guest's / container's loopback is its own.
  The mail reader's `guestfwd` channel is reserved for `Caller::Reader`
  (`admit` refuses any other class on the guest address).
- **Gemini / OpenCode native wiring** — follow-ups: OpenCode could take an
  `mcp` block merged into the `OPENCODE_CONFIG_CONTENT` Eldrun already
  composes; Gemini has no per-invocation server flag today.
- No tool-permission choice: Eldrun passes no `--allowedTools`; the tools carry
  `readOnlyHint`, and approving them stays the CLI's own (AGENTS.md: an
  agent's permission mode is its own CLI's).

## In-app access (cheap, same index)

Tauri commands in `commands::root_mcp` for an intro / Settings "Ask" box:

- `help_search({ query, limit? }) → [{ id, title, section?, sectionTitle?, snippet, score }]`
- `help_read({ topicId, section? }) → { id, title, keywords, section?, text, truncated, sections: [{ id, title }] }`
- `help_topics() → [{ id, title, keywords, sections }]`

`root_mcp_status` gains `help: { enabled, wiredClis, topics }` — `enabled` is
"a local agent tab opened now gets the help server" (listener up and
`help_mcp` not off) — for a "help MCP is wired" chip.

## Verification

Unit tests: `services::help_mcp::tests` (fixture corpus index, ranking,
determinism, bounds, unknown topic/section, class/revocation refusal, registry
separation, status leaks nothing, real corpus parses), `services::root_mcp`
(wiring per CLI, Vibe merge, lane separation), `commands::root_mcp`
(`help_route_is_its_own_lane`: route/class, Origin, Host, closed tab).

Live (user-run, after a restart that loads the new backend): open a fresh
local Claude tab and ask *"Use the eldrun-help tools: how do I install a local
model in Eldrun?"*; approve the tool; expect an `eldrun_help_search` then an
`eldrun_help_read` call. `/mcp` in Claude should list `eldrun-help` as
connected. Repeat in Codex. Switch `help_mcp` off in `settings.json`
(`"help_mcp": false`): the next call in the open tab must be refused (HTTP 403).
