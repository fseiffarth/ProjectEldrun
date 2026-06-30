import type { ConnState } from "../../stores/remoteStatus";

/**
 * A small red/orange/green status lamp for a remote connection channel.
 *  - off        → dim grey
 *  - connecting → orange, pulsing
 *  - connected  → green
 *  - error      → red
 * Used both in the project dialog (next to the SSH / OpenVPN controls) and in
 * the header (the active remote project's live SSH / VPN state).
 */
export function ConnLamp({ status, label }: { status: ConnState; label: string }) {
  return (
    <span
      className={`conn-lamp conn-lamp-${status}`}
      role="img"
      aria-label={`${label}: ${status}`}
      title={`${label}: ${status}`}
    />
  );
}
