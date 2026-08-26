import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import { Toggle } from "../common/Toggle";
import { isTrashProject } from "../../lib/trashProject";

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
  json?: unknown;
  detected?: {
    display_name: string;
    port: number;
    origin: string;
  };
  detection_error?: string;
}
interface ServeVerification {
  verified: boolean;
  error?: string;
}
interface Device { id: string; name: string; created_at: number; last_seen_at?: number }
type AdminResponse =
  | { status: "pairing_code"; code: string; expires_at: number }
  | { status: "devices"; devices: Device[] }
  | { status: "ok" }
  | { status: "error"; message: string };

interface DetectedServeSettings {
  display_name: string;
  port: number;
  origin: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// Compatibility for a live backend built before it returned `detected`. The
// result is still passed through mobile_verify_tailscale_serve before use, so
// this parser cannot weaken the backend's exact-origin/Funnel checks.
function detectServeSettingsFromJson(value: unknown): DetectedServeSettings {
  const status = record(value);
  const web = record(status?.Web);
  const tcp = record(status?.TCP);
  const funnel = record(status?.AllowFunnel);
  const candidates: DetectedServeSettings[] = [];

  for (const [authority, rawServer] of Object.entries(web ?? {})) {
    const server = record(rawServer);
    const handlers = record(server?.Handlers);
    const root = record(handlers?.["/"]);
    if (typeof root?.Proxy !== "string") continue;
    try {
      const target = new URL(root.Proxy);
      const publicUrl = new URL(`https://${authority}`);
      const port = Number(target.port);
      const publicPort = publicUrl.port || "443";
      const listener = record(tcp?.[publicPort]);
      if (
        target.protocol !== "http:"
        || target.hostname !== "127.0.0.1"
        || target.username !== ""
        || target.password !== ""
        || target.pathname !== "/"
        || target.search !== ""
        || target.hash !== ""
        || !Number.isInteger(port)
        || port < 1024
        || port > 65535
        || listener?.HTTPS !== true
        || funnel?.[authority] === true
      ) continue;
      const displayName = publicUrl.hostname.split(".")[0];
      if (!displayName || displayName.length > 64) continue;
      candidates.push({
        display_name: displayName,
        port,
        origin: publicUrl.origin,
      });
    } catch {
      // Ignore malformed/non-URL handlers; they are not eligible mappings.
    }
  }

  const unique = [...new Map(candidates.map((candidate) => [
    `${candidate.origin}\0${candidate.port}`,
    candidate,
  ])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length === 0) {
    throw new Error("No private HTTPS root handler proxies to http://127.0.0.1:<port>.");
  }
  throw new Error("Multiple eligible Tailscale Serve mappings were found; keep only the Eldrun root mapping before detecting settings.");
}

export function MobileSettings() {
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const projects = useProjectsStore((state) => state.projects);
  const rootDir = useProjectsStore((state) => state.rootDir);
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
  const [pairingBusy, setPairingBusy] = useState(false);
  const [detectingServe, setDetectingServe] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [serveVerification, setServeVerification] = useState<ServeVerification | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const initialFieldsHydrated = useRef(false);
  const refreshSequence = useRef(0);
  const originRef = useRef(origin);
  const portRef = useRef(port);
  originRef.current = origin;
  portRef.current = port;
  const parsedGuidePort = Number(port);
  const guidePort = Number.isInteger(parsedGuidePort) && parsedGuidePort >= 1024 && parsedGuidePort <= 65535
    ? parsedGuidePort
    : 8742;

  useEffect(() => {
    if (!settings || initialFieldsHydrated.current) return;
    initialFieldsHydrated.current = true;
    const hydratedPort = String(stored?.port ?? 8742);
    const hydratedOrigin = stored?.serve_origin ?? "";
    setDisplayName(stored?.display_name ?? "Workstation");
    setPort(hydratedPort);
    setOrigin(hydratedOrigin);
    // The initial refresh effect runs in the same commit. Update its refs now,
    // before React schedules the state-driven render, so it verifies the saved
    // values instead of the empty pre-settings form defaults.
    portRef.current = hydratedPort;
    originRef.current = hydratedOrigin;
  }, [settings, stored?.display_name, stored?.port, stored?.serve_origin]);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    setRefreshError(null);

    const [runtimeResult, serveResult, devicesResult] = await Promise.allSettled([
      invoke<RuntimeStatus>("mobile_host_status"),
      invoke<ServeStatus>("mobile_tailscale_serve_status"),
      invoke<AdminResponse>("mobile_admin", { request: { type: "devices" } }),
    ]);
    if (sequence !== refreshSequence.current) return;

    const nextStatus = runtimeResult.status === "fulfilled" ? runtimeResult.value : null;
    const nextServeStatus = serveResult.status === "fulfilled" ? serveResult.value : null;
    setStatus(nextStatus);
    setServeStatus(nextServeStatus);
    setDevices(
      devicesResult.status === "fulfilled" && devicesResult.value.status === "devices"
        ? devicesResult.value.devices
        : [],
    );

    const failures: string[] = [];
    const statusReasons = [runtimeResult, serveResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason));
    if (statusReasons.some((reason) => /command .* not found/i.test(reason))) {
      failures.push("The running Eldrun backend predates Mobile status support. Restart Eldrun to load the current backend.");
    } else {
      if (runtimeResult.status === "rejected") failures.push(`Host status: ${String(runtimeResult.reason)}`);
      if (serveResult.status === "rejected") failures.push(`Tailscale status: ${String(serveResult.reason)}`);
    }

    const enteredOrigin = originRef.current.trim();
    const enteredPort = Number(portRef.current);
    if (
      nextServeStatus?.installed
      && !nextServeStatus.error
      && enteredOrigin.startsWith("https://")
      && Number.isInteger(enteredPort)
      && enteredPort >= 1024
      && enteredPort <= 65535
    ) {
      try {
        await invoke("mobile_verify_tailscale_serve", {
          origin: enteredOrigin,
          port: enteredPort,
        });
        if (sequence !== refreshSequence.current) return;
        setServeVerification({ verified: true });
      } catch (reason) {
        if (sequence !== refreshSequence.current) return;
        setServeVerification({ verified: false, error: String(reason) });
      }
    } else {
      setServeVerification(null);
    }

    setRefreshError(failures.length > 0 ? failures.join(" ") : null);
    setRefreshing(false);
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      refreshSequence.current += 1;
    };
  }, [refresh]);

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

  const setUpInTerminal = () => {
    const command = `tailscale serve --bg http://127.0.0.1:${guidePort}`;
    if (!window.confirm(
      `This will open a root terminal and run:\n\n${command}\n\nIt updates Tailscale Serve's HTTPS root handler and can replace a service currently mounted at /. Continue?`,
    )) return;
    const tabs = useTabsStore.getState();
    tabs.setScope(ROOT_SCOPE);
    tabs.addTab({
      label: "Set up Tailscale Serve",
      cmd: "",
      args: [],
      env: {},
      initialInput: command,
      cwd: rootDir ?? "",
      kind: "shell",
    });
  };

  const installOnPhone = async () => {
    setError(null);
    try {
      // The backend materializes its embedded source so a packaged Eldrun has
      // the same handoff script as a checkout.
      await invoke("mobile_prepare_phone_install_script");
      const tabs = useTabsStore.getState();
      tabs.addTabToScope(ROOT_SCOPE, {
        label: "Install Eldrun Mobile on phone",
        cmd: "/bin/bash",
        cwd: rootDir ?? "",
        kind: "shell",
        initialInput: `bash "\${XDG_DATA_HOME:-$HOME/.local/share}/eldrun/mobile-control/install_phone.sh"`,
      });
      useProjectsStore.setState({
        switchToast: "Phone installation handoff is running in the root terminal",
      });
    } catch (reason) {
      setError(`Could not open the phone installation handoff: ${String(reason)}`);
    }
  };

  const detectServeSettings = async () => {
    setDetectingServe(true);
    setError(null);
    setRefreshError(null);
    try {
      const result = await invoke<ServeStatus>("mobile_tailscale_serve_status");
      setServeStatus(result);
      if (!result.installed) throw new Error("Tailscale is not installed.");
      if (result.error) throw new Error(result.error);
      const detected = result.detected ?? detectServeSettingsFromJson(result.json);
      await invoke("mobile_verify_tailscale_serve", {
        origin: detected.origin,
        port: detected.port,
      });
      setDisplayName(detected.display_name);
      setPort(String(detected.port));
      setOrigin(detected.origin);
      setServeVerification({ verified: true });
      await updateSettings({
        eldrun_mobile_host: {
          enabled: stored?.enabled ?? false,
          display_name: detected.display_name,
          port: detected.port,
          serve_origin: detected.origin,
        },
      });
    } catch (reason) {
      setServeVerification(null);
      setError(String(reason));
    } finally {
      setDetectingServe(false);
    }
  };

  const createPairing = async () => {
    setPairingBusy(true);
    setError(null);
    try {
      const currentStatus = await invoke<RuntimeStatus>("mobile_host_status");
      setStatus(currentStatus);
      if (!currentStatus.running) {
        throw new Error("Start the mobile host before creating a pairing code.");
      }
      const response = await invoke<AdminResponse>("mobile_admin", {
        request: { type: "pairing_code" },
      });
      if (response.status !== "pairing_code") throw new Error(response.status === "error" ? response.message : "Pairing is unavailable");
      setPairCode(response.code);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPairingBusy(false);
    }
  };

  const lockDownNow = async () => {
    if (!window.confirm("Lock down Eldrun Mobile now? This immediately revokes every paired phone, closes their terminal connections, and stops the Mobile host. Every phone will need to pair again.")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await invoke<AdminResponse>("mobile_admin", { request: { type: "forget_all" } });
      if (response.status === "error") throw new Error(response.message);
      await updateSettings({
        eldrun_mobile_host: {
          enabled: false,
          display_name: displayName.trim() || "Workstation",
          port: Number(port) || 8742,
          serve_origin: origin.trim() || undefined,
        },
      });
      await invoke("mobile_host_apply", { enabled: false });
      setPairCode(null);
      await refresh();
    } catch (reason) {
      setError(`Lockdown was only partially completed: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const eligible = projects.filter((project) => !project.remote && (!project.sandbox?.enabled || isTrashProject(project)) && !project.vm?.enabled);
  const normalizedProjectSearch = projectSearch.trim().toLocaleLowerCase();
  const matchingEligible = normalizedProjectSearch
    ? eligible.filter((project) => project.name.toLocaleLowerCase().includes(normalizedProjectSearch))
    : eligible;
  const securityHealth = !stored?.enabled
    ? { tone: "off", title: "Mobile is off", detail: "No Eldrun Mobile host is currently published." }
    : !status?.running
      ? { tone: "danger", title: "Host is stopped", detail: "Mobile is enabled in settings but not serving; start it only after checking the private Serve mapping." }
      : !serveVerification?.verified
        ? { tone: "danger", title: "Serve mapping needs attention", detail: "Eldrun cannot currently verify its exact private loopback HTTPS mapping." }
        : { tone: "good", title: "Private publication verified", detail: "Host is loopback-only and the configured Tailscale Serve route is private HTTPS." };

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
      <div className={`mobile-security-health ${securityHealth.tone}`} role="status">
        <div>
          <strong>{securityHealth.title}</strong>
          <p>{securityHealth.detail}</p>
        </div>
        <button
          type="button"
          className="danger"
          disabled={busy || !status?.running}
          title={status?.running ? "Revoke every paired device and stop the host" : "The host is already stopped"}
          onClick={() => void lockDownNow()}
        >Lock down now</button>
      </div>
      <p className="settings-help">
        This checks Eldrun’s publication shape, not your tailnet ACLs, account MFA, Tailnet Lock, or the phone’s screen lock. Configure those in Tailscale and on the phone.
      </p>
      <div className="mobile-phone-install">
        <div>
          <strong>Install Eldrun Mobile on your phone</strong>
          <p>
            Verifies the private Tailscale Serve mapping, then shows the trusted URL and a scannable QR code in a root terminal. It does not enable Mobile or change your Tailscale configuration.
          </p>
        </div>
        <button type="button" className="mobile-phone-install-button" onClick={() => void installOnPhone()}>
          Show install QR
        </button>
      </div>
      <details className="mobile-settings-guide" open>
        <summary>Set up Tailscale Serve</summary>
        <div className="mobile-settings-guide-body">
          <p>
            Do this on this computer before turning on Eldrun Mobile. Install Tailscale and sign in here, then install and sign in to the same tailnet on the phone or tablet that will use Mobile.
          </p>
          <ol>
            <li>
              In a terminal on this computer, inspect its existing publication with <code>tailscale serve status</code>. Eldrun Mobile needs the HTTPS <code>/</code> (root) handler, so do not replace an existing root handler unless you mean to move that service.
            </li>
            <li>
              Configure the private, persistent reverse proxy. Use Serve—not Funnel:
              <code className="mobile-settings-guide-command">tailscale serve --bg http://127.0.0.1:{guidePort}</code>
              If Tailscale asks for approval or HTTPS setup, complete it in the browser it opens.
            </li>
            <li>
              Run <code>tailscale serve status</code> again, then use <em>Detect Tailscale Serve settings</em> below. Eldrun fills the computer name, loopback port, and verified origin from the private root mapping.
            </li>
            <li>
              Turn on Eldrun Mobile. Eldrun verifies that the origin's root handler proxies exactly to <code>http://127.0.0.1:{guidePort}</code>; use <em>Refresh status</em> if you changed Tailscale in another terminal.
            </li>
            <li>
              Enable the local projects you want to expose, create a pairing code, then open the verified origin on the phone or tablet and enter that code.
            </li>
          </ol>
          <p>
            The address is reachable only by devices allowed in your tailnet, and Mobile still requires its own device pairing. Do not use Tailscale Funnel: it makes the service public and Eldrun will refuse to start.
          </p>
          <div className="mobile-settings-guide-actions">
            <button type="button" onClick={setUpInTerminal}>Set up in terminal</button>
            <span>Opens a root terminal and runs the command above after confirmation.</span>
          </div>
          <a href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer">Tailscale Serve documentation</a>
        </div>
      </details>
      <div className="settings-row">
        <label>Computer name</label>
        <input value={displayName} maxLength={64} onChange={(event) => setDisplayName(event.target.value)} />
      </div>
      <div className="settings-row">
        <label>Loopback port</label>
        <input
          value={port}
          inputMode="numeric"
          onChange={(event) => {
            setPort(event.target.value);
            setServeVerification(null);
          }}
        />
      </div>
      <div className="settings-row">
        <label>Verified Serve origin</label>
        <input
          value={origin}
          placeholder="https://workstation.example.ts.net"
          onChange={(event) => {
            setOrigin(event.target.value);
            setServeVerification(null);
          }}
        />
      </div>
      <div className="settings-link-row">
        <button type="button" disabled={busy || detectingServe} onClick={() => void detectServeSettings()}>
          {detectingServe ? "Detecting…" : "Detect Tailscale Serve settings"}
        </button>
      </div>
      <div className="settings-link-row">
        <button type="button" disabled={busy || pairingBusy} onClick={() => void createPairing()}>
          {pairingBusy ? "Creating code…" : "New pairing code"}
        </button>
        {stored?.enabled && !status?.running && <button type="button" disabled={busy} onClick={() => void apply(true)}>Start mobile host</button>}
        {status?.update_available && <button type="button" disabled={busy} onClick={() => void apply(true)}>Update mobile host</button>}
        <button type="button" disabled={busy || refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh status"}
        </button>
      </div>
      <p className="settings-help" aria-live="polite">
        {status?.running ? `Host running on 127.0.0.1:${status.port}.` : "Host stopped."}
        {status?.installed_version ? ` Sidecar ${status.installed_version}.` : ""}
        {serveVerification?.verified
          ? ` Tailscale Serve routes the verified origin to 127.0.0.1:${port}.`
          : serveStatus?.installed
            ? " Tailscale Serve configuration is readable."
            : " Tailscale Serve is unavailable."}
        {serveStatus?.error ? ` ${serveStatus.error}` : ""}
        {serveVerification && !serveVerification.verified ? ` ${serveVerification.error}` : ""}
        {pairCode ? ` Pairing code: ${pairCode} (valid for five minutes).` : ""}
      </p>
      {refreshError && <div className="project-dialog-error">{refreshError}</div>}
      {error && <div className="project-dialog-error">{error}</div>}

      <div className="settings-section-title">Project access</div>
      <p className="settings-help">
        Access is off per project. Enabling it does not restart a live agent; that agent becomes attachable after its next normal reopen.
      </p>
      {eligible.length > 0 && <input
        className="mobile-project-access-search"
        value={projectSearch}
        placeholder="Search projects…"
        aria-label="Search projects with Mobile access"
        onChange={(event) => setProjectSearch(event.target.value)}
      />}
      <div className="mobile-project-access-list">
        {matchingEligible.map((project) => (
          <label key={project.id} className="settings-toggle-card-row">
            <span>{project.name}</span>
            <Toggle
              checked={project.eldrun_mobile_access ?? false}
              disabled={isTrashProject(project)}
              onChange={(event) => {
                setError(null);
                void setProjectMobileAccess(project.id, event.target.checked).catch((reason) => setError(String(reason)));
              }}
            />
          </label>
        ))}
        {eligible.length === 0 && <p className="settings-help">No local, non-container projects are available.</p>}
        {eligible.length > 0 && matchingEligible.length === 0 && <p className="settings-help">No projects match “{projectSearch.trim()}”.</p>}
      </div>

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
