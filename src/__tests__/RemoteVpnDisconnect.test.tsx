/**
 * VPN-only teardown: a tunnel that is up while SSH is down must still be
 * disconnectable.
 *
 * The reported dead end: the VPN comes up, SSH then fails (wrong network, rejected
 * credential, host down) — and the Connect modal offered no way to bring the tunnel
 * back down. Three things had to line up for that:
 *
 *  1. the VPN section was collapsed on open (its opt-in toggle defaults to off), so
 *     a live tunnel was invisible;
 *  2. the headless VPN button row only had a "Stop" while *connecting*, never a
 *     disconnect once connected; and
 *  3. the modal's Disconnect was gated on `sshStatus !== "off"` — so with SSH never
 *     connected (or already reset by its own Stop), it wasn't rendered at all.
 *
 * Each is locked below. The teardown must also be *VPN-only*: it may not drop the
 * SSH pool as a side effect.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
// The dialog only mounts a TerminalView on the non-headless path (none of these
// cases), but the import pulls xterm into jsdom — stub it out.
vi.mock("../components/terminal/TerminalView", () => ({ TerminalView: () => null }));

import { RemoteConnectDialog } from "../components/projects/RemoteConnectDialog";
import { useProjectsStore } from "../stores/projects";
import { useConnectDialogStore } from "../stores/connectDialog";
import { useRemoteStatusStore } from "../stores/remoteStatus";
import { useSettingsStore } from "../stores/settings";
import { useVpnStatusStore } from "../stores/vpnStatus";
import type { ProjectEntry } from "../types";

const invokeMock = vi.mocked(invoke);

const VPN_CONFIG = "/store/office.ovpn";

const PROJECT = {
  id: "p1",
  name: "sshtest",
  directory: "/local/state/p1",
  position: 0,
  status: "active",
  remote: {
    user: "alice",
    host: "host.example",
    remote_path: "/srv/work",
    openvpn: { config: VPN_CONFIG },
  },
} as unknown as ProjectEntry;

const calledWith = (cmd: string) => invokeMock.mock.calls.filter(([name]) => name === cmd);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "remote_has_saved_password" || cmd === "vpn_has_saved_password") {
      return Promise.resolve(false);
    }
    if (cmd === "openvpn_list_configs") return Promise.resolve([]);
    if (cmd === "openvpn_auth_needs") {
      return Promise.resolve({ username: false, keyPassphrase: false });
    }
    return Promise.resolve();
  });

  useSettingsStore.setState({ settings: { connections_headless: true } as never });
  useProjectsStore.setState({ projects: [PROJECT] } as never);
  useConnectDialogStore.setState({ projectId: PROJECT.id } as never);
  // The state under test: tunnel up, SSH never got anywhere.
  useRemoteStatusStore.setState({ byProject: { p1: { ssh: "off", vpn: "connected" } } } as never);
  useVpnStatusStore.setState({ byConfig: {}, holders: {} });
});

describe("VPN-only disconnect (tunnel up, SSH down)", () => {
  it("opens the VPN section by itself when a tunnel is already up", async () => {
    // A live tunnel must never hide behind the collapsed opt-in: that is precisely
    // the state in which the user needs the section — to bring it down.
    render(<RemoteConnectDialog />);

    const toggle = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: /connect via openvpn/i,
    });
    expect(toggle.checked).toBe(true);
  });

  it("opens the VPN section when the matching tunnel was started globally", async () => {
    useRemoteStatusStore.setState({ byProject: { p1: { ssh: "off", vpn: "off" } } } as never);
    useVpnStatusStore.setState({
      byConfig: { [VPN_CONFIG]: "connected" },
      holders: {},
    });

    render(<RemoteConnectDialog />);

    const toggle = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: /connect via openvpn/i,
    });
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(useRemoteStatusStore.getState().byProject.p1?.vpn).toBe("connected");
    expect(useVpnStatusStore.getState().holders[VPN_CONFIG]).toEqual(["p1"]);
    expect(screen.queryByRole("button", { name: /^connect vpn$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /disconnect vpn/i })).toBeTruthy();
  });

  it("offers a VPN disconnect while connected, and drops only the tunnel", async () => {
    render(<RemoteConnectDialog />);

    const disconnectVpn = await screen.findByRole("button", { name: /disconnect vpn/i });
    await userEvent.click(disconnectVpn);

    await waitFor(() =>
      expect(calledWith("openvpn_disconnect")).toEqual([["openvpn_disconnect", { config: VPN_CONFIG }]]),
    );
    // VPN-only: the SSH pool is a separate channel and must be left alone.
    expect(calledWith("remote_disconnect")).toEqual([]);
    expect(useRemoteStatusStore.getState().byProject.p1?.vpn).toBe("off");
  });

  it("still renders the modal's Disconnect when only the VPN is up", async () => {
    // Gating this on `sshStatus !== "off"` is what left the tunnel with no way out.
    render(<RemoteConnectDialog />);

    // findByRole throws if it isn't rendered — that failure *is* the regression.
    expect(await screen.findByRole("button", { name: /^disconnect$/i })).toBeTruthy();
  });
});
