/**
 * The Skills Library's wire types — the exact shapes `commands::skills`
 * serializes. See `docs/skills_plan.md` for the feature's scope and
 * `lib/skills.ts` for the invoke wrappers built on them.
 */

/** A git repository the catalog is built from. Persisted verbatim server-side —
 *  no per-skill version/commit tracking. */
export interface SkillSource {
  id: string;
  label: string;
  url: string;
}

/** One `SKILL.md` found while walking a source's cached clone. Re-derived from
 *  disk on every open/refresh — nothing here is persisted. */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  source_id: string;
  /** The skill's own folder, relative to the source's cache root. Opaque to
   *  the frontend — passed back verbatim to `skills_get_detail`/`skills_install`. */
  rel_path: string;
  has_scripts: boolean;
}

/** A skill already present in a project's `.claude/skills/<name>/`, whether it
 *  got there via install or was hand-authored. */
export interface InstalledSkill {
  name: string;
  description: string;
}

/** The preview panel's full read of one catalog entry. */
export interface SkillDetail {
  name: string;
  description: string;
  /** `SKILL.md`'s body with the frontmatter already stripped, rendered through
   *  the ordinary sanitized markdown viewer. */
  body: string;
  /** Every other file in the skill's folder, relative to it. */
  files: string[];
  has_scripts: boolean;
}
