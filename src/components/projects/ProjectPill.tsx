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
      <span className="pill-folder-icon" aria-hidden>📁</span>
      <span className="project-pill-label">{project.name}</span>
    </button>
  );
}
