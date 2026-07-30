## Group W — Agent Skills (MVP)
*New feature, scaled to MVP size. Browse/preview/one-click-install `SKILL.md`
bundles from a git source into a project's `.claude/skills/`. Claude-only;
no manifest/versioning, no drag-and-drop, no cross-agent generalization —
those were explored and intentionally deferred. Full reasoning + deferred
scope: [`docs/skills_plan.md`](../docs/skills_plan.md).*

*Files: new `src/components/skills/SkillsLibraryTab.tsx` +
`SkillsLibraryView.tsx`, `src/components/tabs/newTabItems.ts`, new
`src/lib/skills.ts`; backend new `src-tauri/src/services/skills.rs` +
`src-tauri/src/commands/skills.rs`, `src-tauri/src/lib.rs`
(`generate_handler!`).*

153. **Backend: skill source fetch + catalog.** New `services/skills.rs`:
    a small flat `skills_sources.json` (`{id, label, url}[]`, seeded with
    `anthropics/skills`) under the existing `state_dir()`; `refresh_source`
    shallow-clones/pulls into `skills_cache/<id>/` reusing
    `commands/git.rs`'s `validate_clone_url` + `git_clone_blocking`;
    `list_catalog` recursively walks the clone for `**/SKILL.md` and parses
    the YAML frontmatter (`name` + `description`). No manifest of installed
    skills, no per-skill version/commit tracking.
    - **Shipped** (`src-tauri/src/services/skills.rs:113,216`, registered
      `lib.rs:1079-1087`).
    - [x] 🤖 Automated test — `services/skills.rs:359,368,377,419`
      (`parse_skill_md_*`, `list_catalog_walks_nested_skill_folders`).
    - [ ] 🖐️ Manual test

154. **Skills Library tab.** ✅ Implemented · 🧪 Awaiting live QA.
    New `SkillsLibraryTab.tsx` / `SkillsLibraryView.tsx`
    following `ProjectFilesTab.tsx`'s thin-host pattern, registered in
    `TabPane.tsx:127` / `NewTabMenu.tsx:351-369` / `stores/tabs.ts:269,3975`
    (**not** in `newTabItems.ts`'s `SHELL_ITEMS` — it got its own menu group),
    scoped to a project. Sources bar
    (add URL / refresh), catalog list with client-side name/description
    filter and an installed-status badge (computed by checking whether
    `<project>/.claude/skills/<name>/` exists — no tracked state), preview
    panel rendering `SKILL.md` through the existing sanitized markdown
    viewer with bundled-file/script listing. Install is reachable **only**
    from the preview panel.
    - [ ] 🤖 Automated test — installed-status badge reflects disk state,
      not a cached flag. **Genuinely absent**: there is no skills test file
      under `src/__tests__/`, unlike #153/#155 which do have Rust coverage.
    - [ ] 🖐️ Manual test

155. **Install / uninstall commands.** `install_skill(project_id, source_id,
    skill_path)` copies the folder verbatim into
    `<project>/.claude/skills/<name>/` (confirm-overwrite dialog if already
    present — no drift detection, plain overwrite); `uninstall_skill`
    deletes it; `list_installed` reads `.claude/skills/*` directly off disk.
    No `Project.enabled_skills` field, no manifest — the project tree is the
    only source of truth. Containerized projects need no extra code
    (identical-path mount already carries it); a project with no local
    mirror (pure-remote) gets the tab hidden/disabled rather than a silent
    wrong-filesystem write.
    - **Shipped** (`services/skills.rs:298,317,329`, registered
      `lib.rs:1085-1087`) — except the pure-remote case: the tab is only hidden
      at `scope === "root"` (`NewTabMenu.tsx:351`), so a remote project with no
      local mirror is **not** reported as unsupported. That half is still open.
    - [x] 🤖 Automated test — `services/skills.rs:385`
      (`install_then_list_then_uninstall_roundtrip`). The unsupported-remote
      assertion is not covered, matching the gap above.
    - [ ] 🖐️ Manual test
