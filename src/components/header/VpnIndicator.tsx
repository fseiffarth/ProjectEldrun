import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ConnLamp } from "../common/ConnLamp";
import { Toggle } from "../common/Toggle";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useVpnPromptStore } from "../../stores/vpnPrompt";
import { anyVpnLive, disconnectVpnTunnel, useVpnStatusStore } from "../../stores/vpnStatus";
import { canConnectVpnSilently, connectVpnSilently } from "../../lib/vpnConnect";
import { fileOf, setVpnAutoConnect, vpnUsernameFor } from "../../lib/vpnAutoConnect";
import type { StoredVpnConfig } from "../../types";

/**
 * The machine's OpenVPN control, in the header — where a machine-level thing belongs.
 *
 * Every other VPN surface in Eldrun hangs off a project: the toggle is in that
 * project's Connect dialog, the lamp is on its pill, and both vanish the moment you
 * switch away. The tunnel does not vanish. It runs as root, Eldrun passes it no
 * routing flags, and a typical `.ovpn` pushes `redirect-gateway` — so while it is
 * up, *this computer's* traffic goes through it, browser and all, whether or not
 * the project that asked for it is still on screen.
 *
 * So it is always here, whether or not a tunnel is up: dim when nothing is running,
 * lit when something is. It lists every stored config and can bring one **up** as
 * well as down — a VPN is a thing you use, not only a precondition for an SSH
 * project, and requiring one to own a project just to reach the tunnel was backwards.
 * A tunnel started here has no holder; it is simply up (see `vpnStatus`).
 */
export function VpnIndicator() {
  const byConfig = useVpnStatusStore((s) => s.byConfig);
  const holders = useVpnStatusStore((s) => s.holders);
  const refresh = useVpnStatusStore((s) => s.refresh);
  const setVpnState = useVpnStatusStore((s) => s.setState);
  const projects = useProjectsStore((s) => s.projects);
  const requestPassword = useVpnPromptStore((s) => s.request);

  const armed = useSettingsStore((s) => s.settings?.vpn_auto_connect ?? null);
  const headless = useSettingsStore((s) => s.settings?.connections_headless ?? true);

  const [open, setOpen] = useState(false);
  const [configs, setConfigs] = useState<StoredVpnConfig[]>([]);
  const [error, setError] = useState("");
  // Per config: can it be brought up with no prompt at all? Only then may it be armed
  // to connect on launch, since auto-connect promises never to prompt. Refreshed each
  // time the menu opens — the credentials can be saved or forgotten between openings.
  const [silent, setSilent] = useState<Record<string, boolean>>({});
  // Config path whose Remove is awaiting its second, confirming click. Removal
  // also forgets the config's saved credentials, and those are not recoverable
  // by re-browsing the file — hence armed, not single-click.
  const [removeArm, setRemoveArm] = useState<string | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  // Seat from the backend on mount, and re-seat when the window regains focus: a
  // tunnel can outlive the renderer (a reload, a crash, a previous run of the app),
  // and the routing it owns doesn't care that the UI forgot about it.
  //
  // Also re-seat on a timer, because the traffic goes the other way too: a tunnel
  // can **die** while the window sits focused and untouched, and mount+focus alone
  // never look again — the indicator stayed green over a tunnel that had been dead
  // for minutes. That is not just a stale lamp: `refresh` is what detects the drop
  // and gates the SSH/SFTP probes belonging to the projects riding it (see
  // `stores/vpnStatus`'s `onTunnelDropped`), so until something reconciles, every
  // one of those probes blocks ~45 s against a peer that will never answer. This
  // indicator is always mounted in the header, so it is the one place that poll is
  // guaranteed to run. It is a local IPC call against an in-memory registry, so a
  // 10 s cadence is cheap.
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(() => void refresh(), 10_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [refresh]);

  // The stored `.ovpn` list is only needed once the menu is open — and with it, which
  // of those configs could connect with no prompt (the gate on arming auto-connect).
  useEffect(() => {
    if (!open) return;
    setRemoveArm(null);
    let cancelled = false;
    void invoke<StoredVpnConfig[]>("openvpn_list_configs")
      .then(async (list) => {
        const stored = Array.isArray(list) ? list : [];
        if (cancelled) return;
        setConfigs(stored);
        const checks = await Promise.all(
          stored.map(async (c) => [c.path, await canConnectVpnSilently(c.path, vpnUsernameFor(c.path))] as const),
        );
        if (!cancelled) setSilent(Object.fromEntries(checks));
      })
      .catch(() => {
        if (!cancelled) setConfigs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };

  /**
   * Bring a tunnel up from the header, with no project behind it. Takes the silent
   * path only when the backend confirms it would *succeed* silently, and otherwise
   * goes straight to the shared password modal, which owns the retry loop.
   *
   * Asking first is the whole point. `pkexec` authenticates the user before OpenVPN
   * so much as reads the config, so an attempt that was always going to be rejected
   * still costs a system password dialog — and the modal that opens afterwards to
   * collect what was missing costs a second one. That is exactly what this menu used
   * to do to an `auth-user-pass` config with no project behind it: nothing here knew
   * the username, so every connect burned two polkit prompts. Now the backend keeps
   * the username beside the saved password, and `canConnectVpnSilently` says whether
   * the whole set is there — one prompt, one elevation, either way.
   */
  const connect = useCallback(
    async (config: string) => {
      setError("");
      setVpnState(config, "connecting");
      // A project on this config may already know the (non-secret) auth-user-pass
      // username — reuse it rather than making the user retype it. Absent that, the
      // backend falls back to the one saved beside the password.
      const username = vpnUsernameFor(config);
      if (await canConnectVpnSilently(config, username)) {
        try {
          await connectVpnSilently(config, username);
          setVpnState(config, "connected");
          return;
        } catch {
          // Saved credentials the server no longer accepts: fall through to the prompt.
        }
      }
      try {
        await requestPassword(config, fileOf(config), null, username);
        // The prompt store marks the tunnel connected on success.
      } catch (e) {
        setVpnState(config, "off");
        // A cancel is not an error worth shouting about; a failure is.
        const msg = String(e);
        if (!/cancel|superseded/i.test(msg)) setError(msg);
      }
    },
    [requestPassword, setVpnState],
  );

  /**
   * Connect with nothing stored yet: browse for a `.ovpn`, copy it into Eldrun's
   * store (`openvpn_store_config`, the same import the Connect dialog uses), then
   * connect it through the ordinary path above. Before this, a machine with no
   * project and no stored config had no way to reach the tunnel from here at all —
   * the header sent you off to a project's Connect dialog just to register a file.
   */
  const browseAndConnect = useCallback(async () => {
    setError("");
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "OpenVPN config", extensions: ["ovpn", "conf"] }],
    }).catch(() => null);
    if (typeof picked !== "string") return;
    let stored: string;
    try {
      stored = await invoke<string>("openvpn_store_config", { config: picked });
    } catch (e) {
      setError(String(e));
      return;
    }
    setConfigs((prev) =>
      prev.some((c) => c.path === stored)
        ? prev
        : [...prev, { path: stored, name: fileOf(stored) }],
    );
    await connect(stored);
  }, [connect]);

  /**
   * Remove a stored config: delete Eldrun's copy and forget its saved
   * credentials (the backend does both, in that order — a refused removal
   * leaves the credentials alone). Only offered on idle rows; a live tunnel's
   * config can't be removed, only disconnected first. A removed config can't
   * stay armed to connect on launch — an armed path with no file behind it
   * would silently fail at every startup.
   */
  const remove = useCallback(
    async (config: string) => {
      setError("");
      try {
        await invoke("openvpn_remove_config", { config });
      } catch (e) {
        setError(String(e));
        return;
      }
      if (armed === config) void setVpnAutoConnect(config, false);
      setConfigs((prev) => prev.filter((c) => c.path !== config));
      setRemoveArm(null);
    },
    [armed],
  );

  const live = Object.entries(byConfig).filter(
    ([, state]) => state === "connected" || state === "connecting",
  );
  const connecting = live.some(([, state]) => state === "connecting");
  const lamp: "off" | "connecting" | "connected" = !anyVpnLive(byConfig)
    ? "off"
    : connecting
      ? "connecting"
      : "connected";
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  // Configs that are up are listed as tunnels above; don't offer them again below.
  const idle = configs.filter((c) => !(c.path in byConfig));

  /**
   * "Connect on launch", per config. Offered only when the promise can be kept — the
   * connect would raise no prompt (headless: every credential saved) or raises no
   * *modal* by design (non-headless: it opens in the root terminal, where the user
   * types the password anyway). An armed-but-no-longer-eligible config can still be
   * switched off, or a stale opt-in would be unreachable.
   *
   * Arming is exclusive by construction: one config is stored, so turning this on for
   * a second tunnel turns it off for the first. That is not a limitation to work
   * around — two tunnels would be two claims on one machine's routing.
   */
  const autoConnectRow = (config: string) => {
    const on = armed === config;
    const eligible = !headless || silent[config] === true;
    return (
      <>
        <label className="vpn-indicator-auto">
          <Toggle
            size="sm"
            checked={on}
            disabled={!eligible && !on}
            onChange={(e) => void setVpnAutoConnect(config, e.target.checked)}
            aria-label={`Connect ${fileOf(config)} on launch`}
            title={
              headless
                ? "Bring this tunnel up automatically when Eldrun starts, using the saved credentials — no prompt. It reroutes this computer from launch."
                : "Open this tunnel's connect command in the root terminal when Eldrun starts, for you to authenticate. It reroutes this computer once it is up."
            }
          />
          <span>Connect on launch</span>
        </label>
        {!eligible && !on && (
          <div className="vpn-indicator-hint">
            Connect once with <b>Save passphrase</b> ticked to enable this — auto-connect
            never prompts.
          </div>
        )}
        {on && armed !== null && (
          <div className="vpn-indicator-hint">
            Starts with Eldrun{headless ? "" : " (waits in the root terminal)"}.
          </div>
        )}
      </>
    );
  };

  return (
    <div className="global-apps-menu no-drag" onMouseEnter={reveal} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="global-apps-menu-btn vpn-indicator-btn"
        aria-label="OpenVPN — connect or disconnect a tunnel"
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          lamp === "off"
            ? "OpenVPN — no tunnel. Connecting one routes this computer's traffic through it."
            : lamp === "connecting"
              ? "OpenVPN — connecting. Once it is up, this computer's traffic routes through the tunnel."
              : "OpenVPN — up. This computer's traffic routes through the tunnel."
        }
        // Hover-opened, like its sibling header menus (GlobalAppMenu,
        // LocalModelMenu). Click focuses rather than toggling: a click also fires
        // mouseenter, so a toggle here would open on enter and immediately shut.
        onClick={reveal}
        onFocus={reveal}
      >
        <ConnLamp status={lamp} label="OpenVPN" />
        <span className="vpn-indicator-label">VPN</span>
      </button>
      {open && (
        <div className="tab-new-menu vpn-indicator-menu" role="menu">
          {/* Pinned title; the region below it scrolls so the scrollbar starts
              beneath the header (unified `.menu-scroll-region` shape). */}
          <div className="tab-new-menu-group-label">OpenVPN</div>
          <div className="menu-scroll-region">
          <div className="vpn-indicator-note">
            A tunnel routes <strong>this whole computer's</strong> traffic, not just
            Eldrun's — including your browser — for as long as it is up.
          </div>

          {live.map(([config, state]) => {
            const held = holders[config] ?? [];
            return (
              <div key={config} className="vpn-indicator-row">
                <div className="vpn-indicator-head">
                  <ConnLamp status={state} label={`OpenVPN · ${fileOf(config)}`} />
                  <span className="vpn-indicator-config" title={config}>
                    {fileOf(config)}
                  </span>
                </div>
                <div className="vpn-indicator-holders">
                  {held.length > 0 ? `for ${held.map(nameOf).join(", ")}` : "held by no project"}
                </div>
                <button
                  type="button"
                  className="vpn-indicator-disconnect"
                  title="Bring this tunnel down and restore normal routing. Projects using it stay open; their SSH may or may not survive without it."
                  onClick={() => {
                    disconnectVpnTunnel(config);
                    setOpen(false);
                  }}
                  disabled={state === "connecting"}
                >
                  Disconnect tunnel
                </button>
                {autoConnectRow(config)}
              </div>
            );
          })}

          {idle.length > 0 && (
            <>
              <div className="tab-new-menu-group-label">Connect</div>
              {idle.map((c) => {
                const usedBy = projects
                  .filter((p) => p.remote?.openvpn?.config === c.path)
                  .map((p) => p.name);
                return (
                  <div key={c.path} className="vpn-indicator-row">
                    <div className="vpn-indicator-head">
                      <ConnLamp status="off" label={`OpenVPN · ${c.name}`} />
                      <span className="vpn-indicator-config" title={c.path}>
                        {c.name}
                      </span>
                    </div>
                    {removeArm === c.path ? (
                      // Armed remove: the second click is destructive (the saved
                      // credentials go with the config and can't be re-browsed
                      // back), so it is spelled out and separately cancellable.
                      <>
                        <div className="vpn-indicator-hint">
                          Removes this config from Eldrun and forgets its saved
                          credentials.
                          {usedBy.length > 0 && (
                            <>
                              {" "}
                              Used by <b>{usedBy.join(", ")}</b> — connecting that
                              project will ask for a config again.
                            </>
                          )}
                        </div>
                        <div className="vpn-indicator-actions">
                          <button
                            type="button"
                            className="vpn-indicator-remove"
                            onClick={() => void remove(c.path)}
                          >
                            Remove config
                          </button>
                          <button
                            type="button"
                            className="vpn-indicator-connect"
                            onClick={() => setRemoveArm(null)}
                          >
                            Keep
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="vpn-indicator-actions">
                        <button
                          type="button"
                          className="vpn-indicator-connect"
                          title="Bring this tunnel up. It will route this computer's traffic — not only Eldrun's."
                          onClick={() => void connect(c.path)}
                        >
                          Connect
                        </button>
                        <button
                          type="button"
                          className="vpn-indicator-remove"
                          title="Remove this stored config from Eldrun and forget its saved credentials. Asks once more before doing it."
                          onClick={() => setRemoveArm(c.path)}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                    {autoConnectRow(c.path)}
                  </div>
                );
              })}
            </>
          )}

          {live.length === 0 && idle.length === 0 ? (
            <div className="vpn-indicator-row">
              <div className="vpn-indicator-empty">
                No OpenVPN config stored yet — browse for a <code>.ovpn</code> and it
                connects straight away.
              </div>
              <button
                type="button"
                className="vpn-indicator-connect"
                title="Pick a .ovpn file, store it in Eldrun, and bring the tunnel up. It will route this computer's traffic — not only Eldrun's."
                onClick={() => void browseAndConnect()}
              >
                Connect…
              </button>
            </div>
          ) : (
            // Configs already exist, but you may want a different one — browsing
            // here adds/switches without going through a project's Connect dialog.
            // Same browse→store→connect path as the empty state; a cancelled
            // browse changes nothing.
            <div className="vpn-indicator-row vpn-indicator-browse">
              <button
                type="button"
                className="vpn-indicator-connect"
                title="Pick a different .ovpn file, store it in Eldrun, and bring it up. It will route this computer's traffic — not only Eldrun's."
                onClick={() => void browseAndConnect()}
              >
                Browse for a config…
              </button>
            </div>
          )}
          {error && <div className="vpn-indicator-error">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
