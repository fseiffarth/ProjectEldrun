import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";

/**
 * One log line plus a stable, monotonically-increasing id minted at the push
 * site. The id (never the array index) is the React key, so when the caller caps
 * the list with `.slice(-500)` only the trimmed head's nodes drop — the surviving
 * lines keep their ids and React reuses their nodes instead of re-creating all.
 */
export type LogLine = { id: number; text: string };

/**
 * Read-only live log of a headless OpenVPN handshake. Eldrun feeds the password
 * itself (no typing), so this is purely a progress view: it renders the lines
 * the backend forwards (`openvpn-progress`) and auto-scrolls to the newest so a
 * connect reads as live work rather than an opaque spinner. Shared by the
 * project dialog and the activation-time VPN password prompt.
 */
export function ConnectionLog({ lines, busy }: { lines: LogLine[]; busy: boolean }) {
  const t = useT();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  return (
    <div className="connection-log" role="log" aria-label={t("connLog.ariaLabel")}>
      {lines.length === 0 && busy ? (
        <div className="connection-log-line connection-log-waiting">{t("connLog.startingVpn")}</div>
      ) : (
        lines.map((line) => (
          <div key={line.id} className="connection-log-line">
            {line.text}
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
