import { useT } from "../../lib/i18n";

interface Props {
  type: "lan" | "wlan";
  online: boolean;
}

export function ConnTypeIcon({ type, online }: Props) {
  const t = useT();
  const label = `${type === "wlan" ? "WiFi" : "Ethernet"}${online ? "" : t("connTypeIcon.offlineSuffix")}`;
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
      {/* RJ45 clip (the retention tab on top of the plug) */}
      <rect x="6.5" y="3.2" width="3" height="2.4" rx="0.5" fill="currentColor"/>
      {/* plug housing */}
      <rect x="3.5" y="5.2" width="9" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
      {/* contact pins, straight and parallel like a real RJ45 connector */}
      <line x1="4.7" y1="11.2" x2="4.7" y2="12.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <line x1="6.1" y1="11.2" x2="6.1" y2="12.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <line x1="7.5" y1="11.2" x2="7.5" y2="12.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <line x1="8.9" y1="11.2" x2="8.9" y2="12.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <line x1="10.3" y1="11.2" x2="10.3" y2="12.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      <line x1="11.3" y1="11.2" x2="11.3" y2="12.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      {slash}
    </svg>
  );
}
