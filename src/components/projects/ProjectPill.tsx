import type { ProjectEntry } from "../../types";

interface Props {
  project: ProjectEntry;
  active: boolean;
  onClick: () => void;
}

export function ProjectPill({ project, active, onClick }: Props) {
  return (
    <button
      className={`project-pill ${active ? "active" : ""}`}
      onClick={onClick}
      title={project.directory as string | undefined}
    >
      {project.name}
    </button>
  );
}
