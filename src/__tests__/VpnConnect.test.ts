/**
 * The silent OpenVPN connect pair (`lib/remote/vpn/vpnConnect`). `pkexec` prompts before
 * OpenVPN has read the config, so a connect that was always going to fail
 * still costs a system password dialog — hence a "can this be silent?" ask
 * first, which never throws, and a connect whose `remember: null` is
 * load-bearing: with no checkbox behind the call, the keychain must be left
 * exactly as found (`false` would delete the credentials just used).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { canConnectVpnSilently, connectVpnSilently } from "../lib/remote/vpn/vpnConnect";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe("canConnectVpnSilently", () => {
  it("relays the backend's answer, sending a blank username as null", async () => {
    invokeMock.mockResolvedValue(true as never);
    await expect(canConnectVpnSilently("/lab.ovpn", "")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("vpn_can_connect_silently", {
      config: "/lab.ovpn",
      username: null,
    });
    await expect(canConnectVpnSilently("/lab.ovpn", "alice")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("vpn_can_connect_silently", {
      config: "/lab.ovpn",
      username: "alice",
    });
  });

  it("answers no — never throws — when the backend is unreachable", async () => {
    invokeMock.mockRejectedValue(new Error("no backend"));
    await expect(canConnectVpnSilently("/lab.ovpn")).resolves.toBe(false);
  });
});

describe("connectVpnSilently", () => {
  it("connects from saved credentials and leaves the keychain alone", async () => {
    invokeMock.mockResolvedValue(undefined as never);
    await connectVpnSilently("/lab.ovpn", undefined);
    expect(invokeMock).toHaveBeenCalledWith("openvpn_connect", {
      config: "/lab.ovpn",
      username: null,
      password: null,
      keyPassphrase: null,
      remember: null,
    });
  });

  it("throws so the caller can fall back to the modal", async () => {
    invokeMock.mockRejectedValue("AUTH_FAILED");
    await expect(connectVpnSilently("/lab.ovpn", "alice")).rejects.toBe("AUTH_FAILED");
  });
});
