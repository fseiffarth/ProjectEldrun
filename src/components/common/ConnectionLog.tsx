import { useEffect, useRef } from "react";

/**
 * Read-only live log of a headless OpenVPN handshake. Eldrun feeds the password
 * itself (no typing), so this is purely a progress view: it renders the lines
 * the backend forwards (`openvpn-progress`) and auto-scrolls to the newest so a
 * connect reads as live work rather than an opaque spinner. Shared by the
 * project dialog and the activation-time VPN password prompt.
 */
export function ConnectionLog({ lines, busy }: { lines: string[]; busy: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  return (
    <div className="connection-log" role="log" aria-label="OpenVPN connection log">
      {lines.length === 0 && busy ? (
        <div className="connection-log-line connection-log-waiting">Starting OpenVPN…</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="connection-log-line">
            {line}
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
