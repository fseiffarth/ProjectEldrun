import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { Toggle } from "../common/Toggle";

interface RuntimeStatus {
  configured: boolean;
  running: boolean;
  port?: number;
  origin?: string;
  error?: string;
  installed_version?: string;
  update_available: boolean;
}
interface ServeStatus {
  installed: boolean;
  error?: string;
}
interface Device { id: string; name: string; created_at: number; last_seen_at?: number }
type AdminResponse =
  | { status: "pairing_code"; code: string; expires_at: number }
  | { status: "devices"; devices: Device[] }
  | { status: "ok" }
  | { status: "error"; message: string };

export function MobileSettings() {
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const projects = useProjectsStore((state) => state.projects);
  const setProjectMobileAccess = useProjectsStore((state) => state.setProjectMobileAccess);
  const stored = settings?.eldrun_mobile_host;
  const [displayName, setDisplayName] = useState(stored?.display_name ?? "Workstation");
  const [port, setPort] = useState(String(stored?.port ?? 8742));
  const [origin, setOrigin] = useState(stored?.serve_origin ?? "");
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [serveStatus, setServeStatus] = useState<ServeStatus | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void invoke<RuntimeStatus>("mobile_host_status").then(setStatus).catch(() => setStatus(null));
    void invoke<ServeStatus>("mobile_tailscale_serve_status").then(setServeStatus).catch(() => setServeStatus(null));
    void invoke<AdminResponse>("mobile_admin", { request: { type: "devices" } })
      .then((response) => response.status === "devices" && setDevices(response.devices))
      .catch(() => setDevices([]));
  };
  useEffect(refresh, []);

  const apply = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const parsedPort = Number(port);
      if (enabled && (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535)) {
        throw new Error("Port must be between 1024 and 65535.");
      }
      if (enabled && !origin.startsWith("https://")) {
        throw new Error("Enter the exact verified Tailscale Serve HTTPS origin first.");
      }
      if (enabled) {
        await invoke("mobile_verify_tailscale_serve", {
          origin: origin.trim(),
          port: parsedPort,
        });
      }
      await updateSettings({
        eldrun_mobile_host: {
          enabled,
          display_name: displayName.trim() || "Workstation",
          port: parsedPort || 8742,
          serve_origin: origin.trim() || undefined,
        },
      });
      await invoke("mobile_host_apply", { enabled });
      setPairCode(null);
      refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createPairing = async () => {
    setError(null);
    try {
      const response = await invoke<AdminResponse>("mobile_admin", {
        request: { type: "pairing_code" },
      });
      if (response.status !== "pairing_code") throw new Error(response.status === "error" ? response.message : "Pairing is unavailable");
      setPairCode(response.code);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const eligible = projects.filter((project) => !project.remote && !project.sandbox?.enabled && !project.vm?.enabled);

  return (
    <div className="settings-toggle-card">
      <label className="settings-toggle-card-row">
        <span>Eldrun Mobile</span>
        <Toggle
          checked={stored?.enabled ?? false}
          disabled={busy}
          onChange={(event) => void apply(event.target.checked)}
        />
      </label>
      <p className="settings-help">
        Private project terminal access through Tailscale Serve. The host listens on loopback only and every browser must be paired.
      </p>
      <div className="settings-row">
        <label>Computer name</label>
        <input value={displayName} maxLength={64} onChange={(event) => setDisplayName(event.target.value)} />
      </div>
      <div className="settings-row">
        <label>Loopback port</label>
        <input value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} />
      </div>
      <div className="settings-row">
        <label>Verified Serve origin</label>
        <input value={origin} placeholder="https://workstation.example.ts.net" onChange={(event) => setOrigin(event.target.value)} />
      </div>
      <div className="settings-link-row">
        <button type="button" disabled={!status?.running} onClick={() => void createPairing()}>New pairing code</button>
        {stored?.enabled && !status?.running && <button type="button" disabled={busy} onClick={() => void apply(true)}>Start mobile host</button>}
        {status?.update_available && <button type="button" disabled={busy} onClick={() => void apply(true)}>Update mobile host</button>}
        <button type="button" onClick={refresh}>Refresh status</button>
      </div>
      <p className="settings-help">
        {status?.running ? `Host running on 127.0.0.1:${status.port}.` : "Host stopped."}
        {status?.installed_version ? ` Sidecar ${status.installed_version}.` : ""}
        {serveStatus?.installed ? " Tailscale Serve configuration is readable." : " Tailscale Serve is unavailable."}
        {serveStatus?.error ? ` ${serveStatus.error}` : ""}
        {pairCode ? ` Pairing code: ${pairCode} (valid for five minutes).` : ""}
      </p>
      {error && <div className="project-dialog-error">{error}</div>}

      <div className="settings-section-title">Project access</div>
      <p className="settings-help">
        Access is off per project. Enabling it does not restart a live agent; that agent becomes attachable after its next normal reopen.
      </p>
      {eligible.map((project) => (
        <label key={project.id} className="settings-toggle-card-row">
          <span>{project.name}</span>
          <Toggle
            checked={project.eldrun_mobile_access ?? false}
            onChange={(event) => {
              setError(null);
              void setProjectMobileAccess(project.id, event.target.checked).catch((reason) => setError(String(reason)));
            }}
          />
        </label>
      ))}

      {devices.length > 0 && <div className="settings-section-title">Paired devices</div>}
      {devices.map((device) => (
        <div key={device.id} className="settings-link-row">
          <span>{device.name}</span>
          <button
            type="button"
            onClick={() => void invoke<AdminResponse>("mobile_admin", { request: { type: "revoke", device_id: device.id } }).then(refresh)}
          >Revoke</button>
        </div>
      ))}
      {devices.length > 0 && <button
        type="button"
        className="danger"
        onClick={() => {
          if (!window.confirm("Forget every paired Mobile device and rotate all opaque IDs?")) return;
          void invoke<AdminResponse>("mobile_admin", { request: { type: "forget_all" } })
            .then((response) => {
              if (response.status === "error") throw new Error(response.message);
              setPairCode(null);
              refresh();
            })
            .catch((reason) => setError(String(reason)));
        }}
      >Forget all devices</button>}
    </div>
  );
}
