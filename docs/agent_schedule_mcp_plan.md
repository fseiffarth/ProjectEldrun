# Agent Schedule MCP — plan

*Desktop v1 implemented 2026-09-20; live QA remains user-run. Runtime details,
compatibility notes and the click-through checklist: [context/agent_schedule_mcp.md](context/agent_schedule_mcp.md).
Phone controls, additional CLI flag recipes and remote/container reach remain follow-ups.*

The request: **a separate MCP, for all agents, for scheduling prompts** — so an
agent in any tab can say "send me this at 09:00" / "continue this after my
usage window resets" and the prompt shows up in Eldrun's own scheduler instead
of in a CLI-private cron that dies with the session and never reaches the
prompt chart.

Not to be confused with the **root MCP** (`docs/context/root_console.md`):
that one serves root-console agents calendar, board, mail and git-sweep tools.
This one serves *project* agents exactly one thing — rows in their own tab's
schedule list — and must never become a side door into the other.

---

## 1. The shape, in one page

```
agent CLI in a project tab (fenced or not)
   │  streamable HTTP MCP, Bearer ${ELDRUN_SCHEDULE_MCP_TOKEN}
   ▼
the existing loopback listener        POST /mcp/schedule   (new path)
   │  token → {tab, project, scheduleTargetId}   — fixed at spawn
   ▼
services::schedule_mcp  (new, AppHandle-free)
   │  validate → quota → stage or apply
   ▼
services::agent_tasks::upsert / list / delete      (unchanged store)
   │  emit "agent-schedules-changed"
   ▼
AgentScheduleHost  — the same idle-gated delivery every schedule gets
```

Six decisions carry the design:

1. **No new scheduler.** The store (`agent_tasks.json`, keyed
   project → `scheduleTargetId`), the claim/complete protocol, the idle gate in
   `AgentScheduleHost` and the prompt chart all exist. The MCP is a fourth
   *author* of `ScheduledAgentPrompt` rows beside the composer, the Agents view
   and the phone. It adds no delivery path and no second PTY write route.

2. **Self-target only, by construction.** The token is minted per spawn and
   bound to `{tab, project_id, schedule_target_id}`. No tool takes a project,
   tab or target argument — there is nothing to get wrong. A fenced agent can
   therefore never schedule into an unfenced tab, another project, or the root
   console. Same rule for chains: no tool creates an `after`/`related` link
   (`agent_prompts.rs` links), because a link's other endpoint is someone
   else's prompt.

3. **Same listener, separate path, separate registry.** The root MCP listener
   already does the hard parts: bounded body reads, authority and `Origin`
   refusal before the body, per-session permits and rate, revocation, audit.
   It also already serves one non-root class (`Caller::Reader`). So this is
   not a second port. But it is a second **path** (`/mcp/schedule`) with its
   own tool table: the path picks the registry *before* the role is looked at,
   a schedule token presented on `/mcp` is refused and a root token presented
   on `/mcp/schedule` is refused. Isolation then does not rest on every root
   tool remembering to check the caller. New `Caller::Scheduler`; it appears in
   no row of `root_mcp_security`'s root registry.
   *(This revises the first instinct of "its own listener": with `Reader`
   already on the shared listener, a second port buys little and duplicates
   the hardening.)*

4. **Staged by default.** A scheduled prompt is a deferred, unattended prompt.
   Everything inside a project folder is attacker-controlled, so an agent that
   read a poisoned file can ask for one. Default level: the row is written
   **disabled** with `origin: agent` and surfaces as "proposed by the agent" in
   the tab's schedule menu, the Agents view and the prompt chart; one click
   enables it. A per-project level "apply immediately" exists (§5) but is never
   the default and is stored in `projects.json`, never the in-folder
   `project.json`.

5. **The message is a prompt, never a command.** Agent-authored rows carry
   **no `preface`** (no `/clear`, no `/model`, nothing that takes the whole
   line), and the message is refused when its first non-blank character would
   make the CLI treat it as something other than a prompt — `/` (slash
   command), `!` (Claude's shell mode runs the rest as a shell command with no
   permission check), `#` (Claude memory write), `@`-only lines, `$` (Codex).
   The refusal list lives beside `sanitize_message` and is per-CLI-agnostic:
   refuse the union. Newlines inside the message are collapsed the way the
   composer's are so a second line cannot smuggle one either.

6. **Eldrun chooses no mode.** The delivered prompt lands in whatever
   permission mode the tab is in; this plan adds no mode control
   (AGENTS.md → Invariants → Agents). That a tab in a bypass mode will act on
   an agent-authored prompt unattended is precisely why 4 defaults to staged.

---

## 2. Tools

Server name `eldrun-schedule`. Three tools, all scoped to the caller's own
target; ids returned are the store's schedule ids.

| Tool | Args | Does |
| --- | --- | --- |
| `schedule_prompt` | `message`, `when` | Adds one row. `when` is `{type:"once", at}` \| `{type:"daily", time}` \| `{type:"weekdays", weekdays, time}` — `AgentScheduleRule` verbatim — plus the sugar `{type:"in", minutes}` and `{type:"after_usage_reset"}`, both resolved to a `Once` server-side. Returns `{id, state: "proposed"\|"scheduled", fires_at}`. |
| `list_my_schedules` | — | The caller's target's rows: id, rule, next occurrence, `origin`, enabled, `last`. User-authored rows are listed (the agent should know a 09:00 prompt already exists) but their `message` is elided to a 80-char preview. |
| `cancel_schedule` | `id` | Deletes a row **only if `origin == agent`**. A user-authored id answers `not_yours`, not `not_found`. |

No update tool: cancel and re-add. One fewer path that can flip a user's row.

Tool descriptions state the delivery contract plainly, because an agent will
otherwise promise things that silently don't happen:

- fires only while Eldrun is running and this tab is open;
- delivered when the tab is next idle at/after the time, never mid-turn;
- a `once` more than the grace window late is recorded `missed`, not sent;
- at the default level the user must approve it first.

`after_usage_reset` reads the same `agent_usage` report `AgentContinueHost`
uses and resolves to rollover + 1 min; if the CLI has no usage panel the tool
answers `unsupported` rather than guessing.

---

## 3. Limits

All checked in `services::schedule_mcp` before the store is touched; the store's
own `MAX_SCHEDULES = 32` per target and 16 KiB message cap still apply on top.

| Limit | Value | Why |
| --- | --- | --- |
| Pending agent-authored rows per target | 4 | leaves the user's 28 alone |
| Minimum lead time | 5 min | no tight self-prompt loop |
| Agent-authored deliveries per target per day | 6 | a self-rescheduling agent cannot eat a usage window overnight |
| Recurring (`daily`/`weekdays`) rows per target | 1, always staged | a recurring unattended prompt is approved by a human whatever the level |
| `schedule_prompt` calls per session per hour | 12 | on top of the listener's rate |
| Proposal lifetime | 7 days unapproved → pruned | stale proposals don't pile up |

The per-day counter is counted from `last`/delivery records, not held in
memory, so a restart does not reset it.

**Re-arm rule.** A prompt delivered by an agent-authored row may itself call
`schedule_prompt`. That is the legitimate "keep going tomorrow" case and also
the runaway case; the per-day cap and lead time bound it, and the chart shows
the lineage (`origin: agent`, plus the id of the delivery that authored it).

---

## 4. Data

`ScheduledAgentPrompt` gains one optional field:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub origin: Option<ScheduleOrigin>,   // None = user (every existing row)

pub struct ScheduleOrigin { by: "agent", session: String, at: String,
                            from_delivery: Option<String> }
```

- Existing files round-trip untouched (`None` is not serialized).
- The struct is `deny_unknown_fields`, so a file holding an `origin` is
  unreadable by an **older** binary. `agent_tasks.json` is per-machine state
  and the version stays `1`; call this out in the release note rather than
  bumping, the same call `agent_prompts.rs` links made.
- "Proposed" is `enabled: false` + `origin.by == agent` + never delivered. No
  new state enum; approving is the existing enable toggle.
- `session` is the token-hash id `root_mcp::Session.id` already uses, so audit
  rows and schedule rows join.

---

## 5. Opt-in and levels

- **Global switch**, Settings → Manage CLIs, off by default, `UntestedTag`.
  Off → no token minted, no flag added, no env pair: an agent gets nothing.
- **Per project** (`projects.json`): `off` · `propose` (default when the global
  switch is on) · `apply`. `apply` still stages recurring rows (§3).
- **Root console tabs** are out of scope here; a root agent's scheduling, if
  wanted, is a tool on the root registry with the root review levels.
- **Revocation**: the sessions list in the root console's MCP panel already
  lists per-spawn sessions; `Scheduler` sessions appear there with their
  project, and revoking one also offers "remove its proposals".
- **Audit**: every call lands in the existing bounded in-memory audit with
  tool, target, verdict and refusal reason.

---

## 6. Wiring the CLIs

Same rule as the root MCP: the server is named on the CLI's **own command
line**, never in its config, and the token travels by env name, never argv.

| CLI | How | Status |
| --- | --- | --- |
| Claude | `--mcp-config` inline JSON, header `Bearer ${ELDRUN_SCHEDULE_MCP_TOKEN}` | same mechanism as root, verified there |
| Codex | `-c mcp_servers.eldrun-schedule.url=…` + `bearer_token_env_var` | same |
| Vibe (local model) | `VIBE_MCP_SERVERS` entry, only for models wearing the MCP chip | same |
| everything else | env pair `ELDRUN_SCHEDULE_MCP_URL` / `_TOKEN` only | inert until the CLI has a per-invocation flag |

So "all agents" is honestly **Claude + Codex + opted-in Vibe on day one**, and
`WIRED_CLIS` (shared with root) is the list to grow. Per-CLI flag recipes for
Gemini/Qwen/OpenCode are follow-ups, each needing a verified flag — see
`docs/third_party_update_checklist.md`.

Spawn plumbing: `PtyOptions` has `id` and `project_id` but not the tab's
`scheduleTargetId` (frontend-only, `stores/tabs.ts`). Add
`schedule_target_id: Option<String>` to the spawn payload; the token binds to
it. A spawn without one (non-agent tab, old frontend) gets no token.

A root spawn and a schedule spawn are disjoint (`project_id.is_none()` vs
`is_some()`), so a tab never holds both tokens.

**Reachability.**
- Fenced local agents: the fence is filesystem + pid only, network is shared
  (`docs/context/agent_authority.md`), so loopback works. The env pair is
  passed through the fence like the root pair.
- Container / VM / remote-host agents: loopback is the wrong machine. **Out of
  scope for v1** — no token is minted when `remote_target_for` says remote or
  the project runs in a session container. A later phase can tunnel (reverse
  forward over the pooled SSH session; a published port for the container)
  but each is its own exposure review.

**Known limit**, same as root: an *unfenced* agent shares the uid and can read
another tab's `/proc/<pid>/environ`, so it can lift another tab's schedule
token. What it gains is proposals in that tab's list — visible, attributed,
staged. That is weaker than what an unfenced agent can already do to the state
dir directly, and the plan does not pretend otherwise.

---

## 7. Frontend

Small, and all in existing surfaces — no new view:

- Schedule menu, Agents view rows, `PromptCard`: an "agent-proposed" chip on
  `origin.by == agent`, Approve / Dismiss on a proposal. Reuse the shared
  menu/dialog scheme; strings through `useT()`.
- A tab with pending proposals raises the existing attention affordance once,
  not per proposal.
- Prompt chart: agent-authored cards are visually distinct and show the
  authoring delivery when `from_delivery` is set.
- Phone (`mobile_control`): proposals appear in the Agents list with
  Approve / Dismiss; ids stay opaque as today. Follow-up, not v1.
- Settings → Manage CLIs: the switch, the per-project level in project
  settings, both under one `untested` register row.

---

## 8. Files

Backend
- `services/schedule_mcp.rs` (new, AppHandle-free): tool table, arg schemas,
  message refusal rules, quotas, `in`/`after_usage_reset` resolution, pure
  `apply_*` core with tests.
- `services/root_mcp.rs`: `Caller::Scheduler`, `Identity.schedule_target`,
  path → registry dispatch, second env/server-name constants,
  `apply_schedule_to_spawn_with` beside `apply_to_spawn_with`.
- `services/root_mcp_security.rs`: a `Scheduler` registry; root registry
  asserts `Scheduler` is in no row (test).
- `commands/root_mcp.rs`: route `/mcp/schedule`; emit
  `agent-schedules-changed` after an applied write.
- `schema/agent_tasks.rs` + `services/agent_tasks.rs`: `origin`,
  `delete` guard helper, per-day delivery count.
- `terminal/mod.rs` + `services/terminal_service.rs`: `schedule_target_id` on
  the spawn, mint + guard like `SpawnTokenGuard`.
- `schema/settings.rs` / `schema/project.rs`: switch and level.

Frontend
- `lib/agents/agentSchedule.ts` type + `stores/agents/agentSchedules.ts`.
- `AgentScheduleHost.tsx`: count agent-authored deliveries toward the cap;
  no change to the gate.
- `AgentSchedulesView.tsx`, `AgentScheduleDialog.tsx`, `PromptCard.tsx`: chip
  and Approve / Dismiss.
- `lib/i18n.ts`, `lib/untested.ts`, filemap rows, a short
  `docs/context/agent_schedule_mcp.md` once built.

---

## 9. Tests (the ones that hold the invariants)

- A `Scheduler` token on `/mcp` → 401/refused; a root or `Reader` token on
  `/mcp/schedule` → refused. `tools/list` on each path shows only its own.
- No tool schema accepts a project/tab/target key (`deny_unknown_fields`).
- `cancel_schedule` on a user row → `not_yours`; row intact.
- Message refusals: leading `/`, `!`, `#`, `$`, whitespace-then-`!`,
  newline-then-`/`, zero-width-then-`!` (run `strip_invisible` first).
- Agent-authored rows never serialize a `preface`.
- Quotas: 5th pending row, < 5 min lead, 7th delivery of the day, 2nd
  recurring row — each refused with a reason the agent can read.
- `apply` level still stages a recurring row.
- Old `agent_tasks.json` round-trips byte-identically; a row with `origin`
  round-trips.
- No token minted for: global off, project `off`, remote/container/VM spawn,
  root spawn, spawn without `schedule_target_id`.
- Revoking the session refuses the next call; tab close revokes.

---

## 10. Phases

1. **Backend core** — schema field, `schedule_mcp.rs` with refusals + quotas,
   path dispatch, `Scheduler` caller, tests. No wiring: nothing can call it.
2. **Spawn wiring** — `schedule_target_id`, token mint, Claude + Codex flags,
   global switch + project level.
3. **Frontend** — chip, Approve / Dismiss, attention, settings, i18n,
   `UntestedTag` + register row, filemap rows.
4. **Live QA** (user-run; backend needs a restart): Claude proposes → approve →
   delivers when idle; Codex same; fenced tab reaches loopback; refusals read
   sensibly to the agent; revoke; tab close; restart keeps proposals and the
   day count.
5. **Follow-ups** — phone Approve / Dismiss; more CLI flag recipes;
   remote/container reach; root-console scheduling tool.

## 11. Open questions

- Should agent-authored `once` rows die with the tab, or follow the
  `scheduleTargetId` across a restart like user rows do? Plan assumes they
  follow (they are just rows); dying-with-tab is stricter and simpler to
  reason about.
- Is a 80-char preview of the user's own rows in `list_my_schedules` already
  too much? They are the user's words to this same agent, so probably fine;
  alternative is times only.
- `after_usage_reset` overlaps `AgentContinueHost`'s auto-continue. If both
  are on for a tab, auto-continue should stand down when an agent-authored
  reset row exists, or the tab gets `continue` and the prompt back to back.
