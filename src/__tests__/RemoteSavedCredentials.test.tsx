/**
 * Saved credentials in the Connect modal.
 *
 * Two rules, both reported as bugs:
 *
 *  1. **Unticking "Save password" deletes it — now.** The keychain was only cleared
 *     on the *next* successful connect (`remember: false` → `Remember::Clear`), so a
 *     user who unticked and closed the modal left the password they had just asked
 *     to drop sitting in the OS keychain, possibly forever.
 *
 *  2. **A saved credential is used when the field is left blank.** It can't be
 *     pre-filled — the secret never leaves the backend — so the field advertises
 *     that blank means "use the saved one". (The wire-level half of this, sending
 *     `null` rather than `""` so the backend actually falls back, is locked in
 *     `HeadlessSshConnect.test.ts`.)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../components/terminal/TerminalView", () => ({ TerminalView: () => null }));

import { RemoteConnectDialog } from "../components/projects/RemoteConnectDialog";
import { useProjectsStore } from "../stores/projects";
import { useConnectDialogStore } from "../stores/connectDialog";
import { useRemoteStatusStore } from "../stores/remoteStatus";
import { useSettingsStore } from "../stores/settings";
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
    // Both secrets are already in the keychain — the state the toggles reflect.
    if (cmd === "remote_has_saved_password" || cmd === "vpn_has_saved_password") {
      return Promise.resolve(true);
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
  useRemoteStatusStore.setState({ byProject: { p1: { ssh: "off", vpn: "off" } } } as never);
});

describe("saved credentials", () => {
  it("pre-ticks the SSH toggle from the keychain and says the saved password will be used", async () => {
    render(<RemoteConnectDialog />);

    const save = await screen.findByRole<HTMLInputElement>("checkbox", { name: /save password/i });
    await waitFor(() => expect(save.checked).toBe(true));
    // The field stays empty (the secret never comes back to the UI), so it has to
    // say that leaving it blank is the way to use what's saved.
    expect(screen.getByPlaceholderText(/using saved secret/i)).toBeTruthy();
  });

  it("deletes the saved SSH password the moment the toggle is unticked", async () => {
    render(<RemoteConnectDialog />);

    const save = await screen.findByRole<HTMLInputElement>("checkbox", { name: /save password/i });
    await waitFor(() => expect(save.checked).toBe(true));

    await userEvent.click(save);

    await waitFor(() =>
      expect(calledWith("remote_forget_password")).toEqual([
        ["remote_forget_password", { user: "alice", host: "host.example", port: null }],
      ]),
    );
    // Not a connect: forgetting a credential and dropping the connection are
    // separate acts.
    expect(calledWith("remote_disconnect")).toEqual([]);
  });

  it("deletes the saved VPN passphrase the moment its toggle is unticked", async () => {
    render(<RemoteConnectDialog />);

    // The VPN fields live behind the (default-off) "Connect via OpenVPN" opt-in.
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /connect via openvpn/i }),
    );

    const save = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: /save passphrase/i,
    });
    await waitFor(() => expect(save.checked).toBe(true));

    await userEvent.click(save);

    await waitFor(() =>
      expect(calledWith("vpn_forget_password")).toEqual([
        ["vpn_forget_password", { config: VPN_CONFIG }],
      ]),
    );
  });
});
