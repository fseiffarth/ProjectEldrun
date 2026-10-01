# Rename phase 2 — handoff (interim; refreshed at the end of the phase)

Branch `rename`, worktree `.claude/worktrees/rename`. The plan is the untracked
`docs/rename_plan.md` (never `git add` it; the new name is secret). Read
`docs/rename_phase1_handoff.md` first for the brand modules' conventions.

Design rationale of the engine: `docs/context/brand_migration.md`.

## Where things are

- `src-tauri/src/brand.rs`: `Forms`, `Pair`, `PAIR`, `Name` (every `names!`
  entry as a value: `pair.cur(Name::X)`, `pair.legacy(Name::X)` → `None` when
  unchanged), `env()`/`env_os()`, `Pair::{env_in, adopt_legacy_env,
  export_both}`, `legacy_hit(id)`, `is_project_dir`. The file is also compiled
  into `build.rs`, so it stays std-only: the hit sink is installed by
  `services::brand_migration::hits::install()` (first line of `main` and `run`).
- `src-tauri/src/services/brand_migration/`: `mod.rs` (record, runner, lazy
  markers, `resolve_named_dir`), `hits.rs` (`legacy-hits.json`), `host.rs`
  (this machine: `Env::for_this_machine`, the production `World`,
  `run_at_launch`), `state_dir.rs`, `persisted.rs`, `agent_homes.rs`,
  `project.rs`, `keyring.rs`, `docker.rs`, `compat.rs` (script preambles, tool /
  tab-command / tmux / export-manifest / Ollama helpers), `testing.rs`
  (`RENAMED` pair, `Machine`, `seed_install`), `tests.rs`.

## Done so far (backend)

See the status table in the final version of this file. Commits up to
`f47b7ed7`: engine + state dir, agent homes, projects + keyring, dual reads +
persisted names + VM pinning, mail label sets.

## Still to do when this interim note was written

Frontend/phone helpers, packaging + shim alias + scripts, Settings → About
summary, docs (`docs/context/brand_migration.md`, filemaps, AGENTS.md list),
final gates.
