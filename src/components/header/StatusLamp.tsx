interface Props {
  online: boolean;
  workspaceLabel?: string;
}

export function StatusLamp({ online, workspaceLabel }: Props) {
  return (
    <div className="no-drag" style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className={`status-lamp ${online ? "status-online" : "status-offline"}`}>
        {online ? "online" : "offline"}
      </span>
      {workspaceLabel && (
        <span className="status-lamp status-ws-lamp">{workspaceLabel}</span>
      )}
    </div>
  );
}
