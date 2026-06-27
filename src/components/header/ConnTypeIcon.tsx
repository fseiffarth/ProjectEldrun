interface Props {
  type: "lan" | "wlan";
  online: boolean;
}

export function ConnTypeIcon({ type, online }: Props) {
  const label = `${type === "wlan" ? "WiFi" : "Ethernet"}${online ? "" : " (offline)"}`;
  // When offline, draw a diagonal slash over the connection symbol.
  const slash = !online && (
    <>
      <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round" />
      <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  );

  if (type === "wlan") {
    return (
      <svg
        className={`conn-type-icon${online ? "" : " conn-offline"}`}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label={label}
      >
        <title>{label}</title>
        {/* outer arc */}
        <path d="M1.5 6.5 C3.5 4 6.5 2.5 8 2.5 C9.5 2.5 12.5 4 14.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
        {/* middle arc */}
        <path d="M3.5 8.5 C5 7 6.5 6 8 6 C9.5 6 11 7 12.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
        {/* inner arc */}
        <path d="M5.5 10.5 C6.5 9.5 7.2 9 8 9 C8.8 9 9.5 9.5 10.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
        {/* dot */}
        <circle cx="8" cy="13" r="1" fill="currentColor"/>
        {slash}
      </svg>
    );
  }

  return (
    <svg
      className={`conn-type-icon${online ? "" : " conn-offline"}`}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={label}
    >
      <title>{label}</title>
      {/* plug body */}
      <rect x="5" y="2" width="6" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
      {/* pins */}
      <line x1="6.5" y1="2" x2="6.5" y2="0.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <line x1="9.5" y1="2" x2="9.5" y2="0.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      {/* stem */}
      <line x1="8" y1="7" x2="8" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      {/* base bar */}
      <line x1="4" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      {/* legs */}
      <line x1="5.5" y1="10" x2="5.5" y2="13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <line x1="8" y1="10" x2="8" y2="13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <line x1="10.5" y1="10" x2="10.5" y2="13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      {slash}
    </svg>
  );
}
