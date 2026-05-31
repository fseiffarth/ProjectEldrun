interface Props {
  open: boolean;
}

// Phase 4 will replace this with the full file tree implementation.
export function RightPanel({ open }: Props) {
  return (
    <div className={`right-panel ${open ? "open" : ""}`}>
      <div className="right-panel-header">Files</div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
          File tree — Phase 4
        </span>
      </div>
    </div>
  );
}
