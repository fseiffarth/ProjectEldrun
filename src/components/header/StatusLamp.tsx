interface Props {
  online: boolean;
}

export function StatusLamp({ online }: Props) {
  return (
    <span
      className={`status-lamp ${online ? "status-online" : "status-offline"}`}
      title={online ? "Online" : "Offline"}
    >
      ●
    </span>
  );
}
