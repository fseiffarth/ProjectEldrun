# Rename phase 1 — handoff (2026-10-01)

Branch `rename`, worktree `.claude/worktrees/rename`. The plan is the untracked
`docs/rename_plan.md` (never `git add` it; the new name is secret and must not
appear in any tracked file or commit message). Phase 1 = no behaviour change:
every persisted/external name keeps its value, only how the code spells it
changes.

## Committed

- `764c83d3` phase 0 (before this work).
- `08d89531` **Rust area, all gates green** at that commit (cargo test, clippy
  `-D warnings`, npm build/test/lint, privacy-check; Windows lib type-checked
  with the msvc shims; macOS cannot be compiled here).
- The commit after it (see `git log -1`): **WIP** — frontend + frontend tests +
  this file + the codemod scripts. State below.

## State of the WIP commit

Contains: `src/` (non-test) fully converted, the five i18n dictionaries
(key renames + `{slug}` placeholder), `src/styles` scrollbar names,
`src/lib/brand.ts`, all 189 changed files under `src/__tests__`, new
`src/__tests__/shell/BrandMirror.test.ts`, `src/__tests__/helpers/rustBrand.ts`
(already in the Rust commit), filemap rows.

Gates on that tree:
- `npm run build`: green (run on the final tree).
- `npm run lint`: green, 31 pre-existing warnings (run before the last test
  restore; tests were regenerated identically afterwards).
- `npm test`: one full run gave 663 files / 6735 tests with ONE failure
  (`LinkTarget.test.ts`), fixed and re-run alone green. `BrandMirror` and
  `i18n` tests green alone. **A full vitest run on the final tree was not
  repeated** — do it first (`npm test -- --reporter=dot`; expect 664 files,
  6741 tests: baseline 6734 + 1 i18n + 6 BrandMirror).
- cargo test / clippy: not re-run after the Rust commit (no Rust change since).
- `scripts/privacy-check.sh`: passed at commit time if the commit exists.

## Conventions established

Rust (`src-tauri/src/brand.rs`):
- Literal macros `app_name!()`, `app_slug!()`, `app_upper!()`,
  `app_env!("TAB_UID")`, `app_tab_command!("mail")`, `app_repo!()` and
  `legacy_name!/legacy_slug!/legacy_upper!`. Consts `DISPLAY`, `SLUG`, `UPPER`,
  `ENV_PREFIX`, `REPO` and `LEGACY_*` forms.
- `names! { CUR / LEGACY_CUR = [slug, "-suffix"]; … }` declares every
  persisted/external name with its `LEGACY_*` twin. Test
  `legacy_names_are_exactly_what_older_builds_wrote` spells the old values out
  once (brand.rs is the only Rust file allowed to).
- Use sites: `crate::brand::X`; in format strings with inline captures
  `{SLUG}`/`{UPPER}`/`{DISPLAY}` with `use crate::brand::…`; elsewhere
  `concat!(…, crate::app_slug!(), …)`. Tests use the same (value-preserving).
- Serde keys stay literal in `#[serde(rename = "…")]`, preceded by a
  `// brand-check: allow — …` comment line and pinned by a test
  (`the_mobile_*_key_is_the_brand_constant`). `include_bytes!` of
  `scripts/eldrun-send.*` also stay literal (script names flip in phase 3).
- `storage::home_share_dir()` = `~/.local/share/<STATE_DIR_NAME>` regardless of
  the state-dir override: used by `dev_build.rs`, `ollama.rs`,
  `agent_session.rs`. NOT `state_dir()` on purpose — those paths deliberately
  ignore the override and are not the per-OS state dir on Windows/macOS;
  routing them through `state_dir()` would move data.
- Old-brand-only ids use `legacy_slug!()`: `paths::LEGACY_TRASH_PROJECT_ID`,
  `agent_home::LEGACY_STAGE_MOUNT`.
- Lib crate renamed `eldrun_lib` → `app_lib` (Cargo.toml `[lib] name`).
- Tauri command `local_tmux_kill_eldrun_sessions` → `local_tmux_kill_app_sessions`
  (frontend caller renamed in the same commit).
- `app_update.rs` test fixtures (signed sums, asset names) left byte-identical.

Frontend (`src/lib/brand.ts`, imported by mobile-web too):
- `BRAND {display, slug, upper, envPrefix}`, `LEGACY_BRAND`, `NAMES` /
  `LEGACY_NAMES` (same keys, built by `namesFor(brand)`), `MOBILE_HOST_KEY` /
  `MOBILE_ACCESS_KEY` (literal-typed, used as computed keys `[MOBILE_HOST_KEY]`),
  `storageKey("x")` (`<slug>.x`), `storageDashKey`, `storageColonKey`,
  `envName("TAB_UID")`, `tabCommand("mail")`, `fillBrand` (fills `{app}` and
  `{slug}` in dictionaries).
- `BrandMirror.test.ts` + `helpers/rustBrand.ts` hold every shared `NAMES` key
  to brand.rs (camelCase key ↔ UPPER_SNAKE const) and `index.html`'s pre-paint
  storage keys to `storageDashKey`.
- Code-only names went neutral: DOM events `eldrun:*` → `app:*`, CSS
  `--app-scrollbar` / `data-app-scrollbar` / `.app-scrollbar-*`, print classes
  `app-print-hidden` / `app-rot-*` / `app-copy-break`, `app-icon`,
  `__APP_PERF__`, `AskAppPage` (file renamed), i18n keys `…askApp`,
  `…startsWithApp`, `stats.metricAppOpen`, `fileTree.appNativeGroup`, untested id
  `desktop.intro.askApp`, `UriOrigin` value `"app"`.
- Value kept via brand (persisted or crosses to the backend): localStorage keys,
  tab commands, env names, headers `x-<slug>-path`, `<slug>:file-drag-ended`,
  trust/print sentinels, tmux prefix, project dirs, export extension.
- `.eldrun_colors.json` (python-era hidden file) is pinned to `LEGACY_BRAND`.

## Pitfalls found

- Hand edits are the risky part: one slip (`.eldrun/` lost its dot in
  `GITIGNORE_DEFAULT`) was caught only by an integration test. Codemods are
  value-preserving by construction; prefer them.
- Phase 0 left two Windows-only `format!(concat!(… "{e}" …))` in `openvpn.rs`
  that did not compile for Windows (inline captures cannot live in `concat!`);
  fixed in the Rust commit. Always run the Windows type-check:
  `RC="$HOME/.local/bin/eldrun-msvc-rc-shim" AR_x86_64_pc_windows_msvc="$HOME/.local/bin/eldrun-msvc-lib-shim" cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc`
- `vi.mock`/`vi.hoisted` factories are hoisted above imports: a brand import
  used at factory-evaluation time throws. The TS codemod skips and reports
  those; fix by hand (neutral fixture value, or use inside a later callback).
- `git diff > patch` of the tests does not re-apply (one test file is treated
  as binary). To separate test changes, regenerate with the codemod instead.
- Names NOT in the plan's migration table but persisted, now named twins in
  brand.rs — Phase 2 must handle them: `GATEWAY_ID_CONTEXT` (hashed into
  remembered-network ids), `SUBAGENT_TOKEN_CONTEXT`, `VM_INSTANCE_ID_PREFIX`
  (cloud-init instance id is computed from the slug on every boot — a flip
  would re-run first boot in existing VMs), `SCREENSHOTS_DIR`/`EMAILS_DIR`
  project folders, agent-hint files/markers, `COPILOT_HINT_HOOKS`,
  `VIBE_SESSION_HOOK`, `LOCKSTEP_BUNDLE`, `MOBILE_AUTH_CONTEXT`,
  `CONTROL_PIPE_PREFIX`, hpc anchor dir `<slug>/<project>`, ICS uid suffix
  `@<slug>`, the stored intro page id (`askEldrun` → `askApp`: a stored
  last-page value of the old id falls back to the first page once).
- Renaming the Tauri command means a hot-reloaded frontend on a stale backend
  fails that call until the app restarts (`npm run backend:stale` reports it).

## What remains of phase 1

1. Re-run full gates on the WIP tree; then (optional) split/reword the WIP
   commit: frontend + the 8 tests that depend on its neutral renames
   (LinkTarget, FileIcon, MobileSetupGuide, PrintDoc, IntroWizard, SettingsMenu,
   SteeringSettings, CustomScrollbar, plus i18n and BrandMirror), then "tests"
   for the value-preserving rest.
2. **Mobile** (`mobile-web/src`, `mobile-web/public/sw.js`, `vite.*.config.ts`,
   `shared/`): run `scripts/rename-codemods/tsmod.mjs` on
   `git ls-files 'mobile-web/src/*.ts' 'mobile-web/src/*.tsx'`, then by hand:
   `EldrunMark.tsx` → `AppMark.tsx` (+ imports; codemod renames identifiers and
   import specifiers but not files), `__ELDRUN_MOBILE_COMMIT__` /
   `__ELDRUN_MOBILE_BUILT_AT__` vite defines (codemod renames the identifiers to
   `__APP_…`; rename the `define` keys in `vite.mobile.config.ts` to match),
   IndexedDB names → `NAMES.mobileAuthDb` / `NAMES.mobileMarkupDb`,
   `eldrun.mobile.*` keys → `storageKey("mobile.…")`, `eldrun-mobile-theme-colors`,
   `eldrun-show-untested-tags` (shared with desktop? check), `eldrun-open`,
   `eldrun-markup-pen`; `terminal/protocol.ts` → `NAMES.terminalProtocol`
   (then simplify `MobileTerminalProtocol.test.ts`). `public/sw.js`,
   `index.html`, `manifest.webmanifest`, icons are static flip points
   (allowlist); add a BrandMirror assertion for the SW cache prefix. Check the
   host (`mobile_control/host.rs`) for names the PWA shares. Run
   `npm run mobile:bundle` only if AGENTS.md asks for it in this flow.
3. **Scripts**: one sourced helper (e.g. `scripts/lib/brand.sh`) that (a) reads
   the bin name from `src-tauri/Cargo.toml` (`[[bin]] name`), (b) resolves the
   state dir (`~/.local/share/<slug>`), used by `backend-stale.sh`,
   `guard-single-instance.sh`, `package-dev.sh`, `package-dev-auto.sh`,
   `package-local.sh`, `retain-dev-build.sh`, `start-eldrun-dev-build.sh`,
   `start-eldrun-dev-sandbox.sh`, `start-eldrun-tauri-hotreload.sh`. Do not
   rename script files. A miss silently breaks the post-commit frozen build:
   verify with `bash -n`, `scripts/package-dev-auto.sh --status`, and by
   reading each `target/{debug,release}/eldrun` / `eldrun.frozen` /
   `eldrun-dev` use. `ELDRUN_*` env vars in scripts keep their names (derive
   the prefix in the helper). `.githooks/*`, `scripts/eldrun-send.*`,
   `bump-version.sh:71` are flip points.
4. **brand-check.sh** (+ CI job next to `privacy` in
   `.github/workflows/ci-cd.yml`). Design that matches the tree as converted:
   scan tracked files not on the allowlist; strip comments per line
   (`//…`, `/* … */`, `#…` for sh/py/yml/toml, `<!-- -->`), honour a
   `brand-check: allow` marker on the same or the previous line, fail on any
   remaining case-insensitive hit. Comments are prose and flip with the phase-3
   sed. Allowlist (each with a comment and the phase that clears it): docs/,
   todo/, *.md, `src-tauri/src/brand.rs`, `src/lib/brand.ts`,
   `src-tauri/src/services/app_update.rs` (byte-identical test fixtures),
   `src-tauri/src/commands/scaffold_history/` (frozen texts),
   `src/lib/untested.ts` (prose register parsed by `scripts/untested.mjs`),
   `test-fixtures/`, `src/__tests__/fixtures/`, `src-tauri/tests/fixtures/`,
   flip points (`Cargo.toml`, `Cargo.lock`, `package.json`,
   `package-lock.json`, `tauri*.conf.json`, `capabilities/`, `gen/`,
   `index.html`, mobile `index.html`/manifest/`sw.js`, svg/icons, script file
   names and `scripts/eldrun-send.*`, `.github/`, `docker/`, `.githooks/`),
   `scripts/rename-codemods/`, `scripts/privacy-check.sh`.
5. Report items owed: list of edits inside non-Linux `cfg` code (Windows:
   `mobile_control.rs` HOST_BINARY_NAME/RUN_VALUE/start_installed_host,
   `agent_hint.rs` + `agent_session.rs` ps1 script names and
   `container_hook_script_path`, `admin.rs` pipe name, `openvpn.rs` two format
   strings, `ssh_common.rs` askpass ps1 text, `windows_park.rs`; macOS:
   `mobile_control.rs` LAUNCHD_LABEL, `macos_park.rs`, `macos.rs` param rename,
   `lib.rs` MAC_MENU_QUIT_ID — plus whatever the codemod touched in files with
   `target_os = "macos"`; macOS is unverified).

## Codemod scripts

Kept in `scripts/rename-codemods/` (delete when phase 1 lands; allowlist in
brand-check until then):
- `rslex.py` (Rust lexer + counts), `rshits.py prod|test` (non-comment hits),
  `rsmod.py [--dry] files…` (the Rust codemod), `flatten.py` (un-nest
  `concat!`), `edit.py spec.py` (exact replacements with expected counts).
- `tshits.mjs [--tokens] files…` (non-comment TS/TSX hits via the TS AST),
  `tsmod.mjs [--dry] files…` (the TS codemod; prints what it left).
- `vt.sh` (vitest → totals + failures only; writes JSON to
  `/tmp/rename-scratch`, create that dir first).
Run the `.mjs` scripts from the repo root (they use `process.cwd()` and the
repo's `typescript`).
