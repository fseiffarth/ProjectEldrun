import type { ConnState } from "../../stores/remoteStatus";

/**
 * A small red/orange/green status lamp for a remote connection channel.
 *  - off        → dim grey
 *  - connecting → orange, pulsing
 *  - connected  → green
 *  - error      → red
 * Used both in the project dialog (next to the SSH / OpenVPN controls) and in
 * the header (the active remote project's live SSH / VPN state).
 *
 * `busy` is a second, **orthogonal** axis, not a fifth state: a connected host
 * with live work on it (≥1 tmux session — see `stores/hostBusy`) pulses its
 * green rather than sitting steady. It exists because with a fleet held open all
 * day "connected" is the resting state and stops distinguishing anything; the
 * pulse restores the at-a-glance answer to "where am I actually running
 * something?". It is only honoured for `connected` — a pulsing red or orange
 * would read as a state of the *connection*, which is what the colour already
 * says, and `connecting` has its own (orange) pulse to stay distinct from it.
 */
export function ConnLamp({
  status,
  label,
  busy,
}: {
  status: ConnState;
  label: string;
  busy?: boolean;
}) {
  const isBusy = busy && status === "connected";
  const title = isBusy ? `${label}: connected, working` : `${label}: ${status}`;
  return (
    <span
      className={`conn-lamp conn-lamp-${status}${isBusy ? " conn-lamp-busy" : ""}`}
      role="img"
      aria-label={title}
      title={title}
    />
  );
}
