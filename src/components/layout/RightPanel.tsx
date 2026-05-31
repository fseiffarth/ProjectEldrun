import { FileTree } from "../files/FileTree";
import { useProjectsStore } from "../../stores/projects";

interface Props {
  open: boolean;
}

export function RightPanel({ open }: Props) {
  const { projects, activeId } = useProjectsStore();
  const activeProject = projects.find((p) => p.id === activeId);
  const projectDir = (activeProject?.directory as string | undefined) ?? "";

  return (
    <div className={`right-panel ${open ? "open" : ""}`}>
      <div className="right-panel-header">
        {activeProject ? activeProject.name : "Files"}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {open && <FileTree projectDir={projectDir} />}
      </div>
    </div>
  );
}
