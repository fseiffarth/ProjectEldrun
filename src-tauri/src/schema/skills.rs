//! Types for the Skills Library (`docs/skills_plan.md`): a browsable catalog of
//! git-hosted Claude Code skills (plain `<name>/SKILL.md` folders) a project can
//! copy into its own `.claude/skills/`. See `services::skills` for the logic;
//! these are just the wire shapes.

use serde::{Deserialize, Serialize};

/// A git repository the catalog is built from (e.g. `anthropics/skills`).
/// Persisted verbatim in `skills_sources.json` — no per-skill version/commit
/// tracking, see the plan for why.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSource {
    pub id: String,
    pub label: String,
    pub url: String,
}

/// One `SKILL.md` found while walking a source's cached clone. Nothing here is
/// persisted — the catalog is re-derived from disk on each open/refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCatalogEntry {
    pub name: String,
    pub description: String,
    pub source_id: String,
    /// Path to the skill's own folder, relative to the source's cache root.
    pub rel_path: String,
    /// True when the folder holds a `scripts/` directory — surfaced in the
    /// preview panel so an install is never a silent "and it can also execute
    /// things" surprise.
    pub has_scripts: bool,
}

/// A skill already present in `<project>/.claude/skills/<name>/`, whether it got
/// there via install or was hand-authored. `list_installed` is the only source
/// of truth — there is no separate Eldrun-tracked "is this installed" flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledSkill {
    pub name: String,
    pub description: String,
}

/// The preview panel's full read of one catalog entry: `SKILL.md`'s body
/// (frontmatter stripped — name/description are already broken out) rendered
/// through the ordinary sanitized markdown viewer, plus the bundled file list so
/// an install is never a surprise about what else comes along.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDetail {
    pub name: String,
    pub description: String,
    pub body: String,
    /// Every other file in the skill's folder, relative to it (SKILL.md itself
    /// excluded — its content is already `body`).
    pub files: Vec<String>,
    pub has_scripts: bool,
}
