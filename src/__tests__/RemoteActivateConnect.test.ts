/**
 * Auto-connect: a remote project that opted in comes up by itself — silently.
 *
 * The default stays what it always was: a remote project surfaces disconnected and
 * the user brings it up from the pill's connection lamp. The opt-in
 * (`remote.auto_connect`, offered only once a saved password or key auth makes the
 * connect promptless) changes that for one project: it is connected on launch and
 * on activation, and it *never* prompts — a stale opt-in degrades to staying
 * disconnected rather than ambushing the user with a modal.
 *
 * The load-bearing case is the VPN, because whether the tunnel is needed is a
 * property of the *network*, not of the project: the same host is reachable
 * directly at the office and only through the tunnel from home. So auto-connect
 * probes instead of assuming — and escalates to the tunnel only when the host is
 * genuinely unreachable, never when it merely rejected a credential.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useProjectsStore } from "../stores/projects";
import { useConnectDialogStore } from "../stores/connectDialog";
import { useRemoteStatusStore } from "../stores/remoteStatus";
import type { ProjectEntry, RemoteSpec, SshProbe } from "../types";

const invokeMock = vi.mocked(invoke);

const REACHABLE: SshProbe = { ok: true, unreachable: false, error: "" };
const UNREACHABLE: SshProbe = {
  ok: false,
  unreachable: true,
  error: "ssh: connect to host host.example port 22: Connection timed out",
};
const REJECTED: SshProbe = {
  ok: false,
  unreachable: false,
  error: "alice@host.example: Permission denied (publickey,password).",
};

const project = (id: string, remote?: Partial<RemoteSpec>): ProjectEntry =>
  ({
    id,
    name: id,
    directory: `/local/${id}`,
    position: 0,
    status: "active",
    ...(remote
      ? { remote: { user: "alice", host: "host.example", remote_path: "/srv/work", ...remote } }
      : {}),
  }) as unknown as ProjectEntry;

/**
 * Drive the mocked backend. `probe` is what `ssh_probe` answers (an array is
 * consumed one call at a time, so a connect can be unreachable and then reachable
 * once the tunnel is up); every other command resolves unless overridden.
 */
const backend = (opts: {
  probe?: SshProbe | SshProbe[];
  sshSaved?: boolean;
  vpnSaved?: boolean;
  vpnFails?: boolean;
}) => {
  const probes = Array.isArray(opts.probe) ? [...opts.probe] : opts.probe ? [opts.probe] : [];
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "ssh_probe":
        return Promise.resolve(probes.length > 1 ? probes.shift()! : (probes[0] ?? REACHABLE));
      case "remote_has_saved_password":
        return Promise.resolve(opts.sshSaved ?? true);
      case "vpn_has_saved_password":
        return Promise.resolve(opts.vpnSaved ?? false);
      case "openvpn_connect":
        return opts.vpnFails ? Promise.reject("tunnel failed") : Promise.resolve();
      default:
        return Promise.resolve();
    }
  });
};

/** Resolve the microtasks the fire-and-forget connect chain runs on. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const sshLamp = () => useRemoteStatusStore.getState().byProject.remote1?.ssh;
const vpnLamp = () => useRemoteStatusStore.getState().byProject.remote1?.vpn;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useConnectDialogStore.setState({ projectId: null });
  useRemoteStatusStore.setState({ byProject: {} });
  useProjectsStore.setState({ projects: [], activeId: null });
});

describe("auto-connect opt-in", () => {
  it("connects a flagged project silently, without touching the VPN", async () => {
    backend({ probe: REACHABLE, sshSaved: true });
    useProjectsStore.setState({ projects: [project("remote1", { auto_connect: true })] });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).toHaveBeenCalledWith("remote_connect", {
      projectId: "remote1",
      password: null,
    });
    expect(sshLamp()).toBe("connected");
    // Reachable directly: the tunnel is unnecessary on this network and must stay down.
    expect(invokeMock).not.toHaveBeenCalledWith("openvpn_connect", expect.anything());
    // Nothing to ask for — the modal must stay shut.
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("leaves an unflagged remote project disconnected, and never prompts", async () => {
    backend({ probe: REACHABLE, sshSaved: true });
    useProjectsStore.setState({ projects: [project("remote1")] });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    expect(sshLamp()).toBeUndefined();
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("connects the initially-active flagged project on launch", async () => {
    backend({ probe: REACHABLE, sshSaved: true });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_projects")
        return Promise.resolve([{ ...project("remote1", { auto_connect: true }), status: "current" }]);
      if (cmd === "ssh_probe") return Promise.resolve(REACHABLE);
      if (cmd === "remote_has_saved_password") return Promise.resolve(true);
      return Promise.resolve();
    });

    await useProjectsStore.getState().load();
    await settle();

    expect(invokeMock).toHaveBeenCalledWith("remote_connect", {
      projectId: "remote1",
      password: null,
    });
    expect(sshLamp()).toBe("connected");
  });

  it("brings the VPN up when the host is unreachable, then connects", async () => {
    // The other network: the host answers only through the tunnel.
    backend({
      probe: [UNREACHABLE, REACHABLE],
      sshSaved: true,
      vpnSaved: true,
    });
    useProjectsStore.setState({
      projects: [
        project("remote1", { auto_connect: true, openvpn: { config: "/cfg.ovpn" } }),
      ],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).toHaveBeenCalledWith("openvpn_connect", {
      config: "/cfg.ovpn",
      username: null,
      password: null,
      keyPassphrase: null,
      // `null`, never `false`: the backend reads `false` as "the user unticked Save
      // passphrase" and clears the keychain — an auto-connect would then delete the
      // passphrase it just used, and prompt on the next launch.
      remember: null,
    });
    expect(vpnLamp()).toBe("connected");
    expect(sshLamp()).toBe("connected");
  });

  it("does not bring the VPN up when the host merely rejected the credential", async () => {
    // No tunnel fixes a wrong password, and it is not wanted on this network.
    backend({ probe: REJECTED, sshSaved: true, vpnSaved: true });
    useProjectsStore.setState({
      projects: [
        project("remote1", { auto_connect: true, openvpn: { config: "/cfg.ovpn" } }),
      ],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).not.toHaveBeenCalledWith("openvpn_connect", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    expect(sshLamp()).toBe("error");
    // A failed auto-connect stays quiet: red lamp, no modal.
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("stays disconnected when the saved password has since been forgotten", async () => {
    // Stale opt-in: the toggle is on but the keychain entry is gone and the host is
    // not key-auth. Connecting would prompt, so we must not connect at all.
    backend({ probe: REACHABLE, sshSaved: false });
    useProjectsStore.setState({ projects: [project("remote1", { auto_connect: true })] });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(invokeMock).not.toHaveBeenCalledWith("ssh_probe", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    expect(useConnectDialogStore.getState().projectId).toBeNull();
  });

  it("auto-connects a key-auth host with nothing in the keychain", async () => {
    backend({ probe: REACHABLE, sshSaved: false });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true, key_auth: true })],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();

    expect(sshLamp()).toBe("connected");
  });

  it("abandons the connect — and the lamp — when the user switches away mid-probe", async () => {
    let resolveProbe: ((p: SshProbe) => void) | undefined;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ssh_probe") return new Promise((res) => (resolveProbe = res as never));
      if (cmd === "remote_has_saved_password") return Promise.resolve(true);
      return Promise.resolve();
    });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true }), project("local1")],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();
    expect(sshLamp()).toBe("connecting"); // probe in flight — the lamp is ours

    // Switch away while the probe is still in flight, then let it come back.
    await useProjectsStore.getState().setActive("local1");
    resolveProbe?.(REACHABLE);
    await settle();

    expect(invokeMock).not.toHaveBeenCalledWith("remote_connect", expect.anything());
    // A lamp stuck on "connecting" would lie in the header *and* wedge the project
    // shut — the next auto-connect only fires from "off".
    expect(sshLamp()).toBe("off");
  });

  it("does not re-attack a host that already failed this session", async () => {
    backend({ probe: REJECTED, sshSaved: true });
    useProjectsStore.setState({
      projects: [project("remote1", { auto_connect: true }), project("local1")],
    });

    await useProjectsStore.getState().setActive("remote1");
    await settle();
    expect(sshLamp()).toBe("error");

    const probesAfterFirst = invokeMock.mock.calls.filter(([cmd]) => cmd === "ssh_probe").length;
    await useProjectsStore.getState().setActive("local1");
    await useProjectsStore.getState().setActive("remote1");
    await settle();

    // Switching back and forth must not re-probe an unreachable host every time.
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "ssh_probe")).toHaveLength(
      probesAfterFirst,
    );
  });
});
