import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";
import { useT } from "../../lib/i18n";
import { SkillsLibraryView } from "./SkillsLibraryView";

interface Props {
  /** The tab's scope: a project id (Skills Library is hidden at "root"). */
  scope: string;
  /** Fallback cwd, used only if the scope's project can't be resolved. */
  cwd: string;
  visible?: boolean;
}

/**
 * The Skills Library tab (`docs/skills_plan.md`): a thin host, `ProjectFilesTab`'s
 * shape applied to a simpler view — it resolves the project from its own
 * `scope` (so it works identically in a popout, which has no store-resolved
 * `projectDir` to hand it) and renders `SkillsLibraryView`, which owns
 * everything else.
 */
export function SkillsLibraryTab({ scope, cwd, visible = true }: Props) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const project = projects.find((p) => p.id === scope) ?? null;
  const projectDir = project ? resolveProjectDirectory(project) : cwd;

  if (!projectDir) {
    return <div className="file-tree-empty">{t("common.noProjectSelected")}</div>;
  }

  return <SkillsLibraryView projectDir={projectDir} visible={visible} />;
}
