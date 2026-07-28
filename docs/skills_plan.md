# Agent Skills — MVP Plan

Status: **implemented** (2026-07-28), on `develop`, untested live. Backend:
`schema::skills`/`services::skills`/`commands::skills`. Frontend: `lib/skills.ts`,
`components/skills/{SkillsLibraryTab,SkillsLibraryView}.tsx`, wired as the
`skillslibrary` tab kind (`SKILLSLIBRARY_TAB_CMD`, project-scoped, singleton per
scope via `ensureTab`, hidden at the root scope). Scaled down from a broader four-part
investigation (discovery/library UX, integration mechanics, backend storage,
cross-agent generalization) after weighing effort vs. value: the underlying
action — getting a skill folder into `.claude/skills/` — is already nearly
free without any Eldrun code (a user can `git clone`/drag a folder in via the
existing file browser), so this MVP only builds the part that's genuinely
missing: **a good place to browse, preview, and one-click-copy skills into a
project.** Everything speculative or Claude-only-adjacent is deferred (see
bottom).

## Reality check — what "skills" actually are

No hosted skills registry exists anywhere. Every real source is a git repo:
Anthropic's own [anthropics/skills](https://github.com/anthropics/skills)
(itself structured as a Claude Code plugin marketplace, but its skill
folders are plain `<name>/SKILL.md` + optional reference files/`scripts/` on
disk either way), plus a handful of community collections. "Download" means
clone/pull a repo the user points at and copy a skill folder out of it —
never a package-manager API.

Only Claude Code has a native skill-discovery convention (walk
`.claude/skills/`, lazy-load by relevance). **MVP is Claude-only** — no
attempt to generalize to Codex/Gemini/other hosted agents (see deferred
section).

## MVP scope

### 1. Backend: fetch + catalog (no manifest, no versioning)

New `services/skills.rs`:

- `add_source(url)` / `list_sources()` — a small flat JSON list under
  `~/.local/share/eldrun/skills_sources.json` (just `{id, label, url}[]`,
  seeded by default with `anthropics/skills`). No per-skill version/commit
  tracking, no install-state manifest — see below for why.
- `refresh_source(id)` — shallow `git clone --depth 1` (first time) /
  `git pull` (subsequent) into `~/.local/share/eldrun/skills_cache/<id>/`,
  reusing the existing hardened clone plumbing
  (`commands/git.rs`'s `validate_clone_url` + `git_clone_blocking`) rather
  than adding an HTTP client.
- `list_catalog(source_id)` — recursively walk the cached clone for
  `**/SKILL.md` (works unchanged whether the repo is a "marketplace" or a
  flat collection — the marketplace manifest doesn't need parsing, since
  the skill folders exist as plain files on disk either way), parse the YAML
  frontmatter (`name` + `description` only), return the list. Nothing
  persisted — re-derived from disk on each open/refresh.

### 2. Frontend: Skills Library tab (browse → preview → install)

New `SkillsLibraryTab.tsx` / `SkillsLibraryView.tsx`, following
`ProjectFilesTab.tsx`'s thin-host pattern, added to `newTabItems.ts`'s
`SHELL_ITEMS`, scoped to a project:

- **Sources bar** — add a git URL, refresh (pull) a source. No search API,
  just a client-side filter over the parsed catalog.
- **Catalog list** — name + description + source, install-status badge
  (installed for this project / not) computed by checking whether
  `<project>/.claude/skills/<name>/` already exists — no separate tracked
  state.
- **Preview panel** — opens on click, renders `SKILL.md`'s body through the
  existing sanitized markdown viewer, lists bundled files, flags bundled
  scripts explicitly. **The only place the install action lives** — never a
  one-click action off the list row. This is the one piece of the original
  security posture worth keeping even at MVP size: showing the content
  before copying it into agent-trusted territory costs nothing extra to
  build (it's just where the button lives).

### 3. Install / uninstall (copy, not tracked)

- `install_skill(project_id, source_id, skill_path)` — copies the skill
  folder verbatim into `<project>/.claude/skills/<name>/`. Re-installing
  (e.g. after a source refresh) just overwrites — no commit-pin, no
  drift/update detection. A user who hand-edits an installed skill and then
  re-installs loses their edits; acceptable at this scope, worth a plain
  confirm-overwrite dialog rather than silent overwrite.
- `uninstall_skill(project_id, name)` — deletes the folder.
- `list_installed(project_id)` — reads `.claude/skills/*` directly off disk,
  so a hand-authored or agent-authored skill shows up too.
- **No manifest, no `Project.enabled_skills` field, no `enabled_in` map.**
  The project tree itself is the only source of truth for "is this skill
  here" — matches how the rest of `.claude/` scaffolding already works
  (`CLAUDE.md`, `AGENTS.md` etc. have no separate Eldrun-tracked "is this
  present" flag either).

### 4. Propagation — free, no extra code

Because install only writes an ordinary file into the project tree, a
containerized project sees it immediately (identical-path bind mount, no
new mount rule) and a git-tracked `.claude/skills/` syncs to a remote/
multi-host project through the existing transports with zero skills-specific
code. **Explicitly out of scope for MVP**: making install work for a project
whose files live *only* remotely (no local mirror) — hide/disable the
Skills tab for such a project rather than silently writing to the wrong
filesystem; this is a small, well-understood gap to close later, not a
blocker for the MVP itself.

## Deferred (explored, intentionally not built now)

The following were designed in the earlier, broader investigation and are
worth revisiting only if the MVP proves people actually use it:

- **Manifest/versioning** — per-skill commit pinning, content-hash-gated
  review timestamps, update-available detection.
- **Cross-agent delivery** — injecting skill content into `AGENTS.md`/
  `GEMINI.md` for Codex/Gemini/other hosted agents that have no native
  skill convention. Speculative value (untested whether those CLIs benefit
  from always-in-context injected instructions the way Claude benefits from
  lazy-loaded real skills) and real cost (token budget, no bundled-script
  execution) — don't build until there's a concrete ask.
- **Drag-and-drop** onto a tab/project pill as an install accelerator.
- **Project-pill checklist** for toggling multiple skills at once — at MVP
  size, the Skills tab's own install/uninstall buttons are the whole UI.
- **Advisory auto-suggest** based on project file types.
- **Remote-project install** (writing to a project with no local mirror).

If any of these get picked back up, the fuller reasoning (including the
copy-vs-symlink security argument, the per-agent delivery-mode split, and
the multi-host fan-out analysis) is preserved in this file's git history.
