/**
 * Headless SSH connect — the typed password must reach the *pooled* connection,
 * not just the probe.
 *
 * `connectSshHeadless` makes two backend calls. `ssh_connect` only probes: it
 * runs a throwaway ssh with `ControlMaster=no` (reuse-only — it never *creates* a
 * master), so a successful probe leaves nothing behind to ride. `remote_connect`
 * is the one that opens the master-owning pooled SSH/SFTP session, and it needs
 * the password itself; handed `null` it drops to key/agent auth, which a
 * password-auth host rejects. It falls back to a *saved* password, so the bug hid
 * behind the (default-off) "Save password" toggle: connecting worked only if you
 * happened to tick it.
 *
 * These lock the password reaching BOTH calls, and lock the two paths that
 * legitimately pass `null` so they aren't "fixed" into leaking a password they
 * don't have.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { useRemoteReconnect } from "../components/projects/useRemoteReconnect";
import type { ProjectEntry } from "../types";

const invokeMock = vi.mocked(invoke);

const PROJECT = {
  id: "p1",
  name: "sshtest",
  directory: "/local/state/p1",
  remote: { user: "alice", host: "host.example", port: 2222, remote_path: "/srv/work" },
} as unknown as ProjectEntry;

/** Args of the first call to `cmd`, or undefined if it was never invoked. */
const argsOf = (cmd: string) =>
  invokeMock.mock.calls.find(([name]) => name === cmd)?.[1] as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    // Queried on mount; both must resolve or the hook's effects reject.
    if (cmd === "remote_has_saved_password" || cmd === "vpn_has_saved_password") {
      return Promise.resolve(false);
    }
    if (cmd === "openvpn_list_configs") return Promise.resolve([]);
    if (cmd === "openvpn_auth_needs") {
      return Promise.resolve({ username: false, keyPassphrase: false });
    }
    return Promise.resolve();
  });
});

describe("headless SSH connect", () => {
  it("hands the typed password to the pooled connection, not just the probe", async () => {
    const { result } = renderHook(() => useRemoteReconnect(PROJECT));

    await act(async () => {
      await result.current.connectSshHeadless("s3cret", false);
    });

    // The probe authenticates against the host target…
    expect(argsOf("ssh_connect")).toMatchObject({
      user: "alice",
      host: "host.example",
      port: 2222,
      password: "s3cret",
    });

    // …but the pooled session is what actually opens the master, so it needs the
    // password too. Passing `null` here is the bug: it silently downgrades to
    // key/agent auth and only worked when a password happened to be saved.
    expect(argsOf("remote_connect")).toEqual({ projectId: "p1", password: "s3cret" });

    await waitFor(() => expect(result.current.sshStatus).toBe("connected"));
  });

  it("sends a blank password as null, so the backend falls back to key auth or the keychain", async () => {
    // Two callers hand this an empty string: the Windows `winManual` key-auth
    // Connect, and a user who leaves the field blank because a password is already
    // saved (it can't be pre-filled — the secret never leaves the backend). Both
    // mean "nothing given", so it must reach the backend as `null`, not "".
    //
    // `""` is not a harmless synonym: `remote::connect` only falls back (to the
    // saved password, then to key/agent auth) when the password is absent, so a
    // literal empty string was used *as* the password and the pooled connect failed
    // with a perfectly good credential sitting in the keychain.
    const { result } = renderHook(() => useRemoteReconnect(PROJECT));

    await act(async () => {
      await result.current.connectSshHeadless("", false);
    });

    expect(argsOf("ssh_connect")).toMatchObject({ password: null });
    expect(argsOf("remote_connect")).toEqual({ projectId: "p1", password: null });
  });

  it("surfaces a failed pooled connect as an error, not a green lamp", async () => {
    // A probe can succeed while the pool fails (exactly the shape of the bug).
    // The lamp must follow `remote_connect`, not `ssh_connect`.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "remote_has_saved_password" || cmd === "vpn_has_saved_password") {
        return Promise.resolve(false);
      }
      if (cmd === "openvpn_list_configs") return Promise.resolve([]);
      if (cmd === "openvpn_auth_needs") {
        return Promise.resolve({ username: false, keyPassphrase: false });
      }
      if (cmd === "remote_connect") return Promise.reject("Permission denied (publickey,password).");
      return Promise.resolve();
    });

    const { result } = renderHook(() => useRemoteReconnect(PROJECT));

    await act(async () => {
      await result.current.connectSshHeadless("s3cret", false);
    });

    await waitFor(() => expect(result.current.sshStatus).toBe("error"));
    expect(result.current.sshError).toContain("Permission denied");
  });
});
