/**
 * Group B #233: a guard nobody can answer must refuse, never park.
 *
 * `hpcGuardPrompt.request()` returns a Promise that only `HpcGuardDialog`
 * resolves — and that dialog was mounted in `AppShell` alone. So a ▶ run
 * started from a popped-out file tree on an HPC-tagged host awaited a Promise
 * with no resolver anywhere in that window: the run hung forever, with no
 * dialog, no error and nothing on screen to cancel. (The dialog is mounted in
 * `DetachedApp` too now; this is the second half — the store refusing rather
 * than hanging if a future surface asks with no host mounted.)
 */
import { describe, it, expect, beforeEach } from "vitest";

import { useHpcGuardStore } from "../stores/hpcGuardPrompt";

describe("HPC guard with no dialog host (#233)", () => {
  beforeEach(() => {
    useHpcGuardStore.setState({ pending: null, hosts: 0 });
  });

  it("refuses immediately when no dialog is mounted in this window", async () => {
    // Resolves — it does not hang — and answers "no", which runs the caller's
    // ordinary "the user backed out" path. The safe direction for a gate.
    await expect(
      useHpcGuardStore.getState().request("login-node-run", "u@login.example"),
    ).resolves.toBe(false);
    expect(useHpcGuardStore.getState().pending).toBeNull();
  });

  it("asks once a host has registered, and answers what the user chose", async () => {
    const drop = useHpcGuardStore.getState().registerHost();
    const answer = useHpcGuardStore.getState().request("login-node-run", "u@login.example");
    expect(useHpcGuardStore.getState().pending?.target).toBe("u@login.example");

    useHpcGuardStore.getState().proceed();
    await expect(answer).resolves.toBe(true);

    // …and unmounting the last host takes the window back to refusing.
    drop();
    await expect(
      useHpcGuardStore.getState().request("login-node-run", "u@login.example"),
    ).resolves.toBe(false);
  });

  it("counts hosts, so one window closing a dialog does not disarm another", () => {
    const a = useHpcGuardStore.getState().registerHost();
    const b = useHpcGuardStore.getState().registerHost();
    expect(useHpcGuardStore.getState().hosts).toBe(2);
    a();
    expect(useHpcGuardStore.getState().hosts).toBe(1);
    b();
    expect(useHpcGuardStore.getState().hosts).toBe(0);
  });
});
