## Group Y — Verification, Release Gates & Code Health

*Created 2026-07-28 from a full-repo evaluation + a 148-item backlog
reconciliation. These are gaps in the **machinery that checks the work**, not in
the product. They had no TODO entry of any kind, which is itself the finding:
nothing was tracking them because nothing was failing loudly.*

*Files: `.github/workflows/ci-cd.yml`, `.githooks/pre-push`, `package.json`,
`scripts/privacy-check.sh`.*

**Why this group outranks feature work.** The repo has ~4100 automated tests
(1630 `cargo test`, 2476 vitest) and **227 manual-QA items, each now a
Works/Doesn't-work pair, of which exactly two have ever been confirmed
Works**. Verification cost is roughly constant per feature; *deferred*
verification cost is superlinear, because a defect found later must be bisected
across dozens of unvalidated layers instead of one. That inversion — not any
missing capability — is the project's dominant risk.

161. ~~**The 2476-test frontend suite never runs in CI.**~~ **DONE 2026-07-28.**
     A `Run frontend tests: npm test` step now sits beside the `cargo test` step
     in all three test jobs (`test`, `test-windows`, `test-macos`). Baseline at
     the time of wiring: 215 files / 2476 tests green in ~52 s.
     - [x] 🤖 Automated test — a deliberately failing component test makes
       `vitest run` exit 1, which is what the new CI step keys off (verified
       locally with a throwaway spec; the step itself is one `npm test` call).
     - [ ] 🖐️ Manual test — push a branch with a failing vitest and watch CI red.
       *Still open: nothing has watched this go red on GitHub yet.*
       - [ ] ✅ Works
       - [ ] ❌ Doesn't work

162. ~~**`privacy-check.sh` is mandated but wired to nothing.**~~ **DONE
     2026-07-28.** Wired in both places, because neither alone is enough — the
     hook needs `git config core.hooksPath .githooks` per clone, and CI cannot
     stop a push.
     - `scripts/privacy-check.sh` now takes optional `git diff` arguments, so
       `<base> <head>` scans a commit range while the documented bare call still
       scans the index. `PRIVACY_CHECK_SKIP_IDENTITY=1` drops the `$USER`/`$HOME`
       patterns, which on a CI runner match the *runner's* identity and nothing
       the developer owns.
     - `.githooks/pre-push` scans each pushed ref **before** the version bump, so
       a hit aborts without leaving a stray bump commit. The base is the remote
       tip, or — for a brand-new remote branch — the parent of the oldest commit
       no remote branch has yet, falling back to the empty tree at a root commit.
       `ELDRUN_SKIP_PRIVACY_CHECK=1` is the documented one-time override.
     - A `privacy` CI job runs the same scan over `merge-base(base, head)..head`
       and now **gates all three package jobs**: a leak must never become a
       downloadable artifact, let alone a release asset.
     - [x] 🤖 Automated test — verified end to end in a throwaway repo wired with
       the real hook and script: a clean commit pushes, and a commit adding a
       fake GitHub personal-access token prints the match and aborts the push
       with rc=1. (The literal is kept out of this file on purpose — writing it
       here would trip the very scan it documents.)
     - [ ] 🖐️ Manual test
       - [ ] ✅ Works
       - [ ] ❌ Doesn't work

163. **No mechanical quality gate at all.** **MOSTLY DONE 2026-07-28** — the two
     halves that catch defects are in; `cargo fmt --check` is not, and that is
     the remainder of this item.
     - A `lint` CI job now runs `npm run lint` and
       `cargo clippy --all-targets -- -D warnings`. Linux-only: neither verdict
       is platform-dependent, so running it three times buys nothing.
     - `eslint.config.js` is deliberately narrow — hooks rules, a handful of
       defect-shaped rules, unused-vars — and **green on the day it landed**
       (0 errors, 30 advisory warnings: 27 `exhaustive-deps`, 3 `no-explicit-any`).
       A gate that lands with 400 pre-existing violations gets `--no-verify`'d
       into irrelevance within a week. Three rules are off with the reason
       recorded in the config (`no-control-regex` — terminal/markdown match
       control characters on purpose; `no-unmodified-loop-condition` — cannot see
       `date.setDate()` mutation, 2 false positives and 0 true ones;
       `no-this-alias` limited to `self`). Type-aware linting is off because
       `npm run build` already runs `tsc`.
     - Getting clippy to zero took ~83 fixes: `--fix` for the mechanical ones,
       then `sort_by_key`, `slice::from_ref`, `contains_key`,
       `field_reassign_with_default`, doc-paragraph breaks, and `//!` file docs
       in four test files. Four sites got a *local* `#[allow]` with a stated
       reason (`assertions_on_constants` ×2 — the constant value is the property
       under test; `large_enum_variant`; `unusual_byte_groupings` ×2 — hex seeds
       spelled as words). Exactly one crate-wide allow, in `lib.rs`:
       `too_many_arguments`, because a `#[tauri::command]` spends its first
       parameters on `AppHandle` + `State<'_, …>` injection before one of its own.
     - Ten dead `eslint-disable-next-line` comments were removed — written in
       anticipation of a linter that never ran, and unnecessary once one did.
     - **Remaining: `cargo fmt --check`.** The backend has never been rustfmt'd
       and differs at **1069 sites (~14k lines)**. Raising `max_width` does not
       help — 110 gives 1062 hunks and 120 gives *1291*, because rustfmt starts
       re-joining lines that were hand-wrapped deliberately. So there is no cheap
       version: enforcing it needs a one-off whole-backend formatting commit,
       which is a large churn for the one gate here that catches no defects.
       Deferred as a deliberate call, not an oversight.
     - [x] 🤖 Automated test — the gate is the test: `npm run lint` and
       `cargo clippy -- -D warnings` both exit 0 on the current tree, and both
       suites (2476 vitest / 1630 cargo) stay green across every fix above.
     - [ ] 🖐️ Manual test
       - [ ] ✅ Works
       - [ ] ❌ Doesn't work

164. **First live-QA session — unblock the 145 manual boxes.** `TODO.md`'s
     verification section used to say *"do not launch Eldrun from the agent"*,
     contradicting `CLAUDE.md`'s explicit 2026-07-28 permission; that line was
     removed on 2026-07-28 and this item replaces it. Pick the three
     most-shipped subsystems and QA them by hand **before starting a fourth
     product**. Roughly twenty subsystems are simultaneously code-complete and
     never-run — 109 `<UntestedTag>` instances across 54 components.
     - Highest-value targets, in order: (a) **J#66 mail crypto** — an XChaCha20
       store and an OpenPGP path that have never met a real server; both failure
       modes are *silent* (an unopenable mailbox and a mis-verified signature
       both look fine). (b) **J#61 gating check** — one test, `invoke('list_projects')`
       must reject from a live page's devtools; its result decides ship-vs-delete
       for the whole browser track and #61a/#61b hang off it. (c) **V#90 deck
       presenter** — code-complete, never run, and #93/#94 both lose authored
       work with no prompt.
     - [ ] 🖐️ Manual test — this item *is* the manual test.
       - [ ] ✅ Works
       - [ ] ❌ Doesn't work
     - *Status 2026-07-28: not started, and not startable unattended.* (a) mail
       crypto needs a real IMAP/SMTP account and a correspondent's OpenPGP key —
       neither exists in this environment; (b) the `invoke('list_projects')`
       gating check must be typed into a **live page's** devtools, which is the
       one surface an agent driving the app cannot reach; (c) the deck presenter
       needs a second monitor to mean anything. Needs a human at the keyboard.

165. **Security items promoted by the 2026-07-28 audit.** Not new work — these
     already live in Group O, but the audit ranked them above the feature
     backlog and nothing recorded that. Cross-reference only — **all four have
     since moved**, so this entry now points at Group O rather than restating
     stale detail:
     - **O#149** — **DONE 2026-07-29.** `pty_spawn` now validates `cwd` against
       the owning project's directory/mirror. See Group O for the shape.
     - **O#143** — **DONE 2026-07-28** (shipped the same day as this audit,
       just after it was written). Adoption now requires an explicit confirm;
       detection is pure. See Group O.
     - **O#59** — **PARTIALLY DONE 2026-07-28.** A real per-project override
       shipped (force `claude --remote-control` on/off per project); the
       global default deliberately stays ON — flipping it was judged a bigger,
       separate UX call nobody had asked for. See Group O for the reasoning.
     - **O#151 residual** — **MITIGATED 2026-07-28, not fully closed.** The
       `filter.<driver>.clean` residual named here is closed (a config
       denylist matching by key *shape*, so an attacker's driver name doesn't
       matter); `.git/hooks/*` and `credential.helper`/`core.sshCommand` on
       **user-initiated** git actions remain open by deliberate choice — see
       Group O for which and why.

166. **Three god-files concentrate most of the maintenance risk.** Not urgent,
     but untracked until now, and each is a file that *every* feature in its
     area must touch:
     - `src/components/embed/FileViewerPane.tsx` — **6689 lines, 25 React
       components in one file** (`FileViewerPane` `:313`, `CodeEditor` `:1783`,
       `TextView` `:4992`, `MarkdownView` `:5479`, `TexView` `:5827`, plus the
       SLURM bar, AI controls, blame, print and compare surfaces). Should be a
       directory. This is the single least reviewable file in the repo.
     - `src/stores/tabs.ts` — 4383 lines exposing **124 actions** on one store,
       reached into by every pane; the frontend's true god-module.
     - `src-tauri/src/commands/projects.rs` — 3938 lines, 46 Tauri commands. Its
       own file map already calls it *"god module; #1"*.
     - Context for scale: **442 `#[tauri::command]` definitions** repo-wide
       (typical Tauri apps ship 20–80), all reachable from the `main` webview.
       `capabilities/default.json` scopes correctly *by webview label*, so the
       CSP plus that scoping is the real perimeter — see O#144.
     - Splitting these is mechanical but wide; do it behind the green vitest
       suite from #161, never before.
     - *Status 2026-07-28: **unblocked**, not started.* #161 landed, so the
       precondition this item names is now satisfied — the vitest suite runs in
       CI and would catch a bad split. Left for a dedicated pass: ~15k lines
       across three files, and it wants to be the only thing in its commit.
     - [ ] 🤖 Automated test — existing suites must stay green across the split
       (`FileViewerPane` is imported by 19 test files, `tabs.ts` by 61).
     - [ ] 🖐️ Manual test
       - [ ] ✅ Works
       - [ ] ❌ Doesn't work

---
