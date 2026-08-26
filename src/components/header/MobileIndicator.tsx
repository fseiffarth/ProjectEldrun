import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { UntestedTag } from "../common/UntestedTag";

const MENU_ID = "mobile";
const POLL_MS = 15_000;
// `systemctl --user restart` acknowledges the job before the replacement
// sidecar has necessarily rebound its admin socket. A short bounded wait keeps
// that expected hand-off from being rendered as a failed reconnect.
const RECONNECT_READY_ATTEMPTS = 20;
const RECONNECT_RETRY_MS = 250;

interface RuntimeStatus {
  configured: boolean;
  running: boolean;
  port?: number;
  origin?: string;
  error?: string;
  installed_version?: string;
  update_available: boolean;
}

interface AdminResponse {
  status: string;
  devices?: Array<{ id: string }>;
}

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

type StatusTone = "connected" | "connecting" | "off" | "error";

function statusTone(status: RuntimeStatus | null, refreshing: boolean): StatusTone {
  if (refreshing) return "connecting";
  if (status?.running) return "connected";
  return status?.error ? "error" : "off";
}

function MobileIcon({ tone }: { tone: StatusTone }) {
  return (
    <svg
      className={`mobile-indicator-icon ${tone}`}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="4.1" y="1.5" width="7.8" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.7 3.6H9.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="12.3" r="0.7" fill="currentColor" />
      <circle className="mobile-indicator-icon-dot" cx="12.6" cy="3.4" r="2.25" fill="currentColor" />
    </svg>
  );
}

/**
 * Eldrun Mobile is a machine-wide companion host, so its status belongs beside
 * the battery and VPN controls rather than in a project pill. The sidecar is
 * the authority: a green phone means its authenticated admin socket replied,
 * not merely that the setting says it ought to be running.
 */
export function MobileIndicator() {
  const mobileHost = useSettingsStore((s) => s.settings?.eldrun_mobile_host);
  const mobileEnabled = useSettingsStore((s) => s.settings?.eldrun_mobile_host?.enabled ?? false);
  const visible = useSettingsStore((s) => s.settings?.mobile_indicator ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const open = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [hasPairedPhone, setHasPairedPhone] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [uploadingVersion, setUploadingVersion] = useState(false);
  const [lockingDown, setLockingDown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const statusRequest = useRef(0);
  const reconnectingRef = useRef(false);

  const refresh = useCallback(async (waitForHost = false) => {
    if (!waitForHost && reconnectingRef.current) return;
    const request = ++statusRequest.current;
    setRefreshing(true);
    setError(null);
    try {
      let next: RuntimeStatus | null = null;
      let nextHasPairedPhone = false;
      for (let attempt = 0; attempt < (waitForHost ? RECONNECT_READY_ATTEMPTS : 1); attempt += 1) {
        const [runtimeStatus, deviceResponse] = await Promise.all([
          invoke<RuntimeStatus>("mobile_host_status"),
          invoke<AdminResponse>("mobile_admin", { request: { type: "devices" } }).catch(() => null),
        ]);
        next = runtimeStatus;
        nextHasPairedPhone = deviceResponse?.status === "devices" && (deviceResponse.devices?.length ?? 0) > 0;
        if (next.running || !waitForHost || attempt === RECONNECT_READY_ATTEMPTS - 1) break;
        await pause(RECONNECT_RETRY_MS);
      }
      if (request === statusRequest.current) {
        setStatus(next);
        setHasPairedPhone(nextHasPairedPhone);
      }
    } catch (reason) {
      if (request === statusRequest.current) {
        setStatus(null);
        setError(String(reason));
      }
    } finally {
      if (request === statusRequest.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!mobileEnabled || !visible) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [mobileEnabled, visible, refresh]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!mobileEnabled || !visible) closeMenu(MENU_ID);
  }, [mobileEnabled, visible, closeMenu]);

  const reveal = () => openMenu(MENU_ID);
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => closeMenu(MENU_ID), 250);
  };

  const reconnect = async () => {
    // Ignore an earlier focus/interval probe while restart replaces the socket.
    // Without this generation bump, that old `ECONNREFUSED` can land after the
    // successful probe below and repaint the menu red.
    reconnectingRef.current = true;
    statusRequest.current += 1;
    setReconnecting(true);
    setError(null);
    try {
      await invoke("mobile_host_apply", { enabled: true });
      await refresh(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      reconnectingRef.current = false;
      setReconnecting(false);
    }
  };

  const uploadMobileVersion = async () => {
    // Eldrun Mobile is a PWA embedded in the Mobile host. Reinstalling and
    // restarting that sidecar is the atomic publication step: the phone then
    // receives the fresh assets through its normal service-worker update path.
    reconnectingRef.current = true;
    statusRequest.current += 1;
    setUploadingVersion(true);
    setError(null);
    setUploadNotice(null);
    try {
      await invoke("mobile_host_apply", { enabled: true });
      await refresh(true);
      setUploadNotice("The current Eldrun Mobile version is ready. Refresh the app on your phone to install it.");
    } catch (reason) {
      setError(`Could not publish the Mobile version: ${String(reason)}`);
    } finally {
      reconnectingRef.current = false;
      setUploadingVersion(false);
    }
  };

  const lockDownNow = async () => {
    if (!mobileHost) return;
    if (!window.confirm("Lock down Eldrun Mobile now? This immediately revokes every paired phone, closes their terminal connections, and stops the Mobile host. Every phone will need to pair again.")) return;
    setLockingDown(true);
    setError(null);
    try {
      const response = await invoke<{ status: string; message?: string }>("mobile_admin", { request: { type: "forget_all" } });
      if (response.status === "error") throw new Error(response.message ?? "Could not revoke paired devices");
      await updateSettings({ eldrun_mobile_host: { ...mobileHost, enabled: false } });
      await invoke("mobile_host_apply", { enabled: false });
      closeMenu(MENU_ID);
    } catch (reason) {
      setError(`Lockdown was only partially completed: ${String(reason)}`);
    } finally {
      setLockingDown(false);
    }
  };

  if (!mobileEnabled || !visible) return null;

  const tone = statusTone(status, refreshing || reconnecting);
  const title = tone === "connected"
    ? "Eldrun Mobile connected"
    : tone === "connecting"
      ? "Checking Eldrun Mobile connection"
      : tone === "error"
        ? "Eldrun Mobile connection unavailable"
        : "Eldrun Mobile host stopped";

  return (
    <div
      className="global-apps-menu header-status-menu-anchor no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn mobile-indicator-btn"
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={reveal}
        onFocus={reveal}
      >
        <MobileIcon tone={tone} />
      </button>
      {open && (
        <div className="tab-new-menu mobile-indicator-menu" role="menu">
          <div className="tab-new-menu-group-label vpn-indicator-title">
            <span>Eldrun Mobile <UntestedTag /></span>
            <button
              type="button"
              className="vpn-indicator-close"
              aria-label="Close"
              title="Close"
              onClick={() => closeMenu(MENU_ID)}
            >
              ×
            </button>
          </div>
          <div className="mobile-indicator-body">
            <div className="mobile-indicator-status" aria-live="polite">
              <MobileIcon tone={tone} />
              <div>
                <strong>
                  {tone === "connected" ? "Connected" : tone === "connecting" ? "Checking…" : "Disconnected"}
                </strong>
                <span>
                  {tone === "connecting"
                    ? "Starting the Mobile host…"
                    : status?.running
                    ? `Host listening on 127.0.0.1:${status.port ?? "?"}.`
                    : status?.error ?? "The Mobile host is not running."}
                </span>
              </div>
            </div>
            {status?.origin && <div className="mobile-indicator-origin">{status.origin}</div>}
            {error && <div className="mobile-indicator-error">{error}</div>}
            {uploadNotice && <div className="mobile-indicator-notice" role="status">{uploadNotice}</div>}
            <div className="mobile-indicator-actions">
              <button type="button" className="vpn-indicator-connect" disabled={refreshing || reconnecting || uploadingVersion || lockingDown} onClick={() => void refresh()}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <button type="button" className="vpn-indicator-connect" disabled={refreshing || reconnecting || uploadingVersion || lockingDown} onClick={() => void reconnect()}>
                {reconnecting ? "Reconnecting…" : "Reconnect"}
              </button>
              {status?.running && hasPairedPhone && (
                <button
                  type="button"
                  className="vpn-indicator-connect"
                  disabled={refreshing || reconnecting || uploadingVersion || lockingDown}
                  onClick={() => void uploadMobileVersion()}
                >
                  {uploadingVersion ? "Uploading…" : "Upload mobile version"}
                </button>
              )}
              <button type="button" className="vpn-indicator-connect mobile-indicator-lockdown" disabled={refreshing || reconnecting || uploadingVersion || lockingDown || !status?.running} onClick={() => void lockDownNow()}>
                {lockingDown ? "Locking…" : "Lock down"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
