# Resume Sessions — Implementation Plan (Group F, TODO #39b/#39c)

> **Status: DONE for Claude.** All four slices landed. Backend `TabEntry.session_id`,
> save persists resumable agent tabs (Claude only, with `sessionId`), restore
> respawns with `claude --resume <id>`. TODO 39b/39c marked done (Claude only);
> 39d (other agents) and the per-process attribution across `/clear` remain open.
> Gate green: `npx tsc --noEmit` (only the unrelated pre-existing `EmbedCap`
> errors), `cargo test`, and the vitest suite all pass; integration round-trip
> covered by `src/__tests__/ResumeSessionRoundTrip.test.ts`.

Shared spec for the 4-agent team. **Read this whole file before editing.** Each
agent owns a disjoint slice; do not edit files outside your slice.

## Problem

Agent tabs mint a deterministic session UUID (`TabEntry.sessionId`, launched via
`claude --session-id <uuid>` — TODO 39a, done). The UUID is persisted (in
`project.json` `open_tab_sessions` / `extra`), **but the agent tab itself is
dropped on save** (`isRestorableKind` returns false for `agent`/`local_agent`),
so after reopening Eldrun the agent tabs are gone and the stored UUID is unused.

## Goal

Persist resumable agent tabs **in `tab_layout`** (with their `sessionId`) and
restore them on relaunch, respawning the agent with its resume flag
(`claude --resume <sessionId>`) so the conversation comes back. Closes 39b
(persist agent tabs with session id) and 39c for Claude (resume on restore).
39d (Gemini/Codex/Vibe) stays open — only Claude is wired here.

## Core concept: "resumable agent"

A tab is **restorable** if it's a shell/files tab (existing rule) **or** a
resumable agent tab. A tab is a **resumable agent** iff:
`(kind === "agent" || kind === "local_agent") && !!sessionId && cmd ∈ RESUMABLE_AGENTS`.

Only Claude is in the map for now (verified `--resume <id>`). Gemini/Codex/Vibe
are deliberately excluded until their resume-by-id flag is verified (39d).

### Shared helpers (added by Agent 2 in `src/stores/tabs.ts`, exported)

```ts
// cmd -> args to resume a prior session by id
export const RESUMABLE_AGENTS: Record<string, (id: string) => string[]> = {
  claude: (id) => ["--resume", id],
};

export function isResumableAgentTab(
  tab: { kind: TabKind; cmd: string; sessionId?: string },
): boolean {
  return (
    (tab.kind === "agent" || tab.kind === "local_agent") &&
    !!tab.sessionId &&
    tab.cmd in RESUMABLE_AGENTS
  );
}

// tab-level restorability (supersedes bare isRestorableKind at call sites that
// have the full tab). isRestorableKind stays for kind-only checks.
export function isRestorableTab(
  tab: { kind: TabKind; cmd: string; sessionId?: string },
): boolean {
  return isRestorableKind(tab.kind) || isResumableAgentTab(tab);
}
```

## Slices

### Agent 1 — Backend round-trip (Rust, `src-tauri/` only)
- `src-tauri/src/schema/project.rs`: promote `sessionId` to a first-class
  optional field on `TabEntry` — `#[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")] pub session_id: Option<String>`.
  Keep `#[serde(flatten)] extra` (forward-compat). Verify nothing else
  constructs `TabEntry` positionally (grep); if so, add the field.
- Confirm the save/load/snapshot paths (`services/terminal_service.rs`,
  `services/project_runtime.rs`) preserve it — they pass `Vec<TabEntry>` through
  untouched, so promoting the field should require no logic change there.
- Add a Rust test in `src-tauri/tests/services_tests.rs`: write a tab layout
  containing an agent tab with a `sessionId` via `save_tab_layout`, read it back
  via `load_tab_layout`, assert the `session_id` survives round-trip.
- `cargo test --manifest-path src-tauri/Cargo.toml` must pass.
- **Do not touch any `src/` file.**

### Agent 2 — Frontend persistence / save side (`src/stores/tabs.ts`, `src/stores/projects.ts`)
- Add the shared helpers above to `tabs.ts` (exported).
- `saveLayout` (tabs.ts): change the keep-filter from `isRestorableKind(t.kind)`
  to `isRestorableTab(t)`. Persist `sessionId` in each `tabLayout` entry. Keep
  the `groups` prune `keep` set in sync (resumable agent tabs must survive). The
  separate `sessions` array may stay as-is (harmless redundancy) or be derived
  from the same filter — keep it; do not remove `open_tab_sessions`.
- `projects.ts` `setActive` snapshot (~line 163-188): switch the
  `isRestorableKind(t.kind)` filter to `isRestorableTab(t)`, include `sessionId`
  (and `kind`, `env`) in the snapshot `tabLayout` entries so a project switch
  also round-trips resumable agents. Update `ProjectRuntimeSwitchedPayload`
  (~line 36) and the backend snapshot struct expectations accordingly (the
  backend `TabEntry` already carries these via Agent 1).
- Update `src/__tests__/TabPersistFilter.test.ts`: a Claude agent tab **with** a
  sessionId now persists; one **without** still drops; non-Claude agents drop.
- `npx tsc --noEmit` clean for your edits. **Do not edit the restore path**
  (CenterPanel.tsx, loadFromLayout, listenProjectRuntimeSwitched) — that's
  Agent 3. Runs AFTER Agent 1+2; relies on Agent 2's helpers.

### Agent 3 — Frontend restore + resume launch (`src/stores/tabs.ts` loadFromLayout, `src/components/layout/CenterPanel.tsx`, `src/stores/projects.ts` listener, `src/components/tabs/TabBar.tsx`)
- `loadFromLayout` (tabs.ts): carry `sessionId` from the saved entry onto the
  restored `TabEntry`. For a resumable agent tab, set `args` to
  `RESUMABLE_AGENTS[cmd](sessionId)` instead of `[]` so the PTY respawns the
  agent with `--resume <id>`. Non-agent tabs keep `args: []`. Keep the existing
  agent-cwd-reset-to-defaultCwd behavior.
- `CenterPanel.tsx` (~line 90 restore filter): replace `isRestorableKind(...)`
  with the tab-level `isRestorableTab(...)` (entries carry `kind`/`cmd`/
  `sessionId`). Ensure the loaded `LayoutEntry` type includes `sessionId`.
- `projects.ts` `listenProjectRuntimeSwitched` (~line 328): same swap to
  `isResumableAgentTab`/`isRestorableTab`; payload entries now carry
  `kind`/`sessionId` (Agent 2 widened the payload type).
- `TabBar.tsx`: keep launch via `--session-id` for NEW tabs (Agent line ~45 +
  `handleAdd`); resume args belong only to restore. No behavior change needed
  unless the AGENT config is the natural home for the resume mapping — if you
  prefer, source `RESUMABLE_AGENTS` from the AGENT list, but keep tabs.ts as the
  single export others import.
- Update `src/__tests__/CenterPanelSessionRestore.test.tsx` and
  `src/__tests__/SplitLayout.test.ts` (loadFromLayout) to assert a resumable
  agent tab restores with `--resume <id>` args and its sessionId.
- `npx tsc --noEmit` clean. Runs AFTER Agent 2.

### Agent 4 — Tests, docs, verification (whole repo, after 1-3)
- Run full `npx tsc --noEmit` and `cargo test --manifest-path src-tauri/Cargo.toml`;
  fix any fallout from the integration (small, surgical only).
- Add an integration-style frontend test: save a layout with a Claude agent tab
  (sessionId) → reload via loadFromLayout → tab present with `--resume` args.
- `TODO.md` Group F: mark 39b `[x]` and 39c `[x]` (Claude only; leave 39d open);
  add a short note that 39c is done for Claude via `--resume`.
- `CLAUDE.md` persistence section + `isRestorableKind`/`saveLayout` doc comments:
  update the now-stale "agent tabs are dropped / restore path does not consume
  these yet" wording to reflect resumable-agent restore.
- Do not change behavior beyond making the suite green + docs accurate.

## Invariants (all agents)
- Only Claude resumes for now. A `sessionId`-less agent tab, or a non-Claude
  agent, must still be dropped on save (no misleading fresh-agent restore).
- Frontend (`src/`) edits hot-reload; only Agent 1's Rust needs a rebuild for
  live QA — note that, don't launch Eldrun.
- `npx tsc --noEmit` and `cargo test` are the gate.
</content>
</invoke>
