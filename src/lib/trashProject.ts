import type { ProjectEntry } from "../types";

/** Stable id of Eldrun's built-in, strictly isolated agent workspace. */
export const TRASH_PROJECT_ID = "eldrun-trash";

export function isTrashProject(project: Pick<ProjectEntry, "id"> | null | undefined): boolean {
  return project?.id === TRASH_PROJECT_ID;
}
