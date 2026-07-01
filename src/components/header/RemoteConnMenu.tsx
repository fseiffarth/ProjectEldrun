import { useEffect, useRef, useState } from "react";
import { ConnLamp } from "../common/ConnLamp";
import { useRemoteStatusStore } from "../../stores/remoteStatus";
import { reconnectRemote, disconnectRemote } from "../../stores/projects";
import type { ProjectEntry } from "../../types";

/**
 * The active remote project's live SSH/VPN status lamps in the header, made
 * clickable: clicking opens a small menu to (re)connect or disconnect the
 * project's pooled SSH/SFTP connection.
 *
 * Remote projects start DISCONNECTED — they are not auto-connected on launch or
 * switch (that raced the tab restore and hung). Reconnect here brings the pool
 * up via `reconnectRemote`, which un-gates the deferred tab restore. The center
 * "Disconnected" placeholder offers the same action; this is the always-visible
 * header entry point.
 */
export function RemoteConnMenu({ project }: { project: ProjectEntry }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const status = useRemoteStatusStore((s) => s.byProject[project.id]);
  const ssh = status?.ssh ?? "off";
  const vpn = status?.vpn ?? "off";

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const connected = ssh === "connected";
  const connecting = ssh === "connecting";

  return (
    <div className="header-conn-menu" ref={ref}>
      <button
        type="button"
        className="header-conn-lamps no-drag"
        aria-label="Remote connection — click to (re)connect"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`SSH · ${project.remote?.host ?? ""} — ${ssh}`}
        onClick={() => setOpen((o) => !o)}
      >
        <ConnLamp status={ssh} label={`SSH · ${project.remote?.host ?? ""}`} />
        {project.remote?.openvpn && <ConnLamp status={vpn} label="OpenVPN" />}
      </button>
      {open && (
        <div className="header-conn-popover" role="menu">
          <div className="header-conn-popover-state">
            SSH: {ssh}
            {project.remote?.openvpn ? ` · VPN: ${vpn}` : ""}
          </div>
          <button
            type="button"
            role="menuitem"
            className="header-conn-popover-item"
            disabled={connecting}
            onClick={() => {
              setOpen(false);
              void reconnectRemote(project.id);
            }}
          >
            {connecting ? "Connecting…" : connected ? "Reconnect" : "Connect"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="header-conn-popover-item"
            disabled={ssh === "off"}
            onClick={() => {
              setOpen(false);
              disconnectRemote(project.id);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
