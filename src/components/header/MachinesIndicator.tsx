import { useEffect, useRef, useState } from "react";
import { ConnLamp } from "../common/ConnLamp";
import { Toggle } from "../common/Toggle";
import { PasswordInput } from "../common/PasswordInput";
import { UntestedTag } from "../common/UntestedTag";
import { useGlobalMachinesStore } from "../../stores/globalMachines";
import { parseSshAddress } from "../projects/scaffold";

/** MIME type carried by a dragged global-machine row (native HTML5 DnD, the
 *  same style `ProjectPill`'s `PILL_DRAG_TYPE` already uses — plain
 *  `draggable`/`dataTransfer`, not the pointer-based cross-window system,
 *  since both drop targets live in this window's DOM). The payload is a
 *  JSON-encoded `DroppedGlobalMachine`. */
export const GLOBAL_MACHINE_DRAG_TYPE = "application/x-eldrun-global-machine";

function targetLabel(m: { user?: string; host: string; port?: number }): string {
  return `${m.user ? `${m.user}@` : ""}${m.host}${m.port ? `:${m.port}` : ""}`;
}

/**
 * Global worker machines, in the header — the VPN indicator's pattern applied
 * to SSH hosts a project doesn't own. Authenticated once via the ordinary
 * login mechanism, with no project/path attached, then dragged onto an SSH
 * project's pill (or its open Remote machines window) to become a `shared_fs`
 * compute host there. Detaching a machine from a project never touches this
 * list — see `stores/globalMachines.ts` / `commands::global_machines`.
 */
export function MachinesIndicator() {
  const machines = useGlobalMachinesStore((s) => s.machines);
  const status = useGlobalMachinesStore((s) => s.status);
  const load = useGlobalMachinesStore((s) => s.load);
  const probeAll = useGlobalMachinesStore((s) => s.probeAll);
  const connect = useGlobalMachinesStore((s) => s.connect);
  const remove = useGlobalMachinesStore((s) => s.remove);
  const add = useGlobalMachinesStore((s) => s.add);

  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  // A native drag leaving the trigger's bounds fires mouseleave the instant it
  // starts — without this guard `scheduleClose` would shut the menu mid-drag,
  // before the drop ever lands on a target.
  const draggingRef = useRef(false);

  const [removeArm, setRemoveArm] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [retryPassword, setRetryPassword] = useState("");

  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    setRemoveArm(null);
    void probeAll();
  }, [open, probeAll]);

  useEffect(() => {
    const onDragEnd = () => {
      draggingRef.current = false;
    };
    window.addEventListener("dragend", onDragEnd);
    return () => window.removeEventListener("dragend", onDragEnd);
  }, []);

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    if (draggingRef.current) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };

  const live = machines.filter((m) => (status[m.id] ?? "off") === "connected");
  const lamp: "off" | "connecting" | "connected" = machines.some(
    (m) => status[m.id] === "connecting",
  )
    ? "connecting"
    : live.length > 0
      ? "connected"
      : "off";

  const startRetry = (id: string) => {
    setRetryId(id);
    setRetryPassword("");
  };
  const submitRetry = async (id: string) => {
    await connect(id, retryPassword || undefined);
    setRetryId(null);
    setRetryPassword("");
  };

  const submitAdd = async () => {
    const parsed = parseSshAddress(address);
    if (!parsed) {
      setAddError("Enter a host as [user@]host[:port]");
      return;
    }
    setAddBusy(true);
    setAddError("");
    try {
      await add({
        user: parsed.user ?? (username.trim() || undefined),
        host: parsed.host,
        port: parsed.port ?? undefined,
        label: label.trim() || undefined,
        password: password || undefined,
        remember: savePassword,
      });
      setAddress("");
      setUsername("");
      setPassword("");
      setLabel("");
      setSavePassword(false);
      setAdding(false);
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddBusy(false);
    }
  };

  return (
    <div className="global-apps-menu no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn machines-indicator-btn"
        aria-label="Global machines — connect or drag onto a project"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Global worker machines — connect once, then drag onto any SSH project to add it there."
        onClick={reveal}
        onFocus={reveal}
      >
        <ConnLamp status={lamp} label="Machines" />
        <span className="vpn-indicator-label">Machines</span>
      </button>
      {open && (
        <div className="tab-new-menu vpn-indicator-menu machines-indicator-menu" role="menu">
          <div className="tab-new-menu-group-label">Global machines</div>
          <div className="vpn-indicator-note">
            Connected once here, then <strong>drag a machine onto a project</strong> (its
            pill, or its open Remote machines window) to add it there as a shared-folder
            worker. Removing a machine from a project never disconnects it here.
          </div>

          {machines.length === 0 && (
            <div className="vpn-indicator-row">
              <div className="vpn-indicator-empty">No global machines yet.</div>
            </div>
          )}
          {machines.map((m) => {
            const st = status[m.id] ?? "off";
            return (
              <div
                key={m.id}
                className="vpn-indicator-row machines-indicator-row"
                draggable
                onDragStart={(e) => {
                  draggingRef.current = true;
                  e.dataTransfer.setData(
                    GLOBAL_MACHINE_DRAG_TYPE,
                    JSON.stringify({
                      id: m.id,
                      host: m.host,
                      user: m.user,
                      port: m.port,
                      label: m.label,
                    }),
                  );
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={() => {
                  draggingRef.current = false;
                }}
                title="Drag onto a project's pill (or its open Remote machines window) to add it there."
              >
                <div className="vpn-indicator-head">
                  <ConnLamp status={st} label={m.label || m.host} />
                  <span className="vpn-indicator-config" title={targetLabel(m)}>
                    {m.label || m.host}
                  </span>
                </div>
                <div className="vpn-indicator-holders">{targetLabel(m)}</div>
                {retryId === m.id ? (
                  <div className="vpn-indicator-actions">
                    <PasswordInput
                      placeholder="SSH password"
                      value={retryPassword}
                      autoComplete="off"
                      onChange={(e) => setRetryPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRetry(m.id);
                      }}
                    />
                    <button type="button" className="vpn-indicator-connect" onClick={() => void submitRetry(m.id)}>
                      Retry
                    </button>
                    <button type="button" className="vpn-indicator-remove" onClick={() => setRetryId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : removeArm === m.id ? (
                  <div className="vpn-indicator-actions">
                    <div className="vpn-indicator-hint">Removes this machine from the list only.</div>
                    <button type="button" className="vpn-indicator-remove" onClick={() => void remove(m.id)}>
                      Remove
                    </button>
                    <button type="button" className="vpn-indicator-connect" onClick={() => setRemoveArm(null)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <div className="vpn-indicator-actions">
                    <button
                      type="button"
                      className="vpn-indicator-connect"
                      onClick={() => (st === "error" ? startRetry(m.id) : void connect(m.id))}
                      disabled={st === "connecting"}
                    >
                      {st === "connected" ? "Reconnect" : st === "error" ? "Retry…" : "Connect"}
                    </button>
                    <button type="button" className="vpn-indicator-remove" onClick={() => setRemoveArm(m.id)}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          <div className="tab-new-menu-group-label">Add a machine</div>
          {adding ? (
            <div className="vpn-indicator-row">
              <label>
                SSH address
                <input
                  placeholder="[user@]host[:port]"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitAdd();
                  }}
                  spellCheck={false}
                  autoFocus
                />
              </label>
              <label>
                Username
                <input
                  placeholder="SSH login user — or include as user@ above"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                Password
                <PasswordInput
                  placeholder="SSH password — leave blank for key auth"
                  value={password}
                  autoComplete="off"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitAdd();
                  }}
                />
              </label>
              <label className="vpn-indicator-auto">
                <Toggle checked={savePassword} onChange={(e) => setSavePassword(e.target.checked)} size="sm" />
                <span>
                  Save password
                  <UntestedTag />
                </span>
              </label>
              <label>
                Label (optional)
                <input
                  placeholder="e.g. gpu-2"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  spellCheck={false}
                />
              </label>
              {addError && <div className="vpn-indicator-error">{addError}</div>}
              <div className="vpn-indicator-actions">
                <button type="button" className="vpn-indicator-connect" disabled={addBusy} onClick={() => void submitAdd()}>
                  {addBusy ? "Connecting…" : "Connect & add"}
                </button>
                <button type="button" className="vpn-indicator-remove" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="vpn-indicator-row vpn-indicator-browse">
              <button type="button" className="vpn-indicator-connect" onClick={() => setAdding(true)}>
                Add machine…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
