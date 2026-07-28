/**
 * **The** typed invoke surface for the Skills Library (`docs/skills_plan.md`) —
 * one wrapper per `skills_*` command, the convention `lib/mail.ts`/
 * `lib/printing.ts` established: no component calls `invoke("skills_*")`
 * directly.
 *
 * There is deliberately no manifest and no install-state tracking on this
 * side either — `installedSkills` is a plain read of what is actually on disk
 * under a project's `.claude/skills/`, so a hand-authored skill shows up the
 * same as one this UI installed.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledSkill,
  SkillCatalogEntry,
  SkillDetail,
  SkillSource,
} from "../types/skills";

export function listSkillSources(): Promise<SkillSource[]> {
  return invoke<SkillSource[]>("skills_list_sources");
}

export function addSkillSource(label: string, url: string): Promise<SkillSource> {
  return invoke<SkillSource>("skills_add_source", { label, url });
}

export function removeSkillSource(id: string): Promise<void> {
  return invoke<void>("skills_remove_source", { id });
}

/** Shallow-clone (first time) or pull (subsequent) a source's repo into its
 *  cache. Can take a while on a slow link — callers show a spinner. */
export function refreshSkillSource(id: string): Promise<void> {
  return invoke<void>("skills_refresh_source", { id });
}

/** A source's catalog, walked fresh off its cached clone every call. */
export function listSkillCatalog(sourceId: string): Promise<SkillCatalogEntry[]> {
  return invoke<SkillCatalogEntry[]>("skills_list_catalog", { sourceId });
}

/** The preview panel's full read of one catalog entry (body + bundled files). */
export function getSkillDetail(sourceId: string, relPath: string): Promise<SkillDetail> {
  return invoke<SkillDetail>("skills_get_detail", { sourceId, relPath });
}

/** Copy the skill folder into `<projectDir>/.claude/skills/<name>/`, overwriting
 *  an existing install of the same name. Callers confirm the overwrite first. */
export function installSkill(
  projectDir: string,
  sourceId: string,
  relPath: string,
): Promise<void> {
  return invoke<void>("skills_install", { projectDir, sourceId, relPath });
}

export function uninstallSkill(projectDir: string, name: string): Promise<void> {
  return invoke<void>("skills_uninstall", { projectDir, name });
}

/** Every skill folder actually on disk under the project's `.claude/skills/`. */
export function listInstalledSkills(projectDir: string): Promise<InstalledSkill[]> {
  return invoke<InstalledSkill[]>("skills_list_installed", { projectDir });
}
